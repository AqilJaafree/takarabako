import { relay } from "@/lib/backend";

/// GET /api/chat/sessions — the customer's saved chats with Maneki.
export async function GET() {
  return relay("web", "/chat/sessions");
}

/// POST /api/chat/sessions — start a new chat.
export async function POST() {
  return relay("web", "/chat/sessions", { method: "POST", body: {} });
}
