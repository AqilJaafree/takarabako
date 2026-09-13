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

| Test | Privy user id | Open tx | Position NFT | Exit result |
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
- Registered with `address(0)` subregistry/resolver placeholders first (a deliberate lower-risk sequencing — see below), then `setSubregistry` was called once the real registry deployment was confirmed working; `getSubregistry("wantest")` now returns that real registry (see next section). `getResolver("wantest")` is still `address(0)` — no resolver deployed/needed yet.

### Subname registry — real, deployed, issuing real subnames

Found the exact deployment mechanics by getting `RegistryRolesLib.sol`'s
authoritative source from `ensdomains/contracts-v2` on GitHub (via `gh api`,
not a doc summary) rather than guessing a role bitmap, and by confirming
`UserRegistry` (not the root's `PermissionedRegistry`) is the actual
`VerifiableFactory`-clonable implementation, with its own `initialize()`.

| Contract | Address | Verified as |
|---|---|---|
| `UserRegistry` implementation | `0x624a25d67b59d587752ebec8dded8827dae52050` | `UserRegistry`; has `initialize(address,uint256)`, unlike the root's constructor-only `PermissionedRegistry` |
| **Our subregistry for `wantest.eth`** | `0x786441fDe1a4006EadD745A8b90d8621F7a99916` | deployed via `VerifiableFactory.deployProxy`; `factory.verifyContract(...)` confirms it points at the `UserRegistry` impl above |

Deployment used `salt = uint256(keccak256(abi.encode(keccak256("UserRegistry"), namehash("wantest.eth"), 0)))`
and `data = initialize(treasury, ALL_ROLES)`, where `ALL_ROLES` is every
role constant from `RegistryRolesLib.sol` (base + `<<128` admin variant)
OR'd together. Both `namehash("wantest.eth")` and `keccak256("wantest")`
were cross-checked against values that appeared independently inside the
`wantest.eth` registration transaction's own logs — not just internal
consistency, agreement with what the real ENS contracts had already
computed on-chain. Every step (proxy deployment, linking it to
`wantest.eth` via `ETHRegistry.setSubregistry(findTokenId("wantest"), ...)`,
then registering the first real subname) was dry-run via `eth_call`
first — all succeeded with no reverts before any real transaction was sent.

`ETHRegistry.getSubregistry("wantest")` now returns our registry above,
confirmed independently (not just the tx receipt).

**Real subnames issued and independently verified** (`findOwner(label)`
on our registry matches exactly):

| Subname | Owner | Register tx |
|---|---|---|
| `machina.wantest.eth` | `0xb018D435f253f63fff95E3a37a11FA54D9283702` | `0x15ad190b...` |
| `realenstest.wantest.eth` | `0x62F5422C49F448d2D3B57F0dd26F14fF6b43A82B` | `0x0b5a23b4...` |
| `uniswap-1.wantest.eth` | `0x62F5422C49F448d2D3B57F0dd26F14fF6b43A82B` | `0x3ebf71d1...` |

`backend/src/ens.ts` calls this for real now (`registerEnsLabelOnChain` in
`chain.ts`) — `POST /deposit` and `POST /agent/open-position` both mint
genuine subnames, no stub path left for the happy case.

## Identity: World ID → Privy (swapped)

World ID Selfie Check (`backend/src/worldId.ts`, now deleted) was replaced
with Privy (`backend/src/privy.ts`) after its bridge/QR handoff never got a
scanned phone to actually connect — repeated real attempts (with the SDK's
own `getDebugReport()` logged) sat at `waiting_for_connection` forever, even
after registering the missing World ID action via the
`worldcoin-developer-portal` MCP. Privy needs no phone, no QR, no bridge:
the kiosk takes an email on-screen, the backend calls `users().create()` /
`users().getByEmailAddress()` directly (server-to-server, app secret auth)
and gets back a real embedded wallet synchronously. Sybil-resistance signal
is now "one email → one Privy user" — weaker than World ID's biometric
uniqueness proof, a deliberate trade for something that actually works in
the time available.

`PRIVY_APP_ID` / `PRIVY_APP_SECRET` are set in `backend/.env` (from
dashboard.privy.io) and **verified working end-to-end**: real Privy user +
embedded wallet returned synchronously (no polling), same email correctly
reuses the same user (`reused: true`, no duplicate wallet), backend stayed
alive throughout.

**New-account funding:** every brand-new Privy user (first-time
`users().create()` only — not repeat logins) gets **0.001 real Sepolia ETH**
sent from the treasury to their embedded wallet, so they have gas for
anything they do with it themselves later (`fundWalletWithEthOnChain` in
`chain.ts`, gated in `privy.ts`). Verified: a fresh test wallet
(`0xEe411b45...`) received exactly 0.001 ETH (tx `0x9d6c4ba1...`); a
second `/verify` with the *same* email correctly returned `reused: true`
with no `fundingTxHash` and no balance change — confirmed via independent
`cast balance` checks both times, not just trusting the API response.
A funding failure (e.g. treasury low on ETH) is caught and logged without
failing the account creation itself — the user still gets a real wallet,
just no gas yet.

## ATM-style flow reorder (verify-then-deposit)

Backend now authenticates before it accepts cash, matching a real ATM
instead of the original "cash in blind, identify after" order:

- `POST /verify { email }` runs **first**: resolves/creates the Privy user,
  and — new-account only — derives an ENS label from the email
  (`deriveEnsLabel` in `ens.ts`, collision-avoiding hash suffix, e.g.
  `alice-4f2a.wantest.eth`) and registers it immediately, before any money
  has moved. Returns `{ userId, ensName, balance: 0 }` synchronously.
- `POST /deposit { userId, amount }` runs **second**: credits the account
  identified by `userId` (already known from `/verify`), no more inline
  `{handle, email}`/ENS-registration-on-deposit path.
- `backend/src/store.ts` was rewritten to match: `User`+`Wallet` merged into
  one `Account` type keyed by `privyUserId`, with `deriveBoundAddress`
  exported for the deterministic bookkeeping address. `routes/withdraw.ts`,
  `routes/agentRoutes.ts`, `routes/position.ts` updated to look accounts up
  by `userId` through this single store.
- Verified end-to-end via curl and a Playwright kiosk run (email →
  `atm-ui-test-2-feb1.wantest.eth` registered and new wallet funded with
  0.001 ETH at verify-time, deposit afterward credited the same account) —
  see PRD §6.1/§6.2/§8 for the updated flow and sequence diagram.

## Claude Haiku 4.5 decision-making — now real

`backend/src/agent.ts`'s `chooseRiskTierWithAgent()` makes a genuine
`@anthropic-ai/sdk` call to `claude-haiku-4-5-20251001` (`ANTHROPIC_API_KEY`
in `backend/.env`) before every `POST /agent/open-position` mint. It's given
the live pool data (`getPoolsInfo()` — real pair/fee/APY, not hardcoded
strings) plus the user's chosen risk tier and deposit amount, and returns a
one-sentence rationale grounded in that data.

**Guardrail (PRD §10):** the model has no authority to change the user's
risk tier — `chooseRiskTierWithAgent` always mints into the tier the user
picked on the kiosk screen; a mismatched `riskTier` in Claude's JSON reply
is logged as a warning and discarded, never acted on. This is a deliberate
match for the security posture already in place for the agent's on-chain
actions: it proposes/explains, the backend's own tier-scoped logic is what
actually executes.

**Resilience:** any API failure (bad key, timeout, malformed JSON) falls
back to a canned per-tier rationale rather than blocking the mint — verified
by triggering a real failure (an unsupported `output_config.effort` param
on Haiku 4.5) and confirming the position still opened correctly with the
fallback text logged.

**Verified end-to-end, not just trusted:** real API call → response logged
as `[agent] model=claude-haiku-4-5-20251001 confirmed risk=low: "USDC/ETH at
0.3% fee offers stable stablecoin-to-major-asset exposure with modest 3.2%
APY, matching your low-risk selection."` — the rationale cites the pool's
actual fee/APY figures it was given, confirming it's reasoning over the real
JSON rather than echoing a template. The resulting mint tx
(`0xe2b46783...`) was independently confirmed on-chain (`status: 1`, a real
NFT `Transfer` at the NonfungiblePositionManager address) via `cast
receipt`, not just the API's own response.

Two real bugs were caught and fixed by this live test rather than assumed
away: Haiku 4.5 rejects `output_config.effort` (Anthropic API error,
`invalid_request_error`) — removed; and Haiku sometimes wraps its JSON
reply in a ` ```json ` fence despite being told not to — now stripped
before `JSON.parse`.

The rationale is threaded all the way to the kiosk: `POST
/agent/open-position`'s response includes `rationale`, and
`device-agent/public/app.js` logs it (`agent: "..."`) right after the
position-opened line.
