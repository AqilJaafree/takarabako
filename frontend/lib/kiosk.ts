import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, setSessionCookie } from "./backend";
import type { KioskLogin } from "./types";

/// The Pi's bill-acceptor bridge (device-agent/server.js). After a kiosk
/// login, this server — never the browser — hands it the session token, so
/// notes stacked by the serial listener are deposited into that account.
/// Unset = no bridge (bench testing without the box).
export const PI_BRIDGE_URL = process.env.PI_BRIDGE_URL ?? "";

async function bridge(path: string, body?: unknown): Promise<Response> {
  return fetch(`${PI_BRIDGE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
}

export async function bridgeStartSession(s: { token: string; ensName: string; scope: string; expiresAt: string }) {
  if (!PI_BRIDGE_URL) return "skipped" as const;
  try {
    const res = await bridge("/session", { ...s, expiresAt: Date.parse(s.expiresAt) });
    return res.ok ? ("ok" as const) : ("failed" as const);
  } catch {
    return "failed" as const;
  }
}

export async function bridgeEndSession() {
  if (!PI_BRIDGE_URL) return;
  await bridge("/session/end", {}).catch(() => {});
}

export async function bridgeEvents(since: number): Promise<unknown[]> {
  if (!PI_BRIDGE_URL) return [];
  const res = await bridge(`/events?since=${since}`);
  const { events } = (await res.json()) as { events: unknown[] };
  return events;
}

interface BackendLogin {
  token: string;
  ensName: string;
  balance: number;
  scope: "full" | "deposit";
  expiresAt: string;
  qrFallback?: string | null;
  qrEmailed?: boolean;
}

/// Finishes a kiosk login: hand the session to the Pi bridge, keep the token
/// in the kiosk cookie, and give the browser only what it shows.
export async function kioskLoginResponse(req: NextRequest, login: BackendLogin) {
  const bridgeStatus = await bridgeStartSession(login);
  // Every visit to the cash slot is a deposit session that ends in a receipt.
  const depositSession = await backendFetch<{ id: string }>("/deposit-sessions", { token: login.token, method: "POST" }).catch(
    (err) => {
      console.error("[kiosk] could not open a deposit session:", err instanceof Error ? err.message : err);
      return null;
    },
  );
  const body: KioskLogin = {
    ensName: login.ensName,
    balance: login.balance,
    scope: login.scope,
    expiresAt: login.expiresAt,
    qrFallback: login.qrFallback ?? null,
    qrEmailed: login.qrEmailed ?? false,
    bridge: bridgeStatus,
    depositSessionId: depositSession?.id ?? null,
  };
  const res = NextResponse.json(body);
  setSessionCookie(res, req, "kiosk", login.token);
  return res;
}
