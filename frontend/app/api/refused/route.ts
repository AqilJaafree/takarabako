import type { NextRequest } from "next/server";
import { forwardToBackend } from "@/lib/deviceRelay";

/// POST /api/refused — the Pi bridge reporting a note it handed back (backend POST /refused).
export async function POST(req: NextRequest) {
  return forwardToBackend(req, "/refused");
}
