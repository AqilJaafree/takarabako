import { relay } from "@/lib/backend";

/// GET /api/me/wallet — the customer's own wallet: gas, tkCASH and limits.
export async function GET() {
  return relay("web", "/me/wallet");
}
