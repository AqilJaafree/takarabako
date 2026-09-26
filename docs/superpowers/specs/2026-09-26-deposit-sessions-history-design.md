# Deposit sessions, receipts and History — design

Date: 2026-09-26 · Status: approved in chat

## Goal

Turn a cash deposit into a guided session with a receipt, and give customers
one place to see everything that happened to their box.

## Decisions

| Topic | Decision |
|---|---|
| Confirm | Confirm the **total**: each good note is stacked immediately and shown with a running total; the customer taps **Add more** or **Finish** |
| Receipt | Animated on screen, saved to History, emailed (Gmail sender) once every note has confirmed on-chain |
| History | Deposits (as receipts), withdrawals, yield actions, refused notes |
| Idle | 30 s with no note → "Still there?" [Try again] [Cancel] |

## Deposit terminal (`/deposit`, public)

States: **scan** → **waiting** (lid open, cat beckons) → note events →
**receipt** → back to scan (~20 s or Done).

- Refused, not supported (unknown note code / RM2 disabled): cat says it can't take that note.
- Refused, bad condition (acceptor pushes it back): cat asks to smooth it out.
- Accepted: note drops in, card "RM10 → ≈$2.45", running total, [Add more] [Finish].
- Receipt: slides out of the box; each note line ticks from confirming to ✓ with its tx link.

## Backend

### Tables (migration 003)

- `deposit_sessions(id, privy_user_id, status open|finished, started_at, finished_at, receipt_emailed_at)`
- `deposits.session_id` → `deposit_sessions` (nullable for older rows)
- `withdrawals(id, privy_user_id, destination, gross_usd, fee_bps, net_usd, tx_hash, created_at)`
- `yield_events(id, privy_user_id, action, risk_tier, pair, apy_bps, amount_usd, rationale, ens_name, tx_hash, created_at)`
- `refused_notes(id, privy_user_id, session_id, reason, created_at)` — reason `unsupported | bad_condition | no_session`

### Behaviour

- Any login (QR or email) at the kiosk/terminal opens a deposit session
  (`POST /deposit-sessions`, returns id); `/deposit` attaches each note to the
  user's open session.
- `POST /deposit-sessions/:id/finish` closes it and returns the receipt.
  `GET /deposit-sessions/:id` returns the receipt (notes + statuses + totals).
- When a deposit confirms and its session is finished with nothing pending,
  the receipt email is sent once (`receipt_emailed_at`). Finish also sends it
  if everything is already confirmed.
- `POST /refused { reason }` (session token) records a refused note and
  publishes `deposit.refused`. The Pi bridge forwards the listener's
  rejections here.
- `/withdraw` and `/agent/open-position` record rows in `withdrawals` /
  `yield_events`.
- `GET /history?type=&limit=` (full session): one list, newest first:
  `{ kind: deposit_session | withdrawal | yield | refused, at, … }`.

## Frontend

- `/deposit`: the terminal states above (built on `KioskApp` mode="deposit").
- `/history` (customer, logged in): filter chips All · Deposits · Withdrawals ·
  Yield · Refused; deposit sessions expand into their receipt.

## Out of scope

Per-note escrow confirmation; refunds; exporting history.
