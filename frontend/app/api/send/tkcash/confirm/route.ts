import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/send/tkcash/confirm
export async function POST(req: NextRequest) {
  return relay("web", "/send/tkcash/confirm", { body: await req.json().catch(() => ({})) });
}
