import { NextResponse } from "next/server";
import { PI_BRIDGE_URL } from "@/lib/kiosk";

/// GET /api/kiosk/device — this kiosk's ENS name and device key, from the Pi bridge.
export async function GET() {
  if (!PI_BRIDGE_URL) return NextResponse.json({ kiosk: null, address: null, signing: false });
  try {
    const res = await fetch(`${PI_BRIDGE_URL}/device`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ kiosk: null, address: null, signing: false, error: "bridge unreachable" }, { status: 502 });
  }
}
