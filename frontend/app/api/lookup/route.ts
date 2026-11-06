import type { NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";
import { NextResponse } from "next/server";

/// GET /api/lookup?q=&chain= — a label or wallet address to who it is (public).
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const chain = req.nextUrl.searchParams.get("chain") ?? "";
  try {
    return NextResponse.json(await backendFetch(`/lookup?q=${encodeURIComponent(q)}${chain ? `&chain=${encodeURIComponent(chain)}` : ""}`));
  } catch (err) {
    return errorResponse(err);
  }
}
