import { relay } from "@/lib/backend";

/// GET /api/kiosk/worldid/request — an RP-signed World ID request for the customer logged in at this kiosk.
export async function GET() {
  return relay("kiosk", "/worldid/request");
}
