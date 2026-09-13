# Takarabako (宝箱)

An ATM-style cash-in kiosk: verify your identity with just an email (Privy —
real embedded wallet, no seed phrase, no app), *then* insert cash, and it's
credited to an ENS-named on-chain wallet (`*.wantest.eth`) with optional
risk-tiered yield on real Uniswap v3 pools. Built for ETHGlobal Online 2026.
Full product spec lives in `takarabako-prd.md` (gitignored, local-only).

Nearly everything below is real, on Ethereum Sepolia — not a stub. See
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md) for the live contract addresses and an
up-to-date account of exactly what's real vs. what's still a hardcoded map.

## Layout

- **`contracts/`** — Foundry workspace: `MockUSDC`, mock risk-tier tokens,
  and `TakarabakoVault` (mock-yield ERC-4626-flavored vault).
- **`backend/`** — Node/TypeScript orchestrator: real Privy identity, real
  ENS v2 subname registration, real vault deposit/withdraw, real per-user
  Uniswap v3 position open/exit. Pool *selection* is currently a
  deterministic risk-tier map, not yet a live Claude Haiku call.
- **`device-agent/`** — zero-dependency kiosk page for the Raspberry Pi 4
  touchscreen (currently being wired to a real TB74 pulse bill acceptor).

## Quickstart

```bash
# contracts
cd contracts && forge install --no-git && forge test

# backend — needs real Sepolia RPC/keys in .env; see DEPLOYMENTS.md
cd backend && npm install && cp .env.example .env && npm run dev

# kiosk (separate shell)
cd device-agent && node server.js   # http://localhost:8080
```

The kiosk flow, in order: enter an email (`POST /verify`, creates/resolves a
real Privy account + ENS subname) → insert cash or press the fallback button
(`POST /deposit`, real vault deposit) → optionally pick a risk tier on the
dedicated yield page (real Uniswap v3 pool, shown with its actual fee % and
price range) → withdraw (real position exit + vault redemption, 2% fee).

## Status

- **Real and tested**: vault deposit/withdraw, all three Uniswap v3 pools
  (open + exit per user), ENS v2 parent name + subname registrar, Privy
  identity with new-account Sepolia ETH funding, the ATM-style verify-then-
  deposit flow.
- **Not yet real**: Claude Haiku pool *selection* (needs `ANTHROPIC_API_KEY`;
  minting/exiting the chosen pool is already real).
- **In progress**: Raspberry Pi 4 + TB74 pulse bill acceptor hardware —
  kiosk UI is hardware-ready, GPIO wiring and the pulse-debounce listener
  script are the remaining piece before the fallback button can retire.

Treasury wallet is a testnet-only burner key — check its Sepolia ETH
balance before running anything that spends gas; it runs dry easily at
hackathon pace.
