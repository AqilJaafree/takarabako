# Deployments — Ethereum Sepolia (11155111), Arc Testnet (5042002) and Hedera Testnet (296)

> ENS v2 names and World ID were removed from Takarabako. Accounts are a wallet
> address plus a label in Postgres, and kiosks are registered device keys. The
> ENS and World ID deployments that used to be listed here are gone from this
> file; the history is in git.

## Arc Testnet

Not deployed yet. Deploy with your own treasury key (the contracts are owned by
whoever deploys them), then record the addresses here and in `backend/.env`:

```bash
cd contracts
forge script script/DeployCashChain.s.sol --rpc-url https://rpc.testnet.arc.io \
  --broadcast --private-key $TREASURY_PRIVATE_KEY --with-gas-price 25gwei --legacy
```

| Contract | Address |
|---|---|
| USDC (Circle, 6 decimals as an ERC-20) | `0x3600000000000000000000000000000000000000` |
| `TakarabakoVault` | _to deploy_ |
| `TakarabakoCashReceipt (tkCASH)` | _to deploy_ |
| CCTP `TokenMessengerV2` (testnet) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP `MessageTransmitterV2` (testnet) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |

## Hedera Testnet (chain 296, EVM side)

Not deployed yet. Deploy with your own treasury key (the contracts belong to whoever
deploys them):

```bash
cd contracts
HEDERA=1 USDC_ADDRESS=0x0000000000000000000000000000000000068cda \
  forge script script/DeployCashChain.s.sol --rpc-url https://testnet.hashio.io/api \
  --broadcast --private-key $TREASURY_PRIVATE_KEY --skip-simulation --legacy
```

| | |
|---|---|
| USDC | Hedera Token Service token `0.0.429274`, ERC-20 facade `0x0000000000000000000000000000000000068cda` (6 decimals; checked against the testnet mirror node and the relay) |
| Vault | `TakarabakoVaultHedera`: associates itself with USDC when created (HIP-206), which a contract must do before it can hold an HTS token |
| Gas | HBAR (the relay shows it with 18 decimals) |
| RPC | `https://testnet.hashio.io/api` (log queries are capped at 1,000 blocks) |
| Explorer | https://hashscan.io/testnet |
| CCTP | none: top the treasury up from Circle's faucet |

| Contract | Address |
|---|---|
| TakarabakoVaultHedera | _deploy, then fill in_ |
| TakarabakoCashReceipt | _deploy, then fill in_ |

CCTP domains: Ethereum Sepolia 0, Arc Testnet 26. The Sepolia vault below uses a
mock USDC, which CCTP cannot bridge. To bridge from Sepolia, redeploy the vault
against Circle's Sepolia USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) with
the same script and set `SEPOLIA_USDC_ADDRESS` / `SEPOLIA_VAULT_ADDRESS`.


Live testnet addresses this build actually talks to. Update this file
whenever something new is deployed or seeded — it's the source of truth
for `backend/.env`, not the other way around.

## Takarabako contracts

Deployed via `contracts/script/Deploy.s.sol`. All four are **verified on
Sepolia Etherscan as an exact source-code match** (`forge verify-contract`,
independently re-confirmed by fetching each Etherscan page directly rather
than trusting the CLI's own success message):

| Contract | Address | Etherscan |
|---|---|---|
| `MockUSDC` | `0x6cc5f175810e61A56508049f0527BC75EB7e77e4` | [Verified](https://sepolia.etherscan.io/address/0x6cc5f175810e61A56508049f0527BC75EB7e77e4#code) |
| `TakarabakoVault` | `0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D` | [Verified](https://sepolia.etherscan.io/address/0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D#code) |
| `MockRiskToken (mAAVE)` | `0x9c57968055d77d765e4EF1E4F138e9089295eD04` | [Verified](https://sepolia.etherscan.io/address/0x9c57968055d77d765e4EF1E4F138e9089295eD04#code) |
| `MockRiskToken (mDOGE)` | `0x071436DC66a7C86a7c12Bc7E337A05fb46908c38` | [Verified](https://sepolia.etherscan.io/address/0x071436DC66a7C86a7c12Bc7E337A05fb46908c38#code) |

Compiler `0.8.28+commit.7893614a`, optimizer on (200 runs). Constructor args
were re-derived from `Deploy.s.sol` with `cast abi-encode` rather than
guessed — e.g. `MockUSDC(address)` takes the treasury address
`0x9205DcCC081D896edeAB423d88665660d61d5bfE` as `initialOwner`.

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

## ATM-style flow reorder (verify-then-deposit)

Backend now authenticates before it accepts cash, matching a real ATM
instead of the original "cash in blind, identify after" order:

- `POST /verify { email }` runs **first**: resolves/creates the Privy user,
  and — new-account only — derives a label from the email
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

## tkCASH and Curvegrid MultiBaas

`TakarabakoCashReceipt` (tkCASH) is deployed on its own with
`contracts/script/DeployCashReceipt.s.sol`, so the verified contracts above
stay as they are. **Verified on Sepolia Etherscan as an exact source-code
match**, re-confirmed through Etherscan's `getsourcecode` API rather than the
CLI's own message (compiler 0.8.28, optimizer 200 runs):

| Contract | Address | Etherscan |
|---|---|---|
| `TakarabakoCashReceipt (tkCASH)` | `0x8023edf927c0a53f5620998f972b3d0740e04ea9` | [Verified](https://sepolia.etherscan.io/address/0x8023edf927c0a53f5620998f972b3d0740e04ea9#code) |

Deployed in block 11784052 (tx `0x15513552d1…`), with kiosk `kl-sentral-01`
registered in the same block (`setKiosk`, tx `0xab09547f99…`). Checked on-chain
afterwards with `cast call`: `owner()` is the treasury
`0x9205DcCC081D896edeAB423d88665660d61d5bfE`, `symbol()` is `tkCASH`,
`decimals()` is 6, and `kiosks("kl-sentral-01")` is active, not frozen, with a
zero reserve.

How it was deployed and verified (constructor arg: the treasury address as `initialOwner`):

```bash
cd contracts
KIOSK_ID=kl-sentral-01 forge script script/DeployCashReceipt.s.sol --rpc-url $RPC_URL --broadcast --private-key $PRIVATE_KEY
forge verify-contract 0x8023edf927c0a53f5620998f972b3d0740e04ea9 src/TakarabakoCashReceipt.sol:TakarabakoCashReceipt \
  --chain sepolia --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" 0x9205DcCC081D896edeAB423d88665660d61d5bfE)
```

MultiBaas deployment host (Sepolia, free tier): `lfozlu7lwjb2bl25fgqbersp6u.multibaas.com`. Only the host is recorded here, never the API key or webhook secret.

`npm run mb:setup` (backend) creates these labels and aliases:

| Label | Contract | Alias | Address |
|---|---|---|---|
| `takarabako_vault` | `TakarabakoVault` | `vault` | `0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D` |
| `takarabako_cash_receipt` | `TakarabakoCashReceipt` | `tkcash` | `0x8023edf927c0a53f5620998f972b3d0740e04ea9` |
| `mock_usdc` | `MockUSDC` | `musdc` | `0x6cc5f175810e61A56508049f0527BC75EB7e77e4` |
| `uniswap_v3_npm` | `NonfungiblePositionManager` (events + `positions` only) | `uniswap-npm` | `0x1238536071E1c677A632429e3655c799b22cDA52` |
| `ens_user_registry` | `UserRegistry` (`LabelRegistered`, `register`, `findOwner`) | `ens-wantest` | `0x786441fDe1a4006EadD745A8b90d8621F7a99916` |

Plus `treasury` → the treasury signer, and one alias per customer (their
label → their Privy wallet), created at registration.

## 1inch Aqua yield (Sepolia)

| Contract | Address | Notes |
|---|---|---|
| 1inch `Aqua` | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` | Same address as mainnet; present on Sepolia though the SDK's address list omits it |
| `AquaSwapVMRouter` | `0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de` | The router's previous address; `eip712Domain()` reports "1inch SwapVM v1.0" / 1.0.2 on chain 11155111 and `AQUA()` returns the Aqua address above. The current mainnet router address (`0x11111133…ac0de`) has no code on Sepolia |
| `MockRiskToken (mETH)` | `0x5A9E9fF59AeBb96C14DFaB7C2a43d0C130ba9282` | Ours — `contracts/script/DeployMockEth.s.sol`, 18 decimals, 1M minted to the treasury; [Etherscan](https://sepolia.etherscan.io/address/0x5A9E9fF59AeBb96C14DFaB7C2a43d0C130ba9282#code) shows it verified (same bytecode as the other mocks) |

Verified on-chain before building on it: a concentrated strategy shipped
(tx `0x6d8ceb35…`) quoted 100 mUSDC → 0.03318 mETH and 0.01 mETH → 29.90 mUSDC
around a $3,000 spot; a USDC-only bid at $2,400–2,700 (tx `0x021858f7…`) took a
real swap from the treasury as taker (tx `0x0fc339df…`), leaving 973.12 of 1,000
mUSDC. Both probe strategies were docked afterwards. The treasury approved Aqua
(to pull as maker) and the router (to pay as taker) for mETH and mUSDC.

MultiBaas links the Aqua contract as `oneinch_aqua` (alias `aqua`) in the slot
that held Uniswap's position manager; a saved query `aqua_pulled_by_token`
sums swap volume out of our strategies.

### Kiosk renamed: kl-sentral-01 → tokyo-01

The kiosk is now `tokyo-01`. On tkCASH, `setKiosk(tokyo-01, true)` (tx
`0x52fe4df9…`) put it in service and `setKiosk(kl-sentral-01, false)` (tx
`0x1a656cbe…`) retired the old one: no new cash-ins there, but its reserve
(122.33 at the switch) stays redeemable — the backend burns against the
current kiosk first, then retired ones (`KIOSK_PREVIOUS_IDS`). On the kiosk side,
`tokyo-01.takarabako.eth` resolves to the same Pi device key
(`0xb3F9…C9f5`, `takarabako.kind=kiosk`), and `kl-sentral-01.takarabako.eth`
is marked `takarabako.kind=retired-kiosk`, so notes signed as the old kiosk
no longer verify. The first note signed as `tokyo-01.takarabako.eth`
verified end to end and minted against Tokyo's reserve.
