import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/self/arc/prepare { mode, amount } — the transactions to sign to open a position.
export async function POST(req: NextRequest) {
  return relay("web", "/self/arc/prepare", { body: await req.json().catch(() => ({})) });
}
