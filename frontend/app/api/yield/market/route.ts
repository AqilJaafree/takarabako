import { NextResponse } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// GET /api/yield/market — ETH price, candles, tiers and advanced limits (public).
export async function GET() {
  try {
    return NextResponse.json(await backendFetch("/yield/market"));
  } catch (err) {
    return errorResponse(err);
  }
}
