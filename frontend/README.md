# Takarabako web app (`frontend/`)

Next.js 16 (App Router, server-side rendered) front end for Takarabako. One
app serves two audiences:

- **Customers** on a phone or laptop (`/`, `/qr`, `/yield`, `/withdraw`):
  Privy email-code login, the vault balance and deposit history rendered on
  the server, live deposits over SSE, the quick-deposit QR, yield, and
  withdraw to wallet.
- **The box itself** (`/kiosk`): email or wallet-QR login, cash in through
  the bill acceptor, yield, withdraw as cash or to wallet. The old page in
  `device-agent/public` stays on the Pi's `:8080` as a fallback.

The Express backend (`backend/`) is still the API. Browsers only talk to this
Next.js server; it keeps the backend session token in an httpOnly cookie
(`tb_session` for customers, `tb_kiosk_session` for the box), so browser
JavaScript never sees it.

```
browser ──► Next.js (:3000) ──► backend (:4000) ──► Postgres / Redis / Sepolia
               │  /api/*, SSR       ▲
               │                    │ /deposit (session token)
               └──► Pi bridge (:8080, device-agent/server.js) ◄── bill acceptor
                    gets the kiosk session after each kiosk login
```

## Setup

```bash
cd frontend
cp .env.example .env.local   # fill in NEXT_PUBLIC_PRIVY_APP_ID, BACKEND_URL, PI_BRIDGE_URL
npm install
npm run dev                  # http://localhost:3000
```

Privy dashboard: add `http://localhost:3000` (and later the deployed URL) to
the allowed origins, and make sure email login is on. The backend creates
wallets, so the app tells Privy not to create one on login.

## The kiosk screen

Point the Pi's kiosk browser at `http://<this-machine>:3000/kiosk`. The QR
camera only works on a secure page (`localhost` or `https`), so on the bench
open it through a localhost tunnel, as with the old page, or serve it over
https once deployed.

- `PI_BRIDGE_URL` is where the Next.js server hands over each kiosk login, so
  notes stacked by the serial listener go to that account. Leave it empty to
  use `/kiosk` without the box.
- `KIOSK_TEST_DEPOSIT=1` adds a "Test: insert RM10" button for bench testing
  without the acceptor.

## Routes

| Route | What it does |
|---|---|
| `POST/DELETE /api/session` | Privy access token → backend `/auth/privy` → cookie; logout |
| `GET /api/me`, `/api/deposits` | Polling fallback while the live stream is down |
| `GET /api/stream` | Customer's live deposit events (backend `/events/stream`, proxied) |
| `POST /api/yield`, `/api/withdraw` | Open a position; withdraw to wallet |
| `POST /api/kiosk/verify`, `/api/kiosk/login-qr` | Kiosk logins; hands the session to the Pi bridge |
| `GET /api/kiosk/login-world/request`, `POST /api/kiosk/login-world` | World ID login on `/deposit` (verified customers); same session as the wallet QR |
| `GET /api/worldid/request`, `POST /api/me/worldid` | World ID Selfie Check on `/verify` |
| `POST /api/kiosk/logout` | Ends the backend session and the bridge's |
| `GET /api/kiosk/stream`, `/api/kiosk/bridge-events` | Live deposits; refused notes from the bridge |
| `POST /api/kiosk/yield`, `/api/kiosk/withdraw` | Kiosk actions (cash withdrawal is kiosk-only) |
| `POST /api/kiosk/test-deposit` | Bench-only RM10, when `KIOSK_TEST_DEPOSIT=1` |

## The living box (phase 3)

`components/treasure/` is the 3D layer on My box, Yield, Withdraw and
`/kiosk` (React Three Fiber + GSAP, custom GLSL in `materials.ts`). Every
animation is driven by real data:

| What you see | Driven by |
|---|---|
| Gold mound + coins in the box | Vault balance (log scale, so $2 and $2,000 both read) |
| A note falling into the box | `deposit.pending` from the live stream |
| Note melts to gold, tx hash glows over the box | `deposit.confirmed` |
| Note greys out, cat droops | `deposit.failed` |
| Gems orbiting the box | Open Uniswap positions (colour = tier, pulse = APY) |
| Coins streaming out | A completed withdraw |
| The maneki-neko's speech | Scripted lines for events; the Claude agent's rationale on Yield |

`useStageDirector` turns deposit events into these cues; `TreasureStage`
decides whether to render at all. With `prefers-reduced-motion`, no WebGL,
or `?flat` in the URL, pages show the plain layout.

The speech bubble and the etched hash are plain DOM overlays pinned to scene
anchors each frame (`Anchor` in `Scene.tsx`), not drei `<Html>`, which
rendered empty and threw DOM errors under Next 16.
