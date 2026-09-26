import type { NextRequest } from "next/server";
import { proxyEventStream } from "@/lib/backend";

/// GET /api/stream — the signed-in customer's live deposit events (SSE).
export async function GET(req: NextRequest) {
  return proxyEventStream(req, "web");
}
