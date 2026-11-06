import { NextResponse, type NextRequest } from "next/server";
import { loadOpsData } from "@/lib/ops";

/// GET /api/ops/data — the dashboard's polling endpoint.
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("chain");
  const chain = raw === "sepolia" || raw === "arc-testnet" || raw === "hedera-testnet" ? raw : "all";
  return NextResponse.json(await loadOpsData(chain));
}
