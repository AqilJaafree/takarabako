import { NextResponse, type NextRequest } from "next/server";
import { sessionToken } from "@/lib/backend";
import { bridgeEvents } from "@/lib/kiosk";

/// GET /api/kiosk/bridge-events?since=N — the Pi bridge's own feed. The
/// kiosk uses it for notes the acceptor refused (those never reach the
/// backend) and as the deposit fallback while the backend stream is down.
export async function GET(req: NextRequest) {
  if (!(await sessionToken("kiosk"))) return NextResponse.json({ events: [] });
  const since = Number(req.nextUrl.searchParams.get("since") ?? 0) || 0;
  try {
    return NextResponse.json({ events: await bridgeEvents(since) });
  } catch {
    return NextResponse.json({ events: [], error: "bridge unreachable" }, { status: 502 });
  }
}
