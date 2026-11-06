import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/self/arc/positions/:id/close/record { txHashes } — after signing: checked on chain.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return relay("web", `/self/arc/positions/${encodeURIComponent(id)}/close/record`, { body: await req.json().catch(() => ({})) });
}
