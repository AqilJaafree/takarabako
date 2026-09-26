import { NextResponse } from "next/server";
import { BACKEND_URL } from "@/lib/backend";

export const dynamic = "force-dynamic";

/// GET /api/health — is the backend reachable? Drives the "connection lost"
/// scene's auto-retry (components/ConnectionLost.tsx).
export async function GET() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (res.ok) return NextResponse.json({ ok: true });
  } catch {
    // unreachable — fall through
  }
  return NextResponse.json({ ok: false }, { status: 503 });
}
