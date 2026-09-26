import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/chat/sessions/:id/messages { text, files: [{ name, type, dataUrl }] }
/// — a message to Maneki (uploads are read by the model, not stored).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "text or files required" }, { status: 400 });
  return relay("web", `/chat/sessions/${encodeURIComponent(id)}/messages`, { body });
}
