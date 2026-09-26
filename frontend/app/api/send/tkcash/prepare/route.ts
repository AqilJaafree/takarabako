import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/send/tkcash/prepare
export async function POST(req: NextRequest) {
  return relay("web", "/send/tkcash/prepare", { body: await req.json().catch(() => ({})) });
}
