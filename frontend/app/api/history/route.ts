import { type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

export const dynamic = "force-dynamic";

/// GET /api/history?kind= — the customer's History (deposits, withdrawals, yield, refused notes).
export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind");
  return relay("web", `/history?limit=100${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`);
}
