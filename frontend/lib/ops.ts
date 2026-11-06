import "server-only";
import { backendFetch } from "./backend";
import type { ChainFilter, OpsData } from "./opsTypes";

/// Everything the /ops dashboard shows, in one round of backend calls. A
/// panel whose call fails carries its error rather than failing the page.
export async function loadOpsData(chain: ChainFilter = "all"): Promise<OpsData> {
  const q = `?chain=${encodeURIComponent(chain)}`;
  const get = <T,>(path: string) =>
    backendFetch<T>(path).catch((err: unknown) => ({ error: err instanceof Error ? err.message : "request failed" }));
  const [summary, holders, flows, positions, events, integrity, mandate, reports, bridge] = await Promise.all([
    get<OpsData["summary"]>(`/dashboard/summary${q}`),
    get<OpsData["holders"]>(`/dashboard/holders${q}`),
    get<OpsData["flows"]>(`/dashboard/flows${q}`),
    get<OpsData["positions"]>("/dashboard/positions"),
    get<OpsData["events"]>(`/dashboard/events${q}`),
    get<OpsData["integrity"]>("/ops/integrity"),
    get<OpsData["mandate"]>("/ops/mandate"),
    get<OpsData["reports"]>("/ops/reports"),
    get<OpsData["bridge"]>("/dashboard/bridge"),
  ]);
  return { chain, summary, holders, flows, positions, events, integrity, mandate, reports, bridge, loadedAt: new Date().toISOString() };
}
