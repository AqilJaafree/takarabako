import { config } from "./config.js";

/// PRD §7.7 — ENS v2 subname registrar under `wantest.eth`.
/// Phase 1 replaces these with real calls into the deployed subname
/// registry (or the L1 NameWrapper fallback if Namechain isn't usable on a
/// public testnet in time — see PRD §13 risk table).

export function walletSubname(handle: string): string {
  return `${handle}.${config.ens.parentName}`;
}

export function positionSubname(positionId: number): string {
  return `uniswap-${positionId}.${config.ens.parentName}`;
}

export async function registerSubname(subname: string, owner: string): Promise<{ txHash: string }> {
  // TODO(Phase 1): call the deployed ENS v2 subname registrar's register()
  // function against `owner`, and record the resulting tx hash.
  console.log(`[ens:stub] register ${subname} -> ${owner}`);
  return { txHash: `0xSTUB_ENS_${subname}` };
}
