import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/self/arc/positions/:id/close/prepare — the transactions to sign to close it.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return relay("web", `/self/arc/positions/${encodeURIComponent(id)}/close/prepare`, { body: {} });
}
