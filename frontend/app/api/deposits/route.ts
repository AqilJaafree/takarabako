import { relay } from "@/lib/backend";

export async function GET() {
  return relay("web", "/deposits?limit=20");
}
