import { createHmac, timingSafeEqual } from "node:crypto";

/// MultiBaas signs each webhook delivery: X-MultiBaas-Signature is the hex
/// HMAC-SHA256 of the raw body followed by the X-MultiBaas-Timestamp value
/// (unix seconds), keyed with the webhook's secret.
/// https://docs.curvegrid.com/multibaas/webhooks/
export const MAX_SKEW_SECONDS = 5 * 60; // reject replays of old deliveries

export function signWebhook(secret: string, rawBody: Buffer | string, timestamp: string): string {
  return createHmac("sha256", secret).update(rawBody).update(timestamp).digest("hex");
}

export function verifyWebhook(opts: {
  secret: string;
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  now?: number; // unix seconds, for tests
}): { ok: true } | { ok: false; reason: string } {
  const { secret, rawBody, signature, timestamp } = opts;
  if (!secret) return { ok: false, reason: "webhook secret not configured" };
  if (!signature || !timestamp) return { ok: false, reason: "missing signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale timestamp" };

  const expected = Buffer.from(signWebhook(secret, rawBody, timestamp), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}
