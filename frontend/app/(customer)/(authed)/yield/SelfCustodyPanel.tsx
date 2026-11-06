"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NetworkInfo } from "@/lib/networks";
import type { SelfMode, SelfPosition, SelfPrepared, SelfStep, SelfWallet } from "@/lib/selfCustody";
import { shortHex, usd } from "@/lib/format";
import { useArcWallets, type ArcWalletsApi } from "@/lib/useArcWallets";
import { ConfirmRealMoney } from "./RealMoney";

/// Open and close Aqua positions on Arc mainnet with the customer's own wallet:
/// the wallet is the Aqua maker, so the tokens never leave it and the customer
/// signs every transaction. It can be their Takarabako wallet or one they connect,
/// such as MetaMask; opening this view asks that wallet to switch to Arc. The
/// backend only prepares the transactions and checks the result.

const MODES: Array<{ id: SelfMode; name: string; hint: string }> = [
  { id: "low", name: "Full range", hint: "Earns on every trade and swings the least" },
  { id: "medium", name: "Balanced ±25%", hint: "More fees while ETH stays within 25% of today's price" },
  { id: "high", name: "Bold ±8%", hint: "Most fees while the price holds, and nothing once it leaves" },
  { id: "hybrid", name: "Hybrid", hint: "A tight core near today's price plus the whole range as a safety net" },
];
const MODE_NAME = Object.fromEntries(MODES.map((m) => [m.id, m.name])) as Record<SelfMode, string>;

const RISKS = [
  "Your tokens stay in your own wallet. 1inch Aqua pays traders out of them, up to the amounts you approve, so the position's value follows ETH's price and can fall below what you put in.",
  "Earnings are trading fees, which depend on how much people trade. None is promised, and this is not insured or guaranteed.",
  "Aqua is smart-contract software, which carries smart-contract risk. You sign every transaction yourself and pay network fees in USDC.",
  "Closing stops the position earning and releases the approval it used; what remains is already in your wallet.",
];

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "request failed");
  return json as T;
}

const num = (n: number, digits: number) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/// The version that signs with the customer's Privy wallets (embedded and connected).
export function SelfCustodyPanel({ network }: { network: NetworkInfo }) {
  const wallets = useArcWallets();
  return <SelfCustodyView network={network} wallets={wallets} />;
}

/// The panel with its wallets passed in, so it can be exercised without Privy.
export function SelfCustodyView({ network, wallets }: { network: NetworkInfo; wallets: ArcWalletsApi }) {
  const [chosen, setChosen] = useState<string | null>(null);
  // The Takarabako wallet unless the customer picked another one.
  const current = wallets.wallets.find((w) => w.address.toLowerCase() === chosen?.toLowerCase()) ?? wallets.wallets.find((w) => w.kind === "embedded") ?? wallets.wallets[0];
  const address = current?.address;
  const onArc = current?.onArc ?? false;

  const [wallet, setWallet] = useState<{ forAddress: string; data: SelfWallet } | null>(null);
  const [positions, setPositions] = useState<SelfPosition[]>([]);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<SelfMode>("hybrid");
  const [amount, setAmount] = useState(25);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [confirming, setConfirming] = useState<null | ((ok: boolean) => void)>(null);
  const [copied, setCopied] = useState(false);
  const busy = progress !== "";
  const walletData = wallet && wallet.forAddress === address ? wallet.data : null;

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
      setPositions((await api<{ positions: SelfPosition[] }>("/api/self/arc/positions")).positions);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not load your positions");
    }
  }, []);

  const loadWallet = useCallback(async (a: string) => {
    try {
      setWallet({ forAddress: a, data: await api<SelfWallet>(`/api/self/arc/wallet?address=${encodeURIComponent(a)}`) });
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not load your wallet");
    }
  }, []);

  // First loads (and again when another wallet is picked); loadWallet / loadPositions refresh after opening or closing.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    api<SelfWallet>(`/api/self/arc/wallet?address=${encodeURIComponent(address)}`)
      .then((data) => {
        if (cancelled) return;
        setWallet({ forAddress: address, data });
        setLoadError("");
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "could not load your wallet"));
    return () => {
      cancelled = true;
    };
  }, [address]);
  useEffect(() => {
    let cancelled = false;
    api<{ positions: SelfPosition[] }>("/api/self/arc/positions")
      .then((r) => !cancelled && setPositions(r.positions))
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "could not load your positions"));
    return () => {
      cancelled = true;
    };
  }, []);

  /// Has the wallet sign each step in turn and returns the hashes, in order.
  async function signAll(steps: SelfStep[], from: string, label: string): Promise<string[]> {
    const hashes: string[] = [];
    for (const [i, s] of steps.entries()) {
      setProgress(`${label}: signing ${i + 1} of ${steps.length}. ${s.description}`);
      hashes.push(await wallets.sign({ to: s.to, data: s.data, chainId: s.chainId, maxFeePerGas: s.maxFeePerGas, maxPriorityFeePerGas: s.maxPriorityFeePerGas }, from, s.description));
    }
    return hashes;
  }

  async function open() {
    if (!address) return;
    setError("");
    setDone("");
    const ok = await new Promise<boolean>((resolve) => setConfirming(() => resolve));
    setConfirming(null);
    if (!ok) return;
    try {
      setProgress("Checking your wallet and preparing the transactions…");
      const prepared = await api<SelfPrepared>("/api/self/arc/prepare", { mode, amount, wallet: address });
      const hashes = await signAll(prepared.steps, address, "Opening");
      setProgress("Waiting for Arc to confirm, and checking Aqua…");
      await api("/api/self/arc/record", { positionId: prepared.positionId, txHashes: hashes });
      setDone(`Your ${MODE_NAME[mode]} position is open. Your tokens are still in your wallet.`);
      await Promise.all([loadWallet(address), loadPositions()]);
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "something went wrong"}. Nothing is taken from your wallet except network fees; any approval you signed only lets Aqua pay out up to its limit, and you can try again.`,
      );
    } finally {
      setProgress("");
    }
  }

  async function close(p: SelfPosition) {
    setError("");
    setDone("");
    try {
      setProgress("Preparing the transactions to close it…");
      const prepared = await api<SelfPrepared>(`/api/self/arc/positions/${p.id}/close/prepare`, {});
      const hashes = await signAll(prepared.steps, p.wallet, "Closing");
      setProgress("Waiting for Arc to confirm, and checking Aqua…");
      await api(`/api/self/arc/positions/${p.id}/close/record`, { txHashes: hashes });
      setDone("Closed. The position no longer holds anything in Aqua.");
      await Promise.all([address ? loadWallet(address) : Promise.resolve(), loadPositions()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setProgress("");
    }
  }

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
  const valid = Boolean(walletData) && amount >= 5 && amount <= cap && !busy;
  const mine = positions.filter((p) => p.status === "open");

  return (
    <div className="self-panel">
      <h3>Sign with your own wallet</h3>
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        Your wallet is the liquidity provider. Your tokens stay in it, you sign every transaction, and nothing goes through the Takarabako box or treasury.
      </p>

      <div className="self-wallets" role="radiogroup" aria-label="Wallet to sign with">
        {wallets.wallets.map((w) => (
          <button key={w.address} type="button" role="radio" aria-checked={w.address.toLowerCase() === address?.toLowerCase()} className={w.address.toLowerCase() === address?.toLowerCase() ? "is-on" : ""} onClick={() => setChosen(w.address)} disabled={busy}>
            <b>{w.name}</b>
            <span className="mono small">{short(w.address)}</span>
          </button>
        ))}
        <button type="button" className="self-connect" onClick={wallets.connectExternal} disabled={busy}>
          <b>Use MetaMask or another wallet</b>
          <span className="muted small">Connect it, then pick it here</span>
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
          <div><dt>USDC</dt><dd>{num(walletData.usdc, 2)}</dd></div>
          <div><dt>WETH</dt><dd>{num(walletData.weth, 6)}</dd></div>
          <div><dt>For network fees</dt><dd>{num(walletData.gasUsdc, 2)} USDC</dd></div>
        </dl>
      ) : (
        <p className="muted small">Loading this wallet on {network.name}…</p>
      )}
      <p className="row" style={{ margin: "8px 0 0", gap: 8 }}>
        <button type="button" className="btn btn-ghost small" onClick={copy}>{copied ? "Copied" : "Copy address"}</button>
        {empty && <span className="muted small">Send USDC and WETH on {network.name} to this address first. Arc pays network fees in USDC.</span>}
      </p>

      <div className="self-modes" role="radiogroup" aria-label="Strategy">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? "is-on" : ""} onClick={() => setMode(m.id)} disabled={busy}>
            <b>{m.name}</b>
            <span className="muted small">{m.hint}</span>
          </button>
        ))}
      </div>

      <div className="self-amount">
        <label className="label" htmlFor="self-amount">Amount (USD, from your wallet&apos;s USDC and WETH)</label>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input id="self-amount" className="input" type="number" min={5} max={cap} step="1" value={Number.isFinite(amount) ? amount : ""} onChange={(e) => setAmount(Number(e.target.value))} disabled={busy} />
          <span className="muted small">at least $5, at most {usd(cap, 0)} for now</span>
        </div>
      </div>

      <button type="button" className="btn btn-gold btn-block" disabled={!valid} onClick={open}>
        {busy ? "Working…" : `Open ${usd(amount, 0)} · ${MODE_NAME[mode]}`}
      </button>
      {busy && <p className="notice pending self-progress" role="status">{progress}</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {done && !busy && <div className="notice success" role="status">{done}</div>}

      {mine.length > 0 && (
        <>
          <h3>Your positions on {network.name}</h3>
          <ul className="self-list">
            {mine.map((p) => {
              const signer = wallets.wallets.find((w) => w.address.toLowerCase() === p.wallet.toLowerCase());
              return (
                <li key={p.id}>
                  <div className="spread">
                    <b>{MODE_NAME[p.mode]}</b>
                    <span className="pill ok">Open</span>
                  </div>
                  <p className="muted small" style={{ margin: "4px 0" }}>
                    {p.valueUsd === null ? "Value unavailable right now" : `${usd(p.valueUsd)} now`} · put in {usd(p.amountUsd, 0)} · {num(p.weth, 6)} WETH + {num(p.usdc, 2)} USDC held in Aqua
                    {p.priceMin !== null && p.priceMax !== null ? ` · ${usd(p.priceMin, 0)} – ${usd(p.priceMax, 0)}` : " · full range"} · wallet {short(p.wallet)}
                  </p>
                  <p className="small" style={{ margin: "0 0 8px" }}>
                    {(p.openTxs ?? []).map((h) => (
                      <a key={h} className="mono" href={`${network.explorerUrl}/tx/${h}`} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>{shortHex(h)}</a>
                    ))}
                  </p>
                  <button type="button" className="btn btn-ghost small" disabled={busy || !signer} onClick={() => close(p)}>Close position</button>
                  {!signer && <span className="muted small"> Connect wallet {short(p.wallet)} to close it.</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {confirming && (
        <ConfirmRealMoney
          title="Open a position from your own wallet?"
          confirmLabel="Confirm and sign"
          summary={`${usd(amount, 0)} as ${MODE_NAME[mode]} from ${current.name} (${short(current.address)})`}
          network={network.name}
          risks={RISKS}
          onResult={confirming}
        />
      )}
    </div>
  );
}
