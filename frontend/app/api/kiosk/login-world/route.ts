import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";
import { kioskLoginResponse } from "@/lib/kiosk";

/// POST /api/kiosk/login-world { nonce, result } — World ID login (deposit only).
export async function POST(req: NextRequest) {
  const { nonce, result } = (await req.json().catch(() => ({}))) as { nonce?: string; result?: unknown };
  if (!nonce || !result) return NextResponse.json({ error: "World ID proof required" }, { status: 400 });
  try {
    return await kioskLoginResponse(req, await backendFetch("/login/world", { body: { nonce, result } }));
  } catch (err) {
    return errorResponse(err);
  }
}
