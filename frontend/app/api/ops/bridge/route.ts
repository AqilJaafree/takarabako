import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// POST /api/ops/bridge { from, to, amount } — an operator rebalances treasury USDC between chains (CCTP).
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-ops-token");
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await backendFetch("/ops/bridge/rebalance", { token, body }));
  } catch (err) {
    return errorResponse(err);
  }
}
