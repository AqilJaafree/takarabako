import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

export async function POST(req: NextRequest) {
  const { riskLevel, amount } = (await req.json().catch(() => ({}))) as { riskLevel?: string; amount?: number };
  if (!riskLevel || !(Number(amount) > 0)) {
    return NextResponse.json({ error: "riskLevel and a positive amount are required" }, { status: 400 });
  }
  return relay("kiosk", "/agent/open-position", { body: { riskLevel, amount: Number(amount) } });
}
