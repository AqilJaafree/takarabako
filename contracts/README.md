# contracts

Foundry workspace for Takarabako's on-chain pieces (PRD §7.4).

- `src/mocks/MockJPYC.sol` — testnet stand-in for JPYC (PRD §7.5).
- `src/mocks/MockRiskToken.sol` — generic mintable ERC-20 for the medium/high
  risk-tier Uniswap pools when no liquid real testnet pair exists (PRD §7.6).
- `src/TakarabakoVault.sol` — the mock-yield ERC-4626-flavored vault (PRD
  §7.4/§7.6): `depositFor` fronts JPYC from the treasury, `withdrawTo`
  settles principal + accrued yield to an explicit recipient (the
  dev/treasury wallet on withdraw, per §6.6 — not back to the depositor).
- `script/Deploy.s.sol` — deploys all of the above to a testnet, treasury
  self-approves the vault, and mints a demo faucet balance.

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

Feed the printed `MockJPYC` and `TakarabakoVault` addresses into
`backend/.env` (`JPYC_ADDRESS`, `VAULT_ADDRESS`).

## Not yet in this workspace

Per the PRD build plan, `ITakarabakoAgentController` (the guardrailed
proposer the Claude Haiku agent calls into, §7.4/§7.9) and the World ID
`registerUser` identity gate (§7.4) land in Phase 2–3, once the backend's
stub `/verify` and `/agent/open-position` routes are wired to real calls.
