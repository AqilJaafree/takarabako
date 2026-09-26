import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// POST /api/ops/integrity/:kioskId/investigate — the treasury agent looks
/// into a kiosk's cash-integrity findings (operator token required).
export async function POST(req: NextRequest, ctx: { params: Promise<{ kioskId: string }> }) {
  const { kioskId } = await ctx.params;
  try {
    return NextResponse.json(
      await backendFetch(`/ops/integrity/${encodeURIComponent(kioskId)}/investigate`, { token: req.headers.get("x-ops-token"), method: "POST", body: {} }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
