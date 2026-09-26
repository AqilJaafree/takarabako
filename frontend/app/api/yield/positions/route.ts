import { relay } from "@/lib/backend";

/// GET /api/yield/positions — the customer's Aqua positions, valued live.
export async function GET() {
  return relay("web", "/yield/positions");
}
