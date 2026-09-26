import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// POST /api/ops/attest — an operator's cash count, recorded on-chain.
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-ops-token");
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await backendFetch("/ops/attest", { token, body }));
  } catch (err) {
    return errorResponse(err);
  }
}
