import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/send/balance
export async function POST(req: NextRequest) {
  return relay("web", "/send/balance", { body: await req.json().catch(() => ({})) });
}
