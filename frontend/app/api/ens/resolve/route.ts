import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// GET /api/ens/resolve?name= — resolve a name through the official ENS v2 Universal Resolver.
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name") ?? "";
  try {
    return NextResponse.json(await backendFetch(`/ens/resolve?name=${encodeURIComponent(name)}`));
  } catch (err) {
    return errorResponse(err);
  }
}
