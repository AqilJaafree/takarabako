import { NextResponse } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// GET /api/ops/reports/:id — a report with its exact canonical JSON, so the
/// browser can re-hash it and check the on-chain anchor itself.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await backendFetch(`/ops/reports/${encodeURIComponent(id)}`));
  } catch (err) {
    return errorResponse(err);
  }
}
