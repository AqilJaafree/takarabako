# Takarabako web app ("the living box") — design

Date: 2026-09-26 · Status: approved in chat · Builds on `2026-09-26-qr-quick-login-design.md`

## Goal

A customer web app that feels like opening your own treasure box, not reading
a dashboard. A 3D lacquered 宝箱 holds your money, a maneki-neko (lucky cat)
is the visible face of the Claude yield agent, and **cash inserted at the
physical kiosk flies into the box on your phone within a second**, turning to
gold when the Sepolia transaction confirms.

Every animation encodes real data: gold = vault balance, gems = open Uniswap
positions (colour = risk tier, pulse = APY), falling note = a real deposit.

## Decisions

| Topic | Decision |
|---|---|
| Framework | Next.js (App Router, TypeScript) in `frontend/`, server-side rendered; the Express backend stays the API |
| Look | Lacquered treasure box: lacquer red `#b3261e`, deep brown `#120807`/`#1a0f0d`, gold `#e3b36a`, cream `#f4e9da`; serif numerals |
| 3D | React Three Fiber + drei, custom GLSL for lacquer/gold, GSAP for choreography. No Phaser (second render engine, poor fit inside React) |
| Agent face | Procedural 3D maneki-neko built from primitives |
| Agent voice | Event reactions scripted and instant; yield picks and reasoning from the live Claude Haiku agent |
| Login | Privy React SDK, email one-time code; backend verifies Privy's access token |
| Realtime | Server-Sent Events from the backend, proxied through Next.js; polling fallback |
| Deposit durability | Redis + BullMQ queue with retries and stalled-job recovery; Postgres is the source of truth |
| Hosting | Local now (laptop), DigitalOcean later; every URL in env vars |

## Phases

1. **Backend foundation** — Redis, BullMQ deposit queue, event stream, Privy token login, data endpoints. Depends on the QR-login work (Postgres, sessions) being tested first.
2. **Next.js app** — Privy login, SSR pages with real data and live updates, plain UI.
3. **The experience** — 3D box, cat, animations layered onto phase 2's pages.

Each phase ships working software on its own.

## Phase 1 — backend foundation

### Deposit pipeline (Redis + BullMQ)

`deposits` gains `status` (`queued` → `sending` → `confirmed` | `failed`),
`attempts`, `error`, `updated_at`; `tx_hash` becomes nullable.

1. `POST /deposit` (bridge or kiosk) inserts the row as `queued`, enqueues a
   BullMQ job `{ depositId }` (jobId = depositId, so it can't be queued twice),
   publishes `deposit.pending`, and returns `202 { depositId, estUsd }`
   immediately.
2. The worker loads the row. If `tx_hash` is already set (an earlier attempt
   died after sending), it only waits for that receipt. Otherwise it converts
   FX, sends `depositFor`, and **stores `tx_hash` before waiting**. No retry
   can pay twice.
3. Success → `confirmed` + `deposit.confirmed { txHash, usdAmount, fxRate, balance }`.
4. Failure → BullMQ retries (5 attempts, exponential backoff from 5s). A
   worker that dies mid-job is recovered by BullMQ's stalled-job check. After
   the last attempt → `failed` + `deposit.failed { error }`. The row stays for
   manual re-queue.

Redis runs with AOF persistence in `backend/docker-compose.yml` next to
Postgres.

### Events

`backend/src/events.ts` publishes JSON events on the Redis channel
`user:<privyUserId>` (works across several backend instances later).
`GET /events/stream` (session required, either scope) is an SSE stream of that
user's channel, with a 20s heartbeat. The Pi bridge subscribes too, replacing
its own pending/confirmed bookkeeping.

### Privy login for the web

`POST /auth/privy { accessToken }` → `verifyAccessToken` against the app's
JWKS (`https://auth.privy.io/api/v1/apps/<appId>/jwks.json`) → `users()._get`
for the email and wallet → if the user has no Ethereum wallet yet (registered
on the web first), `pregenerateWallets` → the same find-or-create-account path
as kiosk email login (ENS, 0.001 ETH funding, QR email on first bind) →
`full` session. The kiosk's `/verify` keeps working unchanged.

### Data endpoints (full session)

- `GET /me` — ENS, balance, privy wallet, open positions, APY.
- `GET /deposits?limit=20` — history from Postgres.
- `GET /me/qr` — QR PNG data URL of the privy wallet.
- Existing: `/agent/pools`, `/agent/open-position`, `/withdraw` (`destination: "wallet"` from the web; cash stays kiosk-only in the UI).

## Phase 2 — Next.js app

### Auth and data flow

- Browser: Privy `useLoginWithEmail` (send code → enter code) → `getAccessToken()` → `POST /api/session` (Next route handler).
- `/api/session` calls backend `/auth/privy`, sets an **httpOnly, SameSite=Lax cookie** `tb_session` holding the backend token. Browser JS never sees it.
- Server components read the cookie and call the backend with `Authorization: Bearer`, so pages render with real numbers (SSR).
- `/api/stream` proxies the backend SSE using the cookie. The client hook `useLiveEvents()` consumes it, falling back to polling `GET /api/me` every 3s if the stream drops.
- Mutations (open position, withdraw) go through Next route handlers that attach the cookie token.
- Logout clears the cookie and calls backend `/logout`.

### Pages

| Route | SSR data | Content |
|---|---|---|
| `/login` | — | Email → code |
| `/` | `/me`, `/deposits` | The box (phase 3) or, in phase 2, balance + deposit list + live pending line |
| `/qr` | `/me/qr` | Full-screen QR for the kiosk camera, brightness hint |
| `/yield` | `/agent/pools`, `/me` | Risk tiers, open position, the agent's rationale |
| `/withdraw` | `/me` | Withdraw everything to your wallet, confirm step |

Unauthenticated requests redirect to `/login` (middleware on the cookie).

### Kiosk mode (`/kiosk`)

The box's own screen also runs the new frontend (decided 2026-09-26). The old
`device-agent/public` page stays untouched as a fallback on the Pi's `:8080`.

- `/kiosk` runs the kiosk flows: email login (no code, `full`, as today via
  `/verify`), wallet-QR scan login (`deposit`), deposit via the bill acceptor,
  cash withdrawal (cash is kiosk-only), Done/timeout back to the start screen.
- After a kiosk login, the Next.js server (not the browser) posts the session
  to the Pi bridge (`PI_BRIDGE_URL`, e.g. `http://10.42.0.225:8080/session`),
  so the bill listener deposits into that account.
- Live deposit events come from the backend SSE stream, same as the phone:
  one RM10 animates on the kiosk screen and the customer's phone at once.
- The kiosk session cookie is separate from the customer app's
  (`tb_kiosk_session`), so a phone login and the box never share a session.
- Camera: `/kiosk` must be opened from a secure context (localhost, or https
  once deployed) for QR scanning.

## Phase 3 — the experience

- **Scene** (client component, `dynamic(..., { ssr: false })`): the lacquered box on a slowly rotating plinth; lacquer and gold via custom shaders (clearcoat red, gold with fresnel sheen).
- **Balance = gold**: a pile of coins inside the open lid, height scaled logarithmically so $2 and $2,000 both read.
- **Deposit moment**: `deposit.pending` → a ringgit note falls from above into the box (GSAP arc); `deposit.confirmed` → the note melts into gold, the balance counter rolls up, the tx hash is briefly etched on the lid; `deposit.failed` → the note turns grey and the cat looks worried.
- **Gems**: one per open position, orbiting; colour by tier (low teal, medium amber, high red), pulse speed from APY.
- **Withdraw**: the lid opens, coins stream up and out toward the wallet address.
- **The cat**: procedural maneki-neko beside the box. Idle paw wave; blinks; hops on deposits. Speech bubble (HTML overlay via drei `Html`): scripted lines for events ("RM10 landed!"), live Claude rationale on the yield page.
- **Fallbacks**: `prefers-reduced-motion` or no WebGL → the phase 2 page, no animation. Target 60fps on a mid-range phone; cap device pixel ratio at 2.

## Errors

| Failure | Behaviour |
|---|---|
| Privy code wrong or expired | Message on the login form, resend option |
| Backend rejects the Privy token | 401 → back to `/login` |
| Session cookie expired | Middleware redirects to `/login` |
| SSE drops | Auto-reconnect; polling fallback meanwhile |
| Deposit retries | Phone shows "retrying (2/5)"; kiosk keeps the note pending |
| Deposit failed after all retries | Clear failed state on phone and kiosk; row kept for re-queue |
| Redis down | `/deposit` fails within 3s (503); the note is already stacked, so its row stays `failed` in Postgres as the record for manual re-queue |
| WebGL unavailable | Plain phase-2 view |

## Testing

- Phase 1: `node:test` for the worker's idempotency (a row with `tx_hash` is only awaited, never resent), queue retry settings, event publishing; curl for `/auth/privy` (with a real Privy token from phase 2), `/me`, `/deposits`, `/events/stream`; one live RM10 through the queue with a deliberately killed worker to prove stalled-job recovery.
- Phase 2: log in with a real email code, SSR pages show live data, phone sees pending → confirmed from a real kiosk deposit.
- Phase 3: visual check on a phone; reduced-motion and no-WebGL fallbacks.

## Setup the user must do

- `sudo systemctl start docker` (Postgres + Redis).
- Privy dashboard: add `http://localhost:3000` to allowed origins, enable email login.
- `frontend/.env.local`: `NEXT_PUBLIC_PRIVY_APP_ID`, `BACKEND_URL`.
- Resend API key and sender (from the QR-login work).

## Out of scope

Cash withdrawal from the web (kiosk only); multiple backend instances (the
design supports it, not deployed); Phaser; external wallet login.
