import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// GET /api/self/arc/wallet?address= — what a wallet holds on Arc (default: the customer's Takarabako wallet).
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  return relay("web", `/self/arc/wallet${address ? `?address=${encodeURIComponent(address)}` : ""}`);
}
