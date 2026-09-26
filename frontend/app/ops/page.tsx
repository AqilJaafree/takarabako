import type { Metadata } from "next";
import { loadOpsData } from "@/lib/ops";
import { OpsDashboard } from "./OpsDashboard";

export const metadata: Metadata = { title: "Treasury ops · Takarabako" };
export const dynamic = "force-dynamic";

/// The operator dashboard: proof of reserve for tkCASH, vault health,
/// holders, cash flows, Uniswap positions, the live event feed and the
/// treasury agent. Data comes from MultiBaas through the backend.
export default async function OpsPage() {
  return <OpsDashboard initial={await loadOpsData()} />;
}
