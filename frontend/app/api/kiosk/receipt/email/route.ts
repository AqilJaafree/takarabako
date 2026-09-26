import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/kiosk/receipt/email?id= — email this deposit receipt (with its
/// PDF) to the logged-in account's own address.
export async function POST(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  return relay("kiosk", `/deposit-sessions/${encodeURIComponent(id)}/email`, { method: "POST", body: {} });
}
