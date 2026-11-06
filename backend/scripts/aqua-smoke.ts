// End-to-end smoke test of the 1inch Aqua path on the configured network,
// using the same code the backend uses (aqua.ts) and the official SDKs:
// ship a small full-range strategy, read its balances from Aqua, quote and
// make one tiny swap through the SwapVM router, then dock it.
//
//   cd backend && CHAIN=sepolia npm run aqua:smoke              # read-only: balances + readiness
//   cd backend && CHAIN=sepolia npm run aqua:smoke -- --send    # sends ~6 transactions from the treasury
//   cd backend && CHAIN=sepolia npm run aqua:smoke -- --send --usd=5
//
// The treasury pays the gas and needs the pair tokens (mETH + MockUSDC on
// Sepolia). It shows nothing on a chain where Aqua is not deployed.
import { decodeFunctionResult, encodeFunctionData, formatUnits, maxUint256, parseAbi, type Address } from "viem";
import { config } from "../src/config.js";
import { sv } from "../src/aquaSdk.js";
import { aquaReady, aquaUnavailableReason, dockAll, ensureApprovals, ethUsd, PAIR, shipBin, strategyBalances, verifyAquaOnChain } from "../src/aqua.js";
import { publicClient, sendTreasuryTx, treasuryAddress, treasuryEthBalance, waitForTx } from "../src/chain.js";

const send = process.argv.includes("--send");
const usd = Number(process.argv.find((a) => a.startsWith("--usd="))?.slice(6) ?? 2);
const net = config.network;
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const tx = (hash: string) => `${net.explorerUrl}/tx/${hash}`;
const step = (s: string) => console.log(`\n▸ ${s}`);

// Public RPCs sit behind load balancers, so a read right after a confirmed
// transaction can come from a node a block behind. Re-read until the state
// we expect shows up (or give up after ~16s and return the last read).
type Bals = { eth: bigint; usdc: bigint };
async function settled(hash: string, until: (b: Bals) => boolean): Promise<Bals> {
  let b = await strategyBalances(hash);
  for (let i = 1; i < 8 && !until(b); i++) {
    await new Promise((r) => setTimeout(r, 2_000));
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
console.log(`  ETH/USD ${spot.toFixed(2)} · position size $${usd}`);

step("approve Aqua and the router to pull the pair tokens");
await ensureApprovals();
for (const token of [PAIR.eth.address, PAIR.usdc.address] as Address[]) {
  const allowance = await publicClient.readContract({ address: token, abi: erc20, functionName: "allowance", args: [treasuryAddress!, config.aqua.router as Address] });
  if (allowance < 10n ** 40n) {
    await sendTreasuryTx({ to: token, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [config.aqua.router as Address, maxUint256] }) });
  }
}
console.log("  ok");

step("ship a full-range strategy (AquaXYCAmmStrategy via the Aqua SDK)");
const strategy = await shipBin(null, usd, spot, 30);
await waitForTx(strategy.shipTx as `0x${string}`);
console.log(`  hash ${strategy.hash}\n  ${tx(strategy.shipTx)}`);

let ok = false;
try {
  step("read the virtual balances Aqua holds for it");
  const before = await settled(strategy.hash, (b) => b.eth > 0n && b.usdc > 0n) // a full-range strategy starts with both tokens;
  console.log(`  base ${formatUnits(before.eth, 18)} · USDC ${formatUnits(before.usdc, 6)}`);
  if (before.eth === 0n || before.usdc === 0n) throw new Error("Aqua does not report both token balances for the strategy");

  step("quote and swap $0.10 of USDC into the base token through the SwapVM router");
  const order = sv.Order.decode(new sv.HexString(strategy.order));
  const amount = 100_000n; // 0.10 USDC (6 decimals)
  const call = new sv.SwapVMContract(new sv.Address(config.aqua.router));
  const args = { order, amount, takerTraits: sv.TakerTraits.default(), tokenIn: new sv.Address(PAIR.usdc.address), tokenOut: new sv.Address(PAIR.eth.address) };
  const q = call.quote(args);
  // A node a block behind has not seen the ship yet and reverts: retry.
  let res: Awaited<ReturnType<typeof publicClient.call>> | undefined;
  for (let i = 0; i < 8 && !res; i++) {
    res = await publicClient.call({ account: treasuryAddress, to: q.to.toString() as Address, data: q.data.toString() as `0x${string}` }).catch(async () => {
      await new Promise((r) => setTimeout(r, 2_000));
      return undefined;
    });
  }
  if (!res) throw new Error("the router would not quote the shipped strategy after 8 tries");
  const [amountIn, amountOut] = decodeFunctionResult({ abi: sv.ABI.SWAP_VM_ABI, functionName: "quote", data: res.data! }) as readonly bigint[];
  console.log(`  quote: ${formatUnits(amountIn!, 6)} USDC → ${formatUnits(amountOut!, 18)} base token`);
  const s = call.swap(args);
  const swapHash = await sendTreasuryTx({ to: s.to.toString() as Address, data: s.data.toString() as `0x${string}` });
  console.log(`  ${tx(swapHash)}`);

  const after = await settled(strategy.hash, (b) => b.usdc > before.usdc && b.eth < before.eth);
  console.log(`  balances now: base ${formatUnits(after.eth, 18)} · USDC ${formatUnits(after.usdc, 6)}`);
  ok = after.usdc > before.usdc && after.eth < before.eth;
  console.log(ok ? "  ✓ the swap moved the strategy's balances the right way (USDC up, base token down)" : "  ✗ balances did not move as expected");
} finally {
  step("dock the strategy (returns it to the treasury)");
  for (let i = 1; ; i++) {
    try {
      await dockAll([strategy]);
      break;
    } catch (err) {
      // gas estimation can land on a node that has not seen the ship yet
      if (i >= 6) throw err;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  const end = await settled(strategy.hash, (b) => b.eth === 0n && b.usdc === 0n);
  console.log(`  balances after dock: base ${end.eth} · USDC ${end.usdc}`);
  if (end.eth !== 0n || end.usdc !== 0n) ok = false;
}

console.log(ok ? "\n✓ Aqua ship → quote → swap → dock works on " + net.name : "\n✗ smoke test failed");
process.exit(ok ? 0 : 1);
