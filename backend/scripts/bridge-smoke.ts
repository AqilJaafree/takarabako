// Moves a small amount of the treasury's USDC from one chain to the other over CCTP
// and waits for it to arrive. Spends testnet funds on both chains' gas.
//
//   npm run bridge:smoke -- <from> <to> <amountUsd>      e.g.  sepolia arc-testnet 1
import { pool } from "../src/db.js";
import { advanceTransfer, createTransfer, getTransfer, validateAmount, validateRoute } from "../src/bridge.js";
import { chainOps } from "../src/chain.js";

const [fromArg, toArg, amountArg = "1"] = process.argv.slice(2);
const route = validateRoute(fromArg ?? "", toArg ?? "");
const amount = Number(amountArg);
validateAmount(amount);

const t = await createTransfer({ privyUserId: null, kind: "treasury", from: route.from, to: route.to, amountUsd: amount, recipient: chainOps(route.to).treasuryAddress ?? "" });
console.log(`transfer ${t.id}: $${amount} ${route.from} -> ${route.to}`);
for (;;) {
  const state = await advanceTransfer(t.id);
  const row = await getTransfer(t.id);
  console.log(`  ${state}${row?.error ? ` (${row.error})` : ""}`);
  if (state === "failed" || state === "minted" || state === "credited") break;
  await new Promise((r) => setTimeout(r, 20_000));
}
const done = await getTransfer(t.id);
console.log(`burn ${done?.burnTx}\nmint ${done?.mintTx}`);
await pool.end();
