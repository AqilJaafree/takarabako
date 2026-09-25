# QR Quick Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Returning customers deposit cash by showing a QR of their Privy wallet address to the kiosk camera (deposit-only session); email login keeps full access. Accounts, sessions and deposits live in Postgres.

**Architecture:** Postgres (Docker, laptop) holds `accounts`, `sessions`, `deposits`. The backend issues bearer tokens scoped `full` (email login) or `deposit` (QR login) and a `requireSession` middleware enforces scope on every money route. The kiosk decodes QR codes in the browser with a vendored jsQR; the Pi bridge carries the token instead of a raw userId.

**Tech Stack:** TypeScript/Express backend, `pg`, `qrcode`, `resend`, `node:test` via tsx; vanilla JS kiosk with jsQR 1.4.0; Node bridge on the Pi.

Spec: `docs/superpowers/specs/2026-09-26-qr-quick-login-design.md`

**Commits:** the user commits only on explicit request (standing instruction), so tasks end with a verification step, not a commit. Ask before committing at the end.

---

## File map

| File | Responsibility |
|---|---|
| `backend/docker-compose.yml` (new) | Postgres 16 container |
| `backend/migrations/001_init.sql` (new) | Tables |
| `backend/src/db.ts` (new) | Pool + migration |
| `backend/src/qr.ts` (new) | Parse a scanned QR into a wallet address |
| `backend/src/accounts.ts` (new) | Accounts + deposits in Postgres |
| `backend/src/sessions.ts` (new) | Tokens, scope, `requireSession` |
| `backend/src/qrEmail.ts` (new) | QR image + Resend email |
| `backend/src/routes/loginQr.ts` (new) | `POST /login/qr`, `POST /logout` |
| `backend/src/routes/verify.ts` | Email login → full session, first-bind email |
| `backend/src/routes/deposit.ts` / `withdraw.ts` / `agentRoutes.ts` / `position.ts` | Session-based auth |
| `backend/src/store.ts` | Drops accounts/deposits (positions stay) |
| `backend/src/config.ts`, `src/index.ts`, `.env.example`, `package.json` | Wiring |
| `backend/test/*.test.ts` (new) | Unit + DB tests |
| `device-agent/public/vendor/jsQR.js` (new) | QR decoder |
| `device-agent/public/app.js`, `style.css` | Scan screen, deposit-only screen, tokens, withdraw choice |
| `device-agent/server.js` | Token-carrying bridge session with expiry |

---

### Task 1: Postgres in Docker

**Files:** Create `backend/docker-compose.yml`; modify `backend/.env` (local, not committed) and `backend/.env.example`.

- [ ] **Step 1: User starts the Docker daemon** (needs sudo, run in a normal terminal): `sudo systemctl start docker`
- [ ] **Step 2: Write compose file**

```yaml
# Local Postgres for the Takarabako backend (accounts, sessions, deposits).
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: takarabako
      POSTGRES_PASSWORD: takarabako
      POSTGRES_DB: takarabako
    ports:
      - "5432:5432"
    volumes:
      - takarabako-pg:/var/lib/postgresql/data
volumes:
  takarabako-pg:
```

- [ ] **Step 3: Start it and create the test database**

Run: `cd backend && docker compose up -d && sleep 3 && docker compose exec -T postgres createdb -U takarabako takarabako_test`
Expected: container running, no error from createdb.

- [ ] **Step 4: Env vars.** Append to `backend/.env` and `backend/.env.example`:

```
# Postgres (backend/docker-compose.yml)
DATABASE_URL=postgres://takarabako:takarabako@localhost:5432/takarabako
# Resend: API key + a sender on your verified domain. Unset = QR shown on the kiosk instead of emailed.
RESEND_API_KEY=
RESEND_FROM=Takarabako <takarabako@yourdomain>
```

### Task 2: Dependencies, config, migration, db module

**Files:** `backend/package.json`, `backend/src/config.ts`, create `backend/migrations/001_init.sql`, `backend/src/db.ts`.

- [ ] **Step 1: Install**

Run: `cd backend && npm install pg qrcode resend && npm install -D @types/pg @types/qrcode`

- [ ] **Step 2: Add test script** to `package.json` scripts: `"test": "node --import tsx --test test/*.test.ts"`

- [ ] **Step 3: Config** — add to the `config` object in `src/config.ts`:

```ts
  databaseUrl: process.env.DATABASE_URL ?? "",
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM ?? "",
  },
```

- [ ] **Step 4: Migration** `backend/migrations/001_init.sql`:

```sql
create table if not exists accounts (
  privy_user_id text primary key,
  email         text not null unique,
  privy_wallet  text not null unique,
  bound_address text not null,
  ens_name      text,
  qr_emailed_at timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  token         text primary key,
  privy_user_id text not null references accounts on delete cascade,
  scope         text not null check (scope in ('full', 'deposit')),
  expires_at    timestamptz not null
);
create index if not exists sessions_expires_at on sessions (expires_at);

create table if not exists deposits (
  id            uuid primary key,
  privy_user_id text not null references accounts on delete cascade,
  currency      text not null,
  amount        numeric not null,
  usd_amount    numeric not null,
  tx_hash       text not null,
  created_at    timestamptz not null default now()
);
```

- [ ] **Step 5: `src/db.ts`**

```ts
import pg from "pg";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";

/// Postgres holds accounts, sessions and deposits (spec 2026-09-26), so a
/// backend restart no longer forgets who is registered or logged in.
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function migrate() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is not set — see backend/.env.example");
  const sql = await readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8");
  await pool.query(sql);
}
```

- [ ] **Step 6: Verify** `npx tsc --noEmit -p .` → no errors.

### Task 3: QR parsing (TDD)

**Files:** create `backend/test/qr.test.ts`, `backend/src/qr.ts`.

- [ ] **Step 1: Failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWalletFromQr } from "../src/qr.js";

const A = "0x9205DcCC081D896edeAB423d88665660d61d5bfE";

test("plain address, lowercased", () => {
  assert.equal(parseWalletFromQr(A), A.toLowerCase());
});
test("EIP-681 with chain id and query", () => {
  assert.equal(parseWalletFromQr(`ethereum:${A}@11155111?value=0`), A.toLowerCase());
});
test("surrounding whitespace", () => {
  assert.equal(parseWalletFromQr(`  ${A}\n`), A.toLowerCase());
});
test("junk is rejected", () => {
  for (const bad of ["", "hello", "0x1234", `bitcoin:${A}`, `${A}00`]) assert.equal(parseWalletFromQr(bad), null);
});
```

- [ ] **Step 2: Run** `npm test` → FAIL (cannot find `../src/qr.js`).

- [ ] **Step 3: Implement `src/qr.ts`**

```ts
/// Turns the text in a scanned QR into a lowercase wallet address, or null.
/// Accepts a bare address (what the Takarabako email shows) and the EIP-681
/// form wallet apps use for "receive" codes: ethereum:0x…[@chainId][?…].
export function parseWalletFromQr(text: string): string | null {
  let s = text.trim();
  if (s.toLowerCase().startsWith("ethereum:")) s = s.slice("ethereum:".length);
  s = s.split(/[@?/]/)[0];
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}
```

- [ ] **Step 4: Run** `npm test` → 4 pass.

### Task 4: Accounts module (TDD against the test DB)

**Files:** create `backend/test/helpers.ts`, `backend/test/accounts.test.ts`, `backend/src/accounts.ts`.

- [ ] **Step 1: Test helper** `test/helpers.ts` — points the app at the test DB before any module reads config:

```ts
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://takarabako:takarabako@localhost:5432/takarabako_test";

export async function freshDb() {
  const { pool, migrate } = await import("../src/db.js");
  await migrate();
  await pool.query("truncate accounts, sessions, deposits cascade");
  return pool;
}
```

- [ ] **Step 2: Failing test** `test/accounts.test.ts`:

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
after(() => pool.end());

const row = {
  privyUserId: "did:privy:test1",
  email: "a@example.com",
  privyWallet: "0xAbCdEf0000000000000000000000000000000001",
  boundAddress: "0x0000000000000000000000000000000000000abc",
  ensName: "a-1234.wantest.eth",
};

test("insert then find by id and by wallet (case-insensitive)", async () => {
  const created = await accounts.insertAccount(row);
  assert.equal(created.privyWallet, row.privyWallet.toLowerCase());
  assert.equal(created.qrEmailedAt, null);
  assert.equal((await accounts.findByPrivyUserId(row.privyUserId))?.email, row.email);
  assert.equal((await accounts.findByWallet(row.privyWallet.toUpperCase().replace("0X", "0x")))?.privyUserId, row.privyUserId);
  assert.equal(await accounts.findByWallet("0x0000000000000000000000000000000000000fff"), null);
});

test("markQrEmailed sets the timestamp", async () => {
  await accounts.markQrEmailed(row.privyUserId);
  assert.ok((await accounts.findByPrivyUserId(row.privyUserId))?.qrEmailedAt instanceof Date);
});

test("recordDeposit stores a row", async () => {
  await accounts.recordDeposit({ privyUserId: row.privyUserId, currency: "MYR", amount: 10, usdAmount: 2.44881, txHash: "0xabc" });
  const { rows } = await pool.query("select currency, amount::float, usd_amount::float from deposits");
  assert.deepEqual(rows, [{ currency: "MYR", amount: 10, usd_amount: 2.44881 }]);
});
```

- [ ] **Step 3: Run** `npm test` → FAIL (cannot find `../src/accounts.js`).

- [ ] **Step 4: Implement `src/accounts.ts`**

```ts
import { pool } from "./db.js";

/// Registered customers: the Privy user, the embedded wallet whose QR logs
/// them in for deposits, and the vault account their deposits credit.
export interface Account {
  privyUserId: string;
  email: string;
  privyWallet: string; // lowercase 0x address, what the QR holds
  boundAddress: string; // vault account (deriveBoundAddress in store.ts)
  ensName: string | null;
  qrEmailedAt: Date | null;
}

const COLUMNS = `privy_user_id as "privyUserId", email, privy_wallet as "privyWallet",
  bound_address as "boundAddress", ens_name as "ensName", qr_emailed_at as "qrEmailedAt"`;

export async function findByPrivyUserId(privyUserId: string): Promise<Account | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from accounts where privy_user_id = $1`, [privyUserId]);
  return rows[0] ?? null;
}

export async function findByWallet(wallet: string): Promise<Account | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from accounts where privy_wallet = $1`, [wallet.toLowerCase()]);
  return rows[0] ?? null;
}

export async function insertAccount(a: Omit<Account, "qrEmailedAt">): Promise<Account> {
  const { rows } = await pool.query(
    `insert into accounts (privy_user_id, email, privy_wallet, bound_address, ens_name)
     values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
    [a.privyUserId, a.email, a.privyWallet.toLowerCase(), a.boundAddress, a.ensName],
  );
  return rows[0];
}

export async function markQrEmailed(privyUserId: string) {
  await pool.query("update accounts set qr_emailed_at = now() where privy_user_id = $1", [privyUserId]);
}

export async function recordDeposit(d: { privyUserId: string; currency: string; amount: number; usdAmount: number; txHash: string }) {
  await pool.query(
    "insert into deposits (id, privy_user_id, currency, amount, usd_amount, tx_hash) values ($1, $2, $3, $4, $5, $6)",
    [crypto.randomUUID(), d.privyUserId, d.currency, d.amount, d.usdAmount, d.txHash],
  );
}
```

- [ ] **Step 5: Run** `npm test` → all pass.

### Task 5: Sessions module (TDD)

**Files:** create `backend/test/sessions.test.ts`, `backend/src/sessions.ts`.

- [ ] **Step 1: Failing test**

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const { insertAccount } = await import("../src/accounts.js");
const sessions = await import("../src/sessions.js");
after(() => pool.end());

await insertAccount({
  privyUserId: "did:privy:s1", email: "s@example.com",
  privyWallet: "0x0000000000000000000000000000000000000001",
  boundAddress: "0x0000000000000000000000000000000000000002", ensName: null,
});

test("scopeAllows", () => {
  assert.equal(sessions.scopeAllows("full", ["full"]), true);
  assert.equal(sessions.scopeAllows("full", ["deposit"]), true);
  assert.equal(sessions.scopeAllows("deposit", ["full", "deposit"]), true);
  assert.equal(sessions.scopeAllows("deposit", ["full"]), false);
});

test("create, touch extends, end revokes", async () => {
  const { token, expiresAt } = await sessions.createSession("did:privy:s1", "deposit");
  assert.match(token, /^[0-9a-f]{64}$/);
  const touched = await sessions.touchSession(token);
  assert.equal(touched?.scope, "deposit");
  assert.ok(touched!.expiresAt.getTime() >= expiresAt.getTime());
  await sessions.endSession(token);
  assert.equal(await sessions.touchSession(token), null);
});

test("expired session is rejected", async () => {
  const { token } = await sessions.createSession("did:privy:s1", "full");
  await pool.query("update sessions set expires_at = now() - interval '1 second' where token = $1", [token]);
  assert.equal(await sessions.touchSession(token), null);
});

test("unknown token is rejected", async () => {
  assert.equal(await sessions.touchSession("nope"), null);
});
```

- [ ] **Step 2: Run** `npm test` → FAIL (cannot find `../src/sessions.js`).

- [ ] **Step 3: Implement `src/sessions.ts`**

```ts
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
```

- [ ] **Step 4: Run** `npm test` → all pass.

### Task 6: QR email

**Files:** create `backend/src/qrEmail.ts`.

- [ ] **Step 1: Implement**

```ts
import QRCode from "qrcode";
import { Resend } from "resend";
import { config } from "./config.js";

const resend = config.resend.apiKey ? new Resend(config.resend.apiKey) : null;

/// Emails the customer the QR of their Privy wallet address — what they show
/// the kiosk camera next time to deposit without typing their email.
/// Never throws: a failed email must not fail registration. On failure the
/// caller gets a data URL to show the QR on the kiosk screen instead.
export async function sendQrEmail(to: string, wallet: string, ensName: string | null) {
  const png = await QRCode.toBuffer(wallet, { width: 480, margin: 2 });
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  if (!resend || !config.resend.from) {
    console.warn("[qr-email] RESEND_API_KEY/RESEND_FROM not set — showing the QR on the kiosk instead");
    return { sent: false as const, dataUrl };
  }

  const { error } = await resend.emails.send({
    from: config.resend.from,
    to,
    subject: "Your Takarabako quick-deposit QR",
    html: `
      <p>Welcome to Takarabako${ensName ? ` — your account is <b>${ensName}</b>` : ""}.</p>
      <p>Next time, show this QR to the kiosk camera to deposit cash without typing your email.
      It only allows deposits; log in with your email to withdraw or earn yield.</p>
      <p><img src="cid:wallet-qr" alt="Your wallet QR" width="240" height="240" /></p>
      <p style="font-family:monospace">${wallet}</p>`,
    attachments: [{ filename: "takarabako-qr.png", content: png, contentId: "wallet-qr" }],
  });
  if (error) {
    console.error(`[qr-email] Resend rejected the email: [${error.name}] ${error.message}`);
    return { sent: false as const, dataUrl };
  }
  return { sent: true as const, dataUrl };
}
```

- [ ] **Step 2: Verify** `npx tsc --noEmit -p .` → no errors.

### Task 7: Routes — verify, login/qr, logout, deposit, withdraw, agent, position

**Files:** modify `backend/src/routes/verify.ts`, `deposit.ts`, `withdraw.ts`, `agentRoutes.ts`, `position.ts`, `backend/src/store.ts`; create `backend/src/routes/loginQr.ts`; modify `backend/src/index.ts`.

- [ ] **Step 1: `store.ts`** — delete `Account`, `DepositEvent`, `accountsByPrivyId`, `depositEvents`, `accounts`, `createAccount`, `getAccount`, `logDeposit`. Keep `deriveBoundAddress`, positions and withdraw events; update the header comment to say accounts/deposits live in Postgres.

- [ ] **Step 2: `verify.ts`** — replace the handler body after `getOrCreateUserWallet`:

```ts
  const { userId, walletAddress, fundingTxHash } = await getOrCreateUserWallet(email);

  let account = await findByPrivyUserId(userId);
  let ensTxHash: string | null = null;
  const isNew = !account;
  if (!account) {
    const boundAddress = deriveBoundAddress(userId);
    const ensName = walletSubname(deriveEnsLabel(email));
    // Idempotent: an account registered before Postgres existed already owns
    // its name, and registerSubname skips it.
    ({ txHash: ensTxHash } = await registerSubname(ensName, boundAddress));
    account = await insertAccount({ privyUserId: userId, email, privyWallet: walletAddress, boundAddress, ensName });
  }

  // First bind (including accounts that predate Postgres): email the QR once.
  let qrFallback: string | null = null;
  if (!account.qrEmailedAt) {
    const email_ = await sendQrEmail(email, account.privyWallet, account.ensName);
    if (email_.sent) await markQrEmailed(userId);
    else qrFallback = email_.dataUrl;
  }

  const session = await createSession(userId, "full");
  const balance = chainReady ? await previewValueOnChain(account.boundAddress as Address) : 0;

  res.json({
    verified: true,
    userId,
    ensName: account.ensName,
    privyWalletAddress: account.privyWallet,
    balance,
    reused: !isNew,
    token: session.token,
    scope: session.scope,
    expiresAt: session.expiresAt,
    qrEmailed: !account.qrEmailedAt && !qrFallback,
    qrFallback,
    fundingTxHash,
    ensTxHash,
  });
```

with imports:

```ts
import type { Address } from "viem";
import { deriveBoundAddress } from "../store.js";
import { findByPrivyUserId, insertAccount, markQrEmailed } from "../accounts.js";
import { createSession } from "../sessions.js";
import { sendQrEmail } from "../qrEmail.js";
import { chainReady, previewValueOnChain } from "../chain.js";
```

- [ ] **Step 3: `routes/loginQr.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { findByWallet } from "../accounts.js";
import { createSession, endSession, requireSession } from "../sessions.js";
import { parseWalletFromQr } from "../qr.js";
import { chainReady, previewValueOnChain } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /login/qr — quick login for returning customers: the kiosk camera
/// reads their Privy wallet QR and they get a deposit-only session.
export const loginQrRouter = Router();

const LoginQrBody = z.object({ qr: z.string().min(1).max(512) });

loginQrRouter.post("/login/qr", asyncHandler(async (req, res) => {
  const parsed = LoginQrBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "qr text required" });
    return;
  }
  const wallet = parseWalletFromQr(parsed.data.qr);
  if (!wallet) {
    res.status(400).json({ error: "That's not a Takarabako QR" });
    return;
  }
  const account = await findByWallet(wallet);
  if (!account) {
    res.status(404).json({ error: "This QR isn't registered. Sign up with your email first." });
    return;
  }

  const session = await createSession(account.privyUserId, "deposit");
  const balance = chainReady ? await previewValueOnChain(account.boundAddress as Address) : 0;
  res.json({
    userId: account.privyUserId,
    ensName: account.ensName,
    balance,
    token: session.token,
    scope: session.scope,
    expiresAt: session.expiresAt,
  });
}));

loginQrRouter.post("/logout", requireSession("deposit"), asyncHandler(async (_req, res) => {
  await endSession(res.locals.session.token);
  res.json({ ok: true });
}));
```

- [ ] **Step 4: `deposit.ts`** — `/deposit` uses the session:

```ts
const DepositBody = z.object({
  amount: z.number().positive(),
  currency: z.enum(["USD", "MYR"]).default("USD"),
});

depositRouter.post("/deposit", requireSession("deposit"), asyncHandler(async (req, res) => {
  const parsed = DepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { amount, currency } = parsed.data;
  const session: Session = res.locals.session;

  const account = await findByPrivyUserId(session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  if (!chainReady) {
    res.status(503).json({ error: "chain not configured — set TREASURY_PRIVATE_KEY/USDC_ADDRESS/VAULT_ADDRESS in backend/.env" });
    return;
  }

  const { usdAmount, rate, source } = await toUsd(amount, currency);
  if (currency !== "USD") console.log(`[fx] ${currency} ${amount} -> USD ${usdAmount} at ${rate} (${source})`);

  const { txHash, value } = await depositOnChain(account.boundAddress as Address, usdAmount);
  await recordDeposit({ privyUserId: account.privyUserId, currency, amount, usdAmount, txHash });

  res.json({
    ensName: account.ensName,
    boundAddress: account.boundAddress,
    balance: value,
    txHash,
    currency,
    usdAmount,
    fxRate: rate,
    fxSource: source,
    expiresAt: session.expiresAt,
  });
}));
```

imports: replace `store` with `findByPrivyUserId, recordDeposit` from `../accounts.js`, add `requireSession, type Session` from `../sessions.js`.

- [ ] **Step 5: `withdraw.ts`** — full scope, destination choice:

```ts
const WithdrawBody = z.object({
  // "cash": USDC to the treasury, customer collects cash (2% fee, as before).
  // "wallet": USDC straight to the customer's Privy wallet (no cash handling, no fee).
  destination: z.enum(["cash", "wallet"]).default("cash"),
});
```

In the handler: `const { destination } = parsed.data; const { privyUserId: userId } = res.locals.session;`, `const account = await findByPrivyUserId(userId)`, recipient `destination === "wallet" ? (account.privyWallet as Address) : treasuryAddress`, fee `destination === "wallet" ? 0 : config.withdrawFeeBps`, drop `account.idleBalance = 0`, receipt text for wallet: `` `$${grossUsdc.toFixed(2)} sent to your wallet ${account.privyWallet}` ``, include `destination` in the JSON. Route: `withdrawRouter.post("/withdraw", requireSession("full"), asyncHandler(...))`.

- [ ] **Step 6: `agentRoutes.ts`** — `OpenPositionBody` drops `userId`; route gets `requireSession("full")`; `const userId = res.locals.session.privyUserId; const account = await findByPrivyUserId(userId);`.

- [ ] **Step 7: `position.ts`** — `GET /position` (no `:userId`), `requireSession("full")`, user from session, `findByPrivyUserId`.

- [ ] **Step 8: `index.ts`** — `await migrate()` before `app.listen` (exit with a clear message on failure), register `loginQrRouter`, allow the `Authorization` header in CORS:

```ts
res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
```

```ts
try {
  await migrate();
} catch (err) {
  console.error(`[db] cannot reach Postgres (${err instanceof Error ? err.message : err}) — run: docker compose up -d`);
  process.exit(1);
}
```

- [ ] **Step 9: Verify** `npx tsc --noEmit -p . && npm test` → clean, all pass.

### Task 8: API checks with curl (real backend)

- [ ] **Step 1:** Restart backend (`npm run dev`), expect `takarabako backend listening on :4000`.
- [ ] **Step 2:** `POST /verify {email}` with the user's existing email → `scope: "full"`, `token`, and either `qrEmailed: true` or a `qrFallback` data URL.
- [ ] **Step 3:** `POST /login/qr {qr: "<privyWalletAddress>"}` → `scope: "deposit"`.
- [ ] **Step 4:** With the deposit token: `POST /withdraw` → 403; `POST /agent/open-position` → 403.
- [ ] **Step 5:** No token → `/deposit` 401; `POST /login/qr {qr:"hello"}` → 400; unknown address → 404.
- [ ] **Step 6:** Check treasury ETH (`cast balance`), then one real `POST /deposit {amount:1, currency:"MYR"}` with the deposit token → tx hash; confirm `status 1` with `cast receipt`; row in `deposits`.

### Task 9: Vendor jsQR

- [ ] **Step 1:** `mkdir -p device-agent/public/vendor && curl -sL https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js -o device-agent/public/vendor/jsQR.js`
- [ ] **Step 2:** Verify it defines the global: `grep -c "jsQR" device-agent/public/vendor/jsQR.js` ≥ 1 and `head -c 200` shows the UMD wrapper.
- [ ] **Step 3:** Add `<script src="vendor/jsQR.js"></script>` before `app.js` in `index.html`.

### Task 10: Bridge carries the token

**Files:** `device-agent/server.js`.

- [ ] **Step 1:** Session becomes `{ token, ensName, scope, expiresAt }` (ms). `handleSessionStart` requires `token` and `expiresAt`. Add:

```js
// A session the backend will still honour. Past expiresAt the serial
// listener must hand notes back rather than stack cash nobody is logged in for.
function sessionActive() {
  return session !== null && Date.now() < session.expiresAt;
}
```

- [ ] **Step 2:** `GET /session` returns `{ active: sessionActive() }`; `handlePulseDeposit` returns 409 unless `sessionActive()`, sends `Authorization: Bearer ${session.token}` and body `{ amount, currency }`, and on success sets `session.expiresAt = Date.parse(body.expiresAt)`.

- [ ] **Step 3:** `node --check server.js`; mock-backend test as before, plus: expired session → `GET /session` inactive and `/pulse-deposit` 409.

### Task 11: Kiosk UI

**Files:** `device-agent/public/app.js`, `style.css`.

- [ ] **Step 1: State + API with token.** State adds `token`, `scope`, `expiresAt`. `api(path, body)` sends `Authorization: Bearer ${state.token}` when present; on 401 it logs "session expired" and calls `onDone()`.
- [ ] **Step 2: Auth screen** gains `<button id="btn-scan">Scan my QR to deposit</button>` under the email form.
- [ ] **Step 3: Scan screen** — `navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })` into a `<video>`; every animation frame draw to a canvas and run `jsQR(imageData.data, w, h)`; on a hit stop the camera and `POST /login/qr {qr: code.data}`. If `!window.isSecureContext || !navigator.mediaDevices` show "Camera unavailable: open the kiosk via localhost, or log in with email". Cancel button stops the tracks and returns to the auth screen.
- [ ] **Step 4: Deposit-only screen** (`scope === "deposit"`): ENS, balance, pending line, "Insert your cash now", Done. No deposit-fallback, yield or withdraw buttons.
- [ ] **Step 5: Full screen** — withdraw becomes two buttons: "Withdraw as cash" (`destination: "cash"`) and "Withdraw to my wallet" (`destination: "wallet"`). Show `qrFallback` image with "We couldn't email your QR — take a photo of it" when present.
- [ ] **Step 6: Bridge + expiry.** `registerSession()` posts `{ token, ensName, scope, expiresAt: Date.parse(expiresAt) }`; confirmed deposit events update `state.expiresAt`; a 5-second timer calls `onDone()` once `Date.now() > state.expiresAt`. `onDone()` calls `POST /logout` (fire-and-forget) and clears token/scope.
- [ ] **Step 7:** `node --check public/app.js`.

### Task 12: Live test

- [ ] **Step 1:** Deploy `server.js`, `public/*` to the Pi; restart the kiosk server.
- [ ] **Step 2:** Laptop tunnel so the camera works: forward laptop `localhost:8080` → Pi `localhost:8080`, open `http://localhost:8080`.
- [ ] **Step 3:** Email login (existing email) → QR email arrives (or on-screen fallback) → Done.
- [ ] **Step 4:** Scan QR with the laptop webcam → deposit-only screen → insert RM10 → pending then confirmed; verify tx on-chain and the `deposits` row.
- [ ] **Step 5:** Ask the user whether to commit.
