# Feedback: Uniswap v3/v4 for high-frequency retail flows

Context: Takarabako is a cash-in kiosk (ETHGlobal Online 2026) that routes
every deposit into a risk-tiered Uniswap v3 position and exits it on
withdraw — one mint/exit pair per user action, not a buy-and-hold LP. That
usage pattern is closer to a retail trading app (Robinhood-style: frequent,
small, unattended transactions triggered by a non-technical user tapping a
button) than to a typical LP's "deposit once, monitor occasionally" flow,
and it surfaced three real friction points worth flagging to the Uniswap
Foundation.

## 1. Displayed liquidity value doesn't match actual position value

Observed on mainnet before this project moved to testnet-only building:
a position's on-screen/quoted value (e.g. "$60") could sit meaningfully
below what the position was actually worth when unwound (~$83 in one case).
For a buy-and-hold LP checking in occasionally, that gap is a rounding
annoyance. For a kiosk that has to show a user "here's what you're getting
back" the moment they tap withdraw, a ~30%+ discrepancy is a trust-breaking
bug, not a display quirk — the number on screen has to be the number in the
user's hand seconds later.

Root cause, as far as we could tell integrating directly against
`NonfungiblePositionManager` (see `contracts/` in this repo for our own
same-shape valuation logic): a concentrated-liquidity position's real-time
USD value depends on the current tick, both token amounts at that tick,
*and* a live price for the non-quote-currency side — three moving pieces
that a naive "amount0 * price0 + amount1 * price1" computation using a
slightly-stale or wrong-source price will silently get wrong, with no
error or warning surfaced anywhere in the position-manager contracts
themselves.

**Ask:** a canonical, on-chain-computable "position value in terms of
token X, as of this exact tick" view function (or a well-documented,
single-source-of-truth off-chain formula that isn't scattered across
forum posts and outdated blog examples) would remove an entire class of
integrator bugs. Right now every team re-derives this math themselves,
and it's easy to get subtly wrong in exactly the way that erodes user
trust once real money's involved.

## 2. No reliable way to enumerate a user's positions without tracking NFT IDs yourself

There's no "give me every position this address owns in this pool" call
that just works — an integrator either runs their own indexer/subgraph or
manually tracks every minted `tokenId` in their own database the moment
`mint()` returns it (`positions.map(p => p.nftTokenId)` in our
`backend/src/store.ts`, since we had nowhere better to keep it). If that
off-chain record is ever lost, rebuilt from a different source, or simply
out of sync (a backend restart mid-session did exactly this to us during
testing), the position doesn't disappear — it's still real, still on
Sepolia, still worth real value — but the app has no way to *find* it
again short of manually paging through `Transfer` events on the position
manager's NFT contract and cross-checking ownership one tokenId at a time.

**Ask:** either a first-party `positionsByOwner(address, pool)` view (even
if gas-heavy / view-only, not something you'd call in a hot path) or a
clearly-documented, officially-maintained subgraph endpoint recommended
as the source of truth for this — right now every team we've read about
solves this the same ad-hoc way, which means every team is one storage
bug away from an LP position that's real but invisible to its own owner.

## 3. Exiting a one-sided position leaves the user holding the "wrong" asset

When a concentrated-liquidity position's range gets fully exited by price
movement, `decreaseLiquidity` + `collect` hands back 100% of one token and
0% of the other. That's correct AMM behavior, but it means "withdraw my
yield position" doesn't actually give a user cash-equivalent value back —
it gives them a single volatile asset they didn't choose to hold, at
whatever price happened to be current the moment the range was crossed.
For a kiosk whose entire promise is "cash in, cash-equivalent out," we
had to build our own fixed-price valuation fallback for this case (see the
`counterpartUsdcPrice` handling in `backend/src/agent.ts`) just to give a
believable withdrawal quote — a real production version would need a live
price feed and a real swap, not a fixed rate.

**Ask:** a first-class "exit and swap proceeds to token X" primitive —
this feels like exactly the kind of thing a v4 hook belongs solving
(an `afterRemoveLiquidity` hook that auto-routes a lopsided payout through
a swap back to a target asset like USDC/WETH/USDG) rather than something
every downstream product has to bolt on with its own router calls and
slippage handling. Right now the "one-sided exit" problem is treated as
the user's problem to solve after the fact; for any product presenting
yield as something closer to a savings account than an active trading
position, it needs to be the protocol's problem to solve *during* the
exit.

---

None of this is a complaint about correctness — v3's math is correct by
design, and the "problems" above are really "the primitives are correct
but low-level, and every integrator re-solves the same three UX gaps
independently." Flagging them here in case they're useful input for
where v4 hooks (or v3 tooling) could close the gap for higher-frequency,
consumer-facing use cases like this one.

---

# Feedback: Curvegrid MultiBaas

Context: we added MultiBaas to Takarabako as the backend's contract layer
and indexer — treasury writes (tkCASH mint/burn, approved agent actions)
through the unsigned-transaction flow, reads through the contract API,
saved Event Queries for the dashboard, and signed webhooks into Postgres.
These notes are from writing that integration against
`@curvegrid/multibaas-sdk` 1.1.1 and the public docs. They'll be extended
once we've run it against a live deployment.

## What worked well

- **The unsigned-transaction flow fits a backend that must keep its own
  key.** Calling a write method with `from` returns a ready
  `TransactionToSignResponse`; we sign it with viem and hand it back to
  `submitSignedTransaction`. That let us keep the treasury key in our own
  process without a Cloud Wallet, which on the free tier would have meant
  one wallet and an Azure setup.
- **Contract calls by alias and label read cleanly.** `callContractFunction("tkcash", "takarabako_cash_receipt", "recordCashIn", args)`
  is much easier to review than raw ABI encoding, and `formatInts: "string"`
  keeps 6-decimal amounts exact in JavaScript.
- **The webhook docs are precise.** Header names, hex encoding, the
  body-then-timestamp order and the array payload shape were all stated,
  with Go reference code, so the verifier was quick to write and test.
- **Event Query aggregators map onto real questions.** Rebuilding token
  balances from `Transfer` with an `add` on `to` and a `subtract` on `from`,
  grouped by holder, gave us a holders table without running our own indexer.

## What tripped us up

- **The SDK signature changed between versions, and the sample app is on
  the old one.** `multibaas-sample-app` passes a `chain` argument first
  (`callContractFunction(chain, address, label, method, args)`,
  `getChainStatus(chain)`); in 1.1.1 the chain is baked into the paths
  (`/chains/ethereum/...`) and that argument is gone. Copying from the
  sample gave type errors until we read the generated `api.d.ts`.
- **No JSON examples for Event Queries.** The Event Indexing page explains
  the concepts (select, filter, aggregate, group by the one non-aggregated
  field), but we couldn't find a full request example. Unanswered for us
  from the docs: whether `eventName` is the bare name or the full signature
  (we used `CashIn(bytes32,address,uint256,uint32,bytes3)`), how to filter
  to one contract (we used a `contract_label` field filter), and whether
  results can be grouped by day. One complete example per feature would
  have saved guesswork.
- **Nonces when two signers' views differ.** Transactions MultiBaas builds
  carry a nonce from its node, while our viem sends use a local nonce
  manager against a different RPC. A send made a second earlier may not be
  visible to the other side yet, so the two paths could hand out the same
  nonce. We sign MultiBaas-built transactions with our own nonce manager
  instead of the returned `nonce`, and serialise both paths. A note on this
  in the unsigned-transaction docs would help anyone mixing MultiBaas with
  another client.
- **Shared contracts flood the event stream.** Linking Uniswap's
  `NonfungiblePositionManager` or a shared ENS registry indexes every
  user's events, not just ours, so our webhook handler has to filter by
  address. A per-link event filter (e.g. only events involving an address)
  would make linking shared infrastructure practical on a small plan.

## Suggestions

1. Keep the sample app in step with the current SDK, or pin the SDK
   version it targets in its README.
2. Add copy-paste JSON examples to each Event Query doc page (a sum with
   group-by, a filter by contract, an ordered list).
3. Document how to combine MultiBaas-built unsigned transactions with a
   client that manages its own nonces.
4. Offer event filters on address–contract links for shared contracts.
