# Web App Phase 2 (Next.js) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-rendered Next.js app in `frontend/` serving the customer pages (Privy email-code login, dashboard, My QR, yield, withdraw) and the box's `/kiosk` screen, all on the Phase 1 backend, with live deposit updates. Plain but on-brand UI; the 3D layer is Phase 3.

**Architecture:** The browser never holds a backend token. Route handlers and server actions exchange logins for backend sessions and keep them in httpOnly cookies (`tb_session` for customers, `tb_kiosk_session` for the box). Server components render with real data via `lib/backend.ts`. `/api/stream` proxies the backend SSE; `useLiveEvents` consumes it, falling back to polling. Kiosk logins also register the session with the Pi bridge, server-side.

**Tech Stack:** Next.js 16 (App Router, TypeScript), React 19, Tailwind CSS 4, `@privy-io/react-auth` 3, `next/font`, vendored-in-npm `jsqr` for kiosk scanning.

Spec: `docs/superpowers/specs/2026-09-26-web-app-design.md` (Phase 2 + Kiosk mode).

**Commits:** only on the user's explicit request.

---

## File map (`frontend/`)

| File | Responsibility |
|---|---|
| `.env.local` / `.env.example` | `NEXT_PUBLIC_PRIVY_APP_ID`, `BACKEND_URL`, `PI_BRIDGE_URL` |
| `src/lib/backend.ts` (server-only) | `backend(path, { token, method, body })` → typed JSON or `BackendError` |
| `src/lib/session.ts` (server-only) | cookie names, read/set/clear, `requireToken(kind)` (redirects to login) |
| `src/lib/types.ts` | shared shapes: `Me`, `Deposit`, `LiveEvent`, `Pool` |
| `src/lib/format.ts` | money/tx formatting |
| `src/components/providers.tsx` | client `PrivyProvider` |
| `src/components/useLiveEvents.ts` | SSE client hook with polling fallback |
| `src/components/LiveBalance.tsx` | balance + pending line + recent deposits, live |
| `src/app/layout.tsx`, `globals.css` | fonts, lacquer theme tokens |
| `src/app/login/page.tsx` | email → code → `/api/session` |
| `src/app/(app)/layout.tsx` | auth gate (cookie + `/me`), nav, logout |
| `src/app/(app)/page.tsx` | dashboard (SSR `/me` + `/deposits`) |
| `src/app/(app)/qr/page.tsx` | full-screen QR |
| `src/app/(app)/yield/page.tsx` + `actions.ts` | pools, open position (server action) |
| `src/app/(app)/withdraw/page.tsx` + `actions.ts` | withdraw to wallet (server action) |
| `src/app/api/session/route.ts` | POST Privy token → cookie; DELETE → logout |
| `src/app/api/stream/route.ts` | SSE proxy (`?kind=app|kiosk`) |
| `src/app/api/me/route.ts` | polling fallback |
| `src/app/kiosk/page.tsx` + `KioskApp.tsx` | box screen state machine |
| `src/app/api/kiosk/*/route.ts` | email login, QR login, withdraw cash, logout (+ Pi bridge registration) |

## Tasks

### Task 1: Scaffold
- [ ] `npx create-next-app@16 frontend --ts --app --tailwind --eslint --src-dir --import-alias "@/*" --use-npm --yes`
- [ ] `cd frontend && npm install @privy-io/react-auth jsqr server-only`
- [ ] `.env.example` and `.env.local`:
```
NEXT_PUBLIC_PRIVY_APP_ID=        # same app as backend PRIVY_APP_ID
BACKEND_URL=http://localhost:4000
PI_BRIDGE_URL=http://10.42.0.225:8080
```
- [ ] `npm run build` succeeds on the scaffold.

### Task 2: Server libs
- [ ] `lib/backend.ts`: `fetch(`${BACKEND_URL}${path}`, { cache: "no-store", headers: authorization when token })`; non-2xx throws `BackendError(status, message)`.
- [ ] `lib/session.ts`: `COOKIE = { app: "tb_session", kiosk: "tb_kiosk_session" }`; `setSessionCookie(kind, token, expiresAt)` (httpOnly, sameSite lax, secure in production, path "/", maxAge from expiresAt + 1h slack — the backend is the real expiry); `getToken(kind)`; `clearSession(kind)`; `requireToken(kind)` → `redirect(kind === "app" ? "/login" : "/kiosk")` when missing.
- [ ] `lib/types.ts`, `lib/format.ts`.

### Task 3: Theme + layout + Privy provider
- [ ] `globals.css` (Tailwind 4 `@theme`): lacquer `#b3261e`, lacquer-deep `#6e140f`, ink `#120807`, ink-2 `#1a0f0d`, gold `#e3b36a`, cream `#f4e9da`, muted `#c9a07a`, good `#7fd1a8`, warn `#f0a640`.
- [ ] `layout.tsx`: `next/font/google` — display "Shippori Mincho B1" (numerals, headings), body "Zen Kaku Gothic New", mono "JetBrains Mono"; `<Providers>` wraps children.
- [ ] `components/providers.tsx`: `'use client'` `PrivyProvider` with `appId`, `config.loginMethods: ["email"]`, `embeddedWallets.ethereum.createOnLogin: "off"` (the backend creates/pregenerates wallets), appearance dark with gold accent.

### Task 4: Login
- [ ] `app/login/page.tsx` (client): step 1 email → `sendCode({ email })`; step 2 code → `loginWithCode({ code })` → `getAccessToken()` → `POST /api/session { accessToken }` → `router.replace("/")`. Errors shown inline; "Send a new code" button.
- [ ] `app/api/session/route.ts`: `POST` → `backend("/auth/privy", { method: "POST", body })` → `setSessionCookie("app", …)` → `{ ensName, qrEmailed, qrFallback }`; `DELETE` → backend `/logout` + `clearSession("app")`.

### Task 5: Authenticated shell
- [ ] `app/(app)/layout.tsx` (server): `requireToken("app")`; `getMe()` (React `cache`) → on 401 clear cookie + `redirect("/login")`; header with 宝箱 wordmark, ENS name, nav (Box, My QR, Yield, Withdraw), logout form (server action calling backend `/logout`, clearing cookie).

### Task 6: Live events
- [ ] `app/api/stream/route.ts`: reads cookie for `kind`, fetches backend `/events/stream` with the token and returns its body as `text/event-stream` (`dynamic = "force-dynamic"`), aborting upstream when the client disconnects.
- [ ] `app/api/me/route.ts`: `GET` → backend `/me` with the app cookie (polling fallback).
- [ ] `components/useLiveEvents.ts`: `EventSource("/api/stream?kind=…")`; on error closes and polls `/api/me` every 3s, retrying the stream every 15s; returns `{ events, connected }`.
- [ ] `components/LiveBalance.tsx`: starts from SSR `me` + `deposits`; applies `deposit.pending` (pending list with ≈USD), `deposit.retrying` ("retrying 2/5"), `deposit.confirmed` (balance, move to history with tx link), `deposit.failed`.

### Task 7: Pages
- [ ] Dashboard `/`: SSR `/me` + `/deposits?limit=10` → `<LiveBalance>`; APY, positions summary, links.
- [ ] `/qr`: SSR `/me/qr` → large QR on cream card, wallet address, "turn your screen brightness up".
- [ ] `/yield`: SSR `/agent/pools` + `/me`; three tier cards; server action `openPosition(riskLevel)` → backend `/agent/open-position` with `amount = balance` → shows pair + the agent's rationale.
- [ ] `/withdraw`: SSR `/me`; confirm step; server action `withdrawToWallet()` → `/withdraw { destination: "wallet" }` → receipt with tx link.

### Task 8: Kiosk
- [ ] `app/api/kiosk/verify/route.ts` (email → backend `/verify`), `login-qr/route.ts` (`{ qr }` → `/login/qr`): set `tb_kiosk_session`, then `POST ${PI_BRIDGE_URL}/session { token, ensName, scope, expiresAt }` (failure is logged and reported as `bridge: false`, login still succeeds — the listener then refuses notes).
- [ ] `withdraw/route.ts` (`destination: "cash"`), `logout/route.ts` (backend `/logout`, bridge `/session/end`, clear cookie), `me/route.ts` (poll fallback with the kiosk cookie).
- [ ] `kiosk/page.tsx` (server): if a kiosk cookie is live, SSR its `/me`… but a deposit-only session can't call `/me` — pass `{ ensName, scope, expiresAt, balance }` from the login response via a small `tb_kiosk_view` cookie instead (non-secret display data); render `<KioskApp initial={…}/>`.
- [ ] `KioskApp.tsx` (client) states: `start` (email form + "Scan my QR"), `scan` (camera + `jsqr`, needs a secure context), `deposit` (deposit-only: balance, pending, "insert cash", Done), `full` (+ withdraw cash / withdraw to wallet / yield hint), `receipt`; `useLiveEvents("kiosk")`; timeout to `start` at `expiresAt`.

### Task 9: Verify
- [ ] `npm run build` clean; `npm run lint` clean.
- [ ] Dev server: `/login` real email code → dashboard renders SSR with real balance/deposits; `/qr`, `/yield` (no position opened unless the user asks), `/withdraw` renders (not executed).
- [ ] Kiosk on `http://localhost:3000/kiosk`: email login → bridge shows `active: true`; scan the `/qr` page from a phone → deposit-only screen; real RM10 → pending then confirmed live on the kiosk and on the phone dashboard at once.
