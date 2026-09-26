import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// POST /api/ops/reports — have the agent write and anchor a report now.
export async function POST(req: NextRequest) {
  try {
    return NextResponse.json(await backendFetch("/ops/reports", { token: req.headers.get("x-ops-token"), method: "POST", body: {} }));
  } catch (err) {
    return errorResponse(err);
  }
}
