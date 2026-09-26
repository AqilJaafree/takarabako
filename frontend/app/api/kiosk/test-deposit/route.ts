import { NextResponse } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/kiosk/test-deposit — bench testing without the bill acceptor:
/// deposits one RM10 note as if it had been stacked. Off unless
/// KIOSK_TEST_DEPOSIT=1.
export async function POST() {
  if (process.env.KIOSK_TEST_DEPOSIT !== "1") {
    return NextResponse.json({ error: "test deposits are disabled" }, { status: 404 });
  }
  return relay("kiosk", "/deposit", { body: { amount: 10, currency: "MYR" } });
}
