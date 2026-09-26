import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// POST /api/ops/proposals/:id/approve|reject — an operator's decision.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; decision: string }> }) {
  const { id, decision } = await params;
  if (decision !== "approve" && decision !== "reject") return NextResponse.json({ error: "unknown decision" }, { status: 404 });
  const token = req.headers.get("x-ops-token");
  try {
    return NextResponse.json(await backendFetch(`/ops/proposals/${encodeURIComponent(id)}/${decision}`, { token, body: {} }));
  } catch (err) {
    return errorResponse(err);
  }
}
