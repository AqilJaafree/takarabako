import type { NextRequest } from "next/server";
import { forwardToBackend } from "@/lib/deviceRelay";

/// POST /api/deposit — the Pi bridge reporting a stacked note (backend POST /deposit).
export async function POST(req: NextRequest) {
  return forwardToBackend(req, "/deposit");
}
