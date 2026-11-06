import { relay } from "@/lib/backend";

/// GET /api/self/arc/positions — the customer's self-custody positions, valued live.
export async function GET() {
  return relay("web", "/self/arc/positions");
}
