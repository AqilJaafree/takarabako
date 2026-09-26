# World ID Deposit Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let customers who verified with World ID log in on the `/deposit` terminal by approving in World App, alongside the existing wallet-QR login.

**Architecture:** The backend issues a World ID request whose signal is a one-time nonce kept in Redis. It checks the returned proof (nonce, signal hash, World's verify endpoint), then finds the account by the stored `world_nullifier` and opens a deposit-only session with the same response as `/login/qr`. The frontend adds a "Scan my QR | World ID" switch to the deposit scan screen; the World ID tab shows the IDKit QR, using a hook shared with the `/verify` selfie page.

**Tech Stack:** Express + zod + ioredis + pg (backend, `node:test` via tsx), Next.js 16 App Router + `@worldcoin/idkit` 4.3 (frontend).

Spec: `docs/superpowers/specs/2026-09-27-world-id-deposit-login-design.md`

**Commits:** the user commits only when they ask. The "Commit" steps below are checkpoints: run them only if the user has asked for commits in this session.

**Running things:** Postgres and Redis must be up (`cd backend && npm run services`). One backend test file: `cd backend && node --import tsx --test test/<name>.test.ts`.

---

## File map

| File | Change |
|---|---|
| `backend/src/worldId.ts` | Split proof checking (`checkProof`) from recording (`verifyHuman`); `requestContext(signal)` |
| `backend/src/routes/worldIdRoutes.ts` | Call `requestContext(account.privyWallet)` |
| `backend/test/worldId.test.ts` | Update the `requestContext` call |
| `backend/src/accounts.ts` | `findByWorldNullifier` |
| `backend/src/depositLogin.ts` (new) | Deposit session + the login response shared by QR and World ID |
| `backend/src/routes/loginQr.ts` | Use `depositLogin` |
| `backend/src/worldLogin.ts` (new) | Nonce issue and World ID login logic |
| `backend/src/routes/loginWorld.ts` (new) | `GET /login/world/request`, `POST /login/world` |
| `backend/src/index.ts` | Mount `loginWorldRouter` |
| `backend/test/loginWorld.test.ts` (new) | Login tests |
| `frontend/lib/useWorldProof.ts` (new) | Shared IDKit hook |
| `frontend/components/WorldSelfie.tsx` | Use the hook |
| `frontend/app/api/kiosk/login-world/request/route.ts` (new) | Proxy the request |
| `frontend/app/api/kiosk/login-world/route.ts` (new) | Proxy the login, finish via `kioskLoginResponse` |
| `frontend/app/kiosk/WorldLogin.tsx` (new) | World ID tab |
| `frontend/app/kiosk/KioskApp.tsx` | Tabs on the deposit scan screen |
| `frontend/app/globals.css` | `.login-tabs` |

---

### Task 1: Split proof checking out of `verifyHuman`

**Files:**
- Modify: `backend/src/worldId.ts`
- Modify: `backend/src/routes/worldIdRoutes.ts`
- Modify: `backend/test/worldId.test.ts`

- [ ] **Step 1: Change the test to the new `requestContext` signature**

In `backend/test/worldId.test.ts`, replace:

```ts
  const ctx = requestContext(await fresh("u-alice"));
```

with:

```ts
  const ctx = requestContext((await fresh("u-alice")).privyWallet);
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && node --import tsx --test test/worldId.test.ts`
Expected: a type-level mismatch doesn't fail at runtime under tsx, so instead run `npx tsc --noEmit -p .` and expect an error on that line: `Argument of type 'string' is not assignable to parameter of type 'Account'`.

- [ ] **Step 3: Refactor `worldId.ts`**

Replace `requestContext` with:

```ts
/// What the browser needs to open the World ID widget. The signal binds the
/// proof: the customer's wallet for verification, a one-time nonce for login.
export function requestContext(signal: string) {
  const sig = signRequest({ signingKeyHex: config.worldId.signingKey, action: config.worldId.action });
  return {
    app_id: config.worldId.appId,
    action: config.worldId.action,
    environment: config.worldId.environment,
    preset: config.worldId.preset,
    signal,
    rp_context: {
      rp_id: config.worldId.rpId,
      nonce: sig.nonce,
      created_at: sig.createdAt,
      expires_at: sig.expiresAt,
      signature: sig.sig,
    },
  };
}
```

Replace everything from `export type VerifyOutcome` through the end of `verifyHuman` with:

```ts
export type ProofCheck =
  | { ok: true; nullifier: string; credential: string }
  | { ok: false; status: number; error: string };

export type VerifyOutcome =
  | { ok: true; credential: string; alreadyVerified: boolean }
  | { ok: false; status: number; error: string };

/// Checks a proof is for our action and signal, then asks World whether it's
/// valid. requireSignalHash: refuse proofs that don't carry a signal hash
/// (login needs the proof bound to its nonce).
export async function checkProof(
  result: IdkitResult,
  signal: string,
  opts: { requireSignalHash?: boolean; mismatch?: string } = {},
): Promise<ProofCheck> {
  if (!worldIdReady) return { ok: false, status: 503, error: "World ID is not configured" };
  const response = result?.responses?.[0];
  if (!response?.nullifier) return { ok: false, status: 400, error: "no World ID proof in the request" };
  if (result.action && result.action !== config.worldId.action) return { ok: false, status: 400, error: "proof is for a different action" };

  const expected = String(hashSignal(signal)).toLowerCase();
  const got = response.signal_hash?.toLowerCase();
  if (got ? got !== expected : opts.requireSignalHash) {
    return { ok: false, status: 400, error: opts.mismatch ?? "proof was made for a different account" };
  }

  const res = await fetch(VERIFY_URL(config.worldId.rpId), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(result.environment && result.environment !== "production" && config.worldId.stagingToken
        ? { "x-staging-verification-token": config.worldId.stagingToken }
        : {}),
    },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; detail?: string; code?: string; message?: string };
  if (!res.ok || body.success === false) {
    return { ok: false, status: 400, error: `World ID rejected the proof${body.detail || body.code || body.message ? `: ${body.detail ?? body.code ?? body.message}` : ""}` };
  }
  return { ok: true, nullifier: response.nullifier.toLowerCase(), credential: response.identifier ?? "world-id" };
}

export async function verifyHuman(account: Account, result: IdkitResult): Promise<VerifyOutcome> {
  // The proof must be bound to this customer's wallet (the signal we asked for).
  const proof = await checkProof(result, account.privyWallet);
  if (!proof.ok) return proof;
  const { nullifier, credential } = proof;

  const { rows: others } = await pool.query(
    "select ens_name from accounts where world_nullifier = $1 and privy_user_id <> $2",
    [nullifier, account.privyUserId],
  );
  if (others.length) return { ok: false, status: 409, error: "this World ID has already verified another Takarabako account" };

  const alreadyVerified = Boolean(account.worldVerifiedAt);
  await pool.query(
    "update accounts set world_nullifier = $2, world_credential = $3, world_verified_at = coalesce(world_verified_at, now()) where privy_user_id = $1",
    [account.privyUserId, nullifier, credential],
  );
  if (!alreadyVerified) {
    void unlockVerified(account, credential).catch((err) =>
      console.error("[world-id] unlock failed:", err instanceof Error ? err.message : err),
    );
  }
  return { ok: true, credential, alreadyVerified };
}
```

- [ ] **Step 4: Update the route**

In `backend/src/routes/worldIdRoutes.ts`, replace:

```ts
  res.json({ ...requestContext(account), verified: Boolean(account.worldVerifiedAt) });
```

with:

```ts
  res.json({ ...requestContext(account.privyWallet), verified: Boolean(account.worldVerifiedAt) });
```

- [ ] **Step 5: Type-check and run the existing tests**

Run: `cd backend && npx tsc --noEmit -p . && node --import tsx --test test/worldId.test.ts`
Expected: no type errors; `# pass 7`, `# fail 0`.

- [ ] **Step 6: Commit** (only if the user asked)

```bash
git add backend/src/worldId.ts backend/src/routes/worldIdRoutes.ts backend/test/worldId.test.ts
git commit -m "Split World ID proof checking from recording a verification"
```

---

### Task 2: Share the deposit-login response

**Files:**
- Create: `backend/src/depositLogin.ts`
- Modify: `backend/src/routes/loginQr.ts`
- Modify: `backend/src/accounts.ts`

- [ ] **Step 1: Add `findByWorldNullifier` to `accounts.ts`**, after `findByWallet`:

```ts
/// The account a World ID proof's nullifier was recorded on (verifyHuman).
export async function findByWorldNullifier(nullifier: string): Promise<Account | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from accounts where world_nullifier = $1`, [nullifier.toLowerCase()]);
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Create `backend/src/depositLogin.ts`**

```ts
import type { Address } from "viem";
import type { Account } from "./accounts.js";
import { createSession } from "./sessions.js";
import { chainReady, previewValueOnChain } from "./chain.js";
import { allowanceJson, dailyAllowance } from "./limits.js";

/// A deposit-only session at the cash terminal, and what the terminal shows.
/// Shared by the wallet-QR and World ID logins.
export async function depositLogin(account: Account) {
  const session = await createSession(account.privyUserId, "deposit");
  const balance = chainReady ? await previewValueOnChain(account.boundAddress as Address) : 0;
  return {
    userId: account.privyUserId,
    ensName: account.ensName,
    balance,
    token: session.token,
    scope: session.scope,
    expiresAt: session.expiresAt,
    worldVerified: Boolean(account.worldVerifiedAt),
    limit: allowanceJson(await dailyAllowance(account)), // the deposit terminal shows what's left today
  };
}
```

- [ ] **Step 3: Use it in `routes/loginQr.ts`**

Replace the imports block with:

```ts
import { Router } from "express";
import { z } from "zod";
import { findByWallet } from "../accounts.js";
import { endSession, requireSession } from "../sessions.js";
import { parseWalletFromQr } from "../qr.js";
import { asyncHandler } from "../asyncHandler.js";
import { depositLogin } from "../depositLogin.js";
```

and replace everything from `  const session = await createSession(account.privyUserId, "deposit");` to the closing `});` of `res.json(...)` with:

```ts
  res.json(await depositLogin(account));
```

- [ ] **Step 4: Type-check**

Run: `cd backend && npx tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 5: Commit** (only if the user asked)

```bash
git add backend/src/depositLogin.ts backend/src/routes/loginQr.ts backend/src/accounts.ts
git commit -m "Share the deposit login response between QR and upcoming World ID login"
```

---

### Task 3: World ID login logic (TDD)

**Files:**
- Create: `backend/test/loginWorld.test.ts`
- Create: `backend/src/worldLogin.ts`

- [ ] **Step 1: Write the failing tests** — `backend/test/loginWorld.test.ts`:

```ts
import { test, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { freshDb } from "./helpers.js";

process.env.WORLD_APP_ID = "app_test";
process.env.WORLD_RP_ID = "rp_test";
process.env.WORLD_APP_SIGNING_KEY = `0x${"11".repeat(32)}`;
process.env.WORLD_ACTION = "selfie";
delete process.env.MULTIBAAS_URL; // no chain side effects in tests
delete process.env.ENS_REGISTRY_ADDRESS;

const pool = await freshDb();
const { redis } = await import("../src/redis.js");
const { worldLoginRequest, loginWithWorld } = await import("../src/worldLogin.js");
const accounts = await import("../src/accounts.js");
after(async () => {
  await pool.end();
  redis.disconnect();
});

const ALICE = { privyUserId: "u-alice", email: "a@x.io", privyWallet: "0x00000000000000000000000000000000000000a1", boundAddress: "0x00000000000000000000000000000000000000b1", ensName: "alice.takarabako.eth" };
await accounts.insertAccount(ALICE);
await pool.query("update accounts set world_nullifier = '0xabc123', world_verified_at = now() where privy_user_id = 'u-alice'");

const proof = (signal: string | null, nullifier = "0xABC123") => ({
  protocol_version: "3.0",
  action: "selfie",
  environment: "production",
  responses: [{ identifier: "device", nullifier, ...(signal === null ? {} : { signal_hash: String(hashSignal(signal)) }), proof: "0x1", merkle_root: "0x2" }],
});

let worldCalls = 0;
beforeEach(() => {
  worldCalls = 0;
  mock.method(globalThis, "fetch", async () => {
    worldCalls++;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});

test("a login request is signed and bound to a one-time nonce", async () => {
  const r = await worldLoginRequest();
  assert.match(r.nonce, /^[0-9a-f]{64}$/);
  assert.equal(r.signal, r.nonce);
  assert.equal(r.action, "selfie");
  const ttl = await redis.ttl(`worldlogin:${r.nonce}`);
  assert.ok(ttl > 0 && ttl <= 300);
});

test("a verified human gets a deposit-only session", async () => {
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, proof(nonce));
  assert.equal(r.ok, true);
  const login = (r as { login: { scope: string; ensName: string; token: string; worldVerified: boolean } }).login;
  assert.equal(login.scope, "deposit");
  assert.equal(login.ensName, ALICE.ensName);
  assert.equal(login.worldVerified, true);
  assert.match(login.token, /^[0-9a-f]{64}$/);
});

test("a nonce works once", async () => {
  const { nonce } = await worldLoginRequest();
  assert.equal((await loginWithWorld(nonce, proof(nonce))).ok, true);
  const again = await loginWithWorld(nonce, proof(nonce));
  assert.deepEqual(again, { ok: false, status: 400, error: "This World ID request expired — try again" });
});

test("an unknown nonce is refused without asking World", async () => {
  const r = await loginWithWorld("f".repeat(64), proof("f".repeat(64)));
  assert.equal(r.ok, false);
  assert.equal(worldCalls, 0);
});

test("a proof without a signal hash is refused", async () => {
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, proof(null));
  assert.deepEqual(r, { ok: false, status: 400, error: "proof was made for a different request" });
  assert.equal(worldCalls, 0);
});

test("a proof made for another nonce is refused", async () => {
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, proof("someone-elses-nonce"));
  assert.deepEqual(r, { ok: false, status: 400, error: "proof was made for a different request" });
});

test("a World ID that hasn't verified an account gets sent to the QR", async () => {
  const { nonce } = await worldLoginRequest();
  const r = await loginWithWorld(nonce, proof(nonce, "0xnotlinked"));
  assert.deepEqual(r, { ok: false, status: 404, error: "This World ID isn't linked to a Takarabako account yet — scan your QR instead." });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd backend && node --import tsx --test test/loginWorld.test.ts`
Expected: FAIL, `Cannot find module '../src/worldLogin.js'`.

- [ ] **Step 3: Implement `backend/src/worldLogin.ts`**

```ts
import { randomBytes } from "node:crypto";
import { redis } from "./redis.js";
import { findByWorldNullifier } from "./accounts.js";
import { depositLogin } from "./depositLogin.js";
import { checkProof, requestContext, worldIdReady, type IdkitResult } from "./worldId.js";

/// World ID login at the deposit terminal. We don't know who's there yet, so
/// the proof is bound to a one-time nonce instead of a wallet; the proof's
/// nullifier (World ID's anonymous per-app id for the person) then finds the
/// account that verified with it. Same action as verification, so the
/// nullifier matches the one recorded then.

const NONCE_TTL_S = 300;
const nonceKey = (nonce: string) => `worldlogin:${nonce}`;

export async function worldLoginRequest() {
  const nonce = randomBytes(32).toString("hex");
  await redis.set(nonceKey(nonce), "1", "EX", NONCE_TTL_S);
  return { nonce, ...requestContext(nonce) };
}

export type WorldLoginOutcome =
  | { ok: true; login: Awaited<ReturnType<typeof depositLogin>> }
  | { ok: false; status: number; error: string };

export async function loginWithWorld(nonce: string, result: IdkitResult): Promise<WorldLoginOutcome> {
  if (!worldIdReady) return { ok: false, status: 503, error: "World ID is not configured" };
  // Spend the nonce first: each request logs in at most once, even if two race.
  if (!/^[0-9a-f]{64}$/.test(nonce) || (await redis.del(nonceKey(nonce))) !== 1) {
    return { ok: false, status: 400, error: "This World ID request expired — try again" };
  }
  const proof = await checkProof(result, nonce, { requireSignalHash: true, mismatch: "proof was made for a different request" });
  if (!proof.ok) return proof;

  const account = await findByWorldNullifier(proof.nullifier);
  if (!account) {
    return { ok: false, status: 404, error: "This World ID isn't linked to a Takarabako account yet — scan your QR instead." };
  }
  return { ok: true, login: await depositLogin(account) };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --import tsx --test test/loginWorld.test.ts`
Expected: `# pass 7`, `# fail 0`.

If "a verified human gets a deposit-only session" fails inside `dailyAllowance`, read `backend/src/limits.ts` and look at how `backend/test/limits.test.ts` sets up accounts; don't mock it away.

- [ ] **Step 5: Commit** (only if the user asked)

```bash
git add backend/src/worldLogin.ts backend/test/loginWorld.test.ts
git commit -m "Log in to the deposit terminal with a World ID proof"
```

---

### Task 4: Backend routes

**Files:**
- Create: `backend/src/routes/loginWorld.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Create `backend/src/routes/loginWorld.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { worldIdReady, type IdkitResult } from "../worldId.js";
import { loginWithWorld, worldLoginRequest } from "../worldLogin.js";

/// World ID login at the deposit terminal (see worldLogin.ts). No session
/// needed: the proof is what identifies the customer. Deposit-only, like /login/qr.
export const loginWorldRouter = Router();

/// GET /login/world/request — a signed World ID request bound to a one-time nonce.
loginWorldRouter.get("/login/world/request", asyncHandler(async (_req, res) => {
  if (!worldIdReady) {
    res.status(503).json({ error: "World ID login isn't available" });
    return;
  }
  res.json(await worldLoginRequest());
}));

const LoginWorldBody = z.object({
  nonce: z.string().min(1).max(128),
  result: z.object({ responses: z.array(z.unknown()) }).passthrough(),
});

/// POST /login/world { nonce, result } — the IDKit result from World App.
loginWorldRouter.post("/login/world", asyncHandler(async (req, res) => {
  const parsed = LoginWorldBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "World ID proof required" });
    return;
  }
  const outcome = await loginWithWorld(parsed.data.nonce, parsed.data.result as unknown as IdkitResult);
  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }
  res.json(outcome.login);
}));
```

- [ ] **Step 2: Mount it in `backend/src/index.ts`**

Add after `import { loginQrRouter } from "./routes/loginQr.js";`:

```ts
import { loginWorldRouter } from "./routes/loginWorld.js";
```

Add after `app.use(loginQrRouter);`:

```ts
app.use(loginWorldRouter);
```

- [ ] **Step 3: Type-check, run both World test files, then smoke-test the running backend**

Run: `cd backend && npx tsc --noEmit -p . && node --import tsx --test test/worldId.test.ts test/loginWorld.test.ts`
Expected: no type errors; `# fail 0`.

The dev backend (`tsx watch`) reloads on save. Then:

Run: `curl -s localhost:4000/login/world/request | head -c 300; echo; curl -s -X POST localhost:4000/login/world -H 'content-type: application/json' -d '{}'`
Expected: first prints JSON with `"nonce"`, `"action":"selfie"`, `"environment":"production"`, `"preset":"device"`; second prints `{"error":"World ID proof required"}`.

- [ ] **Step 4: Commit** (only if the user asked)

```bash
git add backend/src/routes/loginWorld.ts backend/src/index.ts
git commit -m "Add World ID login routes for the deposit terminal"
```

---

### Task 5: Shared IDKit hook, used by the selfie page

**Files:**
- Create: `frontend/lib/useWorldProof.ts`
- Modify: `frontend/components/WorldSelfie.tsx`

- [ ] **Step 1: Create `frontend/lib/useWorldProof.ts`**

```ts
"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { deviceLegacy, selfieCheck, selfieCheckLegacy, useIDKitRequest, type RpContext } from "@worldcoin/idkit";

/// A signed World ID request from the backend (worldId.ts requestContext).
export interface WorldRequest {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  preset?: "device" | "selfie" | "selfie-v4";
  signal: string;
  rp_context: RpContext;
}

/// The credential the backend asked for (WORLD_PRESET).
function presetFor({ preset, signal }: WorldRequest) {
  if (preset === "selfie-v4") return { allow_legacy_proofs: false, preset: selfieCheck({ signal }) };
  if (preset === "device") return { allow_legacy_proofs: true, preset: deviceLegacy({ signal }) };
  return { allow_legacy_proofs: true, preset: selfieCheckLegacy({ signal }) };
}

export type WorldProofStatus = "open" | "approve" | "success" | "error";

/// Runs one World ID request: opens it once, draws the World App QR, and
/// reports where it is. The caller sends `result` to the backend on success.
export function useWorldProof(request: WorldRequest) {
  const flow = useIDKitRequest({
    app_id: request.app_id,
    action: request.action,
    rp_context: request.rp_context,
    environment: request.environment,
    ...presetFor(request),
  });
  const [qr, setQr] = useState<string | null>(null);
  const opened = useRef(false);

  // Start the request once; IDKit then waits for World App.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    flow.open();
  }, [flow]);

  useEffect(() => {
    if (!flow.connectorURI) return;
    let cancelled = false;
    QRCode.toDataURL(flow.connectorURI, { width: 320, margin: 1, color: { dark: "#120807", light: "#f4e9da" } })
      .then((url) => !cancelled && setQr(url))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [flow.connectorURI]);

  const status: WorldProofStatus =
    flow.isSuccess && flow.result ? "success" : flow.isError ? "error" : flow.isAwaitingUserConfirmation ? "approve" : "open";
  return {
    status,
    qr,
    connectorURI: flow.connectorURI ?? null,
    result: flow.isSuccess ? flow.result : null,
    errorCode: flow.errorCode ?? null,
  };
}
```

- [ ] **Step 2: Rewrite `frontend/components/WorldSelfie.tsx` on the hook** (same UI and text as today)

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useWorldProof, type WorldRequest } from "@/lib/useWorldProof";

/// The World ID selfie, taken right after the customer creates their wallet.
/// The backend signs the request and binds it to that wallet's address (the
/// signal), so the proof can only ever verify this account. On a phone the
/// button opens World App directly; on a computer, scan the code with it.
/// Until they verify, the account can move $1,000 a day.
export function WorldSelfie({ onVerified }: { onVerified: () => void }) {
  const [request, setRequest] = useState<WorldRequest | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function start() {
    setLoading(true);
    setError("");
    try {
      // A fresh signed request each time (they expire after a few minutes).
      const res = await fetch("/api/worldid/request");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "couldn't start World ID");
      setRequest(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't start World ID");
    } finally {
      setLoading(false);
    }
  }

  if (!request) {
    return (
      <>
        {error && <div className="notice error">{error}</div>}
        <button className="btn btn-gold btn-block" onClick={start} disabled={loading}>
          {loading ? "Preparing…" : "Take my World ID selfie"}
        </button>
      </>
    );
  }
  return <SelfieFlow request={request} onVerified={onVerified} onRestart={() => setRequest(null)} />;
}

function SelfieFlow({ request, onVerified, onRestart }: { request: WorldRequest; onVerified: () => void; onRestart: () => void }) {
  const proof = useWorldProof(request);
  const [status, setStatus] = useState<"waiting" | "checking" | "done" | "error">("waiting");
  const [error, setError] = useState("");
  const submitted = useRef(false);

  useEffect(() => {
    // The proof is sent once.
    if (proof.status !== "success" || !proof.result || submitted.current) return;
    submitted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("checking");
    fetch("/api/me/worldid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proof.result) })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "verification failed");
        setStatus("done");
        setTimeout(onVerified, 1200);
      })
      .catch((e) => {
        setStatus("error");
        setError(e instanceof Error ? e.message : "verification failed");
      });
  }, [proof.status, proof.result, onVerified]);

  if (status === "done") return <p className="world-done">✓ Verified — no daily limit on your box.</p>;

  const failure = status === "error" ? error : proof.status === "error" ? `World ID didn't finish (${proof.errorCode ?? "error"}).` : "";
  if (failure) {
    return (
      <>
        <div className="notice error">{failure}</div>
        <button className="btn btn-block" onClick={onRestart}>Try again</button>
      </>
    );
  }

  return (
    <div className="world-flow">
      {status === "waiting" && proof.status === "open" && (
        <>
          <a className={`btn btn-gold btn-block${proof.connectorURI ? "" : " is-disabled"}`} href={proof.connectorURI ?? undefined}>
            Open World App
          </a>
          <details className="world-qr-alt">
            <summary className="muted small">On a computer? Scan with your phone instead</summary>
            <div className="world-code">
              {/* A generated data URL — next/image adds nothing here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {proof.qr ? <img src={proof.qr} alt="World ID QR code — scan with World App" width={220} height={220} /> : <span className="muted small">Preparing the code…</span>}
            </div>
          </details>
        </>
      )}
      <p className="small" style={{ textAlign: "center", margin: "10px 0 0" }}>
        {status === "checking" ? "Checking your proof with World…" : proof.status === "approve" ? "Take the selfie and approve in World App…" : "World App asks for a quick selfie, then comes back here."}
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Type-check and lint**

Run: `cd frontend && npx tsc --noEmit -p . && npx eslint lib/useWorldProof.ts components/WorldSelfie.tsx`
Expected: no output. If eslint reports an unused `eslint-disable` directive for `set-state-in-effect`, remove that comment line.

- [ ] **Step 4: Commit** (only if the user asked)

```bash
git add frontend/lib/useWorldProof.ts frontend/components/WorldSelfie.tsx
git commit -m "Share the IDKit request handling in a useWorldProof hook"
```

---

### Task 6: Frontend API routes

**Files:**
- Create: `frontend/app/api/kiosk/login-world/request/route.ts`
- Create: `frontend/app/api/kiosk/login-world/route.ts`

- [ ] **Step 1: Create `frontend/app/api/kiosk/login-world/request/route.ts`**

```ts
import { NextResponse } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";

/// GET /api/kiosk/login-world/request — a World ID request bound to a one-time nonce.
export async function GET() {
  try {
    return NextResponse.json(await backendFetch("/login/world/request"));
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 2: Create `frontend/app/api/kiosk/login-world/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { backendFetch, errorResponse } from "@/lib/backend";
import { kioskLoginResponse } from "@/lib/kiosk";

/// POST /api/kiosk/login-world { nonce, result } — World ID login (deposit only).
export async function POST(req: NextRequest) {
  const { nonce, result } = (await req.json().catch(() => ({}))) as { nonce?: string; result?: unknown };
  if (!nonce || !result) return NextResponse.json({ error: "World ID proof required" }, { status: 400 });
  try {
    return await kioskLoginResponse(req, await backendFetch("/login/world", { body: { nonce, result } }));
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 3: Type-check and smoke-test**

Run: `cd frontend && npx tsc --noEmit -p . && curl -s localhost:3000/api/kiosk/login-world/request | head -c 200; echo; curl -s -X POST localhost:3000/api/kiosk/login-world -H 'content-type: application/json' -d '{}'`
Expected: JSON with `"nonce"`; then `{"error":"World ID proof required"}`.

- [ ] **Step 4: Commit** (only if the user asked)

```bash
git add frontend/app/api/kiosk/login-world
git commit -m "Proxy World ID login for the deposit terminal"
```

---

### Task 7: World ID tab on the deposit terminal

**Files:**
- Create: `frontend/app/kiosk/WorldLogin.tsx`
- Modify: `frontend/app/kiosk/KioskApp.tsx`
- Modify: `frontend/app/globals.css`

- [ ] **Step 1: Create `frontend/app/kiosk/WorldLogin.tsx`**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { KioskLogin } from "@/lib/types";
import { useWorldProof, type WorldRequest } from "@/lib/useWorldProof";

type LoginRequest = WorldRequest & { nonce: string };

/// World ID login at the deposit terminal: the customer scans this code with
/// World App on their phone. Only works for accounts verified with World ID;
/// everyone else is sent back to their wallet QR.
export function WorldLogin({ onLogin, onUseQr }: { onLogin: (login: KioskLogin) => void; onUseQr: () => void }) {
  const [request, setRequest] = useState<LoginRequest | null>(null);
  const [error, setError] = useState("");

  function load() {
    fetch("/api/kiosk/login-world/request")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "World ID login isn't available");
        setRequest(body);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "World ID login isn't available"));
  }

  useEffect(() => {
    load(); // one request per mount; retry() asks for the next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function retry() {
    setRequest(null);
    setError("");
    load();
  }

  return (
    <section className="card">
      <p className="label" style={{ textAlign: "center" }}>Log in with World ID</p>
      {error ? (
        <>
          <div className="notice error">{error}</div>
          <button className="btn btn-gold btn-block" onClick={retry}>Try again</button>
        </>
      ) : request ? (
        <WorldLoginFlow key={request.nonce} request={request} onLogin={onLogin} onError={setError} />
      ) : (
        <p className="muted small" style={{ textAlign: "center" }}>Preparing the code…</p>
      )}
      <button className="btn btn-block" onClick={onUseQr}>Scan my QR instead</button>
    </section>
  );
}

function WorldLoginFlow({
  request,
  onLogin,
  onError,
}: {
  request: LoginRequest;
  onLogin: (login: KioskLogin) => void;
  onError: (message: string) => void;
}) {
  const proof = useWorldProof(request);
  const [checking, setChecking] = useState(false);
  const submitted = useRef(false);

  useEffect(() => {
    if (proof.status === "error") {
      onError(`World ID didn't finish (${proof.errorCode ?? "error"}).`);
      return;
    }
    // The proof is sent once.
    if (proof.status !== "success" || !proof.result || submitted.current) return;
    submitted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChecking(true);
    fetch("/api/kiosk/login-world", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: request.nonce, result: proof.result }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "World ID login failed");
        onLogin(body as KioskLogin);
      })
      .catch((e) => onError(e instanceof Error ? e.message : "World ID login failed"));
  }, [proof.status, proof.result, proof.errorCode, request.nonce, onLogin, onError]);

  return (
    <>
      <p className="muted small" style={{ textAlign: "center" }}>Scan this code with World App on your phone, then approve.</p>
      <div className="world-code">
        {/* A generated data URL — next/image adds nothing here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {proof.qr ? <img src={proof.qr} alt="World ID QR code — scan with World App" width={260} height={260} /> : <span className="muted small">Preparing the code…</span>}
      </div>
      <p className="muted small" style={{ textAlign: "center" }}>
        {checking ? "Checking with World…" : proof.status === "approve" ? "Approve in World App…" : "For accounts verified with World ID."}
      </p>
    </>
  );
}
```

- [ ] **Step 2: Wire it into `frontend/app/kiosk/KioskApp.tsx`**

a) Import, after the `DepositFlow` import:

```tsx
import { WorldLogin } from "./WorldLogin";
```

b) Greeting — replace:

```tsx
  deposit: "いらっしゃいませ! Show me your QR to deposit.",
```

with:

```tsx
  deposit: "いらっしゃいませ! Show me your QR, or log in with World ID, to deposit.",
```

c) State — after `const [refusal, setRefusal] = useState<Refusal | null>(null);` add:

```tsx
  // Deposit terminal: which login the scan screen shows.
  const [loginVia, setLoginVia] = useState<"qr" | "world">("qr");
```

d) In `logout`, after `setScreen(startScreen);` add:

```tsx
    setLoginVia("qr");
```

e) Deposit-mode welcome card — replace the `Scan my QR` button:

```tsx
            <button className="btn btn-gold btn-block" disabled={busy} onClick={() => { setMessage(""); setScreen("scan"); }}>
              {busy ? "Checking your QR…" : "Scan my QR"}
            </button>
```

with:

```tsx
            <button className="btn btn-gold btn-block" disabled={busy} onClick={() => { setMessage(""); setLoginVia("qr"); setScreen("scan"); }}>
              {busy ? "Checking your QR…" : "Scan my QR"}
            </button>
            <button className="btn btn-block" disabled={busy} onClick={() => { setMessage(""); setLoginVia("world"); setScreen("scan"); }}>
              Log in with World ID
            </button>
```

f) Scan screen — replace the whole block:

```tsx
        {screen === "scan" && (
          <Scanner
```

…through its closing `)}` with:

```tsx
        {screen === "scan" && depositOnly && (
          <div className="login-tabs" role="tablist" aria-label="How to log in">
            <button role="tab" aria-selected={loginVia === "qr"} onClick={() => setLoginVia("qr")}>Scan my QR</button>
            <button role="tab" aria-selected={loginVia === "world"} onClick={() => setLoginVia("world")}>World ID</button>
          </div>
        )}

        {screen === "scan" && depositOnly && loginVia === "world" && (
          <WorldLogin onLogin={startSession} onUseQr={() => setLoginVia("qr")} />
        )}

        {screen === "scan" && !(depositOnly && loginVia === "world") && (
          <Scanner
            onResult={onQr}
            onCancel={(why) => { setMessage(why ?? ""); setScreen("welcome"); }}
            hint={depositOnly ? "Open My QR on your phone, then hold it up to the camera." : undefined}
            fallback={depositOnly ? "check the camera is connected and allowed, then tap Scan my QR" : "log in with email instead"}
          />
        )}
```

Switching to the World ID tab unmounts `Scanner`, whose cleanup stops the camera; switching back unmounts `WorldLogin`, dropping its request.

- [ ] **Step 3: Styles — append to `frontend/app/globals.css`** after the `.kiosk-limit` rule:

```css
/* ---------- Deposit terminal: QR or World ID login ---------- */
.login-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 4px;
  margin-bottom: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.login-tabs button {
  padding: 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}

.login-tabs button[aria-selected="true"] {
  background: var(--gold-soft);
  color: var(--gold);
}
```

- [ ] **Step 4: Type-check, lint, build**

Run: `cd frontend && npx tsc --noEmit -p . && npx eslint app/kiosk lib/useWorldProof.ts components/WorldSelfie.tsx`
Expected: no output.

- [ ] **Step 5: Commit** (only if the user asked)

```bash
git add frontend/app/kiosk/WorldLogin.tsx frontend/app/kiosk/KioskApp.tsx frontend/app/globals.css
git commit -m "Add World ID login to the deposit terminal"
```

---

### Task 8: Verify end to end

- [ ] **Step 1: Full backend test suite**

Run: `cd backend && npm test`
Expected: the new tests pass. Report any other failures with their output, and say whether they touch files this plan changed. Don't stash or reset: the working tree has the user's uncommitted work.

- [ ] **Step 2: Screenshot the deposit terminal** with Playwright/chromium at `http://localhost:3000/deposit`: click the **World ID** tab and check the World ID QR code renders. Look at the screenshot.

- [ ] **Step 3: Live test with the user** (needs their phone):
  - `aqiljeff@gmail.com` is verified: on `/deposit` → World ID tab → scan with World App → approve → the terminal shows "Depositing to aqiljeff-6263.takarabako.eth".
  - Tap Done; the terminal returns to the QR tab.
  - A World ID not linked to any account (or after clearing aqiljeff's nullifier, only with the user's OK) → "This World ID isn't linked to a Takarabako account yet — scan your QR instead."
  - `/verify` selfie still works (Task 5 refactor).
