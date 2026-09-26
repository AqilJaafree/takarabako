import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/me/worldid — the IDKit result, verified by the backend with World.
export async function POST(req: NextRequest) {
  return relay("web", "/me/worldid", { body: await req.json().catch(() => ({})) });
}
