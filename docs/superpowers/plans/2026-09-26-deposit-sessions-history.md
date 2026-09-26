# Deposit Sessions, Receipts and History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guided deposit sessions with a receipt (screen, email, History), refused-note feedback, and a unified History of deposits, withdrawals, yield actions and refused notes.

**Architecture:** Postgres gains `deposit_sessions`, `withdrawals`, `yield_events`, `refused_notes`; `/deposit` attaches notes to the user's open session; the deposit worker sends the receipt email when a finished session settles; the Pi bridge forwards refusals to the backend, which publishes `deposit.refused`. `/deposit` (terminal) and `/history` (customer) in the Next.js app consume it.

**Tech Stack:** Express/TypeScript/pg/BullMQ (backend), Next.js 16 (frontend), node:test.

Spec: `docs/superpowers/specs/2026-09-26-deposit-sessions-history-design.md`. **Commits:** only on the user's request.

## Tasks

- [ ] **1. Migration 003** — the four tables + `deposits.session_id`.
- [ ] **2. `history.ts` (backend)** — `openDepositSession`, `currentOpenSession`, `finishDepositSession`, `getReceipt`, `markReceiptEmailed`, `recordWithdrawal`, `recordYieldEvent`, `recordRefused`, `listHistory`. TDD in `test/history.test.ts` against the test DB: open → attach deposits → finish → receipt totals; refused/withdrawal/yield rows appear in `listHistory` newest first; filter by type.
- [ ] **3. Receipt email** — `receiptEmail.ts` (Gmail/Resend like `qrEmail.ts`); `maybeSendReceipt(sessionId)` sends once when the session is finished and no note is queued/sending; called from the deposit worker after confirm/fail and from finish.
- [ ] **4. Routes** — `POST /deposit-sessions` (any session), `GET /deposit-sessions/:id`, `POST /deposit-sessions/:id/finish` (owner only), `POST /refused` (any session; publishes `deposit.refused`), `GET /history` (full). `/deposit` attaches `session_id`; `/withdraw` and `/agent/open-position` record rows. New event type `deposit.refused`.
- [ ] **5. Pi bridge** — `/bill-rejected` also POSTs `/refused` to the backend with the session token (skipped when no session); reason mapping unknown note → `unsupported`, not recognised → `bad_condition`.
- [ ] **6. Frontend API** — `/api/kiosk/session-finish`, receipt fetch; kiosk login opens a deposit session; `/api/history`.
- [ ] **7. Deposit terminal UI** — `KioskApp` deposit mode: waiting state (cat beckons, 30 s idle → Still there?), refused messages, accepted card with running total + Add more / Finish, animated receipt, auto-return to scan.
- [ ] **8. History page** — `/history` + nav item; filter chips; expandable deposit receipts.
- [ ] **9. Verify** — tests, typecheck, lint, build; curl flow with a real deposit; fake-camera/test-deposit run of the terminal; screenshots.
