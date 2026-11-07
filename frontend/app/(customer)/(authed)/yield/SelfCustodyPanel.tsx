"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NetworkInfo } from "@/lib/networks";
import type { LiquidityRequest, Market, Preview, RiskTier } from "@/lib/types";
import type { DashOutPrepared, SelfMarket, SelfPosition, SelfPrepared, SelfShape, SelfStep, SelfWallet } from "@/lib/selfCustody";
import { shortHex, usd } from "@/lib/format";
import { useArcWallets, type ArcWalletsApi } from "@/lib/useArcWallets";
import { ConfirmRealMoney } from "./RealMoney";
import { DashOut } from "./DashOut";
import { Advanced, type OpenRequest } from "./Advanced";
import { PositionRange } from "./PositionRange";
import { QuickStart, type QuickTier } from "./QuickStart";
import { StrategyTabs } from "./StrategyTabs";

/// Open and close Aqua positions with the customer's own wallet, on Arc mainnet or (for testing)
/// Sepolia. Where a position manager contract is deployed (Sepolia), one transaction opens a
/// position and one closes it, and the tokens sit in the contract while it is open; elsewhere the
/// wallet is the Aqua maker, the tokens never leave it and each strategy is signed separately. The
/// wallet can be the Takarabako wallet or one they connect, such as MetaMask; opening this view
/// asks that wallet to switch to the chain. Strategies are chosen with the same
/// Quick start and Advanced as the box. The backend only prepares the transactions
/// and checks the result.

const SHAPE_NAME: Record<SelfShape, string> = { spot: "Spot", curve: "Curve", bidask: "Bid-Ask", hybrid: "Hybrid", full: "Full range" };

/// Quick start's cards for a pair that has none of its own.
function makeTier(riskTier: QuickTier["riskTier"], label: string, description: string, feeBps: number, spot: number, lo: number | null, hi: number | null, shape?: "curve"): QuickTier {
  return {
    riskTier,
    label,
    description,
    pair: "",
    apyBps: 0,
    feeBps,
    fullRange: lo === null,
    rangePct: lo === null ? null : Number(((1 - lo) * 100).toFixed(1)),
    priceLowUsd: lo === null ? null : spot * lo,
    priceHighUsd: hi === null ? null : spot * hi,
    ...(shape ? { shape } : {}),
  };
}

/// A stable pair (EURC/USDC) trades within a few percent of its price, so its strategies are narrow.
const stableTiers = (spot: number, feeBps: number): QuickTier[] => [
  makeTier("low", "Wide ±5%", "Survives bigger moves", feeBps, spot, 0.95, 1.05),
  makeTier("medium", "Balanced ±1.5%", "Core with room to drift", feeBps, spot, 0.985, 1.015, "curve"),
  makeTier("high", "Tight ±0.5%", "Most fees if price holds", feeBps, spot, 0.995, 1.005),
];
const volatileTiers = (spot: number, feeBps: number): QuickTier[] => [
  makeTier("low", "Steady", "Always earning", feeBps, spot, null, null),
  makeTier("medium", "Balanced", "More fees within ±25%", feeBps, spot, 0.75, 1.25),
  makeTier("high", "Bold", "Most fees, stops if price leaves", feeBps, spot, 0.92, 1.08),
];

const RISKS_CONTRACT = [
  "While open, your tokens sit in the Takarabako position contract (with other people's), not your wallet. Only you can close it, but the contract is new and unaudited: a flaw in it or in 1inch Aqua could lose funds.",
  "Value follows the price and can fall below what you put in. Fees aren't promised or insured.",
  "You sign everything and pay network fees. Closing returns everything to your wallet in one transaction.",
];

const RISKS = [
  "Tokens stay in your wallet; 1inch Aqua pays traders from them up to what you approve. Value can fall below what you put in.",
  "Fees aren't promised or insured.",
  "Aqua is smart-contract software (smart-contract risk). You sign everything and pay network fees in USDC.",
  "Closing stops earning and releases the approval.",
];

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "request failed");
  return json as T;
}

const num = (n: number, digits: number) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/// How long to wait for a wallet balance to catch up with a transaction: about 10 seconds.
const READ_RETRIES = 5;
const READ_RETRY_MS = 2000;

/// What the page around the panel shows about the wallet (`onSummary` must be a stable function).
export interface WalletSummary {
  /// What the wallet's tokens in the chosen pair are worth, once loaded.
  usd: number | null;
  /// One per open position, for the treasure stage.
  gems: Array<{ id: string; riskTier: RiskTier; apyBps: number }>;
}

/// The pair chosen in the panel, for the chart at the top of the page (`onPair` must be a stable function).
export interface PairChart {
  market: Market;
  symbols: { base: string; quote: string };
  stable: boolean;
}

/// The version that signs with the customer's Privy wallets (embedded and connected).
export function SelfCustodyPanel({ network, market, onSummary, onPair }: { network: NetworkInfo; market: Market; onSummary?: (s: WalletSummary) => void; onPair?: (p: PairChart) => void }) {
  const wallets = useArcWallets(network.chainId);
  return <SelfCustodyView network={network} market={market} wallets={wallets} onSummary={onSummary} onPair={onPair} />;
}

/// A market for a non-default pair, in the shape the panel already uses (its tiers are ETH's, so none).
const toMarket = (m: SelfMarket): Market => ({ spot: m.spot, candles: m.candles, tiers: [], advanced: { minPrice: m.advanced.minPrice, maxPrice: m.advanced.maxPrice, feeBps: m.advanced.feeBps, apyEstBps: 0, bins: m.advanced.bins } });

/// The panel with its wallets passed in, so it can be exercised without Privy. A chain can offer several
/// pairs (a base token against USDC, the token every position exits to): the customer picks one, and each
/// pair is its own view, so its range, shape and preview start fresh.
export function SelfCustodyView({ network, market, wallets, onSummary, onPair }: { network: NetworkInfo; market: Market; wallets: ArcWalletsApi; onSummary?: (s: WalletSummary) => void; onPair?: (p: PairChart) => void }) {
  const pairs = network.selfPairs ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const current = pairs.find((p) => p.key === picked) ?? pairs[0];
  const isDefault = !current || current.key === pairs[0]?.key;
  const [pairMarket, setPairMarket] = useState<{ key: string; data?: SelfMarket; error?: string } | null>(null);
  const currentKey = current?.key;
  useEffect(() => {
    if (isDefault || !currentKey) return;
    let cancelled = false;
    api<SelfMarket>(`/api/self/${network.key}/market?pair=${encodeURIComponent(currentKey)}`)
      .then((data) => !cancelled && setPairMarket({ key: currentKey, data }))
      .catch((e) => !cancelled && setPairMarket({ key: currentKey, error: e instanceof Error ? e.message : "could not load this pair's price" }));
    return () => {
      cancelled = true;
    };
  }, [isDefault, currentKey, network.key]);
  const loaded = pairMarket?.key === currentKey ? pairMarket : null;
  const loadedData = loaded?.data;
  const pairView = useMemo(() => (isDefault ? market : loadedData ? toMarket(loadedData) : null), [isDefault, market, loadedData]);
  const names = current?.symbols ?? (network.key === "sepolia" ? { base: "mETH", quote: "mUSDC" } : { base: "WETH", quote: "USDC" });

  // The chart at the top of the page follows the pair chosen here, once its price has loaded.
  const base = names.base;
  const quote = names.quote;
  const stable = Boolean(current?.stable);
  useEffect(() => {
    if (pairView) onPair?.({ market: pairView, symbols: { base, quote }, stable });
  }, [pairView, base, quote, stable, onPair]);

  return (
    <>
      {pairs.length > 1 && (
        <div className="self-shape" style={{ marginBottom: 10 }}>
          <span className="label">Pair</span>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="radiogroup" aria-label="Pair">
            {pairs.map((p) => (
              <button key={p.key} type="button" role="radio" aria-checked={p.key === current?.key} className={`chip btn btn-ghost small${p.key === current?.key ? " is-on" : ""}`} onClick={() => setPicked(p.key)}>
                {p.symbols.base}/{p.symbols.quote}
                {p.stable ? " · stable" : ""}
              </button>
            ))}
          </div>
        </div>
      )}
      {pairView ? (
        <PairView key={current?.key ?? "default"} network={network} market={pairView} wallets={wallets} onSummary={onSummary} pair={{ key: isDefault ? undefined : current?.key, symbols: names, stable: Boolean(current?.stable) }} />
      ) : loaded?.error ? (
        <div className="notice error">{loaded.error}</div>
      ) : (
        <p className="muted small">Loading the {names.base}/{names.quote} price…</p>
      )}
    </>
  );
}

/// One pair's panel: wallet, Dash out, Quick start and Advanced, and positions.
function PairView({ network, market, wallets, onSummary, pair }: { network: NetworkInfo; market: Market; wallets: ArcWalletsApi; onSummary?: (s: WalletSummary) => void; pair: { key: string | undefined; symbols: { base: string; quote: string }; stable: boolean } }) {
  const [chosen, setChosen] = useState<string | null>(null);
  // /api/self/arc or /api/self/sepolia: the backend serves the same flow per chain.
  const base = `/api/self/${network.key}`;
  // which pair the wallet and the new position are for (none: the chain's default)
  const pairQ = pair.key ? `&pair=${encodeURIComponent(pair.key)}` : "";
  // a pair priced near $1 (EURC) needs decimals in its prices: whole dollars would read "$1 and $1"
  const pd = pair.stable ? 4 : 0;
  // Where a position manager is deployed, the tokens sit in that contract while a position is open.
  const viaContract = Boolean(network.selfManager);
  // The Takarabako wallet unless the customer picked another one.
  const current = wallets.wallets.find((w) => w.address.toLowerCase() === chosen?.toLowerCase()) ?? wallets.wallets.find((w) => w.kind === "embedded") ?? wallets.wallets[0];
  const address = current?.address;
  const onArc = current?.onArc ?? false;

  const spot = market.spot;
  const [wallet, setWallet] = useState<{ forAddress: string; data: SelfWallet } | null>(null);
  const [positions, setPositions] = useState<SelfPosition[]>([]);
  const [loadError, setLoadError] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  // The position being confirmed, and the answer to the dialog.
  const [confirming, setConfirming] = useState<null | { label: string; amount: number; oneSided: boolean; resolve: (ok: boolean) => void }>(null);
  // An instant exit being confirmed: the position, and the answer to the dialog.
  const [exitFor, setExitFor] = useState<null | { p: SelfPosition; resolve: (ok: boolean) => void }>(null);
  const [copied, setCopied] = useState(false);
  // An open that was signed and sent but not yet confirmed by the backend: the tokens may already be in the position.
  const [unrecorded, setUnrecorded] = useState<null | { positionId: string; hashes: string[] }>(null);
  const busy = progress !== "";
  const walletData = wallet && wallet.forAddress === address ? wallet.data : null;
  const sym = walletData?.symbols ?? pair.symbols;

  /// Asks the wallet to switch to Arc (MetaMask shows its own prompt, and adds the network if it is missing).
  const switchToArc = useCallback(
    async (a: string) => {
      setSwitching(true);
      setSwitchError("");
      try {
        await wallets.switchToArc(a);
      } catch (e) {
        setSwitchError(e instanceof Error ? e.message : "the wallet did not switch");
      } finally {
        setSwitching(false);
      }
    },
    [wallets],
  );

  // Opening the Arc view, or choosing another wallet, asks that wallet to switch once.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!address || onArc || asked.current.has(address.toLowerCase())) return;
    asked.current.add(address.toLowerCase());
    void switchToArc(address);
  }, [address, onArc, switchToArc]);

  const loadPositions = useCallback(async () => {
    try {
      setPositions((await api<{ positions: SelfPosition[] }>(`${base}/positions`)).positions);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not load your positions");
    }
  }, [base]);

  const loadWallet = useCallback(async (a: string) => {
    try {
      setWallet({ forAddress: a, data: await api<SelfWallet>(`${base}/wallet?address=${encodeURIComponent(a)}${pairQ}`) });
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not load your wallet");
    }
  }, [base, pairQ]);

  // First loads (and again when another wallet is picked); loadWallet / loadPositions refresh after opening or closing.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    api<SelfWallet>(`${base}/wallet?address=${encodeURIComponent(address)}${pairQ}`)
      .then((data) => {
        if (cancelled) return;
        setWallet({ forAddress: address, data });
        setLoadError("");
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "could not load your wallet"));
    return () => {
      cancelled = true;
    };
  }, [address, base, pairQ]);
  useEffect(() => {
    let cancelled = false;
    api<{ positions: SelfPosition[] }>(`${base}/positions`)
      .then((r) => !cancelled && setPositions(r.positions))
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "could not load your positions"));
    return () => {
      cancelled = true;
    };
  }, [base]);

  /// Has the wallet sign each step in turn and returns the hashes, in order.
  async function signAll(steps: SelfStep[], from: string, label: string): Promise<string[]> {
    const hashes: string[] = [];
    for (const [i, s] of steps.entries()) {
      setProgress(`${label}: signing ${i + 1} of ${steps.length}. ${s.description}`);
      hashes.push(await wallets.sign({ to: s.to, data: s.data, chainId: s.chainId, maxFeePerGas: s.maxFeePerGas, maxPriorityFeePerGas: s.maxPriorityFeePerGas }, from, s.description));
    }
    return hashes;
  }

  const rangeLabel = (min: number, max: number) => `${usd(min, pd)} – ${usd(max, pd)}`;
  const previewLiquidity = useCallback((req: LiquidityRequest) => api<Preview>(`${base}/preview`, { ...(pair.key ? { pair: pair.key } : {}), ...req }), [base, pair.key]);
  const openedLabel = useRef("");

  /// Asks the backend to check the signed transactions on chain and open the position. Safe to repeat.
  async function finishOpen(positionId: string, hashes: string[]) {
    setProgress(`Waiting for ${network.name} to confirm, and checking Aqua…`);
    try {
      await api(`${base}/record`, { positionId, txHashes: hashes });
      setUnrecorded(null);
      setDone(viaContract ? `Your ${openedLabel.current} position is open. Your tokens are held by the position contract until you close it.` : `Your ${openedLabel.current} position is open. Your tokens are still in your wallet.`);
      if (address) await Promise.all([loadWallet(address), loadPositions()]);
    } catch (e) {
      // The transactions were signed and sent, so the tokens may already be in the position: keep what is needed to check again.
      setUnrecorded({ positionId, hashes });
      setError(
        `${e instanceof Error ? e.message : "something went wrong"}. Your transactions were sent to ${network.name}, so the position may be open: ${hashes.map((h) => shortHex(h)).join(", ")}. Check again below; nothing is lost.`,
      );
    } finally {
      setProgress("");
    }
  }

  async function open({ label, ...req }: OpenRequest) {
    if (!address) return;
    setError("");
    setDone("");
    setUnrecorded(null);
    const oneSided = req.hybrid !== undefined && req.hybrid.side !== "both";
    const ok = await new Promise<boolean>((resolve) => setConfirming({ label, amount: req.amount, oneSided, resolve }));
    setConfirming(null);
    if (!ok) return;
    openedLabel.current = label;
    let prepared: SelfPrepared;
    let hashes: string[];
    try {
      setProgress("Checking your wallet and preparing the transactions…");
      prepared = await api<SelfPrepared>(`${base}/prepare`, { ...(pair.key ? { pair: pair.key } : {}), ...req, wallet: address });
      hashes = await signAll(prepared.steps, address, "Opening");
    } catch (e) {
      setProgress("");
      setError(
        viaContract
          ? `${e instanceof Error ? e.message : "something went wrong"}. Nothing was opened. If you signed an approval it only lets the position contract take the amount shown, and you can try again.`
          : `${e instanceof Error ? e.message : "something went wrong"}. Nothing is taken from your wallet except network fees; any approval you signed only lets Aqua pay out up to its limit, and you can try again.`,
      );
      return;
    }
    await finishOpen(prepared.positionId, hashes);
  }

  async function close(p: SelfPosition) {
    setError("");
    setDone("");
    try {
      setProgress("Preparing the transactions to close it…");
      const prepared = await api<SelfPrepared>(`${base}/positions/${p.id}/close/prepare`, {});
      const hashes = await signAll(prepared.steps, p.wallet, "Closing");
      setProgress(`Waiting for ${network.name} to confirm, and checking Aqua…`);
      await api(`${base}/positions/${p.id}/close/record`, { txHashes: hashes });
      setDone(viaContract ? "Closed. Everything the position held is back in your wallet." : "Closed. The position no longer holds anything in Aqua.");
      await Promise.all([address ? loadWallet(address) : Promise.resolve(), loadPositions()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setProgress("");
    }
  }

  /// The wallet's balance of a position's base token, read fresh.
  const baseHeld = (p: SelfPosition) => api<SelfWallet>(`${base}/wallet?address=${encodeURIComponent(p.wallet)}${p.pair ? `&pair=${encodeURIComponent(p.pair)}` : ""}`).then((w) => w.weth);

  /// Reads the base token balance until it passes `until`, for the chain and the RPC node to catch up.
  async function waitForBase(p: SelfPosition, until: (held: number) => boolean): Promise<number> {
    let held = await baseHeld(p);
    for (let i = 0; i < READ_RETRIES && !until(held); i++) {
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
      held = await baseHeld(p);
    }
    return held;
  }

  /// Closes a position, then sells the base token it returned for the quote token (Dash out), as separate
  /// transactions: what the close pays is only known once it has happened. Only what this position returned
  /// is sold, never the rest of the wallet. If the sale can't happen the position is still closed and the
  /// customer keeps the base token, which Dash out can sell later.
  async function closeAndSwap(p: SelfPosition) {
    setError("");
    setDone("");
    const sy = p.symbols ?? pair.symbols;
    const ok = await new Promise<boolean>((resolve) => setExitFor({ p, resolve }));
    setExitFor(null);
    if (!ok) return;
    let expected: number;
    let before = 0;
    try {
      setProgress("Preparing the transactions to close it…");
      // Trades may have moved the position since this page loaded, so use what it holds now.
      const latest = (await api<{ positions: SelfPosition[] }>(`${base}/positions`)).positions.find((x) => x.id === p.id);
      expected = (latest ?? p).weth;
      if (p.manager) before = await baseHeld(p);
      const prepared = await api<SelfPrepared>(`${base}/positions/${p.id}/close/prepare`, {});
      const hashes = await signAll(prepared.steps, p.wallet, "Closing");
      setProgress(`Waiting for ${network.name} to confirm, and checking Aqua…`);
      await api(`${base}/positions/${p.id}/close/record`, { txHashes: hashes });
      await Promise.all([address ? loadWallet(address) : Promise.resolve(), loadPositions()]);
    } catch (e) {
      setProgress("");
      setError(`${e instanceof Error ? e.message : "something went wrong"}. The position was not closed unless a closing transaction was confirmed in your wallet, so nothing was sold.`);
      return;
    }
    // Closed. Sell what it returned: with a position contract the wallet's balance rose by exactly that; where
    // the wallet was the maker the tokens never left it, so it is what the position held just before closing.
    let signed = 0;
    try {
      setProgress(`Closed. Checking what came back to your wallet…`);
      const held = await waitForBase(p, (h) => !p.manager || expected <= 0 || h > before);
      const sell = p.manager ? held - before : expected;
      if (sell <= 0) {
        setDone(expected > 0 ? `The position is closed. Your wallet doesn't show the returned ${sy.base} yet, so nothing was sold. You can use Dash out once it does.` : `The position is closed. It held only ${sy.quote}, so there was nothing to sell.`);
        return;
      }
      setProgress(`Closed. Finding the best price for your ${sy.base}…`);
      const dash = await api<DashOutPrepared>(`${base}/dashout/prepare`, { wallet: p.wallet, ...(p.pair ? { pair: p.pair } : {}), amount: sell.toFixed(18) });
      for (const [i, st] of dash.steps.entries()) {
        setProgress(`Selling ${sy.base}: signing ${i + 1} of ${dash.steps.length}. ${st.description}`);
        await wallets.sign({ to: st.to, data: st.data, chainId: st.chainId, maxFeePerGas: st.maxFeePerGas, maxPriorityFeePerGas: st.maxPriorityFeePerGas }, p.wallet, st.description);
        signed++;
      }
      // A signed swap can still fail on chain, so only the wallet's balance says it was sold.
      setProgress(`Waiting for ${network.name} to confirm the sale…`);
      const target = held - dash.quote.amountIn * 0.99;
      const after = await waitForBase(p, (h) => h <= target);
      const left = dash.quote.unfilled > 0 ? ` ${num(dash.quote.unfilled, 6)} ${sy.base} could not be sold right now: use Dash out for it.` : "";
      setDone(
        after <= target
          ? `Closed and swapped: ${num(dash.quote.amountIn, 6)} ${sy.base} sold for about ${num(dash.quote.amountOut, 2)} ${sy.quote} (at least ${num(dash.minOut, 2)} guaranteed).${left}`
          : `The position is closed and the sale was sent, but your wallet doesn't show it yet. Check your wallet in a moment; anything unsold can go through Dash out.${left}`,
      );
    } catch (e) {
      const why = e instanceof Error ? e.message : "something went wrong";
      setDone(
        signed > 0
          ? `The position is closed and part of the sale may have gone through, but it stopped: ${why}. Check your wallet; anything unsold can go through Dash out.`
          : `The position is closed and everything it held is in your wallet. Selling the ${sy.base} for ${sy.quote} did not happen: ${why}. You can try Dash out below.`,
      );
    } finally {
      setProgress("");
      if (address) await loadWallet(address);
    }
  }

  // What the page around this panel shows: the wallet's value, and a gem per open position.
  const walletUsd = walletData ? walletData.usdc + walletData.weth * spot : null;
  const gems = useMemo(
    () => positions.filter((p) => p.status === "open" || p.partial).map((p) => ({ id: p.id, riskTier: (p.mode === "full" ? "low" : p.mode === "spot" ? "medium" : "high") as RiskTier, apyBps: 0 })),
    [positions],
  );
  useEffect(() => {
    onSummary?.({ usd: walletUsd, gems });
  }, [walletUsd, gems, onSummary]);

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the address stays selectable */
    }
  }

  if (!current) return <p className="muted small">Waiting for your wallet…</p>;
  if (loadError && !walletData) return <div className="notice error">{loadError}</div>;

  const empty = walletData ? walletData.usdc === 0 && walletData.weth === 0 : false;
  const cap = walletData?.maxUsd ?? 100;
  const fee = market.advanced.feeBps;
  const tiers: QuickTier[] = pair.stable ? stableTiers(spot, fee) : market.tiers.length > 0 ? market.tiers : volatileTiers(spot, fee);
  const limits = { lo: market.advanced.minPrice, hi: market.advanced.maxPrice };
  const showEstimates = market.showEstimates !== false && !network.real && !pair.stable && market.tiers.length > 0;
  const available = `Up to ${usd(cap, 0)}, from ${current.name}`;
  const mine = positions.filter((p) => p.status === "open" || p.partial);

  return (
    <>
      <div className="self-panel">
      <h3>Sign with your own wallet</h3>
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        {viaContract
          ? "One transaction opens, one closes. Meanwhile your tokens sit in the position contract."
          : "Your tokens stay in your wallet. You sign everything."}
      </p>

      <div className="self-wallets" role="radiogroup" aria-label="Wallet to sign with">
        {wallets.wallets.map((w) => (
          <button key={w.address} type="button" role="radio" aria-checked={w.address.toLowerCase() === address?.toLowerCase()} className={w.address.toLowerCase() === address?.toLowerCase() ? "is-on" : ""} onClick={() => setChosen(w.address)} disabled={busy}>
            <b>{w.name}</b>
            <span className="mono small">{short(w.address)}</span>
          </button>
        ))}
        <button type="button" className="self-connect" onClick={wallets.connectExternal} disabled={busy}>
          <b>+ Connect a wallet</b>
          <span className="muted small">MetaMask and others</span>
        </button>
      </div>

      <p className={`self-network ${onArc ? "ok" : "warn"}`} role="status">
        {onArc ? (
          <>✓ {current.name} is on {network.name}</>
        ) : switching ? (
          <>Check your wallet: switching {current.name} to {network.name}…</>
        ) : (
          <>
            {current.name} is not on {network.name}.{" "}
            <button type="button" className="link-btn" onClick={() => switchToArc(current.address)}>Switch to {network.name}</button>
            {switchError && <span className="muted"> ({switchError})</span>}
          </>
        )}
      </p>

      {walletData ? (
        <dl className="net-facts">
          <div><dt>Your wallet on {network.name}</dt><dd className="mono small" style={{ wordBreak: "break-all" }}>{walletData.address}</dd></div>
          <div><dt>{sym.quote}</dt><dd>{num(walletData.usdc, 2)}</dd></div>
          <div><dt>{sym.base}</dt><dd>{num(walletData.weth, 6)}</dd></div>
          <div><dt>For network fees</dt><dd>{num(walletData.gas ?? walletData.gasUsdc, walletData.gasSymbol === "ETH" ? 5 : 2)} {walletData.gasSymbol ?? "USDC"}</dd></div>
        </dl>
      ) : (
        <p className="muted small">Loading this wallet on {network.name}…</p>
      )}
      <p className="row" style={{ margin: "8px 0 0", gap: 8 }}>
        <button type="button" className="btn btn-ghost small" onClick={copy}>{copied ? "Copied" : "Copy address"}</button>
        {empty && <span className="muted small">Fund it with {sym.quote}, {sym.base} and {walletData?.gasSymbol ?? "USDC"} for fees.</span>}
      </p>

      {address && walletData && (walletData.pairs ?? [{ pair: pair.key ?? "", symbols: pair.symbols, base: walletData.weth, stable: pair.stable }]).filter((x) => x.base > 0).map((x) => (
        <DashOut key={x.pair} network={network} base={base} pairKey={x.pair || undefined} symbols={x.symbols} address={address} held={x.base} wallets={wallets} onDone={() => loadWallet(address)} disabled={busy} />
      ))}
      </div>

      {mine.length > 0 && (
        <section className="card">
          <h2>Your strategies</h2>
          <ul className="pos-list">
            {mine.map((p) => {
              const signer = wallets.wallets.find((w) => w.address.toLowerCase() === p.wallet.toLowerCase());
              const names = p.symbols ?? sym;
              const hasRange = p.priceMin !== null && p.priceMax !== null;
              // The price shown is this pair's, so it only says where a position in this pair sits.
              const samePair = names.base === sym.base;
              const inRange = !hasRange || (spot >= p.priceMin! && spot <= p.priceMax!);
              const digits = hasRange && p.priceMax! < 10 ? 4 : 0;
              const pnl = p.valueUsd === null ? null : p.valueUsd - p.amountUsd;
              return (
                <li key={p.id}>
                  <div className="spread">
                    <b>{SHAPE_NAME[p.mode] ?? p.mode}</b>
                    {p.partial ? (
                      <span className="pill bad">Partly opened</span>
                    ) : samePair ? (
                      <span className={`pill ${inRange ? "ok" : "warn"}`}>{inRange ? "Earning · in range" : "Out of range"}</span>
                    ) : (
                      <span className="pill ok">Open</span>
                    )}
                  </div>
                  <div className="spread pos-numbers">
                    <span className="amount">{p.valueUsd === null ? "Value unavailable" : usd(p.valueUsd)}</span>
                    {pnl !== null && (
                      <span className={`small ${pnl >= 0 ? "tone-ok" : "tone-bad"}`}>
                        {pnl >= 0 ? "+" : "−"}{usd(Math.abs(pnl), 4)} since opening
                      </span>
                    )}
                  </div>
                  {hasRange && samePair && <PositionRange min={p.priceMin!} max={p.priceMax!} spot={spot} base={names.base} digits={digits} />}
                  {p.partial && (
                    <p className="notice warn small" style={{ margin: "6px 0" }}>
                      Signing stopped partway. Closing removes the live part.
                    </p>
                  )}
                  <p className="muted small" style={{ margin: "6px 0 8px" }}>
                    {hasRange ? `${usd(p.priceMin, digits)} – ${usd(p.priceMax, digits)}` : "Full range"} · {num(p.weth, 6)} {names.base} + {num(p.usdc, 2)} {names.quote} {p.manager ? "held by the position contract in Aqua" : "held in Aqua"} · wallet {short(p.wallet)}
                  </p>
                  <p className="small" style={{ margin: "0 0 8px" }}>
                    {(p.openTxs ?? []).map((h) => (
                      <a key={h} className="mono" href={`${network.explorerUrl}/tx/${h}`} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>{shortHex(h)}</a>
                    ))}
                  </p>
                  {!p.partial && (
                    <button type="button" className="btn btn-gold small" style={{ marginRight: 8 }} disabled={busy || !signer} onClick={() => closeAndSwap(p)} title={`Close it, then sell the ${names.base} it returns for ${names.quote}`}>
                      Close &amp; swap to {names.quote}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost small" disabled={busy || !signer} onClick={() => close(p)}>{p.partial ? "Close the live part" : "Close, keep tokens"}</button>
                  {!signer && <span className="muted small"> Connect wallet {short(p.wallet)} to close it.</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <StrategyTabs
        quick={
          <QuickStart
            tiers={tiers}
            candles={market.candles}
            spot={spot}
            balance={cap}
            limits={limits}
            previewLiquidity={previewLiquidity}
            showEstimates={showEstimates}
            initialAmount={25}
            availableLabel={available}
            symbols={sym}
            priceDigits={pd}
            disabled={busy || !walletData}
            onOpen={async (tierId, amt) => {
              const t = tiers.find((x) => x.riskTier === tierId)!;
              const isFull = t.fullRange || t.priceLowUsd === null || t.priceHighUsd === null;
              const label = isFull ? t.label : `${t.label} ${rangeLabel(t.priceLowUsd!, t.priceHighUsd!)}`;
              await open(isFull ? { amount: amt, shape: "full", label } : { amount: amt, shape: t.shape ?? "spot", priceMin: t.priceLowUsd!, priceMax: t.priceHighUsd!, label });
            }}
          />
        }
        advanced={
          <Advanced
            market={market}
            balance={cap}
            preview={previewLiquidity}
            initialAmount={25}
            availableLabel={available}
            allowFull
            stable={pair.stable}
            symbols={sym}
            priceDigits={pd}
            showEstimates={showEstimates}
            disabled={busy || !walletData}
            onOpen={open}
          />
        }
      />
      {busy && <p className="notice pending self-progress" role="status">{progress}</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {unrecorded && !busy && (
        <p className="row" style={{ gap: 8, margin: "8px 0" }}>
          <button type="button" className="btn btn-gold small" onClick={() => { setError(""); void finishOpen(unrecorded.positionId, unrecorded.hashes); }}>
            Check my position again
          </button>
        </p>
      )}
      {done && !busy && <div className="notice success" role="status">{done}</div>}

      {exitFor && (
        <ConfirmRealMoney
          title={`Close and swap to ${(exitFor.p.symbols ?? pair.symbols).quote}?`}
          confirmLabel="Confirm and sign"
          summary={`Close your ${SHAPE_NAME[exitFor.p.mode] ?? exitFor.p.mode} position (${usd(exitFor.p.valueUsd ?? exitFor.p.amountUsd)}) and sell the ${(exitFor.p.symbols ?? pair.symbols).base} it returns for ${(exitFor.p.symbols ?? pair.symbols).quote}, from ${short(exitFor.p.wallet)}`}
          network={network.name}
          risks={[
            "Separate transactions, each signed: closing comes first and is final, then the sale. Only what this position returns is sold.",
            `The ${(exitFor.p.symbols ?? pair.symbols).base} sells to other Aqua strategies, possibly below market. If the price is too low, it stays closed and you keep the ${(exitFor.p.symbols ?? pair.symbols).base}.`,
            "Each swap has a minimum payout. You pay network fees; Aqua carries smart-contract risk.",
          ]}
          onResult={exitFor.resolve}
        />
      )}

      {confirming && (
        <ConfirmRealMoney
          title="Open a position from your own wallet?"
          confirmLabel="Confirm and sign"
          summary={`${usd(confirming.amount, 0)} as ${confirming.label} from ${current.name} (${short(current.address)})`}
          network={network.name}
          risks={[...(confirming.oneSided ? ["This position holds one token and earns nothing until the price reaches its range."] : []), ...(viaContract ? RISKS_CONTRACT : RISKS)]}
          onResult={confirming.resolve}
        />
      )}
    </>
  );
}
