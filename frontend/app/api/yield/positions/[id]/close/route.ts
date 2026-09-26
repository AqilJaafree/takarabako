import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/yield/positions/:id/close — dock it and return the value to the box.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return relay("web", `/yield/positions/${encodeURIComponent(id)}/close`, { body: {} });
}
