import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { BACKEND_URL } from "./backend";

/// Passes a Pi bridge call through to the backend, so the Pi can use this
/// site as its BACKEND_URL (https://…/api) when the backend itself isn't
/// public. The bridge sends the customer's session token as a Bearer header;
/// the backend checks it, and the kiosk's note signature, exactly as if the
/// Pi had called it directly. Nothing is trusted here.
export async function forwardToBackend(req: NextRequest, path: string): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return NextResponse.json({ error: "session token required" }, { status: 401 });

  const headers: Record<string, string> = { authorization: auth };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const accept = req.headers.get("accept");
  if (accept) headers.accept = accept;

  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND_URL}${path}`, {
      method: req.method,
      headers,
      body: req.method === "GET" ? undefined : await req.text(),
      signal: req.signal, // the bridge disconnecting also closes the upstream stream
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "The Takarabako backend is unreachable" }, { status: 502 });
  }

  const type = upstream.headers.get("content-type") ?? "application/json";
  const out: Record<string, string> = { "content-type": type };
  if (type.startsWith("text/event-stream")) {
    Object.assign(out, { "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
