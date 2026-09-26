import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/kiosk/withdraw { destination: "cash" | "wallet" } — cash is
/// only offered at the box.
export async function POST(req: NextRequest) {
  const { destination } = (await req.json().catch(() => ({}))) as { destination?: string };
  if (destination !== "cash" && destination !== "wallet") {
    return NextResponse.json({ error: "destination must be cash or wallet" }, { status: 400 });
  }
  return relay("kiosk", "/withdraw", { body: { destination } });
}
