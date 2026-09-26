import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// POST /api/yield/preview — how an advanced range splits into liquidity (public, no chain calls).
export async function POST(req: NextRequest) {
  try {
    return NextResponse.json(await backendFetch("/yield/preview", { body: await req.json() }));
  } catch (err) {
    return errorResponse(err);
  }
}
