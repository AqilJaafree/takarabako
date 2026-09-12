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
| **Medium** | USDC/mAAVE | 0.3% | `0xb9a463fdBC9f1be53d582351b631e0EC277B16e0` | **Live** — real liquidity seeded (LP NFT `#231958`, owned by treasury). Price initialized at 100 USDC = 1 mAAVE. |
| **High** | USDC/mDOGE | 1% | `0x90999138f8b1B69b953239Eb1F0D991e601Bbfe2` | **Live** — real liquidity seeded (LP NFT `#231959`, owned by treasury). Price initialized at 1 USDC = 10 mDOGE. |

All three verified independently after seeding (`liquidity()` non-zero,
`token0`/`token1`/`fee` match, `NPM.ownerOf(tokenId)` == treasury) —
not just trusting transaction receipts.

Pool math (token ordering, `sqrtPriceX96`, full-range ticks) for all three
tiers was precomputed with exact BigInt arithmetic before touching chain —
see the low-risk pool above for the pattern if reviving medium/high:
`sqrtPriceX96 = isqrt(amount1Raw * 2**192 / amount0Raw)`, full-range ticks
`[-887220, 887220]` at the 0.3% tier and `[-887200, 887200]` at 1%.

## Treasury / deployer

`0x9205DcCC081D896edeAB423d88665660d61d5bfE` — testnet-only burner key,
lives in `contracts/.env` and `backend/.env` (both gitignored). Funded via
public Sepolia faucets; never used for anything but this project.

## Per-user position open/exit (PRD §6.4/§6.6) — real

`POST /agent/open-position` mints a genuine new LP NFT into the tier's pool
above; `POST /withdraw` decreases its liquidity and collects the proceeds,
valuing the non-USDC side at each pool's fixed init price (not a live
oracle) to fold into the receipt. Verified end-to-end for all three tiers,
both directions (`chain.ts`, `agent.ts`):

| Test | Nullifier | Open tx | Position NFT | Exit result |
|---|---|---|---|---|
| Low | `0xuni-low` | `0x6b1de330...` | `#231960` | liquidity → 0, gross ≈ $2.00 (1 USDC + 0.000333 WETH) |
| Medium | `0xuni-med` | `0x868eae43...` | `#231961` | gross ≈ $20.00 (10 USDC + 0.1 mAAVE) |
| High | `0xuni-high` | `0x99a78ffe...` | `#231962` | gross ≈ $20.00 (100 mDOGE + 10 USDC) |

The treasury supplies the non-USDC side of every open (WETH for low —
wrapped from real ETH, so this is the one operation that costs real
capital, not just gas; mAAVE/mDOGE are freely mintable mocks for
medium/high). Mint amounts are small and fixed per tier, not literally
proportional to the user's deposit — see the "why" comment in `agent.ts`.

## ENS v2 (Sepolia Beta — genuinely live, confirmed on-chain)

Earlier drafts of this doc assumed ENS v2/Namechain testnet availability
was unconfirmed. It's not unconfirmed — it's live. Every address below
was verified two ways before use: bytecode presence, then the *actual*
Etherscan-verified contract name (not a doc summary) via WebFetch, then
cross-checked against a related contract's own on-chain reference (e.g.
`ETHRegistrar.ETH_REGISTRY()` == the `ETHRegistry` address independently
found).

| Contract | Address | Verified as |
|---|---|---|
| `ETHRegistry` (root PermissionedRegistry for `.eth`) | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` | `PermissionedRegistry` |
| `ETHRegistrar` | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | `ETHRegistrar`; `.ETH_REGISTRY()` matches the row above exactly |
| `VerifiableFactory` | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` | `VerifiableFactory` |
| `StandardRentPriceOracle` | `0x8914b66260EB8C4fff795650c3AE8Cd335958987` | accepts real Circle Sepolia USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) as `paymentToken` — **not** ETH, **not** our MockUSDC |

**`wantest.eth` is registered**, owned by the treasury:
- `findOwner("wantest")` → treasury address (independently verified, not just trusting the tx receipt)
- `findExpiry("wantest")` → 2027-09-12 (1-year registration)
- Paid 8.000021 real Circle-USDC (commit tx `0x1cf2f306...`, register tx `0x0a10c61f...`)
- `getSubregistry`/`getResolver` are currently `address(0)` — a deliberate safe placeholder. `ETHRegistry.setSubregistry(anyId, registry)` / `.setResolver(anyId, resolver)` are owner-only calls that can set these properly later, so registering first with placeholders (rather than guessing a `VerifiableFactory.deployProxy` init payload under time/cost pressure) was the lower-risk order of operations.

**Not yet done:** deploying our own `PermissionedRegistry` (via
`VerifiableFactory.deployProxy(implementation, salt, initData)`) to
actually issue subnames like `machina.wantest.eth` / `uniswap-{id}.wantest.eth`.
This needs the exact initializer signature confirmed before spending real
gas on it — `backend/src/ens.ts` stays stubbed until then.

## Not yet real (still stubbed in the backend)

- **World ID Selfie Check** (`backend/src/worldId.ts`) — needs a World
  Developer Portal app + Selfie Check enablement (`developers@toolsforhumanity.com`).
- **ENS v2 subname issuance** (`backend/src/ens.ts`) — the parent name is
  real (see above); issuing actual subnames under it is the remaining step.
- **Claude Haiku *decision-making*** (`backend/src/agent.ts`) — pool
  *selection* is still a hardcoded risk-tier map, not an LLM call; needs
  its own `ANTHROPIC_API_KEY` (`config.agent.model` is wired but unused).
  Minting/exiting the chosen pool, however, is real — see above.
