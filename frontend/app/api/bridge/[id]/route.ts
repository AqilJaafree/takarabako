import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// GET /api/bridge/:id — one transfer's progress.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return relay("web", `/bridge/${encodeURIComponent(id)}`);
}
