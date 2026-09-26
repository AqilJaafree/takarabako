import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/yield { riskLevel, amount } — the Claude agent opens a real
/// Uniswap v3 position for the chosen tier.
export async function POST(req: NextRequest) {
  const { riskLevel, amount } = (await req.json().catch(() => ({}))) as { riskLevel?: string; amount?: number };
  if (!riskLevel || !(Number(amount) > 0)) {
    return NextResponse.json({ error: "riskLevel and a positive amount are required" }, { status: 400 });
  }
  return relay("web", "/agent/open-position", { body: { riskLevel, amount: Number(amount) } });
}
