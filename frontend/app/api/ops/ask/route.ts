import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// POST /api/ops/ask — forwards an operator's question to the treasury
/// agent. The operator token comes from the page (x-ops-token) and goes to
/// the backend as its Bearer token.
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-ops-token");
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await backendFetch("/ops/ask", { token, body }));
  } catch (err) {
    return errorResponse(err);
  }
}
