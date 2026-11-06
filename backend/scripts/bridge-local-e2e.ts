// Runs the real bridge state machine (src/bridge.ts) between two LOCAL chains, with
// contracts/test/mocks/MockCctp.sol standing in for Circle's CCTP contracts at their testnet
// addresses, and a stub for Circle's attestation service. No testnet funds needed.
//
//   anvil --chain-id 11155111 --port 8546      (Sepolia stand-in)
//   anvil --chain-id 5042002  --port 8545      (Arc Testnet stand-in)
//   deploy MockUSDC + DeployCashChain.s.sol on each, `anvil_setCode` the mock at both CCTP
//   addresses and `setUsdc` on it, then:   npm run bridge:e2e   (env as in arc-local-e2e.ts,
//   with SEPOLIA_* and ARC_TESTNET_* for both chains)
import { decodeEventLog, parseAbi, type Address } from "viem";
import { pool, migrate } from "../src/db.js";
import { chainOps } from "../src/chain.js";
import { advanceTransfer, createTransfer, getTransfer, validateAmount, validateRoute, BridgeError } from "../src/bridge.js";
import { CCTP_TESTNET } from "../src/cctp.js";

let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

await migrate();
const sep = chainOps("sepolia");
const arc = chainOps("arc-testnet");
check(sep.chainReady && arc.chainReady, "both chains are configured");
// A fresh account each run, so balances left on the local chains by earlier runs don't matter.
const run = Date.now();
const bound = `0x${run.toString(16).padStart(40, "0")}` as Address;
const uid = `u-br-${run}`;
await pool.query("insert into accounts (privy_user_id, email, privy_wallet, bound_address, label) values ($1, $2, $3, $4, $5)", [uid, `br-${run}`, `0x${(run + 1).toString(16).padStart(40, "0")}`, bound, `br-${run}`]);
await sep.ensureVaultApproval();
await arc.ensureVaultApproval();
await sep.depositOnChain(bound, 40);

// Circle's attestation service, stubbed: not ready on the first look, then the burn's message.
const eventAbi = parseAbi(["event MessageSent(bytes message)"]);
let looks = 0;
const deps = {
  fetchAttestation: async (_url: string, _domain: number, burnTx: string) => {
    if (++looks === 1) return { ready: false as const, reason: "pending_confirmations" };
    const receipt = await sep.publicClient.getTransactionReceipt({ hash: burnTx as `0x${string}` });
    const log = receipt.logs.find((l) => l.address.toLowerCase() === CCTP_TESTNET.tokenMessenger.toLowerCase());
    if (!log) return { ready: false as const, reason: "no burn log" };
    const ev = decodeEventLog({ abi: eventAbi, data: log.data, topics: log.topics });
    return { ready: true as const, message: ev.args.message, attestation: "0x00" as const };
  },
};

// 1. A customer moves $15 from Sepolia to Arc.
const t = await createTransfer({ privyUserId: uid, kind: "customer", from: "sepolia", to: "arc-testnet", amountUsd: 15, recipient: bound });
check((await advanceTransfer(t.id, deps)) === "burned", "burns, then waits while Circle hasn't signed");
let row = await getTransfer(t.id);
check(Boolean(row?.withdrawTx && row?.burnTx), "the withdrawal and the burn are recorded");
check(near(await sep.previewValueOnChain(bound), 25), "the box on Sepolia dropped by $15");
check((await advanceTransfer(t.id, deps)) === "credited", "once attested it mints and credits");
row = await getTransfer(t.id);
check(Boolean(row?.mintTx && row?.creditTx), "the mint and the credit are recorded");
check(near(await arc.previewValueOnChain(bound), 15), "the box on Arc holds $15");
check(near(await sep.previewValueOnChain(bound), 25), "Sepolia still holds $25 (nothing duplicated)");
const burnBefore = row!.burnTx;
check((await advanceTransfer(t.id, deps)) === "credited" && (await getTransfer(t.id))!.burnTx === burnBefore, "advancing a finished transfer does nothing");

// 2. Resuming: the burn happened, the process died before minting; someone else relays the message.
const t2 = await createTransfer({ privyUserId: uid, kind: "customer", from: "sepolia", to: "arc-testnet", amountUsd: 5, recipient: bound });
await advanceTransfer(t2.id, { fetchAttestation: async () => ({ ready: false as const, reason: "pending" }) }); // withdraws + burns, stops at burned
const mid = await getTransfer(t2.id);
check(mid?.state === "burned" && Boolean(mid.burnTx), "a restart point: burned and waiting");
// the worker picks it up again after a restart
check((await advanceTransfer(t2.id, deps)) === "credited", "a later run finishes the transfer without burning again");
check((await getTransfer(t2.id))!.burnTx === mid!.burnTx, "the same burn is used");
check(near(await sep.previewValueOnChain(bound), 20) && near(await arc.previewValueOnChain(bound), 20), "balances: $20 on each chain");

// 3. Treasury rebalance: Arc -> Sepolia, no customer box involved.
const t3 = await createTransfer({ privyUserId: null, kind: "treasury", from: "arc-testnet", to: "sepolia", amountUsd: 3, recipient: sep.treasuryAddress ?? "" });
const arcBurn = parseAbi(["event MessageSent(bytes message)"]);
const deps3 = {
  fetchAttestation: async (_u: string, _d: number, burnTx: string) => {
    const receipt = await arc.publicClient.getTransactionReceipt({ hash: burnTx as `0x${string}` });
    const log = receipt.logs.find((l) => l.address.toLowerCase() === CCTP_TESTNET.tokenMessenger.toLowerCase())!;
    return { ready: true as const, message: decodeEventLog({ abi: arcBurn, data: log.data, topics: log.topics }).args.message, attestation: "0x00" as const };
  },
};
check((await advanceTransfer(t3.id, deps3)) === "minted", "a treasury rebalance ends at minted");

// 4. Guards.
check(
  (() => {
    try {
      validateRoute("sepolia", "sepolia");
      return false;
    } catch (e) {
      return e instanceof BridgeError;
    }
  })(),
  "the same chain twice is refused",
);
check(
  (() => {
    try {
      validateAmount(1_000_000);
      return false;
    } catch (e) {
      return e instanceof BridgeError;
    }
  })(),
  "an amount over the cap is refused",
);
// A customer without enough in their box: the transfer fails cleanly before anything moves.
const t4 = await createTransfer({ privyUserId: uid, kind: "customer", from: "sepolia", to: "arc-testnet", amountUsd: 500, recipient: bound });
check((await advanceTransfer(t4.id, deps)) === "failed", "a transfer the box can't cover fails before anything moves");
check(near(await sep.previewValueOnChain(bound), 20), "…and the box is untouched");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
await pool.end();
process.exit(failed ? 1 : 0);
