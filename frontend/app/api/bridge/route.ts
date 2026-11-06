import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// GET /api/bridge — my recent transfers between chains.
export async function GET() {
  return relay("web", "/bridge");
}

/// POST /api/bridge { from, to, amount } — start a CCTP transfer.
export async function POST(req: NextRequest) {
  return relay("web", "/bridge", { body: await req.json().catch(() => ({})) });
}
