import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// GET /api/me/deposit-chain — where this customer's next note would be credited.
export async function GET() {
  return relay("web", "/me/deposit-chain");
}

/// POST /api/me/deposit-chain { chain } — pick the network notes are credited and tkCASH minted on.
export async function POST(req: NextRequest) {
  return relay("web", "/me/deposit-chain", { body: await req.json().catch(() => ({})) });
}
