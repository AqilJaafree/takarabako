// End-to-end smoke test of the 1inch Aqua path on the configured network,
// using the same code the backend uses (aqua.ts) and the official SDKs:
// plan a position, ship its strategies, read their balances from Aqua, quote
// and make one tiny swap through the SwapVM router, then dock them.
//
//   cd backend && CHAIN=sepolia npm run aqua:smoke                           # read-only: balances + readiness
//   cd backend && CHAIN=sepolia npm run aqua:smoke -- --send                 # a full-range strategy
//   cd backend && CHAIN=sepolia npm run aqua:smoke -- --send --shape=hybrid  # core + full-range tail
//   cd backend && CHAIN=sepolia npm run aqua:smoke -- --send --usd=5
//
// The treasury pays the gas and needs the pair tokens (mETH + MockUSDC on
// Sepolia). Shows nothing on a chain where Aqua is not deployed.
import { decodeFunctionResult, encodeFunctionData, formatUnits, maxUint256, parseAbi, type Address } from "viem";
import { config } from "../src/config.js";
import { sv } from "../src/aquaSdk.js";
import {
  aquaUnavailableReason,
  dockAll,
  ensureApprovals,
  ethUsd,
  PAIR,
  planPosition,
  shipBin,
  strategyBalances,
  verifyAquaOnChain,
} from "../src/aqua.js";
import { publicClient, sendTreasuryTx, treasuryAddress, treasuryEthBalance, waitForTx } from "../src/chain.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const send = process.argv.includes("--send");
const usd = Number(arg("usd") ?? 2);
const shape = arg("shape") ?? "full";
if (shape !== "full" && shape !== "hybrid") {
  console.error(`--shape must be full or hybrid, got "${shape}"`);
  process.exit(2);
}
const net = config.network;
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const tx = (hash: string) => `${net.explorerUrl}/tx/${hash}`;
const step = (s: string) => console.log(`\n▸ ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (b: { eth: bigint; usdc: bigint }) => `base ${formatUnits(b.eth, 18)} · USDC ${formatUnits(b.usdc, 6)}`;

// Public RPCs sit behind load balancers, so a read right after a confirmed
// transaction can come from a node a block behind. Re-read until the state
// we expect shows up (or give up after ~16s and return the last read).
type Bals = { eth: bigint; usdc: bigint };
async function settled(hash: string, until: (b: Bals) => boolean): Promise<Bals> {
  let b = await strategyBalances(hash);
  for (let i = 1; i < 8 && !until(b); i++) {
    await sleep(2_000);
    b = await strategyBalances(hash);
  }
  return b;
}

console.log(`${net.name} (chain ${net.chain.id}) · treasury ${treasuryAddress ?? "not configured"}`);
const reason = aquaUnavailableReason();
if (reason) {
  console.log(`✗ Aqua is off: ${reason}`);
  process.exit(1);
}

const onChain = await verifyAquaOnChain();
if (!onChain.ok) {
  console.log(`✗ missing on chain: ${onChain.missing.join("; ")}`);
  process.exit(1);
}
console.log(`✓ Aqua ${config.aqua.address} · router ${config.aqua.router} (${config.aqua.origin} addresses)`);

const bal = (token: string) => publicClient.readContract({ address: token as Address, abi: erc20, functionName: "balanceOf", args: [treasuryAddress!] });
const [gas, base, quote] = await Promise.all([treasuryEthBalance(), bal(PAIR.eth.address), bal(PAIR.usdc.address)]);
console.log(`  gas ${gas.toFixed(4)} ${net.nativeSymbol} · base token ${formatUnits(base, Number(PAIR.eth.decimals))} · USDC ${formatUnits(quote, Number(PAIR.usdc.decimals))}`);

if (!send) {
  console.log("\nRead-only. Add --send to ship, swap and dock a small position.");
  process.exit(0);
}

const spot = await ethUsd();
// The same planner the app uses: Steady (one full-range bin), or an advanced
// hybrid over -50%…+100% of today's price.
const plan =
  shape === "hybrid"
    ? planPosition({ mode: "advanced", shape: "hybrid", priceMin: spot * 0.5, priceMax: spot * 2 }, spot)
    : planPosition({ mode: "low" }, spot);
console.log(`  ETH/USD ${spot.toFixed(2)} · $${usd} as ${shape}: ${plan.bins.length} strategies`);
plan.bins.forEach((b, i) =>
  console.log(`    ${i + 1}. ${b ? `$${b.min.toFixed(0)} – $${b.max.toFixed(0)}` : "full range"} · ${((b?.weight ?? 1) * 100).toFixed(0)}% of the money`),
);

step("approve Aqua and the router to pull the pair tokens");
await ensureApprovals();
for (const token of [PAIR.eth.address, PAIR.usdc.address] as Address[]) {
  const allowance = await publicClient.readContract({ address: token, abi: erc20, functionName: "allowance", args: [treasuryAddress!, config.aqua.router as Address] });
  if (allowance < 10n ** 40n) {
    await sendTreasuryTx({ to: token, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [config.aqua.router as Address, maxUint256] }) });
  }
}
console.log("  ok");

step("ship the strategies (SwapVM concentrate / XYC programs via the Aqua SDK)");
const strategies = [];
for (const b of plan.bins) strategies.push(await shipBin(b, usd * (b?.weight ?? 1), spot, plan.feeBps));
await Promise.all(strategies.map((s) => waitForTx(s.shipTx as `0x${string}`)));
strategies.forEach((s, i) => console.log(`  ${i + 1}. ${s.hash}\n     ${tx(s.shipTx)}`));

let ok = false;
try {
  step("read the virtual balances Aqua holds for each");
  // A range around the price starts with both tokens.
  const before = await Promise.all(strategies.map((s) => settled(s.hash, (b) => b.eth > 0n && b.usdc > 0n)));
  before.forEach((b, i) => console.log(`  ${i + 1}. ${fmt(b)}`));
  if (before.some((b) => b.eth === 0n || b.usdc === 0n)) throw new Error("Aqua does not report both token balances for every strategy");

  step("quote and swap $0.10 of USDC into the base token against strategy 1");
  const target = strategies[0]!;
  const order = sv.Order.decode(new sv.HexString(target.order));
  const amount = 100_000n; // 0.10 USDC (6 decimals)
  const call = new sv.SwapVMContract(new sv.Address(config.aqua.router));
  const args = { order, amount, takerTraits: sv.TakerTraits.default(), tokenIn: new sv.Address(PAIR.usdc.address), tokenOut: new sv.Address(PAIR.eth.address) };
  const q = call.quote(args);
  // A node a block behind has not seen the ship yet and reverts: retry.
  let res: Awaited<ReturnType<typeof publicClient.call>> | undefined;
  for (let i = 0; i < 8 && !res; i++) {
    res = await publicClient.call({ account: treasuryAddress, to: q.to.toString() as Address, data: q.data.toString() as `0x${string}` }).catch(async () => {
      await sleep(2_000);
      return undefined;
    });
  }
  if (!res) throw new Error("the router would not quote the shipped strategy after 8 tries");
  const [amountIn, amountOut] = decodeFunctionResult({ abi: sv.ABI.SWAP_VM_ABI, functionName: "quote", data: res.data! }) as readonly bigint[];
  console.log(`  quote: ${formatUnits(amountIn!, 6)} USDC → ${formatUnits(amountOut!, 18)} base token`);
  const s = call.swap(args);
  const swapHash = await sendTreasuryTx({ to: s.to.toString() as Address, data: s.data.toString() as `0x${string}` });
  console.log(`  ${tx(swapHash)}`);

  const after = await settled(target.hash, (b) => b.usdc > before[0]!.usdc && b.eth < before[0]!.eth);
  console.log(`  strategy 1 now: ${fmt(after)}`);
  const moved = after.usdc > before[0]!.usdc && after.eth < before[0]!.eth;
  console.log(moved ? "  ✓ the swap moved strategy 1 the right way (USDC up, base token down)" : "  ✗ strategy 1 did not move as expected");
  ok = moved;

  // Every strategy is its own isolated pool in Aqua: swapping one must not touch the others.
  for (let i = 1; i < strategies.length; i++) {
    const other = await strategyBalances(strategies[i]!.hash);
    const same = other.eth === before[i]!.eth && other.usdc === before[i]!.usdc;
    console.log(`  ${same ? "✓" : "✗"} strategy ${i + 1} untouched (${fmt(other)})`);
    ok = ok && same;
  }
} finally {
  step("dock the strategies (returns them to the treasury)");
  for (let i = 1; ; i++) {
    try {
      await dockAll(strategies);
      break;
    } catch (err) {
      // gas estimation can land on a node that has not seen the ship yet
      if (i >= 6) throw err;
      await sleep(3_000);
    }
  }
  for (const [i, s] of strategies.entries()) {
    const end = await settled(s.hash, (b) => b.eth === 0n && b.usdc === 0n);
    console.log(`  ${i + 1}. after dock: base ${end.eth} · USDC ${end.usdc}`);
    if (end.eth !== 0n || end.usdc !== 0n) ok = false;
  }
}

console.log(ok ? `\n✓ Aqua ship → quote → swap → dock works on ${net.name} (${shape}, ${strategies.length} strategies)` : "\n✗ smoke test failed");
process.exit(ok ? 0 : 1);
