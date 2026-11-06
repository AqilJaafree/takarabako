import { NextResponse } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// GET /api/networks — the networks the app can show and which one is live (public).
export async function GET() {
  try {
    return NextResponse.json(await backendFetch("/networks"));
  } catch (err) {
    return errorResponse(err);
  }
}
