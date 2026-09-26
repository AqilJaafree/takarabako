import { relay } from "@/lib/backend";

/// GET /api/worldid/request — an RP-signed World ID request for this customer.
export async function GET() {
  return relay("web", "/worldid/request");
}
