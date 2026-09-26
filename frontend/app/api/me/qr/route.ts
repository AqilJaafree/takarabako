import { relay } from "@/lib/backend";

/// GET /api/me/qr — a fresh 5-minute deposit QR (the Deposit tab refreshes
/// through this). Every call issues a new code and kills the previous one.
export const dynamic = "force-dynamic";

export async function GET() {
  return relay("web", "/me/qr");
}
