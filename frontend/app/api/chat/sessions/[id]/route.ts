import { relay } from "@/lib/backend";

type Ctx = { params: Promise<{ id: string }> };

/// GET /api/chat/sessions/:id — one chat with its messages.
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return relay("web", `/chat/sessions/${encodeURIComponent(id)}`);
}

/// DELETE /api/chat/sessions/:id
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return relay("web", `/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}
