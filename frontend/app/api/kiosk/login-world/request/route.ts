import { NextResponse } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// GET /api/kiosk/login-world/request — a World ID request bound to a one-time nonce.
export async function GET() {
  try {
    return NextResponse.json(await backendFetch("/login/world/request"));
  } catch (err) {
    return errorResponse(err);
  }
}
