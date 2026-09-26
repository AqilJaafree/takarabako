import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/yield/advanced — open an advanced 1inch Aqua position from the box.
export async function POST(req: NextRequest) {
  return relay("web", "/yield/advanced", { body: await req.json().catch(() => ({})) });
}
