import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

export const dynamic = "force-dynamic";

/// GET /api/kiosk/receipt?id= — the deposit session's notes, statuses and totals so far.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  return relay("kiosk", `/deposit-sessions/${encodeURIComponent(id)}`);
}
