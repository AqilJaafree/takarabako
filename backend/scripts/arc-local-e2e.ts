// End-to-end check of the second chain against a LOCAL node, no testnet funds needed:
//
//   anvil --chain-id 5042002
//   (deploy a MockUSDC and run contracts/script/DeployCashChain.s.sol against it)
//   CHAIN=sepolia ENABLED_CHAINS=arc-testnet ARC_TESTNET_RPC_URL=http://127.0.0.1:8545 \
//   ARC_TESTNET_USDC_ADDRESS=... ARC_TESTNET_VAULT_ADDRESS=... ARC_TESTNET_CASH_RECEIPT_ADDRESS=... \
//   TREASURY_PRIVATE_KEY=<anvil key> DATABASE_URL=... npm run arc:e2e
//
// (Vault share maths rounds down by up to a millionth of a dollar, hence the 1e-4 tolerances.)
// Covers what the Arc chain relies on: the vault and tkCASH through the direct-RPC path,
// the event log reader, the reserve / vault / treasury panels, and a withdrawal.
import { pool, migrate } from "../src/db.js";
import { chainOps } from "../src/chain.js";
import { allowlist, cashReceiptReadyOn, recordCashIn, redeemAll, tkRead, tkSupply } from "../src/cashReceipt.js";
import { indexChainOnce, indexerStatus } from "../src/logIndexer.js";
import { reserveStatus, treasuryBalances, vaultState } from "../src/treasury.js";
import { balancesByChain } from "../src/balances.js";

// E2E_CHAIN=hedera-testnet runs the same checks against a Hedera stand-in.
const chain = (process.env.E2E_CHAIN ?? "arc-testnet") as "arc-testnet" | "hedera-testnet";
const ops = chainOps(chain);
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
};

await migrate();
check(ops.chainReady, "the chain is configured");
check(cashReceiptReadyOn(chain), "tkCASH is reachable without MultiBaas");

const user = "0x00000000000000000000000000000000000000a1";
const wallet = "0x00000000000000000000000000000000000000b2";
await pool.query("insert into accounts (privy_user_id, email, privy_wallet, bound_address, label) values ('u-e2e', 'e2e-test', $1, $2, 'e2e') on conflict do nothing", [wallet, user]);

await ops.ensureVaultApproval();
const dep = await ops.depositOnChain(user, 25);
check(Math.abs(dep.value - 25) < 1e-4, `vault deposit credited $25 (box now $${dep.value})`);

await allowlist(wallet, chain);
check((await tkRead<boolean>(chain, "allowlist", [wallet])) === true, "wallet allowlisted in tkCASH");
await pool.query("insert into deposits (id, privy_user_id, currency, amount, status, chain) values ('00000000-0000-0000-0000-0000000000e2', 'u-e2e', 'USD', 25, 'confirmed', $1) on conflict do nothing", [chain]);
const mint = await recordCashIn({ depositId: "00000000-0000-0000-0000-0000000000e2", wallet, usdAmount: 25, denomination: 25, currency: "USD", chain });
check(Boolean(mint), "tkCASH minted for the note");
const supply = await tkSupply(chain);
check(Math.abs(supply.supply - 25) < 1e-4 && Math.abs(supply.reserve - 25) < 1e-4, `tkCASH supply ${supply.supply} equals reserve ${supply.reserve}`);

const n = await indexChainOnce(chain);
check(n >= 4, `the log reader stored ${n} events (Deposited, Transfer, CashIn, allowlist/kiosk…)`);
const { rows } = await pool.query("select name, chain from chain_events where chain = $1", [chain]);
const names = new Set(rows.map((r) => r.name));
check(names.has("Deposited") && names.has("CashIn") && names.has("Transfer"), `events carry the chain: ${[...names].join(", ")}`);
check((await indexChainOnce(chain)) === 0, "reading again stores nothing twice");
const st = (await indexerStatus()).find((i) => i.chain === chain);
check(Boolean(st && st.behind !== null && st.behind < 50), `indexer status: ${st?.behind} blocks behind`);

const v = await vaultState(chain);
check(Math.abs(v.liabilityUsd - 25) < 1e-4 && v.vaultUsdcBalance >= 25, `vault panel: owes $${v.liabilityUsd}, holds $${v.vaultUsdcBalance}`);
const r = await reserveStatus(chain);
check(r.configured && r.backed, "reserve panel: backed");
const t = await treasuryBalances(chain);
check(t.gasIsUsdc === (chain === "arc-testnet") && (t.usdc ?? 0) > 0, `treasury panel: gas ${t.nativeSymbol}, usdc $${t.usdc?.toFixed(2)}`);
check((await balancesByChain(user)).some((b) => b.chain === chain && Math.abs(b.balance - 25) < 1e-4), "per-chain balance for the account");

const out = await ops.withdrawAllOnChain(user as `0x${string}`, wallet as `0x${string}`);
check(Math.abs(out.amount - 25) < 1e-4, `withdrew $${out.amount} to the wallet`);
const burned = await redeemAll(wallet, chain);
check(Math.abs(burned.burned - 25) < 1e-4, `redeemed $${burned.burned} of tkCASH`);
const after = await tkSupply(chain);
check(after.supply === 0 && after.reserve === 0, "supply and reserve are back to zero");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
await pool.end();
process.exit(failed ? 1 : 0);
