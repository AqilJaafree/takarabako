# Deployments — Ethereum Sepolia (chain 11155111)

Live testnet addresses this build actually talks to. Update this file
whenever something new is deployed or seeded — it's the source of truth
for `backend/.env`, not the other way around.

## Takarabako contracts

Deployed via `contracts/script/Deploy.s.sol`.

| Contract | Address |
|---|---|
| `MockUSDC` | `0x6cc5f175810e61A56508049f0527BC75EB7e77e4` |
| `TakarabakoVault` | `0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D` |
| `MockRiskToken (mAAVE)` | `0x9c57968055d77d765e4EF1E4F138e9089295eD04` |
| `MockRiskToken (mDOGE)` | `0x071436DC66a7C86a7c12Bc7E337A05fb46908c38` |

Vault's yield reserve was topped up with 100 mUSDC (tx `0x17b9fe848b...`)
so `withdrawTo` can actually pay out accrued mock yield — see PRD §7.6.

## Uniswap v3 (canonical Sepolia deployment, not ours)

| Contract | Address |
|---|---|
| `UniswapV3Factory` | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| `NonfungiblePositionManager` | `0x1238536071E1c677A632429e3655c799b22cDA52` |
| `WETH9` | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |

Verified independently before use: `factory.feeAmountTickSpacing(3000) == 60`,
`NPM.factory() == UniswapV3Factory`, `NPM.WETH9() == WETH9` above.

## Risk-tier pools (PRD §7.6)

| Tier | Pair | Fee | Pool address | Status |
|---|---|---|---|---|
| **Low** | USDC/WETH | 0.3% | `0xE8Dd26347E5Ef1D98946D81b681db1bC4dEeC44d` | **Live** — real liquidity seeded (LP NFT `#231957`, owned by treasury). Price initialized at 3000 USDC = 1 WETH. |
| Medium | USDC/mAAVE | 0.3% | — | Not yet created — pool creation alone costs ~0.005 ETH (a fresh Uniswap v3 pool deploys its own contract via CREATE2); deferred pending more testnet ETH. |
| High | USDC/mDOGE | 1% | — | Not yet created — same reason as medium. |

Pool math (token ordering, `sqrtPriceX96`, full-range ticks) for all three
tiers was precomputed with exact BigInt arithmetic before touching chain —
see the low-risk pool above for the pattern if reviving medium/high:
`sqrtPriceX96 = isqrt(amount1Raw * 2**192 / amount0Raw)`, full-range ticks
`[-887220, 887220]` at the 0.3% tier and `[-887200, 887200]` at 1%.

## Treasury / deployer

`0x9205DcCC081D896edeAB423d88665660d61d5bfE` — testnet-only burner key,
lives in `contracts/.env` and `backend/.env` (both gitignored). Funded via
public Sepolia faucets; never used for anything but this project.

## Not yet real (still stubbed in the backend)

- **World ID Selfie Check** (`backend/src/worldId.ts`) — needs a World
  Developer Portal app + Selfie Check enablement (`developers@toolsforhumanity.com`).
- **ENS v2 subname registration** (`backend/src/ens.ts`) — needs owning
  `wantest.eth` and confirming ENS v2/Namechain testnet availability
  (fallback: L1 NameWrapper subname registrar, same UX).
- **Claude Haiku agent** (`backend/src/agent.ts`) — needs its own
  `ANTHROPIC_API_KEY`; pool selection is currently a hardcoded map, not an
  LLM decision, and no per-user LP position is minted yet (only the
  treasury's own seed position above exists).
