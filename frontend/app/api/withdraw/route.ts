import { relay } from "@/lib/backend";

/// POST /api/withdraw — the web can only withdraw to the customer's own
/// wallet. Cash comes out at the kiosk.
export async function POST() {
  return relay("web", "/withdraw", { body: { destination: "wallet" } });
}
