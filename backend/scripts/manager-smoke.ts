// Live end-to-end test of AquaPositionManager on the configured chain (Sepolia by default):
// one approval, ONE open transaction for a whole Curve position, a real trade against it, then
// ONE close. The treasury plays both the user and the trader.
//
//   MANAGER=0x... npx tsx scripts/manager-smoke.ts
import { decodeFunctionResult, formatUnits, parseAbi, type Address } from "viem";
import { config } from "../src/config.js";
import { sv } from "../src/aquaSdk.js";
import { PAIR } from "../src/aqua.js";
import { planSelfOpen } from "../src/selfCustody.js";
import { selfBins } from "../src/selfShapes.js";
import { publicClient, sendTreasuryTx, treasuryAddress } from "../src/chain.js";
import { retryOnLag } from "../src/retry.js";
import { encodeFunctionData } from "viem";

const MANAGER = process.env.MANAGER as Address | undefined;
if (!MANAGER) throw new Error("set MANAGER=<deployed AquaPositionManager address>");
if (!treasuryAddress) throw new Error("no treasury key configured");
const user = treasuryAddress;
const AQUA = config.aqua.address as Address;
const ROUTER = config.aqua.router as Address;
const SPOT = 2200;

const abi = parseAbi([
  "function open(bytes[] strategies, uint256[] wethAmounts, uint256[] usdcAmounts) returns (uint256)",
  "function close(uint256 id)",
  "function nextPositionId() view returns (uint256)",
  "function positionOf(uint256 id) view returns (address owner, bool closed, bytes32[] hashes)",
]);
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const aquaAbi = parseAbi(["function rawBalances(address maker, address app, bytes32 hash, address token) view returns (uint248 balance, uint8 tokensCount)"]);

const step = (s: string) => console.log(`\n▸ ${s}`);
const link = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;
const bal = (token: Address, who: Address) => publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });
const virt = async (hash: `0x${string}`) => {
  const [w, u] = await Promise.all(
    [PAIR.eth.address, PAIR.usdc.address].map((t) =>
      publicClient.readContract({ address: AQUA, abi: aquaAbi, functionName: "rawBalances", args: [MANAGER, ROUTER, hash, t as Address] }),
    ),
  );
  return { eth: w[0], usdc: u[0] };
};
// A node a block behind returns the old state: poll until the check holds.
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

step(`plan a $50 Curve position over $1,800–$2,900 with the manager (${MANAGER}) as the maker`);
const { bins, feeBps } = selfBins("curve", SPOT, 1800, 2900);
const plan = planSelfOpen({ maker: MANAGER, amountUsd: 50, bins, feeBps, spot: SPOT, pair: PAIR, aqua: AQUA, router: ROUTER, allowance: { eth: 0n, usdc: 0n }, owed: { eth: 0n, usdc: 0n } });
const wAmts = plan.strategies.map((s) => BigInt(s.eth));
const uAmts = plan.strategies.map((s) => BigInt(s.usdc));
console.log(`  ${plan.strategies.length} strategies, ${formatUnits(plan.need.eth, 18)} mETH + ${formatUnits(plan.need.usdc, 6)} USDC`);

const before = { eth: await bal(PAIR.eth.address as Address, user), usdc: await bal(PAIR.usdc.address as Address, user) };

step("approve the manager once per token (a user does this one time ever)");
for (const [token, need] of [[PAIR.eth.address, plan.need.eth], [PAIR.usdc.address, plan.need.usdc]] as const) {
  const have = await publicClient.readContract({ address: token as Address, abi: erc20, functionName: "allowance", args: [user, MANAGER] });
  if (have >= need) {
    console.log(`  allowance already covers ${token}`);
    continue;
  }
  const h = await sendTreasuryTx({ to: token as Address, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [MANAGER, need * 4n] }) });
  console.log(`  ${link(h)}`);
}

step("ONE transaction opens the whole position");
const id = (await until(() => publicClient.readContract({ address: MANAGER, abi, functionName: "nextPositionId" }), () => true, "id")) + 1n;
const openHash = await sendTreasuryTx({ to: MANAGER, data: encodeFunctionData({ abi, functionName: "open", args: [plan.strategies.map((s) => s.order as `0x${string}`), wAmts, uAmts] }) });
console.log(`  ${link(openHash)}`);
const rc = await publicClient.getTransactionReceipt({ hash: openHash });
console.log(`  gas used: ${rc.gasUsed}`);
check(rc.status === "success", "open succeeded");

const [owner, closed0, hashes] = await until(
  () => publicClient.readContract({ address: MANAGER, abi, functionName: "positionOf", args: [id] }),
  (p) => p[2].length > 0,
  "position to be visible",
);
check(owner.toLowerCase() === user.toLowerCase(), "position is owned by the caller");
check(!closed0, "position is open");
check(hashes.length === plan.strategies.length && hashes.every((h, i) => h.toLowerCase() === plan.strategies[i]!.hash.toLowerCase()), "the contract's strategy hashes equal the ones the SDK computed");
const v0 = await until(() => virt(hashes[2]!), (v) => v.eth > 0n || v.usdc > 0n, "virtual balances");
check(v0.eth === wAmts[2]! && v0.usdc === uAmts[2]!, "Aqua's virtual balances equal the deposit");
const held = { eth: await bal(PAIR.eth.address as Address, MANAGER), usdc: await bal(PAIR.usdc.address as Address, MANAGER) };
check(held.eth === plan.need.eth && held.usdc === plan.need.usdc, "the manager holds exactly the deposited tokens");

step("a trader swaps 0.10 USDC for mETH against the middle strategy (the router pulls it from the taker)");
const swapIn = 100_000n;
const swapAllow = await publicClient.readContract({ address: PAIR.usdc.address as Address, abi: erc20, functionName: "allowance", args: [user, ROUTER] });
if (swapAllow < swapIn) await sendTreasuryTx({ to: PAIR.usdc.address as Address, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, swapIn * 100n] }) });
const order = sv.Order.decode(new sv.HexString(plan.strategies[2]!.order));
const call = new sv.SwapVMContract(new sv.Address(ROUTER));
const args = { order, amount: swapIn, takerTraits: sv.TakerTraits.default(), tokenIn: new sv.Address(PAIR.usdc.address), tokenOut: new sv.Address(PAIR.eth.address) };
const q = call.quote(args);
const quoted = await retryOnLag(() => publicClient.call({ account: user, to: q.to.toString() as Address, data: q.data.toString() as `0x${string}` }), { tries: 8, delayMs: 2_000 });
const [amountIn, amountOut] = decodeFunctionResult({ abi: sv.ABI.SWAP_VM_ABI, functionName: "quote", data: quoted.data! }) as readonly bigint[];
console.log(`  quote: ${formatUnits(amountIn!, 6)} USDC → ${formatUnits(amountOut!, 18)} mETH`);
const s = call.swap(args);
const swapHash = await sendTreasuryTx({ to: s.to.toString() as Address, data: s.data.toString() as `0x${string}` });
console.log(`  ${link(swapHash)}`);
const v1 = await until(() => virt(hashes[2]!), (v) => v.usdc > v0.usdc, "swap to settle");
check(v1.usdc > v0.usdc && v1.eth < v0.eth, "the swap moved the strategy (USDC up, mETH down)");
const heldAfterSwap = { eth: await bal(PAIR.eth.address as Address, MANAGER), usdc: await bal(PAIR.usdc.address as Address, MANAGER) };
check(heldAfterSwap.usdc === held.usdc + (v1.usdc - v0.usdc) && heldAfterSwap.eth === held.eth - (v0.eth - v1.eth), "the manager's real balances moved by exactly what Aqua recorded");

step("ONE transaction closes the whole position");
let expect = { eth: 0n, usdc: 0n };
for (const h of hashes) {
  const v = await virt(h);
  expect = { eth: expect.eth + v.eth, usdc: expect.usdc + v.usdc };
}
const pre = { eth: await bal(PAIR.eth.address as Address, user), usdc: await bal(PAIR.usdc.address as Address, user) };
const closeHash = await sendTreasuryTx({ to: MANAGER, data: encodeFunctionData({ abi, functionName: "close", args: [id] }) });
console.log(`  ${link(closeHash)}`);
const rc2 = await publicClient.getTransactionReceipt({ hash: closeHash });
console.log(`  gas used: ${rc2.gasUsed}`);
const post = await until(
  async () => ({ eth: await bal(PAIR.eth.address as Address, user), usdc: await bal(PAIR.usdc.address as Address, user) }),
  (b) => b.eth > pre.eth || b.usdc > pre.usdc,
  "payout",
);
check(post.eth - pre.eth === expect.eth && post.usdc - pre.usdc === expect.usdc, `the owner received exactly Aqua's balances (${formatUnits(expect.eth, 18)} mETH + ${formatUnits(expect.usdc, 6)} USDC)`);
const left = { eth: await bal(PAIR.eth.address as Address, MANAGER), usdc: await bal(PAIR.usdc.address as Address, MANAGER) };
check(left.eth === 0n && left.usdc === 0n, "nothing is left in the manager");
const net = { eth: post.eth - before.eth, usdc: post.usdc - before.usdc };
console.log(`  net for the user after the trade (as taker and maker): ${formatUnits(net.eth, 18)} mETH, ${formatUnits(net.usdc, 6)} USDC (ignoring the tiny trade fee/price effect)`);

console.log(failures === 0 ? "\n✓ AquaPositionManager works live: 1 open + 1 close" : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
