import { NextResponse } from "next/server";
import { loadOpsData } from "@/lib/ops";

/// GET /api/ops/data — the dashboard's polling endpoint.
export async function GET() {
  return NextResponse.json(await loadOpsData());
}
