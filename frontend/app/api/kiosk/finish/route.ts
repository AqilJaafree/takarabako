import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/kiosk/finish { sessionId } — the customer tapped Finish: close
/// the deposit session and return its receipt (emailed once all notes confirm).
export async function POST(req: NextRequest) {
  const { sessionId } = (await req.json().catch(() => ({}))) as { sessionId?: string };
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  return relay("kiosk", `/deposit-sessions/${encodeURIComponent(sessionId)}/finish`, { method: "POST" });
}
