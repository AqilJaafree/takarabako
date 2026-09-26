import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// POST /api/ops/kiosks/:kioskId/unfreeze — clear a count mismatch.
export async function POST(req: NextRequest, { params }: { params: Promise<{ kioskId: string }> }) {
  const { kioskId } = await params;
  const token = req.headers.get("x-ops-token");
  try {
    return NextResponse.json(await backendFetch(`/ops/kiosks/${encodeURIComponent(kioskId)}/unfreeze`, { token, body: {} }));
  } catch (err) {
    return errorResponse(err);
  }
}
