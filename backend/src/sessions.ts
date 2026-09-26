import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { pool } from "./db.js";

/// Login sessions. Email login gets `full` (deposit, yield, withdraw); a
/// wallet-QR login gets `deposit` only — a wallet address is public, so
/// whoever holds someone's QR may only put money *into* their account.
export type Scope = "full" | "deposit";

// Short, sliding lifetimes suit a kiosk: the next person walks up soon.
export const SESSION_TTL_MS: Record<Scope, number> = { full: 15 * 60_000, deposit: 5 * 60_000 };

export interface Session {
  token: string;
  privyUserId: string;
  scope: Scope;
  expiresAt: Date;
}

export function scopeAllows(have: Scope, allowed: Scope[]): boolean {
  return have === "full" || allowed.includes(have);
}

export async function createSession(privyUserId: string, scope: Scope): Promise<Session> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS[scope]);
  await pool.query("insert into sessions (token, privy_user_id, scope, expires_at) values ($1, $2, $3, $4)", [
    token, privyUserId, scope, expiresAt,
  ]);
  return { token, privyUserId, scope, expiresAt };
}

/// Returns the live session and slides its expiry forward, or null if the
/// token is unknown or expired.
export async function touchSession(token: string): Promise<Session | null> {
  const { rows } = await pool.query(
    `update sessions
        set expires_at = now() + (case scope when 'full' then $2::int else $3::int end) * interval '1 millisecond'
      where token = $1 and expires_at > now()
      returning token, privy_user_id as "privyUserId", scope, expires_at as "expiresAt"`,
    [token, SESSION_TTL_MS.full, SESSION_TTL_MS.deposit],
  );
  return rows[0] ?? null;
}

export async function endSession(token: string) {
  await pool.query("delete from sessions where token = $1", [token]);
}

function bearer(req: Request): string | null {
  const h = req.header("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/// Express guard: 401 without a live session, 403 if its scope isn't allowed.
/// The session lands in res.locals.session for the route.
export function requireSession(...allowed: Scope[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: "log in first" });
      return;
    }
    touchSession(token)
      .then((session) => {
        if (!session) {
          res.status(401).json({ error: "session expired — log in again" });
          return;
        }
        if (!scopeAllows(session.scope, allowed)) {
          res.status(403).json({ error: "this needs an email login" });
          return;
        }
        res.locals.session = session;
        next();
      })
      .catch(next);
  };
}
