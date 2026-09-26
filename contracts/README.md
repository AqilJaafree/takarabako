# contracts

Foundry workspace for Takarabako's on-chain pieces (PRD §7.4).

- `src/mocks/MockUSDC.sol` — testnet stand-in for USDC (6 decimals, matching
  the real token) (PRD §7.5).
- `src/mocks/MockRiskToken.sol` — generic mintable ERC-20 for the medium/high
  risk-tier Uniswap pools when no liquid real testnet pair exists (PRD §7.6).
- `src/TakarabakoVault.sol` — the mock-yield ERC-4626-flavored vault (PRD
  §7.4/§7.6): `depositFor` fronts USDC from the treasury, `withdrawTo`
  settles principal + accrued yield to an explicit recipient (the
  dev/treasury wallet on withdraw, per §6.6 — not back to the depositor).
- `src/TakarabakoCashReceipt.sol` — **tkCASH**, a tokenized receipt for
  the banknotes in a kiosk (6 decimals, $1 each). The treasury mints on
  `recordCashIn` and burns on `redeem`, moving that kiosk's reserve with
  it, so supply always equals total reserve. `attestReserve` records an
  operator's physical count and freezes the kiosk's minting on a mismatch
  (`unfreezeKiosk` after a human resolves it). Holder-to-holder transfers
  need both sides allowlisted, stay under a per-address daily limit, and
  stop when paused; mint and burn bypass those rules.
- `script/Deploy.s.sol` — deploys the mocks and the vault to a testnet, treasury
  self-approves the vault, and mints a demo faucet balance.
- `script/DeployCashReceipt.s.sol` — deploys tkCASH on its own and
  registers the first kiosk (`KIOSK_ID`, default `kl-sentral-01`).

## Setup

```bash
forge install --no-git   # restores lib/ (forge-std, openzeppelin-contracts) — gitignored
forge build
forge test
```

## Deploy

```bash
forge script script/Deploy.s.sol --rpc-url <testnet_rpc> --broadcast --private-key <treasury_pk>
```

Feed the printed `MockUSDC` and `TakarabakoVault` addresses into
`backend/.env` (`USDC_ADDRESS`, `VAULT_ADDRESS`).

```bash
KIOSK_ID=kl-sentral-01 forge script script/DeployCashReceipt.s.sol --rpc-url <testnet_rpc> --broadcast --private-key <treasury_pk>
```

Put the printed tkCASH address in `backend/.env` as `CASH_RECEIPT_ADDRESS`.

## Not yet in this workspace

Per the PRD build plan, `ITakarabakoAgentController` (the guardrailed
proposer the Claude Haiku agent calls into, §7.4/§7.9) and the World ID
`registerUser` identity gate (§7.4) land in Phase 2–3, once the backend's
stub `/verify` and `/agent/open-position` routes are wired to real calls.
