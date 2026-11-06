import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";

/// GET /api/kiosk/registered — the kiosks an operator has registered (id, device key, chain, active).
export async function GET() {
  try {
    return NextResponse.json(await backendFetch("/ops/kiosks"));
  } catch {
    return NextResponse.json({ kiosks: [] }, { status: 502 });
  }
}
