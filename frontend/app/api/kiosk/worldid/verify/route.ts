import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/kiosk/worldid/verify — the proof from World App, verified by the backend.
export async function POST(req: NextRequest) {
  return relay("kiosk", "/me/worldid", { body: await req.json().catch(() => ({})) });
}
