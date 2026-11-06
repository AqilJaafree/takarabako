import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/bridge/quote { from, to, amount }
export async function POST(req: NextRequest) {
  return relay("web", "/bridge/quote", { body: await req.json().catch(() => ({})) });
}
