# QR quick login (deposit-only) — design

Date: 2026-09-26 · Status: approved in chat

## Goal

A returning customer deposits cash without typing their email. They show a
QR code of their Privy wallet address to the kiosk camera and get a
**deposit-only** session. Email login remains the only way to get **full**
access (deposit, yield, withdraw).

Email is needed once, at first registration: it creates the Privy account and
embedded wallet, binds them in Postgres, and emails the customer their QR.

## Decisions

| Topic | Decision |
|---|---|
| QR content | The customer's Privy embedded wallet address (`0x…`, also accept `ethereum:0x…[@chainId]`) |
| Database | Postgres in Docker on the laptop, `DATABASE_URL` in `backend/.env`, `pg` driver, SQL migration at startup |
| Enforcement | Scoped session tokens checked by the backend (approach A) |
| Camera | Laptop webcam for now; kiosk opened via an SSH tunnel as `http://localhost:8080` so the browser allows the camera |
| QR delivery | Emailed via Resend from the user's verified domain (`RESEND_FROM`) at first bind |
| Deposits | Stay in the customer's own vault account (`boundAddress`), as today |
| Withdraw | Full scope only; choose cash receipt (today's behaviour) or "to my wallet" (the Privy wallet) |

## Data model

```sql
accounts (
  privy_user_id  text primary key,
  email          text unique not null,
  privy_wallet   text unique not null,   -- lowercase 0x address, what the QR holds
  bound_address  text not null,          -- vault account deposits are credited to
  ens_name       text,
  qr_emailed_at  timestamptz,            -- null = QR email not delivered yet
  created_at     timestamptz not null default now()
)
sessions (
  token          text primary key,       -- 32 random bytes, hex
  privy_user_id  text not null references accounts,
  scope          text not null check (scope in ('full','deposit')),
  expires_at     timestamptz not null
)
deposits (
  id             uuid primary key,
  privy_user_id  text not null references accounts,
  currency       text not null,
  amount         numeric not null,       -- face value in currency
  usd_amount     numeric not null,       -- what the vault was credited
  tx_hash        text not null,
  created_at     timestamptz not null default now()
)
```

Accounts, sessions and deposits leave the in-memory `store.ts`, so a backend
restart no longer forgets accounts or logs everyone out. Positions and
withdraw events stay in memory for now.

## Components

- `backend/src/db.ts`: pool plus migration at startup; refuses to start if Postgres is unreachable.
- `backend/src/accounts.ts`: upsert/find by user, email or wallet; mark QR emailed; record deposits.
- `backend/src/sessions.ts`: create, validate (sliding expiry), end; `requireSession(scope)` Express middleware.
- `backend/src/qrEmail.ts`: QR PNG (`qrcode`) plus Resend send, inline image.
- `backend/src/routes/verify.ts`: email login returns a `full` session; binds the account and sends the QR email on first bind.
- `backend/src/routes/loginQr.ts`: `POST /login/qr { wallet }` returns a `deposit` session.
- Routes: `/deposit` needs any session; `/withdraw` and the yield endpoints need `full`. The user comes from the token, never the body.
- Kiosk (`device-agent/public`): Scan QR button, camera view, vendored `jsQR`, deposit-only screen, bearer token on API calls, withdraw choice.
- Bridge (`device-agent/server.js`): holds the session token and `expiresAt` instead of `userId`; deposits call `/deposit` with the token; `GET /session` reports inactive after expiry, so the serial listener hands notes back.

## Session lifetimes

`deposit`: 5 minutes, `full`: 15 minutes, both sliding (each authorised call
extends the session) and ended by Done. The bridge learns the new expiry
from each deposit response.

## Flows

1. **Email (full):** Privy get/create → Postgres lookup. If the account is new, register ENS, fund 0.001 ETH, insert the row and email the QR. If it exists but was never emailed, email the QR. Then create a `full` session and show the full account screen.
2. **QR (deposit):** camera → jsQR → normalise the address → `POST /login/qr` → lookup by `privy_wallet` → `deposit` session → deposit-only screen (ENS, balance, pending deposits, Insert cash, Done).
3. **Deposit:** bridge → `/deposit` with the bearer token → user resolved from the token → existing FX + vault deposit → row in `deposits`.
4. **Withdraw (full only):** cash receipt (recipient = treasury) or to my wallet (recipient = Privy wallet).

## Errors

| Failure | Behaviour |
|---|---|
| Postgres down at startup | Backend exits with a clear message |
| Postgres down mid-request | 503, kiosk says try again |
| Resend fails | Registration still succeeds; `qr_emailed_at` stays null (retried next email login); kiosk shows the QR on screen as a fallback |
| Camera blocked or denied | "Camera unavailable: open the kiosk via localhost, or log in with email" |
| Scan isn't an address | "That's not a Takarabako QR" |
| Wallet not registered | "This QR isn't registered. Sign up with your email first." |
| Token invalid or expired | 401, kiosk returns to the start screen |
| Deposit session calls withdraw or yield | 403 |
| Note stacked, deposit fails | As today: "NOT credited, please ask staff", logged on the Pi |

## Testing

- `node:test` unit tests: QR parsing, session scope and expiry, accounts code against a test database in the same Docker Postgres.
- curl against the real backend: email → full, QR → deposit, deposit-session withdraw → 403, expired → 401, one real deposit (check treasury gas first).
- Kiosk: laptop webcam scanning the emailed QR on a phone, then a live RM10 through the TB74, confirmed on-chain.
- Use the existing email to avoid new ENS registration and ETH funding. The first login against the new DB counts as a first bind and sends the QR email.

## Out of scope

Kiosk browser on the Pi with a USB webcam; rate limiting QR attempts;
moving positions and withdraw history into Postgres.
