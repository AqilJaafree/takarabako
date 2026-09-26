import type { NextRequest } from "next/server";
import { forwardToBackend } from "@/lib/deviceRelay";

export const dynamic = "force-dynamic";

/// GET /api/events/stream — the Pi bridge following its session's deposits (backend SSE).
export async function GET(req: NextRequest) {
  return forwardToBackend(req, "/events/stream");
}
