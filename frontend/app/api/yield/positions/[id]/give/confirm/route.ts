import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/yield/positions/:id/give/confirm — hand a position's deed (its ENS name) to someone.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return relay("web", `/yield/positions/${encodeURIComponent(id)}/give/confirm`, { body: await req.json().catch(() => ({})) });
}
