"use client";

import type { ChainSummary, IndexerStatus } from "@/lib/opsTypes";
import { addressUrl, apy, shortHex, usd } from "@/lib/format";

/// One card per chain: is it configured, does its vault cover what it owes, is tkCASH backed,
/// and what the treasury holds there. Arc's gas asset is USDC (the same funds as its USDC
/// float), so Arc shows one USDC figure; Sepolia shows ETH for gas and USDC separately.
export function ChainsPanel({ chains, indexers }: { chains: ChainSummary[]; indexers: IndexerStatus[] }) {
  return (
    <section className="card">
      <h2>Chains</h2>
      <p className="muted small">Each chain has its own vault, tkCASH and treasury balance. USDC moves between them over Circle CCTP.</p>
      <div className="ops-chains">
        {chains.map((c) => (
          <ChainCard key={c.chain} c={c} indexer={indexers.find((i) => i.chain === c.chain)} />
        ))}
      </div>
    </section>
  );
}

function ChainCard({ c, indexer }: { c: ChainSummary; indexer?: IndexerStatus }) {
  const v = c.vault.data;
  const r = c.reserve.data;
  const t = c.treasury.data;
  const coverage = v?.reserveCoverage;
  const gasLow = t ? (t.native ?? t.eth) < (t.gasMin ?? (t.gasIsUsdc ? 1 : 0.05)) : false;
  return (
    <div className="ops-chain">
      <div className="spread">
        <b>{c.name}</b>
        <span className={`pill ${c.ready ? "ok" : "bad"}`}>{c.ready ? "Configured" : "Not configured"}</span>
      </div>
      {!c.ready ? (
        <p className="ops-empty">Set this chain&apos;s treasury key, USDC and vault addresses in backend/.env.</p>
      ) : (
        <dl className="ops-chain-stats">
          <div><dt>Vault owes</dt><dd>{usd(v?.liabilityUsd)}{v ? <span className="muted small"> · APY {apy(v.apyBps)}</span> : null}</dd></div>
          <div>
            <dt>Coverage</dt>
            <dd className={coverage == null ? "" : coverage < 1 ? "tone-bad" : coverage < 1.2 ? "tone-warn" : "tone-ok"}>
              {coverage == null ? "—" : `${coverage.toFixed(2)}×`}
              {v ? <span className="muted small"> · {usd(v.vaultUsdcBalance)} held</span> : null}
            </dd>
          </div>
          <div>
            <dt>tkCASH</dt>
            <dd className={r?.configured ? (r.backed ? "tone-ok" : "tone-bad") : ""}>
              {r?.configured ? `${usd(r.supply)} ${r.backed ? "✓ backed" : "✗ not backed"}` : "not deployed"}
            </dd>
          </div>
          <div>
            <dt>Treasury USDC</dt>
            <dd>{t?.usdc == null ? "—" : usd(t.usdc)}</dd>
          </div>
          <div>
            <dt>{t?.gasIsUsdc ? "Gas (paid in USDC)" : `Gas (${t?.nativeSymbol ?? "ETH"})`}</dt>
            <dd className={gasLow ? "tone-bad" : ""}>
              {t ? (t.gasIsUsdc ? "same USDC pool" : `${(t.native ?? t.eth).toFixed(4)} ${t.nativeSymbol ?? "ETH"}`) : "—"}
              {gasLow && <span> · top up</span>}
            </dd>
          </div>
          <div>
            <dt>Event log</dt>
            <dd>
              {indexer ? (
                indexer.behind === null ? "starting…" : indexer.live ? <span className="tone-ok">live</span> : <span className="tone-warn">{indexer.behind.toLocaleString("en-US")} blocks behind</span>
              ) : (
                <span className="muted">via MultiBaas</span>
              )}
            </dd>
          </div>
        </dl>
      )}
      {t?.address && (
        <p className="muted small" style={{ margin: "8px 0 0" }}>
          Treasury <a href={addressUrl(t.address, c.chain)} target="_blank" rel="noreferrer" className="mono">{shortHex(t.address)}</a>
        </p>
      )}
    </div>
  );
}
