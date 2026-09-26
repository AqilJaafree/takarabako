# World ID login on the deposit terminal — design

Date: 2026-09-27 · Status: approved in chat

## Goal

Give the `/deposit` terminal a second way in: customers who have verified with
World ID can log in by approving in World App, instead of showing their wallet
QR. Customers who haven't verified keep using the wallet QR.

## Decisions

| Topic | Decision |
|---|---|
| Where | `/deposit` only (`KioskApp` mode="deposit"). `/kiosk` is unchanged. |
| Options | Two tabs on the scan screen: **Scan my QR** (default, unchanged) and **World ID** |
| Who can use World ID | Accounts with a stored `world_nullifier` (verified via `/verify`) |
| Session | Deposit-only, the same scope and response as `/login/qr` |
| Identity | The proof's nullifier. Same person + same app + same action → same nullifier, so login uses the verification action (`WORLD_ACTION`, currently `selfie`) |
| Credential | Whatever `WORLD_PRESET` asks for (currently `device`), the same as verification |
| Not verified | 404 "This World ID isn't linked to a Takarabako account yet — scan your QR instead." |

**Why not IDKit sessions (`createSession`/`proveSession`):** they need World
ID 4.0, which the test World App doesn't have (`world_id_4_not_available`).

**Checked on 2026-09-27:** World accepts a second proof from the same World ID
for the same action (aqiljeff re-verified on `selfie` after an earlier
verification). So repeat logins aren't blocked by a verification limit.

## Backend

### `worldId.ts` refactor

Split `verifyHuman` into:

- `checkProof(result, signal, { requireSignalHash })`: signal-hash check
  against `hashSignal(signal)`, action check, then POST to `developer.world.org/api/v4/verify/{rp_id}`
  (with the staging token header for non-production results). Returns
  `{ ok: true, nullifier, credential }` or `{ ok: false, status, error }`.
- `verifyHuman(account, result)`: `checkProof(result, account.privyWallet)`,
  then the existing duplicate-nullifier check, database update and unlock.
  Behaviour unchanged.

`requestContext` takes the signal as a parameter, so login can pass its nonce.

Login calls `checkProof` with `requireSignalHash: true`: the proof must carry
a `signal_hash`, and it must match the nonce. Verification keeps today's rule
(checked only when present), so `/verify` doesn't change.

### `routes/loginWorld.ts`

- `GET /login/world/request`, no session. Makes a random 32-byte hex nonce,
  stores `worldlogin:<nonce>` in Redis with a 300 s TTL, and returns
  `requestContext(nonce)` (app id, action, environment, preset, signal = nonce,
  signed `rp_context`). 503 when World ID isn't configured.
- `POST /login/world`, no session. Body: `{ nonce, result }`.
  1. Delete `worldlogin:<nonce>` from Redis (`DEL` returns 1). If it wasn't
     there: 400 "This World ID request expired — try again". Deleting first
     means each nonce works once, even if two requests race.
  2. `checkProof(result, nonce)`. On failure, return its status and error.
  3. Find the account by `world_nullifier` (lowercased). None → 404 with the
     not-verified message.
  4. `createSession(privyUserId, "deposit")` and reply in the same shape as
     `/login/qr` (userId, ensName, balance, token, scope, expiresAt,
     worldVerified, limit). Reuse one helper for both routes.

`accounts.ts` gets `findByWorldNullifier(nullifier)`.

## Frontend

- `lib/useWorldProof.ts`: the IDKit handling pulled out of
  `WorldSelfie.tsx`: build the preset from the request, `useIDKitRequest`, open
  once, make the QR data URL from `connectorURI`, and expose
  status (`open | approve | success | error`), `qr`, `connectorURI`, `result`,
  `errorCode`. `WorldSelfie.tsx` uses it with no visible change.
- API routes, following `api/kiosk/login-qr`:
  - `GET /api/kiosk/login-world/request` → backend `GET /login/world/request`
  - `POST /api/kiosk/login-world` → backend `POST /login/world`, answered via
    `kioskLoginResponse` (sets the kiosk session and starts the Pi bridge
    session, same as QR).
- `KioskApp` deposit mode, scan screen: a two-tab switch above the camera.
  The **World ID** tab fetches a request, shows the IDKit QR large
  (the customer scans it with World App on their phone), then posts
  `{ nonce, result }` and calls `startSession` on success, the same as `onQr`.
  Errors show in the tab with **Try again** and **Scan my QR instead**.
  Switching tabs stops the camera or drops the World request.

## Error handling

| Case | Result |
|---|---|
| World ID not configured | Tab shows "World ID login isn't available" |
| Nonce expired or reused | 400, Try again (fetches a new request) |
| World App error (`user_rejected`, etc.) | Error code shown, Try again |
| World rejects the proof | 400 with World's reason |
| Proof signal isn't our nonce | 400 "proof was made for a different request" |
| Nullifier not linked | 404, not-verified message, Scan my QR instead |

## Testing

- `backend/test/loginWorld.test.ts` (needs Postgres and Redis, like the other
  DB tests), with the call to World stubbed:
  - request stores a nonce with a TTL
  - a valid proof for a verified account → deposit session in the `/login/qr` shape
  - the same nonce twice → second is refused
  - missing or wrong `signal_hash` → refused
  - unknown nullifier → 404
- Existing `worldId.test.ts` keeps passing (verification unchanged).
- Live: on `/deposit`, `aqiljeff` (verified) logs in with World ID and reaches
  the deposit screen; an unverified account's World ID gets the not-verified
  message.
