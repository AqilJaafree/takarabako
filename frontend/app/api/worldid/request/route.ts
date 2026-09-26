import { relay } from "@/lib/backend";

/// GET /api/worldid/request — an RP-signed World ID request bound to this customer's wallet.
export async function GET() {
  return relay("web", "/worldid/request");
}
