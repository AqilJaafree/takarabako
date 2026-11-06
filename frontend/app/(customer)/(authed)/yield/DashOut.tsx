"use client";

import { useEffect, useState } from "react";
import type { NetworkInfo } from "@/lib/networks";
import type { DashOutPrepared, DashOutQuote } from "@/lib/selfCustody";
import { usd } from "@/lib/format";
import type { ArcWalletsApi } from "@/lib/useArcWallets";
import { ConfirmRealMoney } from "./RealMoney";

/// Dash out: sell the base token a wallet is left holding (for example after closing a position that
/// traded into it) for USDC, through 1inch Aqua. The backend finds the open strategies that will buy it,
/// quotes each through the router, and prepares the customer's own transactions: an approval for exactly
/// what is sold, then a swap per strategy, each with a minimum payout. It is refused when the price is
/// far below the market, and the wallet signs everything.

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "request failed");
  return json as T;
}

const num = (n: number, digits: number) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

export function DashOut({
  network,
  base,
  address,
  held,
  wallets,
  onDone,
  disabled,
}: {
  network: NetworkInfo;
  /// /api/self/<network>
  base: string;
  address: string;
  /// The wallet's base-token balance, in whole tokens: nothing is shown when it is 0.
  held: number;
  wallets: ArcWalletsApi;
  /// Called after a swap, so the wallet's balances are read again.
  onDone: () => void;
  /// Another action is in progress.
  disabled: boolean;
}) {
  const [reload, setReload] = useState(0);
  // The quote is keyed to the wallet and balance it was fetched for, so a stale one is never shown.
  const key = `${address}|${held}|${reload}`;
  const [result, setResult] = useState<{ key: string; quote?: DashOutQuote; error?: string } | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [confirming, setConfirming] = useState<null | ((ok: boolean) => void)>(null);

  useEffect(() => {
    if (held <= 0) return;
    let cancelled = false;
    api<DashOutQuote>(`${base}/dashout?address=${encodeURIComponent(address)}`)
      .then((quote) => !cancelled && setResult({ key, quote }))
      .catch((e) => !cancelled && setResult({ key, error: e instanceof Error ? e.message : "could not get a quote" }));
    return () => {
      cancelled = true;
    };
  }, [key, held, base, address]);

  if (held <= 0 && !done) return null;
  const quote = result?.key === key ? result.quote : undefined;
  const sym = quote?.symbols ?? (network.key === "sepolia" ? { base: "mETH", quote: "mUSDC" } : { base: "WETH", quote: "USDC" });
  const busy = progress !== "";

  async function dash() {
    setError("");
    setDone("");
    const ok = await new Promise<boolean>((resolve) => setConfirming(() => resolve));
    setConfirming(null);
    if (!ok) return;
    try {
      setProgress("Finding the best strategies and preparing the swap…");
      const prepared = await api<DashOutPrepared>(`${base}/dashout/prepare`, { wallet: address });
      for (const [i, s] of prepared.steps.entries()) {
        setProgress(`Signing ${i + 1} of ${prepared.steps.length}. ${s.description}`);
        await wallets.sign({ to: s.to, data: s.data, chainId: s.chainId, maxFeePerGas: s.maxFeePerGas, maxPriorityFeePerGas: s.maxPriorityFeePerGas }, address, s.description);
      }
      setDone(`Sold ${num(prepared.quote.amountIn, 6)} ${sym.base} for about ${num(prepared.quote.amountOut, 2)} ${sym.quote} (at least ${num(prepared.minOut, 2)} guaranteed).`);
      setReload((r) => r + 1);
      onDone();
    } catch (e) {
      setError(`${e instanceof Error ? e.message : "something went wrong"}. Nothing was sold unless a swap was confirmed in your wallet; any approval only lets the router take the amount shown, and you can try again.`);
    } finally {
      setProgress("");
    }
  }

  return (
    <div className="self-dashout">
      <h3>Dash out</h3>
      <p className="muted small" style={{ margin: "0 0 8px" }}>
        {held > 0
          ? `Your wallet is holding ${num(held, 6)} ${sym.base}. Dash out sells it for ${sym.quote} to other people's open strategies on 1inch Aqua, so the price can differ from the market.`
          : `Done. ${sym.base} you were holding has been sold.`}
      </p>
      {held > 0 && !quote && !result?.error && <p className="muted small">Finding the best price…</p>}
      {result?.key === key && result.error && <div className="notice warn small">{result.error}</div>}
      {quote && quote.strategies > 0 && (
        <dl className="net-facts">
          <div><dt>You would sell</dt><dd>{num(quote.amountIn, 6)} {sym.base}</dd></div>
          <div><dt>You would get about</dt><dd>{num(quote.amountOut, 2)} {sym.quote}</dd></div>
          <div><dt>Price</dt><dd>{quote.rate !== null ? usd(quote.rate) : "–"} per {sym.base}{quote.marketRate !== null ? ` · market ${usd(quote.marketRate)}` : ""}{quote.discountPct !== null ? ` · ${quote.discountPct >= 0 ? `${num(quote.discountPct, 1)}% below` : `${num(-quote.discountPct, 1)}% above`}` : ""}</dd></div>
          {quote.unfilled > 0 && <div><dt>Cannot be sold now</dt><dd>{num(quote.unfilled, 6)} {sym.base}</dd></div>}
        </dl>
      )}
      {quote && !quote.allowed && <div className="notice warn small" role="status">{quote.reason}</div>}
      {quote && quote.allowed && (
        <button type="button" className="btn btn-gold btn-block" disabled={busy || disabled} onClick={dash}>
          {busy ? "Working…" : `Dash out ${num(quote.amountIn, 6)} ${sym.base} → about ${num(quote.amountOut, 2)} ${sym.quote}`}
        </button>
      )}
      {busy && <p className="notice pending self-progress" role="status">{progress}</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {done && !busy && <div className="notice success" role="status">{done}</div>}
      {confirming && quote && (
        <ConfirmRealMoney
          title={`Sell your ${sym.base} for ${sym.quote}?`}
          confirmLabel="Confirm and sign"
          summary={`${num(quote.amountIn, 6)} ${sym.base} for about ${num(quote.amountOut, 2)} ${sym.quote}${quote.discountPct !== null ? ` (${num(quote.discountPct, 1)}% ${quote.discountPct >= 0 ? "below" : "above"} the market)` : ""}`}
          network={network.name}
          risks={[
            "You sell to other people's open Aqua strategies, not to a market. Their prices can sit away from the market price, so you may get less than the market is paying; the price is shown above and shown again by your wallet.",
            "The price can move before your transaction is mined. Each swap carries a minimum payout (the quote less 0.5%), and fails instead of paying less.",
            "Selling is final. You pay network fees for the approval and each swap, and Aqua is smart-contract software with smart-contract risk.",
          ]}
          onResult={confirming}
        />
      )}
    </div>
  );
}
