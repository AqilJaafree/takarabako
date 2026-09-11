# Takarabako (宝箱)

Cash-in IoT box → ENS-registered wallet → World ID Selfie Check → risk-tiered
Uniswap v3/v4 yield managed by a Claude Haiku agent. Built for ETHGlobal
Tokyo 2026. Full product spec: `takarabako-prd.pdf` (v0.1) — the current
working spec (v0.2) lives outside this repo, kept local-only.

## Layout

- **`contracts/`** — Foundry workspace: `MockJPYC`, mock risk-tier tokens,
  and `TakarabakoVault` (mock-yield ERC-4626-flavored vault). See its own
  `forge test` output for coverage.
- **`backend/`** — Node/TypeScript orchestrator: the deposit/verify/withdraw
  API and the (stubbed, Phase 3) agentic yield endpoints.
- **`device-agent/`** — zero-dependency kiosk page for the Raspberry Pi 4.

## Quickstart

```bash
# contracts
cd contracts && forge install --no-git && forge test

# backend
cd backend && npm install && cp .env.example .env && npm run dev

# kiosk (separate shell)
cd device-agent && node server.js   # http://localhost:8080
```

The kiosk works end-to-end against the backend's in-memory stub store with
no chain, World ID, or Claude Agent SDK calls wired in yet — that's the
Phase 1–3 work per the build plan (deposit → verify → risk choice → agent
position → withdraw, all reachable from `http://localhost:8080`).

## Build phases (see PRD §12)

0. Repo scaffold, mock tokens, fallback-button deposit loop — **done**.
1. Wire the vault's `depositFor`/`withdrawTo` and the ENS v2 registrar into
   the backend's stub calls.
2. Real World ID Selfie Check (Sandbox simulator, then production).
3. Real Claude Haiku agent behind `/agent/open-position` and `/withdraw`.
4. Real bill acceptor hardware, button kept wired as the fallback.
5. Polish, Uniswap v4 hook stretch, demo rehearsal.
