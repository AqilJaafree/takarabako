"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NetworkInfo } from "@/lib/networks";
import type { Market, Preview, PreviewBin } from "@/lib/types";
import type { SelfPosition, SelfPrepared, SelfShape, SelfStep, SelfWallet } from "@/lib/selfCustody";
import { shortHex, usd } from "@/lib/format";
import { useArcWallets, type ArcWalletsApi } from "@/lib/useArcWallets";
import { ConfirmRealMoney } from "./RealMoney";
import { RangeChart } from "./RangeChart";

/// Open and close Aqua positions with the customer's own wallet, on Arc mainnet or (for testing)
/// Sepolia. Where a position manager contract is deployed (Sepolia), one transaction opens a
/// position and one closes it, and the tokens sit in the contract while it is open; elsewhere the
/// wallet is the Aqua maker, the tokens never leave it and each strategy is signed separately. The
/// wallet can be the Takarabako wallet or one they connect, such as MetaMask; opening this view
/// asks that wallet to switch to the chain. The chart
/// draws the chosen strategy's liquidity over the live candles (USDC below the
/// price, ETH above), and the range and shape can be changed. The backend only
/// prepares the transactions and checks the result.

/// Ready-made strategies: choosing one sets the shape and range the chart draws.
const PRESETS: Array<{ id: string; name: string; hint: string; shape: SelfShape; lo?: number; hi?: number }> = [
  { id: "full", name: "Full range", hint: "Earns on every trade and swings the least", shape: "full" },
  { id: "balanced", name: "Balanced ±25%", hint: "More fees while ETH stays within 25% of today's price", shape: "spot", lo: 0.75, hi: 1.25 },
  { id: "bold", name: "Bold ±8%", hint: "Most fees while the price holds, and nothing once it leaves", shape: "spot", lo: 0.92, hi: 1.08 },
  { id: "hybrid", name: "Hybrid", hint: "A tight core near today's price plus the whole range as a safety net", shape: "hybrid", lo: 0.5, hi: 2 },
];

const SHAPES: Array<{ id: SelfShape; name: string; hint: string }> = [
  { id: "spot", name: "Spot", hint: "Even across the range" },
  { id: "curve", name: "Curve", hint: "Most near today's price" },
  { id: "bidask", name: "Bid-Ask", hint: "Most at the edges" },
  { id: "hybrid", name: "Hybrid", hint: "A tight core plus the whole range" },
  { id: "full", name: "Full range", hint: "Every price" },
];
const SHAPE_NAME = Object.fromEntries(SHAPES.map((s) => [s.id, s.name])) as Record<SelfShape, string>;

const RISKS_CONTRACT = [
  "While the position is open your tokens are held by the Takarabako position contract, together with other people's positions, not by your wallet. The contract has no owner, admin or upgrade and only you can close your position, but it is new software that has not been professionally audited, and a flaw in it or in 1inch Aqua could lose funds.",
  "The position's value follows ETH's price and can fall below what you put in. Earnings are trading fees, which depend on how much people trade. None is promised, and this is not insured or guaranteed.",
  "You sign every transaction yourself and pay network fees. Closing sends everything the position holds back to your wallet in one transaction.",
];

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
export function SelfCustodyPanel({ network, market }: { network: NetworkInfo; market: Market }) {
  const wallets = useArcWallets(network.chainId);
  return <SelfCustodyView network={network} market={market} wallets={wallets} />;
}

/// The panel with its wallets passed in, so it can be exercised without Privy.
export function SelfCustodyView({ network, market, wallets }: { network: NetworkInfo; market: Market; wallets: ArcWalletsApi }) {
  const [chosen, setChosen] = useState<string | null>(null);
  // /api/self/arc or /api/self/sepolia: the backend serves the same flow per chain.
  const base = `/api/self/${network.key}`;
  // Where a position manager is deployed, the tokens sit in that contract while a position is open.
  const viaContract = Boolean(network.selfManager);
  // The chart's coordinates come from floating-point maths that can differ in the last digits between the server and
  // the browser, so it is drawn only in the browser: the server HTML always matches.
  const inBrowser = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  // The Takarabako wallet unless the customer picked another one.
  const current = wallets.wallets.find((w) => w.address.toLowerCase() === chosen?.toLowerCase()) ?? wallets.wallets.find((w) => w.kind === "embedded") ?? wallets.wallets[0];
  const address = current?.address;
  const onArc = current?.onArc ?? false;

  const spot = market.spot;
  const limits = useMemo(() => ({ lo: market.advanced.minPrice, hi: market.advanced.maxPrice }), [market.advanced.minPrice, market.advanced.maxPrice]);

  // What the chart draws: a strategy to start from, then whatever the customer changes.
  const [presetId, setPresetId] = useState("hybrid"); // "custom" once the range or shape is edited
  const [basePreset, setBasePreset] = useState("hybrid");
  const [shape, setShape] = useState<SelfShape>("hybrid");
  const [range, setRange] = useState({ min: spot * 0.5, max: spot * 2 });
  const [amount, setAmount] = useState(25);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");

  const [wallet, setWallet] = useState<{ forAddress: string; data: SelfWallet } | null>(null);
  const [positions, setPositions] = useState<SelfPosition[]>([]);
  const [loadError, setLoadError] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [confirming, setConfirming] = useState<null | ((ok: boolean) => void)>(null);
  const [copied, setCopied] = useState(false);
  // An open that was signed and sent but not yet confirmed by the backend: the tokens may already be in the position.
  const [unrecorded, setUnrecorded] = useState<null | { positionId: string; hashes: string[] }>(null);
  const busy = progress !== "";
  const walletData = wallet && wallet.forAddress === address ? wallet.data : null;
  const sym = walletData?.symbols ?? (network.key === "sepolia" ? { base: "mETH", quote: "mUSDC" } : { base: "WETH", quote: "USDC" });

  function choosePreset(id: string) {
    const p = PRESETS.find((x) => x.id === id)!;
    setPresetId(id);
    setBasePreset(id);
    setShape(p.shape);
    if (p.lo !== undefined && p.hi !== undefined) setRange({ min: spot * p.lo, max: spot * p.hi });
  }
  function chooseShape(s: SelfShape) {
    setShape(s);
    setPresetId("custom");
    // coming from the full range, start the range around today's price
    if (shape === "full" && s !== "full") setRange({ min: spot * 0.75, max: spot * 1.25 });
  }
  function changeRange(min: number, max: number) {
    setRange({ min, max });
    setPresetId("custom");
  }

  // Liquidity for the chart: a full-range position is one block over the whole chart, the rest come from the backend's maths.
  const full = shape === "full";
  const fullBins = useMemo<PreviewBin[]>(
    () => [{ min: limits.lo, max: limits.hi, weight: 1, usd: amount, eth: amount / 2 / spot, usdc: amount / 2 }],
    [limits.lo, limits.hi, amount, spot],
  );
  const seq = useRef(0);
  useEffect(() => {
    if (full) return;
    const id = ++seq.current;
    const t = setTimeout(() => {
      api<Preview>("/api/yield/preview", { amount: amount >= 5 ? amount : 100, shape, priceMin: range.min, priceMax: range.max })
        .then((p) => {
          if (id !== seq.current) return;
          setPreview(p);
          setPreviewError("");
        })
        .catch((e) => id === seq.current && setPreviewError(e instanceof Error ? e.message : "could not draw the liquidity"));
    }, 250);
    return () => clearTimeout(t);
  }, [full, shape, range.min, range.max, amount]);
  const bins = full ? fullBins : (preview?.bins ?? []);
  const totals = bins.reduce((s, b) => ({ eth: s.eth + b.eth, usdc: s.usdc + b.usdc }), { eth: 0, usdc: 0 });
  const ethShare = totals.eth * spot + totals.usdc > 0 ? ((totals.eth * spot) / (totals.eth * spot + totals.usdc)) * 100 : 0;

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
      setWallet({ forAddress: a, data: await api<SelfWallet>(`${base}/wallet?address=${encodeURIComponent(a)}`) });
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not load your wallet");
    }
  }, [base]);

  // First loads (and again when another wallet is picked); loadWallet / loadPositions refresh after opening or closing.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    api<SelfWallet>(`${base}/wallet?address=${encodeURIComponent(address)}`)
      .then((data) => {
        if (cancelled) return;
        setWallet({ forAddress: address, data });
        setLoadError("");
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "could not load your wallet"));
    return () => {
      cancelled = true;
    };
  }, [address, base]);
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

  const label = full ? "Full range" : `${SHAPE_NAME[shape]} ${usd(range.min, 0)} – ${usd(range.max, 0)}`;

  /// Asks the backend to check the signed transactions on chain and open the position. Safe to repeat.
  async function finishOpen(positionId: string, hashes: string[]) {
    setProgress(`Waiting for ${network.name} to confirm, and checking Aqua…`);
    try {
      await api(`${base}/record`, { positionId, txHashes: hashes });
      setUnrecorded(null);
      setDone(viaContract ? `Your ${label} position is open. Your tokens are held by the position contract until you close it.` : `Your ${label} position is open. Your tokens are still in your wallet.`);
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

  async function open() {
    if (!address) return;
    setError("");
    setDone("");
    setUnrecorded(null);
    const ok = await new Promise<boolean>((resolve) => setConfirming(() => resolve));
    setConfirming(null);
    if (!ok) return;
    let prepared: SelfPrepared;
    let hashes: string[];
    try {
      setProgress("Checking your wallet and preparing the transactions…");
      prepared = await api<SelfPrepared>(`${base}/prepare`, { shape, ...(full ? {} : { priceMin: range.min, priceMax: range.max }), amount, wallet: address });
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
  const valid = Boolean(walletData) && amount >= 5 && amount <= cap && !busy && (full || bins.length > 0);
  const mine = positions.filter((p) => p.status === "open");

  return (
    <div className="self-panel">
      <h3>Sign with your own wallet</h3>
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        {viaContract
          ? "You sign everything from your own wallet: one transaction opens the position and one closes it. While it is open your tokens sit in the position contract, not in your wallet, and nothing goes through the Takarabako box or treasury."
          : "Your wallet is the liquidity provider. Your tokens stay in it, you sign every transaction, and nothing goes through the Takarabako box or treasury."}
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
          <div><dt>{sym.quote}</dt><dd>{num(walletData.usdc, 2)}</dd></div>
          <div><dt>{sym.base}</dt><dd>{num(walletData.weth, 6)}</dd></div>
          <div><dt>For network fees</dt><dd>{num(walletData.gas ?? walletData.gasUsdc, walletData.gasSymbol === "ETH" ? 5 : 2)} {walletData.gasSymbol ?? "USDC"}</dd></div>
        </dl>
      ) : (
        <p className="muted small">Loading this wallet on {network.name}…</p>
      )}
      <p className="row" style={{ margin: "8px 0 0", gap: 8 }}>
        <button type="button" className="btn btn-ghost small" onClick={copy}>{copied ? "Copied" : "Copy address"}</button>
        {empty && <span className="muted small">Send {sym.quote} and {sym.base} on {network.name} to this address first, plus {walletData?.gasSymbol ?? "USDC"} for network fees.</span>}
      </p>

      <h3>Pick a strategy, then shape it</h3>
      <div className="self-modes" role="radiogroup" aria-label="Strategy">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={presetId === p.id} className={presetId === p.id ? "is-on" : ""} onClick={() => choosePreset(p.id)} disabled={busy}>
            <b>{p.name}</b>
            <span className="muted small">{p.hint}</span>
          </button>
        ))}
      </div>

      <div className="self-chart">
        {inBrowser ? (
          <RangeChart
            candles={market.candles}
            spot={spot}
            min={full ? limits.lo : range.min}
            max={full ? limits.hi : range.max}
            limits={limits}
            bins={bins}
            onChange={changeRange}
            locked={full}
          />
        ) : (
          <div style={{ height: 356 }} aria-hidden="true" />
        )}
        <p className="muted small self-chart-note">
          {previewError
            ? previewError
            : full
              ? `Full range spreads your liquidity over every price, half in ${sym.base} and half in ${sym.quote}.`
              : `Your liquidity sits between ${usd(range.min, 0)} and ${usd(range.max, 0)}. Below today's price it holds ${sym.quote}, above it ${sym.base}.`}
          {" "}
          {bins.length > 0 && `At today's price that is ${num(100 - ethShare, 0)}% ${sym.quote} and ${num(ethShare, 0)}% ${sym.base}.`}
        </p>
      </div>

      <div className="self-shape">
        <span className="label">Liquidity shape</span>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="radiogroup" aria-label="Liquidity shape">
          {SHAPES.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={shape === s.id} title={s.hint} className={`chip btn btn-ghost small${shape === s.id ? " is-on" : ""}`} onClick={() => chooseShape(s.id)} disabled={busy}>
              {s.name}
            </button>
          ))}
          {presetId === "custom" && (
            <button type="button" className="link-btn" onClick={() => choosePreset(basePreset)} disabled={busy}>
              Reset to {PRESETS.find((p) => p.id === basePreset)?.name}
            </button>
          )}
        </div>
      </div>

      <div className="self-amount">
        <label className="label" htmlFor="self-amount">Amount (USD, from your wallet&apos;s {sym.quote} and {sym.base})</label>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input id="self-amount" className="input" type="number" min={5} max={cap} step="1" value={Number.isFinite(amount) ? amount : ""} onChange={(e) => setAmount(Number(e.target.value))} disabled={busy} />
          <span className="muted small">at least $5, at most {usd(cap, 0)} for now</span>
        </div>
      </div>

      <button type="button" className="btn btn-gold btn-block" disabled={!valid} onClick={open}>
        {busy ? "Working…" : `Open ${usd(amount, 0)} · ${label}`}
      </button>
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

      {mine.length > 0 && (
        <>
          <h3>Your positions on {network.name}</h3>
          <ul className="self-list">
            {mine.map((p) => {
              const signer = wallets.wallets.find((w) => w.address.toLowerCase() === p.wallet.toLowerCase());
              return (
                <li key={p.id}>
                  <div className="spread">
                    <b>{SHAPE_NAME[p.mode] ?? p.mode}</b>
                    <span className="pill ok">Open</span>
                  </div>
                  <p className="muted small" style={{ margin: "4px 0" }}>
                    {p.valueUsd === null ? "Value unavailable right now" : `${usd(p.valueUsd)} now`} · put in {usd(p.amountUsd, 0)} · {num(p.weth, 6)} {sym.base} + {num(p.usdc, 2)} {sym.quote} {p.manager ? "held by the position contract in Aqua" : "held in Aqua"}
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
          summary={`${usd(amount, 0)} as ${label} from ${current.name} (${short(current.address)})`}
          network={network.name}
          risks={viaContract ? RISKS_CONTRACT : RISKS}
          onResult={confirming}
        />
      )}
    </div>
  );
}
