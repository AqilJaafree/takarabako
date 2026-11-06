"use client";

import { useEffect, useState } from "react";
import type { Market, Preview } from "@/lib/types";
import type { ContractCheck, NetworkInfo, NetworkKey, NetworkStatus, NetworksResponse } from "@/lib/networks";
import { shortHex, usd } from "@/lib/format";
import { SelfCustodyPanel } from "./SelfCustodyPanel";

const ORIGIN: Record<string, string> = {
  sdk: "address from the official 1inch SDK",
  env: "address set in the app's settings",
  sepolia: "the Sepolia deployment (it has an earlier router than mainnet)",
};

const price = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));

/// Switches which network the yield page describes. It is a read-only view:
/// real positions are opened and closed on the network the backend runs on
/// (`networks.active`), so the controls below it only show for that one.
export function NetworkSwitcher({
  networks,
  view,
  onView,
  market,
}: {
  networks: NetworksResponse;
  view: NetworkKey;
  onView: (key: NetworkKey) => void;
  market: Market;
}) {
  const info = networks.networks.find((n) => n.key === view)!;
  const live = networks.networks.find((n) => n.active)!;
  const isLive = info.active;
  const panel = <NetworkPanel info={info} live={live} market={market} withSelf={!isLive} />;

  return (
    <section className="net-switch" aria-label="Network">
      <div className="yield-tabs net-tabs" role="tablist" aria-label="Network">
        {networks.networks.map((n) => (
          <button key={n.key} role="tab" aria-selected={view === n.key} className={view === n.key ? "is-on" : ""} onClick={() => onView(n.key)}>
            {n.name}
            <span className="muted small">{n.active ? (n.selfCustody ? "your positions · or sign with your wallet" : "your positions") : n.selfCustody ? "sign with your wallet" : n.key === "arc" ? "mainnet · view only" : "view only"}</span>
          </button>
        ))}
      </div>

      {isLive ? (
        <>
          {info.selfCustody && (
            <div className="card net-panel">
              <SelfCustodyPanel network={info} market={market} />
            </div>
          )}
          <details className="card net-panel">
            <summary>How it works on {info.name}</summary>
            {panel}
          </details>
        </>
      ) : (
        <div className="card net-panel">
          <div className="notice">
            You are looking at <b>{info.name}</b>
            {info.key === "arc" ? " (mainnet, real money)" : ""}.{" "}
            {info.selfCustody
              ? `Below you can open positions by signing with your own wallet. Your box and the positions the treasury manages live on ${live.name}.`
              : `This is a read-only view: nothing here sends a transaction. Your box and positions live on ${live.name}.`}{" "}
            <button type="button" className="link-btn" onClick={() => onView(live.key)}>
              Back to {live.name}
            </button>
          </div>
          {panel}
        </div>
      )}
    </section>
  );
}

function NetworkPanel({ info, live, market, withSelf }: { info: NetworkInfo; live: NetworkInfo; market: Market; withSelf: boolean }) {
  const [result, setResult] = useState<{ key: NetworkKey; status: NetworkStatus | null } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const status = result?.key === info.key ? result.status : undefined; // undefined = still checking
  const checking = status === undefined;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/networks/status?network=${info.key}`)
      .then((r) => (r.ok ? (r.json() as Promise<NetworkStatus>) : null))
      .catch(() => null)
      .then((s) => !cancelled && setResult({ key: info.key, status: s }));
    return () => {
      cancelled = true;
    };
  }, [info.key]);

  // The same example on every network: how a $1,000 Hybrid position splits at today's price.
  const lo = market.spot * 0.5;
  const hi = market.spot * 2;
  useEffect(() => {
    let cancelled = false;
    fetch("/api/yield/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 1000, shape: "hybrid", priceMin: lo, priceMax: hi }) })
      .then((r) => (r.ok ? (r.json() as Promise<Preview>) : null))
      .catch(() => null)
      .then((p) => !cancelled && setPreview(p));
    return () => {
      cancelled = true;
    };
  }, [lo, hi]);

  return (
    <div className="net-body">
      {withSelf && info.selfCustody && <SelfCustodyPanel network={info} market={market} />}
      <dl className="net-facts">
        <div><dt>Chain</dt><dd>{info.name} · id {info.chainId}</dd></div>
        <div><dt>Pays gas in</dt><dd>{info.nativeSymbol}</dd></div>
        <div><dt>Fee floor</dt><dd>{info.feeFloorGwei > 0 ? `${info.feeFloorGwei} gwei` : "none"}</dd></div>
        <div>
          <dt>Right now</dt>
          <dd>
            {checking ? "Checking…" : !status?.reachable ? <span className="pill bad">RPC unreachable</span> : (
              <>
                <span className={`pill ${status.chainIdOk ? "ok" : "bad"}`}>{status.chainIdOk ? "live" : "wrong chain"}</span>{" "}
                block {status.block?.toLocaleString("en-US")}
                {status.fees.maxFeeGwei !== null && <> · {status.fees.maxFeeGwei < 0.01 ? "<0.01" : status.fees.maxFeeGwei.toFixed(1)} gwei</>}
              </>
            )}
          </dd>
        </div>
      </dl>

      <h3>1inch Aqua on {info.name}</h3>
      {info.aqua ? (
        <div className="net-contracts">
          <ContractRow label="Aqua registry" address={info.aqua.aqua} check={status?.aqua.registry} checking={checking} explorer={info.explorerUrl} />
          <ContractRow label="SwapVM router" address={info.aqua.router} check={status?.aqua.router} checking={checking} explorer={info.explorerUrl} />
          <p className="muted small">{ORIGIN[info.aqua.origin]}.</p>
        </div>
      ) : (
        <div className="notice warn">1inch Aqua is not deployed on {info.name}, so no strategies can run there yet. The steps below describe how it works where it is.</div>
      )}
      {info.usdc ? (
        <ContractRow label="USDC" address={info.usdc} check={status?.usdc} checking={checking} explorer={info.explorerUrl} extra={status?.usdc?.symbol ? `${status.usdc.symbol}, ${status.usdc.decimals} decimals` : undefined} />
      ) : (
        <p className="muted small">The USDC address for {info.name} is not set up yet, so the app does not guess one.</p>
      )}

      <h3>How a position works</h3>
      <ol className="net-steps">
        <li><b>Plan.</b> Your amount is split into price ranges. A Hybrid position puts 70% in a tight range around today&apos;s price and 30% across a wide one.</li>
        <li><b>Ship.</b> Each range is registered as its own strategy in the Aqua registry{info.aqua ? ` (${shortHex(info.aqua.aqua)})` : ""}. The tokens stay in the treasury wallet; Aqua only tracks each strategy&apos;s balances.</li>
        <li><b>Trade.</b> Anyone can swap against a strategy through the SwapVM router{info.aqua ? ` (${shortHex(info.aqua.router)})` : ""}. Each swap pays the 30 bps fee into the strategy and moves its price.</li>
        <li><b>Close.</b> Docking a strategy takes its balances back. The value, at today&apos;s price, goes back to your box.</li>
      </ol>

      <h3>Example: $1,000 Hybrid at ETH ${price(market.spot)}</h3>
      {preview ? (
        <div className="scroll-x">
          <table className="net-table">
            <thead><tr><th>Price range</th><th>Share</th><th>Holds</th></tr></thead>
            <tbody>
              {preview.bins.map((b, i) => (
                <tr key={i}>
                  <td>${b.min === null ? "0" : price(b.min)} – ${b.max === null ? "∞" : price(b.max)}</td>
                  <td>{Math.round(b.weight * 100)}% · {usd(b.usd)}</td>
                  <td>{b.eth.toFixed(4)} ETH + {usd(b.usdc)} USDC</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">Loading the example…</p>
      )}
      <p className="muted small">
        The example uses today&apos;s ETH price from Coinbase and is the same on every network. Positions open on {live.name} only.
      </p>
    </div>
  );
}

function ContractRow({ label, address, check, checking, explorer, extra }: { label: string; address: string; check?: ContractCheck | null; checking: boolean; explorer: string; extra?: string }) {
  const state = checking ? "checking…" : !check || check.hasCode === null ? "could not check" : check.hasCode ? `✓ code on chain${check.codeBytes ? ` · ${check.codeBytes.toLocaleString("en-US")} bytes` : ""}` : "✗ no code at this address";
  const bad = !checking && check?.hasCode === false;
  return (
    <div className="net-contract">
      <span className="net-contract-label">{label}</span>
      <a className="mono small" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">{shortHex(address, 8, 6)} ↗</a>
      <span className={`small ${bad ? "bad-text" : "muted"}`}>{extra ? `${extra} · ` : ""}{state}</span>
    </div>
  );
}
