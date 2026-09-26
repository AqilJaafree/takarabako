import { test } from "node:test";
import assert from "node:assert/strict";
import { signWebhook, verifyWebhook, MAX_SKEW_SECONDS } from "../src/webhookSignature.js";

const secret = "whsec-test";
const body = Buffer.from(JSON.stringify([{ id: "1", event: "event.emitted", data: {} }]));
const now = 1_790_000_000;
const ts = String(now);

test("a correctly signed delivery verifies", () => {
  const signature = signWebhook(secret, body, ts);
  assert.deepEqual(verifyWebhook({ secret, rawBody: body, signature, timestamp: ts, now }), { ok: true });
});

test("the signature is HMAC-SHA256 over body then timestamp, hex", async () => {
  const { createHmac } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(Buffer.concat([body, Buffer.from(ts)])).digest("hex");
  assert.equal(signWebhook(secret, body, ts), expected);
});

test("a tampered body is rejected", () => {
  const signature = signWebhook(secret, body, ts);
  const tampered = Buffer.from(body.toString().replace('"1"', '"2"'));
  assert.deepEqual(verifyWebhook({ secret, rawBody: tampered, signature, timestamp: ts, now }), { ok: false, reason: "bad signature" });
});

test("the wrong secret is rejected", () => {
  const signature = signWebhook("other", body, ts);
  assert.equal(verifyWebhook({ secret, rawBody: body, signature, timestamp: ts, now }).ok, false);
});

test("a stale or future timestamp is rejected", () => {
  const old = String(now - MAX_SKEW_SECONDS - 1);
  assert.deepEqual(
    verifyWebhook({ secret, rawBody: body, signature: signWebhook(secret, body, old), timestamp: old, now }),
    { ok: false, reason: "stale timestamp" },
  );
  const future = String(now + MAX_SKEW_SECONDS + 1);
  assert.equal(verifyWebhook({ secret, rawBody: body, signature: signWebhook(secret, body, future), timestamp: future, now }).ok, false);
});

test("missing headers, bad hex and no secret are rejected", () => {
  assert.equal(verifyWebhook({ secret, rawBody: body, signature: undefined, timestamp: ts, now }).ok, false);
  assert.equal(verifyWebhook({ secret, rawBody: body, signature: "zz", timestamp: ts, now }).ok, false);
  assert.equal(verifyWebhook({ secret: "", rawBody: body, signature: signWebhook("", body, ts), timestamp: ts, now }).ok, false);
});
