import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";
import { kioskLoginResponse } from "@/lib/kiosk";

/// POST /api/kiosk/login-qr { qr } — wallet-QR quick login (deposit only).
export async function POST(req: NextRequest) {
  const { qr } = (await req.json().catch(() => ({}))) as { qr?: string };
  if (!qr) return NextResponse.json({ error: "qr text required" }, { status: 400 });
  try {
    return await kioskLoginResponse(req, await backendFetch("/login/qr", { body: { qr } }));
  } catch (err) {
    return errorResponse(err);
  }
}
