import { NextResponse } from "next/server";
import { backendFetch, clearSessionCookie, sessionToken } from "@/lib/backend";
import { bridgeEndSession } from "@/lib/kiosk";

/// POST /api/kiosk/logout — Done, timeout, or a fresh page load: end the
/// backend session and tell the Pi bridge, so the next note is refused.
export async function POST() {
  const token = await sessionToken("kiosk");
  await Promise.all([
    token ? backendFetch("/logout", { token, method: "POST" }).catch(() => {}) : null,
    bridgeEndSession(),
  ]);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res, "kiosk");
  return res;
}
