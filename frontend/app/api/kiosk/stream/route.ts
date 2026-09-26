import type { NextRequest } from "next/server";
import { proxyEventStream } from "@/lib/backend";

export async function GET(req: NextRequest) {
  return proxyEventStream(req, "kiosk");
}
