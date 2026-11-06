// End to end through the app's backend code on Sepolia, with the AquaPositionManager:
// prepareOpen -> the wallet signs the steps -> recordOpen -> list -> prepareClose -> sign -> recordClose.
// The treasury wallet stands in for the customer's wallet and a throwaway account row is used and
// removed afterwards. Needs SELF_CUSTODY_SEPOLIA=1 and SELF_MANAGER_SEPOLIA in .env.
//
//   npx tsx --env-file=.env scripts/self-manager-e2e.ts
import { migrate, pool } from "../src/db.js";
import { insertAccount, type Account } from "../src/accounts.js";
import { ethUsd } from "../src/aqua.js";
import { selfNet } from "../src/selfChain.js";
import { listSelf, prepareClose, prepareOpen, recordClose, recordOpen, walletState } from "../src/selfPositions.js";
import { sendTreasuryTx, treasuryAddress } from "../src/chain.js";
import type { Address, Hex } from "viem";

if (!treasuryAddress) throw new Error("no treasury key configured");
let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const step = (s: string) => console.log(`\n▸ ${s}`);
const sign = async (steps: Array<{ to: string; data: string; description: string }>) => {
  const hashes: string[] = [];
  for (const s of steps) {
    console.log(`  signing: ${s.description}`);
    hashes.push(await sendTreasuryTx({ to: s.to as Address, data: s.data as Hex }));
  }
  return hashes;
};
const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

await migrate();
const net = selfNet("sepolia");
check(net.manager !== null, `Sepolia self-custody is on and uses the manager ${net.manager}`);

const id = `e2e-manager-${Date.now()}`;
const account: Account = await insertAccount({ privyUserId: id, email: `${id}@example.test`, privyWallet: treasuryAddress.toLowerCase(), boundAddress: `0x${Date.now().toString(16).padStart(40, "0")}`, label: null });
try {
  step("wallet state");
  const w = await walletState(net, treasuryAddress.toLowerCase());
  console.log(`  ${net.symbols.base} ${w.weth}, ${net.symbols.quote} ${w.usdc}, ${net.symbols.gas} ${w.gasNative}, allowance to manager: ${w.allowance.eth}/${w.allowance.usdc}`);

  const spot = await ethUsd();
  const req = { shape: "curve" as const, priceMin: spot * 0.75, priceMax: spot * 1.25, amount: 15 };

  step("prepare: the transactions the wallet would be asked to sign");
  const prepared = await prepareOpen(net, account, req);
  prepared.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.description}`));
  check(prepared.steps.length <= 3, `at most 3 signatures (was up to 7), got ${prepared.steps.length}`);
  check(prepared.steps.every((s) => s.chainId === net.chainId), "every step is for Sepolia");
  check(prepared.steps[prepared.steps.length - 1]!.to.toLowerCase() === net.manager!.toLowerCase(), "the last step is the one open call to the manager");

  step("a second prepared position must not accept the first one's transactions");
  const decoy = await prepareOpen(net, account, req);

  step("sign and record");
  const hashes = await sign(prepared.steps);
  const open = await recordOpen(net, account, prepared.positionId, hashes);
  check(open.status === "open", "recorded as open");
  check(open.manager?.toLowerCase() === net.manager!.toLowerCase(), "held by the manager");
  check(open.weth > 0 || open.usdc > 0, `live balances in Aqua: ${open.weth} ${net.symbols.base} + ${open.usdc} ${net.symbols.quote}`);
  check(open.valueUsd !== null && Math.abs(open.valueUsd - req.amount) < req.amount * 0.1, `valued at about what was put in ($${open.valueUsd?.toFixed(2)} vs $${req.amount})`);
  const row = (await pool.query("select manager_position_id::text as mid from self_positions where id = $1", [prepared.positionId])).rows[0];
  check(row.mid !== null, `the manager's position id was read from the chain event (#${row.mid})`);

  const replay = await recordOpen(net, account, prepared.positionId, hashes);
  check(replay.status === "open", "recording again is harmless");
  const stolen = await rejects(recordOpen(net, account, decoy.positionId, hashes));
  check(stolen !== null, `another position can't be recorded with these transactions (${stolen})`);
  const wrongCount = await rejects(recordOpen(net, account, decoy.positionId, hashes.slice(0, 1)));
  check(wrongCount !== null, `a wrong number of transactions is refused (${wrongCount})`);

  step("list");
  const listed = await listSelf(net, id);
  check(listed.length === 1 && listed[0]!.status === "open", "the open position is listed on Sepolia");

  step("close");
  const closing = await prepareClose(net, account, prepared.positionId);
  closing.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.description}`));
  check(closing.steps.length === 1, "one signature to close");
  const closeHashes = await sign(closing.steps);
  const closed = await recordClose(net, account, prepared.positionId, closeHashes);
  check(closed.status === "closed", "recorded as closed");
  const after = await walletState(net, treasuryAddress.toLowerCase());
  check(after.weth > 0n || after.usdc > 0n, "the tokens are back in the wallet");
  const wrongClose = await rejects(recordClose(net, account, decoy.positionId, closeHashes));
  check(wrongClose !== null, `closing can't be recorded for a position that never opened (${wrongClose})`);
} finally {
  await pool.query("delete from accounts where privy_user_id = $1", [id]); // cascades to the throwaway positions
  await pool.end();
}
console.log(failures === 0 ? "\n✓ app backend + position manager work end to end on Sepolia" : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
