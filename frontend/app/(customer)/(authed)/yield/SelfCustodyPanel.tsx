"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NetworkInfo } from "@/lib/networks";
import type { Market, Preview, PreviewBin } from "@/lib/types";
import type { DashOutPrepared, SelfMarket, SelfPosition, SelfPrepared, SelfShape, SelfStep, SelfWallet } from "@/lib/selfCustody";
import { shortHex, usd } from "@/lib/format";
import { useArcWallets, type ArcWalletsApi } from "@/lib/useArcWallets";
import { ConfirmRealMoney } from "./RealMoney";
import { DashOut } from "./DashOut";
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
  { id: "full", name: "Full range", hint: "Always earning, smallest swings", shape: "full" },
  { id: "balanced", name: "Balanced ±25%", hint: "More fees within ±25%", shape: "spot", lo: 0.75, hi: 1.25 },
  { id: "bold", name: "Bold ±8%", hint: "Most fees, stops if price leaves", shape: "spot", lo: 0.92, hi: 1.08 },
  { id: "hybrid", name: "Hybrid", hint: "Tight core + safety net", shape: "hybrid", lo: 0.5, hi: 2 },
];

/// A stable pair (EURC/USDC) trades within a few percent of its price, so its strategies are narrow.
const STABLE_PRESETS: Array<{ id: string; name: string; hint: string; shape: SelfShape; lo?: number; hi?: number }> = [
  { id: "tight", name: "Tight ±0.5%", hint: "Most fees if price holds", shape: "spot", lo: 0.995, hi: 1.005 },
  { id: "balanced", name: "Balanced ±1.5%", hint: "Core with room to drift", shape: "curve", lo: 0.985, hi: 1.015 },
  { id: "wide", name: "Wide ±5%", hint: "Survives bigger moves", shape: "spot", lo: 0.95, hi: 1.05 },
];

const SHAPES: Array<{ id: SelfShape; name: string; hint: string }> = [
  { id: "spot", name: "Spot", hint: "Even across the range" },
  { id: "curve", name: "Curve", hint: "Most near today's price" },
  { id: "bidask", name: "Bid-Ask", hint: "Most at the edges" },
  { id: "hybrid", name: "Hybrid", hint: "Core + safety net" },
  { id: "full", name: "Full range", hint: "Every price" },
];
const SHAPE_NAME = Object.fromEntries(SHAPES.map((s) => [s.id, s.name])) as Record<SelfShape, string>;

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

/// The version that signs with the customer's Privy wallets (embedded and connected).
export function SelfCustodyPanel({ network, market }: { network: NetworkInfo; market: Market }) {
  const wallets = useArcWallets(network.chainId);
  return <SelfCustodyView network={network} market={market} wallets={wallets} />;
}

/// A market for a non-default pair, in the shape the panel already uses (its tiers are ETH's, so none).
const toMarket = (m: SelfMarket): Market => ({ spot: m.spot, candles: m.candles, tiers: [], advanced: { minPrice: m.advanced.minPrice, maxPrice: m.advanced.maxPrice, feeBps: m.advanced.feeBps, apyEstBps: 0, bins: m.advanced.bins } });

/// The panel with its wallets passed in, so it can be exercised without Privy. A chain can offer several
/// pairs (a base token against USDC, the token every position exits to): the customer picks one, and each
/// pair is its own view, so its range, shape and preview start fresh.
export function SelfCustodyView({ network, market, wallets }: { network: NetworkInfo; market: Market; wallets: ArcWalletsApi }) {
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
  const pairView = isDefault ? market : loaded?.data ? toMarket(loaded.data) : null;
  const names = current?.symbols ?? (network.key === "sepolia" ? { base: "mETH", quote: "mUSDC" } : { base: "WETH", quote: "USDC" });

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
        <PairView key={current?.key ?? "default"} network={network} market={pairView} wallets={wallets} pair={{ key: isDefault ? undefined : current?.key, symbols: names, stable: Boolean(current?.stable) }} />
      ) : loaded?.error ? (
        <div className="notice error">{loaded.error}</div>
      ) : (
        <p className="muted small">Loading the {names.base}/{names.quote} price…</p>
      )}
    </>
  );
}

/// One pair's panel: wallet, strategies, chart, positions and Dash out.
function PairView({ network, market, wallets, pair }: { network: NetworkInfo; market: Market; wallets: ArcWalletsApi; pair: { key: string | undefined; symbols: { base: string; quote: string }; stable: boolean } }) {
  const [chosen, setChosen] = useState<string | null>(null);
  // /api/self/arc or /api/self/sepolia: the backend serves the same flow per chain.
  const base = `/api/self/${network.key}`;
  // which pair the wallet and the new position are for (none: the chain's default)
  const pairQ = pair.key ? `&pair=${encodeURIComponent(pair.key)}` : "";
  const presets = pair.stable ? STABLE_PRESETS : PRESETS;
  // a pair priced near $1 (EURC) needs decimals in its prices: whole dollars would read "$1 and $1"
  const pd = pair.stable ? 4 : 0;
  const startPreset = presets.find((p) => p.id === (pair.stable ? "balanced" : "hybrid"))!;
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
  const [presetId, setPresetId] = useState(startPreset.id); // "custom" once the range or shape is edited
  const [basePreset, setBasePreset] = useState(startPreset.id);
  const [shape, setShape] = useState<SelfShape>(startPreset.shape);
  const [range, setRange] = useState({ min: spot * (startPreset.lo ?? 0.5), max: spot * (startPreset.hi ?? 2) });
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
  // An instant exit being confirmed: the position, and the answer to the dialog.
  const [exitFor, setExitFor] = useState<null | { p: SelfPosition; resolve: (ok: boolean) => void }>(null);
  const [copied, setCopied] = useState(false);
  // An open that was signed and sent but not yet confirmed by the backend: the tokens may already be in the position.
  const [unrecorded, setUnrecorded] = useState<null | { positionId: string; hashes: string[] }>(null);
  const busy = progress !== "";
  const walletData = wallet && wallet.forAddress === address ? wallet.data : null;
  const sym = walletData?.symbols ?? pair.symbols;

  function choosePreset(id: string) {
    const p = presets.find((x) => x.id === id)!;
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
      api<Preview>(`${base}/preview`, { ...(pair.key ? { pair: pair.key } : {}), amount: amount >= 5 ? amount : 100, shape, priceMin: range.min, priceMax: range.max })
        .then((p) => {
          if (id !== seq.current) return;
          setPreview(p);
          setPreviewError("");
        })
        .catch((e) => id === seq.current && setPreviewError(e instanceof Error ? e.message : "could not draw the liquidity"));
    }, 250);
    return () => clearTimeout(t);
  }, [full, shape, range.min, range.max, amount, base, pair.key]);
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

  const label = full ? "Full range" : `${SHAPE_NAME[shape]} ${usd(range.min, pd)} – ${usd(range.max, pd)}`;

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
      prepared = await api<SelfPrepared>(`${base}/prepare`, { ...(pair.key ? { pair: pair.key } : {}), shape, ...(full ? {} : { priceMin: range.min, priceMax: range.max }), amount, wallet: address });
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

  /// Instant exit to the quote token: closes the position, then sells the base token it handed back for USDC
  /// (Dash out). They are two steps in order, not one transaction: what the close pays is only known once it
  /// has happened, and the sale is sized from it. If no fair price is available the position is still closed
  /// and the customer keeps the base token, which Dash out can sell later.
  async function exitToQuote(p: SelfPosition) {
    setError("");
    setDone("");
    const sy = p.symbols ?? pair.symbols;
    const ok = await new Promise<boolean>((resolve) => setExitFor({ p, resolve }));
    setExitFor(null);
    if (!ok) return;
    try {
      setProgress("Preparing the transactions to close it…");
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
    // Closed. Now sell what it handed back: the position's base token, never more than the wallet holds.
    try {
      setProgress(`Closed. Finding the best price for your ${sy.base}…`);
      const dash = await api<DashOutPrepared>(`${base}/dashout/prepare`, { wallet: p.wallet, ...(p.pair ? { pair: p.pair } : {}), amount: p.weth.toFixed(18) });
      for (const [i, st] of dash.steps.entries()) {
        setProgress(`Selling ${sy.base}: signing ${i + 1} of ${dash.steps.length}. ${st.description}`);
        await wallets.sign({ to: st.to, data: st.data, chainId: st.chainId, maxFeePerGas: st.maxFeePerGas, maxPriorityFeePerGas: st.maxPriorityFeePerGas }, p.wallet, st.description);
      }
      setDone(`Exited to ${sy.quote}: the position is closed and ${num(dash.quote.amountIn, 6)} ${sy.base} was sold for about ${num(dash.quote.amountOut, 2)} ${sy.quote} (at least ${num(dash.minOut, 2)} guaranteed).`);
    } catch (e) {
      setDone(`The position is closed and everything it held is in your wallet. Selling the ${sy.base} for ${sy.quote} did not happen: ${e instanceof Error ? e.message : "something went wrong"}. You can try Dash out again below.`);
    } finally {
      setProgress("");
      if (address) await loadWallet(address);
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
  const mine = positions.filter((p) => p.status === "open" || p.partial);

  return (
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

      <h3>Pick a strategy</h3>
      <div className="self-modes" role="radiogroup" aria-label="Strategy">
        {presets.map((p) => (
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
            symbols={sym}
            priceDigits={pair.stable ? 4 : 0}
          />
        ) : (
          <div style={{ height: 356 }} aria-hidden="true" />
        )}
        <p className="muted small self-chart-note">
          {previewError
            ? previewError
            : full
              ? "Every price."
              : `${usd(range.min, pd)} – ${usd(range.max, pd)}.`}
          {" "}
          {bins.length > 0 && `Now ${num(100 - ethShare, 0)}% ${sym.quote}, ${num(ethShare, 0)}% ${sym.base}.`}
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
              Reset to {presets.find((p) => p.id === basePreset)?.name}
            </button>
          )}
        </div>
      </div>

      <div className="self-amount">
        <label className="label" htmlFor="self-amount">Amount (USD)</label>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input id="self-amount" className="input" type="number" min={5} max={cap} step="1" value={Number.isFinite(amount) ? amount : ""} onChange={(e) => setAmount(Number(e.target.value))} disabled={busy} />
          <span className="muted small">$5 – {usd(cap, 0)}</span>
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
                    {p.partial ? <span className="pill bad">Partly opened</span> : <span className="pill ok">Open</span>}
                  </div>
                  {p.partial && (
                    <p className="notice warn small" style={{ margin: "6px 0" }}>
                      Signing stopped partway. Closing removes the live part.
                    </p>
                  )}
                  <p className="muted small" style={{ margin: "4px 0" }}>
                    {p.valueUsd === null ? "Value unavailable right now" : `${usd(p.valueUsd)} now`} · put in {usd(p.amountUsd, 0)} · {num(p.weth, 6)} {(p.symbols ?? sym).base} + {num(p.usdc, 2)} {(p.symbols ?? sym).quote} {p.manager ? "held by the position contract in Aqua" : "held in Aqua"}
                    {p.priceMin !== null && p.priceMax !== null ? ` · ${usd(p.priceMin, p.priceMax < 10 ? 4 : 0)} – ${usd(p.priceMax, p.priceMax < 10 ? 4 : 0)}` : " · full range"} · wallet {short(p.wallet)}
                  </p>
                  <p className="small" style={{ margin: "0 0 8px" }}>
                    {(p.openTxs ?? []).map((h) => (
                      <a key={h} className="mono" href={`${network.explorerUrl}/tx/${h}`} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>{shortHex(h)}</a>
                    ))}
                  </p>
                  <button type="button" className="btn btn-ghost small" disabled={busy || !signer} onClick={() => close(p)}>{p.partial ? "Close the live part" : "Close position"}</button>
                  {!p.partial && p.weth > 0 && (
                    <button type="button" className="btn btn-gold small" style={{ marginLeft: 8 }} disabled={busy || !signer} onClick={() => exitToQuote(p)} title={`Close it and sell the ${(p.symbols ?? pair.symbols).base} for ${(p.symbols ?? pair.symbols).quote}`}>
                      Exit to {(p.symbols ?? pair.symbols).quote}
                    </button>
                  )}
                  {!signer && <span className="muted small"> Connect wallet {short(p.wallet)} to close it.</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {exitFor && (
        <ConfirmRealMoney
          title={`Exit to ${(exitFor.p.symbols ?? pair.symbols).quote}?`}
          confirmLabel="Confirm and sign"
          summary={`Close your ${SHAPE_NAME[exitFor.p.mode] ?? exitFor.p.mode} position (${usd(exitFor.p.valueUsd ?? exitFor.p.amountUsd)}) and sell the ${(exitFor.p.symbols ?? pair.symbols).base} it holds (${num(exitFor.p.weth, 6)}) for ${(exitFor.p.symbols ?? pair.symbols).quote}, from ${short(exitFor.p.wallet)}`}
          network={network.name}
          risks={[
            "Two signatures: the position closes (final), then the base token is sold.",
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
          summary={`${usd(amount, 0)} as ${label} from ${current.name} (${short(current.address)})`}
          network={network.name}
          risks={viaContract ? RISKS_CONTRACT : RISKS}
          onResult={confirming}
        />
      )}
    </div>
  );
}
