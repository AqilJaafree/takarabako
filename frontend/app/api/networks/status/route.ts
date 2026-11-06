import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// GET /api/networks/status?network=arc — live, read-only checks of one network (public).
export async function GET(req: NextRequest) {
  const network = req.nextUrl.searchParams.get("network") ?? "";
  try {
    return NextResponse.json(await backendFetch(`/networks/${encodeURIComponent(network)}/status`));
  } catch (err) {
    return errorResponse(err);
  }
}
