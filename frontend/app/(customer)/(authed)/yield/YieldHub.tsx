"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChainBalance, LiquidityRequest, Market, PositionView, Preview, RiskTier } from "@/lib/types";
import type { NetworkInfo, NetworksResponse } from "@/lib/networks";
import type { SelfPosition } from "@/lib/selfCustody";
import { addressUrl, usd } from "@/lib/format";
import { aquaBalance } from "@/lib/boxes";
import { useNetwork } from "@/components/NetworkProvider";
import { TreasureStage } from "@/components/treasure/TreasureStage";
import { useStageDirector } from "@/components/treasure/useStageDirector";
import { Advanced } from "./Advanced";
import { MarketHero } from "./MarketHero";
import { NetworkSwitcher } from "./NetworkSwitcher";
import { PositionRange } from "./PositionRange";
import { SelfCustodyPanel, type PairChart, type WalletSummary } from "./SelfCustodyPanel";
import { StrategyTabs } from "./StrategyTabs";
import { ConfirmRealMoney } from "./RealMoney";
import { QuickStart } from "./QuickStart";

// The bubble keeps to a sentence or two; the full rationale is shown below.
const bubble = (text: string) => (text.length > 170 ? `${text.slice(0, 167).trimEnd()}…` : text);

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("log in first"), { status: 401 });
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "request failed");
  return json as T;
}

const previewBox = (req: LiquidityRequest) => postJson<Preview>("/api/yield/preview", req);

/// The yield page, for the network picked in the top bar. Every network has the same layout. On the network
/// the backend runs on, a position can be paid for from the box or signed from the customer's own wallet;
/// elsewhere only from a wallet, and where there is no wallet flow the page is a preview.
export function YieldHub({ networks, ...rest }: { networks: NetworksResponse; balance: number; market: Market; positions: PositionView[] }) {
  const selected = useNetwork();
  const view = networks.networks.find((n) => n.key === selected?.view)?.key ?? networks.active;
  const info = networks.networks.find((n) => n.key === view)!;
  const live = networks.networks.find((n) => n.active)!;
  const where = info.active
    ? `Yield runs on ${info.name}, so it uses your ${info.name} box.`
    : info.selfCustody
      ? `On ${info.name} you sign with your own wallet.`
      : `${info.name} is a preview. Your box is on ${live.name}.`;
  return (
    <>
      <p className="muted">Earn trading fees with 1inch Aqua. {where}</p>
      {view === networks.active ? (
        <YieldHubBody {...rest} walletNetwork={info.selfCustody ? info : undefined} />
      ) : (
        <OtherNetworkBody key={info.key} info={info} market={rest.market} live={live} onBack={() => selected?.setView(live.key)} />
      )}
      <NetworkSwitcher networks={networks} view={view} market={rest.market} />
    </>
  );
}

/// A network the customer's box is not on: the same page, with their wallet in place of the box.
function OtherNetworkBody({ info, market, live, onBack }: { info: NetworkInfo; market: Market; live: NetworkInfo; onBack: () => void }) {
  const [summary, setSummary] = useState<WalletSummary>({ usd: null, gems: [] });
  const [chart, setChart] = useState<PairChart | null>(null);
  const shown = chart?.market ?? market;
  const { stage } = useStageDirector(info.selfCustody ? "Pick a strategy and sign with your own wallet." : `Just looking here. Your box is on ${live.name}.`);
  const showEstimates = market.showEstimates !== false && !info.real;
  const readOnly = { label: `Back to ${live.name} to open a position`, onClick: onBack };
  return (
    <>
      <TreasureStage {...stage} balance={summary.usd ?? 0} gems={summary.gems} height={240} />
      <MarketHero
        spot={shown.spot}
        candles={shown.candles}
        balance={summary.usd ?? 0}
        balanceLabel="Your wallet"
        bestApyBps={Math.max(...market.tiers.map((t) => t.apyBps), market.advanced.apyEstBps)}
        showEstimates={showEstimates && !chart?.stable}
        feeBps={shown.advanced.feeBps}
        liveCount={summary.gems.length}
        symbols={chart?.symbols}
        priceDigits={chart?.stable ? 4 : 2}
      />
      {info.selfCustody ? (
        <SelfCustodyPanel network={info} market={market} onSummary={setSummary} onPair={setChart} />
      ) : (
        <StrategyTabs
          quick={
            <QuickStart
              tiers={market.tiers}
              candles={market.candles}
              spot={market.spot}
              balance={0}
              limits={{ lo: market.advanced.minPrice, hi: market.advanced.maxPrice }}
              previewLiquidity={previewBox}
              showEstimates={showEstimates}
              readOnly={readOnly}
              onOpen={async () => {}}
            />
          }
          advanced={<Advanced market={market} balance={0} preview={previewBox} showEstimates={showEstimates} readOnly={readOnly} onOpen={async () => {}} />}
        />
      )}
    </>
  );
}

function YieldHubBody({ balance, market, positions: initialPositions, walletNetwork }: { balance: number; market: Market; positions: PositionView[]; walletNetwork?: NetworkInfo }) {
  const router = useRouter();
  const [source, setSource] = useState<"box" | "wallet">("box");
  // The wallet view only appears once asked for, since it asks the wallet to switch networks. After that
  // it stays mounted, so moving away never loses a signature in progress or a position still being recorded.
  const [walletShown, setWalletShown] = useState(false);
  const [walletOpen, setWalletOpen] = useState(0);
  const [walletUsd, setWalletUsd] = useState<number | null>(null);
  // While paying from the wallet, the chart follows the pair chosen there.
  const [walletChart, setWalletChart] = useState<PairChart | null>(null);
  const fromWallet = source === "wallet";
  const shown = (fromWallet ? walletChart?.market : undefined) ?? market;
  const [positions, setPositions] = useState(initialPositions);
  const [box, setBox] = useState(balance);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; tag?: string; rationale?: string | null } | null>(null);
  const open = positions.filter((p) => p.status !== "closed"); // a closing one stays here until it is finished
  const { stage, say } = useStageDirector(
    box > 0 ? "Quick start picks a range for you — or go Advanced and draw your own." : "Your box is empty. Feed me a note at the kiosk first!",
  );
  // On a real-money network every open asks first; resolves false if the customer cancels.
  const real = market.realMoney === true;
  const showEstimates = market.showEstimates !== false;
  const [pending, setPending] = useState<{ summary: string; resolve: (ok: boolean) => void } | null>(null);
  const confirmReal = (summary: string) =>
    real ? new Promise<boolean>((resolve) => setPending({ summary, resolve })) : Promise.resolve(true);
  const gems = open.map((p) => ({ id: p.id, riskTier: (p.mode === "advanced" ? "high" : p.mode) as RiskTier, apyBps: p.apyEstBps }));

  const refresh = useCallback(async () => {
    const [pos, me] = await Promise.all([fetch("/api/yield/positions"), fetch("/api/me")]);
    if (pos.ok) setPositions(((await pos.json()) as { positions: PositionView[] }).positions);
    // Yield runs on the chain 1inch Aqua is on, so it draws on that chain's box.
    if (me.ok) setBox(aquaBalance(((await me.json()) as { balances: ChainBalance[] }).balances, market.network?.key));
  }, [market.network?.key]);

  // Wallet positions live behind the switch, so it says when there are some.
  const onWalletSummary = useCallback((s: WalletSummary) => {
    setWalletOpen(s.gems.length);
    setWalletUsd(s.usd);
  }, []);
  const walletKey = walletNetwork?.key;
  useEffect(() => {
    if (!walletKey) return;
    let cancelled = false;
    fetch(`/api/self/${walletKey}/positions`)
      .then((r) => (r.ok ? (r.json() as Promise<{ positions: SelfPosition[] }>) : null))
      .then((r) => r && !cancelled && setWalletOpen(r.positions.filter((p) => p.status === "open" || p.partial).length))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [walletKey]);

  const onFail = (e: unknown) => {
    if ((e as { status?: number }).status === 401) return router.replace("/login");
    setError(e instanceof Error ? e.message : "something went wrong");
    say("Hmm, that didn't work. Try again?", "worried");
  };

  const onOpened = async (label: string, body: { name?: string; rationale?: string | null }) => {
    setNotice({ text: `${label} position opened`, tag: body.name, rationale: body.rationale });
    say(bubble(body.rationale ?? `Done! Your ${label} position is live on 1inch Aqua.`), "happy", 0);
    await refresh();
    router.refresh();
  };

  async function close(p: PositionView) {
    setError("");
    try {
      const r = await postJson<{ value: number; closeTx: string | null }>(`/api/yield/positions/${p.id}/close`, {});
      setNotice({ text: `Closed — ${usd(r.value)} is back in your box` });
      say(`${usd(r.value)} back in the box!`, "happy");
      await refresh();
      router.refresh();
    } catch (e) {
      onFail(e);
    }
  }

  return (
    <>
      <TreasureStage {...stage} balance={box} gems={gems} height={240} />
      <MarketHero
        spot={shown.spot}
        candles={shown.candles}
        balance={fromWallet ? (walletUsd ?? 0) : box}
        balanceLabel={fromWallet ? "Your wallet" : "Your box"}
        bestApyBps={Math.max(...market.tiers.map((t) => t.apyBps), market.advanced.apyEstBps)}
        showEstimates={showEstimates && !(fromWallet && walletChart?.stable)}
        feeBps={shown.advanced.feeBps}
        liveCount={fromWallet ? walletOpen : open.length}
        symbols={fromWallet ? walletChart?.symbols : undefined}
        priceDigits={fromWallet && walletChart?.stable ? 4 : 2}
      />
      {error && <div className="notice error">{error}</div>}
      {notice && (
        <div className="notice success">
          {notice.text}
          {notice.tag && <div className="account-label small">{notice.tag}</div>}
          {notice.rationale && <p className="speech small" style={{ margin: "8px 0 0" }}>{notice.rationale}</p>}
        </div>
      )}

      {open.length > 0 && (
        <PositionsList
          positions={open}
          onClose={close}
        />
      )}

      {walletNetwork && (
        <div className="pay-from" role="radiogroup" aria-label="Pay from">
          <span className="label">Pay from</span>
          <button type="button" role="radio" aria-checked={source === "box"} className={source === "box" ? "is-on" : ""} onClick={() => setSource("box")}>
            <b>Your box</b>
            <span className="muted small">{usd(box)}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={source === "wallet"}
            className={source === "wallet" ? "is-on" : ""}
            onClick={() => {
              setSource("wallet");
              setWalletShown(true);
            }}
          >
            <b>Your wallet</b>
            <span className="muted small">{walletOpen > 0 ? `${walletOpen} open` : "You sign"}</span>
          </button>
        </div>
      )}

      <div hidden={source !== "box"}>
        <StrategyTabs
          quick={
            <QuickStart
              tiers={market.tiers}
              candles={market.candles}
              spot={market.spot}
              balance={box}
              limits={{ lo: market.advanced.minPrice, hi: market.advanced.maxPrice }}
              previewLiquidity={previewBox}
              showEstimates={showEstimates}
              confirm={confirmReal}
              onOpen={async (tier, amount) => {
                setError("");
                say(`Placing your ${tier}-risk strategy on 1inch Aqua…`, "thinking", 0);
                try {
                  const body = await postJson<{ name: string; rationale: string; pair: string }>("/api/yield", { riskLevel: tier, amount });
                  await onOpened(market.tiers.find((t) => t.riskTier === tier)?.label ?? tier, body);
                } catch (e) {
                  onFail(e);
                }
              }}
            />
          }
          advanced={
            <Advanced
              market={market}
              balance={box}
              preview={previewBox}
              confirm={confirmReal}
              showEstimates={showEstimates}
              onOpen={async ({ label, ...req }) => {
                setError("");
                say("Shipping your strategies to 1inch Aqua…", "thinking", 0);
                try {
                  const body = await postJson<{ name: string }>("/api/yield/advanced", req);
                  await onOpened(`Advanced ${label}`, body);
                } catch (e) {
                  onFail(e);
                }
              }}
            />
          }
        />
      </div>

      {walletNetwork && walletShown && (
        <div hidden={source !== "wallet"}>
          <SelfCustodyPanel network={walletNetwork} market={market} onSummary={onWalletSummary} onPair={setWalletChart} />
        </div>
      )}

      {pending && (
        <ConfirmRealMoney
          summary={pending.summary}
          network={market.network?.name ?? "this network"}
          onResult={(ok) => {
            pending.resolve(ok);
            setPending(null);
          }}
        />
      )}
    </>
  );
}

function PositionsList({
  positions,
  onClose,
}: {
  positions: PositionView[];
  onClose: (p: PositionView) => Promise<void>;
}) {
  const [closing, setClosing] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>Your strategies</h2>
      <ul className="pos-list">
        {positions.map((p) => {
          const pnl = p.pnlUsd ?? 0;
          const hasRange = p.priceMin !== null && p.priceMax !== null;
          return (
            <li key={p.id}>
              <div className="spread">
                <b>{p.label}</b>
                {p.status === "closing" ? (
                  <span className="pill warn">Closing · not finished</span>
                ) : (
                  <span className={`pill ${p.inRange ? "ok" : "warn"}`}>{p.inRange ? "Earning · in range" : "Out of range"}</span>
                )}
              </div>
              <div className="spread pos-numbers">
                <span className="amount">{usd(p.valueUsd)}</span>
                <span className={`small ${pnl >= 0 ? "tone-ok" : "tone-bad"}`}>
                  {pnl >= 0 ? "+" : "−"}{usd(Math.abs(pnl), 4)} since opening
                </span>
              </div>
              {hasRange ? <PositionRange min={p.priceMin!} max={p.priceMax!} spot={p.spot} /> : null}
              {p.status === "closing" && (
                <p className="muted small" style={{ margin: "6px 0 0" }}>
                  Stopped part-way. Press Finish closing.
                </p>
              )}
              <p className="muted small" style={{ margin: "6px 0 8px" }}>
                {hasRange ? `${usd(p.priceMin, 0)} – ${usd(p.priceMax, 0)}` : "Full range"} · ETH {usd(p.spot, 0)}
              </p>
              <div className="row">
                <button
                  className="btn btn-ghost small"
                  disabled={closing === p.id}
                  onClick={async () => {
                    setClosing(p.id);
                    await onClose(p);
                    setClosing(null);
                  }}
                >
                  {closing === p.id ? "Closing…" : p.status === "closing" ? "Finish closing" : "Close & return to box"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Runs on <a href={addressUrl("0x1111113ccf1426a8e30e2bff5e005d929bf6a90a")} target="_blank" rel="noreferrer">1inch Aqua ↗</a>
      </p>
    </section>
  );
}
