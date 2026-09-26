# Web App Phase 1 (Backend Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable, retrying deposits (Redis + BullMQ), a per-user live event stream (SSE), Privy access-token login, and the data endpoints the Next.js app needs.

**Architecture:** `/deposit` records a `queued` row in Postgres and enqueues a BullMQ job; a worker in the backend process sends the transaction idempotently (a stored `tx_hash` is only awaited, never resent). Every state change is published on Redis channel `user:<privyUserId>`; `GET /events/stream` relays it as SSE. `POST /auth/privy` turns a verified Privy access token into a `full` session.

**Tech Stack:** Express/TypeScript, `pg`, `ioredis`, `bullmq`, `jose` (via `@privy-io/node`), `node:test`.

Spec: `docs/superpowers/specs/2026-09-26-web-app-design.md` (Phase 1). Prerequisite: QR-login plan tasks 1, 4, 5, 8 passing (Postgres up, sessions tested).

**Commits:** only on the user's explicit request.

---

## File map

| File | Responsibility |
|---|---|
| `backend/docker-compose.yml` | add Redis (AOF) |
| `backend/migrations/002_deposit_queue.sql` | deposit status columns |
| `backend/src/redis.ts` | shared Redis connections |
| `backend/src/events.ts` | publish/subscribe per-user events |
| `backend/src/depositQueue.ts` | BullMQ queue + worker + idempotent processor |
| `backend/src/routes/deposit.ts` | enqueue instead of sending inline |
| `backend/src/routes/events.ts` | `GET /events/stream` (SSE) |
| `backend/src/routes/authPrivy.ts` | `POST /auth/privy` |
| `backend/src/accountsFlow.ts` | find-or-create account (shared by `/verify` and `/auth/privy`) |
| `backend/src/routes/me.ts` | `GET /me`, `GET /deposits`, `GET /me/qr` |
| `backend/src/db.ts` | run every migration in order |
| `device-agent/server.js` | pending/confirmed from the backend stream |
| `backend/test/depositQueue.test.ts` | idempotency + state transitions |

---

### Task 1: Redis in Docker

- [ ] Add to `backend/docker-compose.yml` services:

```yaml
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "6379:6379"
    volumes:
      - takarabako-redis:/data
```
and `takarabako-redis:` under `volumes`.
- [ ] `.env` / `.env.example`: `REDIS_URL=redis://localhost:6379`
- [ ] `config.ts`: `redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",`
- [ ] Run `docker compose up -d && docker compose exec -T redis redis-cli ping` → `PONG`.

### Task 2: Migrations run in order

- [ ] `backend/migrations/002_deposit_queue.sql`:

```sql
alter table deposits add column if not exists status text not null default 'confirmed'
  check (status in ('queued', 'sending', 'confirmed', 'failed'));
alter table deposits add column if not exists attempts int not null default 0;
alter table deposits add column if not exists error text;
alter table deposits add column if not exists updated_at timestamptz not null default now();
alter table deposits alter column tx_hash drop not null;
alter table deposits alter column usd_amount drop not null;
create index if not exists deposits_user_created on deposits (privy_user_id, created_at desc);
```

- [ ] `db.ts` `migrate()` runs every `migrations/*.sql` in filename order (all statements are idempotent):

```ts
import { readdir, readFile } from "node:fs/promises";
// …
export async function migrate() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is not set — see backend/.env.example");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await pool.query(await readFile(new URL(file, dir), "utf8"));
  }
}
```

- [ ] `npm test` still passes (accounts test's `recordDeposit` row now defaults to `confirmed`).

### Task 3: Redis + events

- [ ] `npm install ioredis bullmq`
- [ ] `src/redis.ts`:

```ts
import { Redis } from "ioredis";
import { config } from "./config.js";

/// One connection for commands/publishing. BullMQ and each SSE subscriber
/// need their own (a subscribed connection can't run other commands).
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export function newRedisConnection() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}
```

- [ ] `src/events.ts`:

```ts
import { redis, newRedisConnection } from "./redis.js";

/// Per-user live events (deposit pending/confirmed/failed …). Published on
/// Redis so every backend instance's SSE clients hear them.
export type UserEvent =
  | { type: "deposit.pending"; depositId: string; amount: number; currency: string; estUsd: number | null }
  | { type: "deposit.retrying"; depositId: string; attempt: number; maxAttempts: number; error: string }
  | { type: "deposit.confirmed"; depositId: string; amount: number; currency: string; usdAmount: number; fxRate: number; txHash: string; balance: number }
  | { type: "deposit.failed"; depositId: string; amount: number; currency: string; error: string };

const channel = (privyUserId: string) => `user:${privyUserId}`;

export async function publishUserEvent(privyUserId: string, event: UserEvent) {
  await redis.publish(channel(privyUserId), JSON.stringify({ ...event, ts: Date.now() }));
}

/// Calls `onEvent` for each event on the user's channel until the returned
/// function is called.
export async function subscribeUserEvents(privyUserId: string, onEvent: (json: string) => void) {
  const sub = newRedisConnection();
  await sub.subscribe(channel(privyUserId));
  sub.on("message", (_ch, message) => onEvent(message));
  return async () => {
    await sub.unsubscribe();
    sub.disconnect();
  };
}
```

### Task 4: Accounts queries for the queue

- [ ] Replace `recordDeposit` in `src/accounts.ts` with queue-aware functions:

```ts
export interface DepositRow {
  id: string;
  privyUserId: string;
  currency: string;
  amount: number;
  usdAmount: number | null;
  txHash: string | null;
  status: "queued" | "sending" | "confirmed" | "failed";
  attempts: number;
  error: string | null;
  createdAt: Date;
}

const DEPOSIT_COLUMNS = `id, privy_user_id as "privyUserId", currency, amount::float, usd_amount::float as "usdAmount",
  tx_hash as "txHash", status, attempts, error, created_at as "createdAt"`;

export async function createQueuedDeposit(d: { privyUserId: string; currency: string; amount: number }): Promise<DepositRow> {
  const { rows } = await pool.query(
    `insert into deposits (id, privy_user_id, currency, amount, status) values ($1, $2, $3, $4, 'queued') returning ${DEPOSIT_COLUMNS}`,
    [crypto.randomUUID(), d.privyUserId, d.currency, d.amount],
  );
  return rows[0];
}

export async function getDeposit(id: string): Promise<DepositRow | null> {
  const { rows } = await pool.query(`select ${DEPOSIT_COLUMNS} from deposits where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function markDepositSending(id: string, txHash: string, usdAmount: number) {
  await pool.query(
    "update deposits set status = 'sending', tx_hash = $2, usd_amount = $3, attempts = attempts + 1, updated_at = now() where id = $1",
    [id, txHash, usdAmount],
  );
}

export async function markDepositConfirmed(id: string) {
  await pool.query("update deposits set status = 'confirmed', error = null, updated_at = now() where id = $1", [id]);
}

export async function markDepositFailed(id: string, error: string, final: boolean) {
  await pool.query(
    `update deposits set error = $2, status = case when $3 then 'failed' else status end, updated_at = now() where id = $1`,
    [id, error, final],
  );
}

export async function listDeposits(privyUserId: string, limit: number): Promise<DepositRow[]> {
  const { rows } = await pool.query(
    `select ${DEPOSIT_COLUMNS} from deposits where privy_user_id = $1 order by created_at desc limit $2`,
    [privyUserId, limit],
  );
  return rows;
}
```

- [ ] Update `test/accounts.test.ts`'s deposit test to `createQueuedDeposit` → `getDeposit` (status `queued`).

### Task 5: chain.ts — split send and wait

- [ ] Expose the two halves so the worker can store the hash between them:

```ts
/// Sends depositFor and returns the hash without waiting (queued send, 30% gas headroom).
export async function sendDepositTx(user: Address, usdAmount: number): Promise<`0x${string}`> { /* body of today's queueSend(...) with parseUnits */ }

/// Waits for a deposit tx; throws if it reverted. Returns the user's vault value afterwards.
export async function waitForDepositTx(hash: `0x${string}`, user: Address): Promise<number> { /* waitForTransactionReceipt + status check + previewValueOnChain */ }
```
`depositOnChain` becomes `sendDepositTx` + `waitForDepositTx` (kept for any other caller).

### Task 6: Deposit queue + idempotent processor (TDD)

- [ ] Failing test `test/depositQueue.test.ts` — the processor with injected chain functions:

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const { processDeposit } = await import("../src/depositQueue.js");
after(() => pool.end());

await accounts.insertAccount({
  privyUserId: "did:privy:q1", email: "q@example.com",
  privyWallet: "0x0000000000000000000000000000000000000011",
  boundAddress: "0x0000000000000000000000000000000000000022", ensName: null,
});

function fakeChain() {
  const calls = { sent: 0, waited: [] as string[] };
  return {
    calls,
    deps: {
      toUsd: async (amount: number) => ({ usdAmount: amount * 0.25, rate: 0.25, source: "test" }),
      send: async () => { calls.sent++; return "0xfeed" as `0x${string}`; },
      wait: async (hash: string) => { calls.waited.push(hash); return 12.5; },
      publish: async () => {},
    },
  };
}

test("fresh deposit: sends once, stores hash, confirms", async () => {
  const d = await accounts.createQueuedDeposit({ privyUserId: "did:privy:q1", currency: "MYR", amount: 10 });
  const { calls, deps } = fakeChain();
  await processDeposit(d.id, deps);
  assert.equal(calls.sent, 1);
  const row = await accounts.getDeposit(d.id);
  assert.equal(row?.status, "confirmed");
  assert.equal(row?.txHash, "0xfeed");
  assert.equal(row?.usdAmount, 2.5);
});

test("retry after a crash with a stored hash never resends", async () => {
  const d = await accounts.createQueuedDeposit({ privyUserId: "did:privy:q1", currency: "MYR", amount: 1 });
  await accounts.markDepositSending(d.id, "0xalready", 0.25);
  const { calls, deps } = fakeChain();
  await processDeposit(d.id, deps);
  assert.equal(calls.sent, 0);
  assert.deepEqual(calls.waited, ["0xalready"]);
  assert.equal((await accounts.getDeposit(d.id))?.status, "confirmed");
});

test("already-confirmed job is a no-op", async () => {
  const d = await accounts.createQueuedDeposit({ privyUserId: "did:privy:q1", currency: "MYR", amount: 5 });
  await accounts.markDepositSending(d.id, "0xdone", 1.25);
  await accounts.markDepositConfirmed(d.id);
  const { calls, deps } = fakeChain();
  await processDeposit(d.id, deps);
  assert.equal(calls.sent, 0);
  assert.equal(calls.waited.length, 0);
});
```

- [ ] Run `npm test` → FAIL (module not found).
- [ ] `src/depositQueue.ts`:

```ts
import { Queue, Worker, type Job } from "bullmq";
import type { Address } from "viem";
import { newRedisConnection } from "./redis.js";
import { getDeposit, findByPrivyUserId, markDepositSending, markDepositConfirmed, markDepositFailed } from "./accounts.js";
import { toUsd } from "./fx.js";
import { sendDepositTx, waitForDepositTx } from "./chain.js";
import { publishUserEvent, type UserEvent } from "./events.js";

/// Durable deposits: the row in Postgres is the record, the BullMQ job is
/// the work item. A worker that dies mid-job is recovered by BullMQ's
/// stalled-job check; a stored tx_hash means "already sent — only wait".
export const DEPOSIT_ATTEMPTS = 5;
const QUEUE = "deposits";

export const depositQueue = new Queue(QUEUE, {
  connection: newRedisConnection(),
  defaultJobOptions: {
    attempts: DEPOSIT_ATTEMPTS,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 1000,
    removeOnFail: false,
  },
});

export async function enqueueDeposit(depositId: string) {
  await depositQueue.add("deposit", { depositId }, { jobId: depositId });
}

export interface ProcessDeps {
  toUsd: (amount: number, currency: "USD" | "MYR") => Promise<{ usdAmount: number; rate: number; source: string }>;
  send: (user: Address, usdAmount: number) => Promise<`0x${string}`>;
  wait: (hash: `0x${string}`, user: Address) => Promise<number>;
  publish: (privyUserId: string, event: UserEvent) => Promise<void>;
}

const liveDeps: ProcessDeps = { toUsd, send: sendDepositTx, wait: waitForDepositTx, publish: publishUserEvent };

export async function processDeposit(depositId: string, deps: ProcessDeps = liveDeps) {
  const row = await getDeposit(depositId);
  if (!row || row.status === "confirmed" || row.status === "failed") return;
  const account = await findByPrivyUserId(row.privyUserId);
  if (!account) throw new Error(`deposit ${depositId}: account missing`);
  const user = account.boundAddress as Address;

  let hash = row.txHash as `0x${string}` | null;
  let usdAmount = row.usdAmount;
  let rate = usdAmount && row.amount ? usdAmount / row.amount : 1;
  if (!hash) {
    const fx = await deps.toUsd(row.amount, row.currency as "USD" | "MYR");
    usdAmount = fx.usdAmount;
    rate = fx.rate;
    hash = await deps.send(user, usdAmount);
    await markDepositSending(depositId, hash, usdAmount); // stored before waiting
  }

  const balance = await deps.wait(hash, user);
  await markDepositConfirmed(depositId);
  await deps.publish(row.privyUserId, {
    type: "deposit.confirmed", depositId, amount: row.amount, currency: row.currency,
    usdAmount: usdAmount!, fxRate: rate, txHash: hash, balance,
  });
}

export function startDepositWorker() {
  const worker = new Worker(QUEUE, (job: Job<{ depositId: string }>) => processDeposit(job.data.depositId), {
    connection: newRedisConnection(),
    concurrency: 1, // sends are serialised anyway; keeps receipt waits simple
  });
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= DEPOSIT_ATTEMPTS;
    const row = await getDeposit(job.data.depositId);
    await markDepositFailed(job.data.depositId, err.message, final);
    if (!row) return;
    await publishUserEvent(row.privyUserId, final
      ? { type: "deposit.failed", depositId: row.id, amount: row.amount, currency: row.currency, error: err.message }
      : { type: "deposit.retrying", depositId: row.id, attempt: job.attemptsMade, maxAttempts: DEPOSIT_ATTEMPTS, error: err.message });
  });
  return worker;
}
```

- [ ] Run `npm test` → pass.

### Task 7: `/deposit` enqueues

- [ ] Handler: validate → `findByPrivyUserId` → `createQueuedDeposit` → `estimate = (await toUsd(amount, currency)).usdAmount` (cached rate, fast) → `enqueueDeposit(row.id)` → `publishUserEvent(... deposit.pending ...)` → `res.status(202).json({ depositId: row.id, estUsd: estimate, expiresAt: session.expiresAt })`. If the enqueue throws (Redis down) → mark row failed, `503`.
- [ ] `index.ts`: after `migrate()`, `startDepositWorker()`.

### Task 8: SSE stream

- [ ] `src/routes/events.ts`:

```ts
import { Router } from "express";
import { requireSession } from "../sessions.js";
import { subscribeUserEvents } from "../events.js";
import { asyncHandler } from "../asyncHandler.js";

/// GET /events/stream — Server-Sent Events of the session user's live
/// events. 20s heartbeat keeps proxies from closing an idle stream.
export const eventsRouter = Router();

eventsRouter.get("/events/stream", requireSession("deposit"), asyncHandler(async (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const unsubscribe = await subscribeUserEvents(res.locals.session.privyUserId, (json) => res.write(`data: ${json}\n\n`));
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    void unsubscribe();
  });
}));
```
- [ ] Register in `index.ts`.

### Task 9: Shared account flow + `/auth/privy`

- [ ] Move the find-or-create block from `routes/verify.ts` into `src/accountsFlow.ts` as `ensureAccount({ privyUserId, email, walletAddress })` returning `{ account, isNew, ensTxHash, qrEmailed, qrFallback }`; `/verify` calls it.
- [ ] `src/privy.ts` adds:

```ts
import { verifyAccessToken } from "@privy-io/node";
import { createRemoteJWKSet } from "jose";

const jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${config.privy.appId}/jwks.json`));

/// Verifies a web login and returns the Privy user's email + Ethereum wallet,
/// creating the wallet if they registered on the web before ever using the kiosk.
export async function userFromAccessToken(accessToken: string) {
  const { user_id } = await verifyAccessToken({ access_token: accessToken, app_id: config.privy.appId, verification_key: jwks });
  let user = await privy.users()._get(user_id);
  const email = user.linked_accounts.find((a) => a.type === "email");
  if (!email || !("address" in email)) throw new Error("Privy user has no email");
  let walletAddress = findEthereumWallet(user.linked_accounts);
  if (!walletAddress) {
    user = await privy.users().pregenerateWallets(user_id, { wallets: [{ chain_type: "ethereum" }] });
    walletAddress = findEthereumWallet(user.linked_accounts);
  }
  if (!walletAddress) throw new Error(`Privy user ${user_id} has no ethereum wallet`);
  return { userId: user_id, email: email.address as string, walletAddress };
}
```
(`jose` ships with `@privy-io/node`; add it as a direct dependency.)
- [ ] `src/routes/authPrivy.ts`: `POST /auth/privy { accessToken }` → `userFromAccessToken` (401 on `InvalidAuthTokenError`) → `ensureAccount` → `createSession(userId, "full")` → same JSON shape as `/verify`.

### Task 10: Data endpoints

- [ ] `src/routes/me.ts`, all `requireSession("full")`:
  - `GET /me` → `{ ensName, privyWallet, balance (previewValueOnChain), apyBps (currentApyBpsOnChain), positions: store.getPositions(user) }`
  - `GET /deposits?limit=20` → `listDeposits(user, min(limit, 100))`
  - `GET /me/qr` → `{ wallet, dataUrl: await QRCode.toDataURL(account.privyWallet, { width: 480, margin: 2 }) }`
- [ ] CORS `Allow-Methods` gains `GET` (already) — no change.

### Task 11: Bridge uses the backend stream

- [ ] `device-agent/server.js`: `handlePulseDeposit` posts to `/deposit`, gets `202 { depositId, estUsd }`, records a `pending` event keyed by `depositId`, returns immediately. On session start, open `GET /events/stream` with the token (Node `fetch` streaming body, parse `data:` lines); map `deposit.confirmed`/`deposit.failed`/`deposit.retrying` onto the existing kiosk events by `depositId`. Close the stream on session end.
- [ ] Serial listener unchanged (it only needs the bridge to accept the note).

### Task 12: Verification

- [ ] `npx tsc --noEmit && npm test` clean.
- [ ] curl: `/me`, `/deposits`, `/me/qr` with a full token; 403 with a deposit token.
- [ ] `curl -N /events/stream` in one terminal, `POST /deposit` in another → `deposit.pending` then `deposit.confirmed` (one real Sepolia tx; check treasury gas first).
- [ ] Crash test: enqueue a deposit, kill the backend right after `deposit.pending`, restart → the job resumes (stalled-job recovery) and confirms exactly once (`cast` shows one tx).
- [ ] Live: RM10 at the kiosk → kiosk pending → confirmed via the stream.
