import { relay } from "@/lib/backend";

/// GET /api/me — polling fallback while the live stream is down.
export async function GET() {
  return relay("web", "/me");
}
