import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/self/arc/record { positionId, txHashes } — after signing: the backend checks them on chain.
export async function POST(req: NextRequest) {
  return relay("web", "/self/arc/record", { body: await req.json().catch(() => ({})) });
}
