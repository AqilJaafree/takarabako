import { NextResponse, type NextRequest } from "next/server";
import {
  backendFetch,
  clearSessionCookie,
  errorResponse,
  sessionToken,
  setSessionCookie,
} from "@/lib/backend";

/// POST /api/session { accessToken } — swaps a Privy access token (from the
/// email-code login in the browser) for a backend session. The backend
/// verifies the token with Privy; we keep its session token in an httpOnly
/// cookie.
export async function POST(req: NextRequest) {
  const { accessToken } = (await req.json().catch(() => ({}))) as { accessToken?: string };
  if (!accessToken) return NextResponse.json({ error: "accessToken required" }, { status: 400 });
  try {
    const login = await backendFetch<{ token: string; ensName: string; reused: boolean }>("/auth/privy", {
      body: { accessToken },
    });
    const res = NextResponse.json({ ensName: login.ensName, isNew: !login.reused });
    setSessionCookie(res, req, "web", login.token);
    return res;
  } catch (err) {
    return errorResponse(err, "web");
  }
}

/// DELETE /api/session — log out: end the backend session and drop the cookie.
export async function DELETE() {
  const token = await sessionToken("web");
  if (token) await backendFetch("/logout", { token, method: "POST" }).catch(() => {});
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res, "web");
  return res;
}
