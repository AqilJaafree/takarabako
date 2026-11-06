// A small live position through the AquaPositionManager on Arc MAINNET (real money, so keep it tiny).
// The treasury wallet is the customer. The position is USDC-only (a range below today's price), so no
// WETH is needed. Two steps so the result can be inspected in between:
//
//   MANAGER=0x... AMOUNT_USD=0.5 SHAPE=curve STEP=open  npx tsx --env-file=.env scripts/manager-smoke-arc.ts
//   MANAGER=0x... POSITION_ID=1  STEP=close npx tsx --env-file=.env scripts/manager-smoke-arc.ts
import { decodeFunctionData, createPublicClient, createWalletClient, decodeFunctionResult, encodeAbiParameters, formatUnits, http, keccak256, maxUint256, numberToHex, pad, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";
import { config } from "../src/config.js";
import { ethUsd, MONEY_PRICE_MAX_AGE_MS } from "../src/aqua.js";
import { applyFeeFloor, NETWORKS, resolveAquaDeployment } from "../src/networks.js";
import { ARC_CHAIN_ID, ARC_PAIR, managerAbi, planManagerClose, planManagerOpen } from "../src/selfCustody.js";
import { selfBins, type SelfShape } from "../src/selfShapes.js";
import { sv } from "../src/aquaSdk.js";

const MANAGER = process.env.MANAGER as Address | undefined;
const STEP = process.env.STEP;
if (!MANAGER || (STEP !== "open" && STEP !== "close" && STEP !== "trade")) throw new Error("set MANAGER=<address> and STEP=open|close");
const key = config.treasuryPrivateKey;
if (!key) throw new Error("no treasury key configured");

const chain = { ...arc, rpcUrls: { default: { http: [config.selfCustody.arcRpcUrl] } } };
const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
const pub = createPublicClient({ chain, transport: http(config.selfCustody.arcRpcUrl, { timeout: 15_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(config.selfCustody.arcRpcUrl, { timeout: 15_000 }) });
const dep = resolveAquaDeployment(ARC_CHAIN_ID, {})!;
const AQUA = dep.aqua as Address;
const ROUTER = dep.router as Address;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const aquaAbi = parseAbi(["function rawBalances(address maker, address app, bytes32 hash, address token) view returns (uint248, uint8)"]);
const USDC = ARC_PAIR.usdc.address as Address;
const WETH = ARC_PAIR.eth.address as Address;
const link = (h: string) => `https://explorer.arc.io/tx/${h}`;
const step = (s: string) => console.log(`\n▸ ${s}`);
let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`  ${c ? "✓" : "✗"} ${m}`);
  if (!c) failures++;
};
const usdcOf = (a: Address) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });
const wethOf = (a: Address) => pub.readContract({ address: WETH, abi: erc20, functionName: "balanceOf", args: [a] });
const virt = async (hash: Hex) => {
  const [[w], [u]] = await Promise.all([WETH, USDC].map((t) => pub.readContract({ address: AQUA, abi: aquaAbi, functionName: "rawBalances", args: [MANAGER, ROUTER, hash, t] })) as Promise<[readonly [bigint, number], readonly [bigint, number]]>);
  return { weth: BigInt(w), usdc: BigInt(u) };
};

/// Arc drops anything under 20 gwei: pay 1.3x the current fee.
async function send(to: Address, data: Hex): Promise<{ hash: Hex; gasUsed: bigint; cost: bigint }> {
  const f = applyFeeFloor(await pub.estimateFeesPerGas(), NETWORKS.arc.minMaxFeePerGas);
  const hash = await wallet.sendTransaction({ to, data, maxFeePerGas: (f.maxFeePerGas! * 13n) / 10n, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n });
  console.log(`  ${link(hash)}`);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 1_500 });
  if (rc.status !== "success") throw new Error(`transaction failed: ${hash}`);
  return { hash, gasUsed: rc.gasUsed, cost: rc.gasUsed * rc.effectiveGasPrice };
}
/// Dry-run a call from the wallet before paying for it.
const simulate = (to: Address, data: Hex) => pub.call({ account: account.address, to, data });

/// A trade against the live strategy, simulated: a made-up taker is given 0.001 WETH and an approval
/// for the router through eth_call state overrides (Arc's WETH keeps balances and allowances in
/// OpenZeppelin ERC-7201 storage), then the SDK's swap runs against real mainnet state. Nothing is sent.
async function simulateTrade(order: string, hash: Hex) {
  step("simulate a trade against the live position (a made-up taker sells 0.00001 WETH for USDC)");
  const taker = "0x00000000000000000000000000000000000dead1" as Address;
  const base = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n; // ERC20StorageLocation
  const word = (v: bigint | Address) => (typeof v === "bigint" ? pad(numberToHex(v), { size: 32 }) : pad(v, { size: 32 }));
  const balSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [taker, base]));
  const allowInner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [taker, base + 1n]));
  const allowSlot = keccak256(`0x${word(ROUTER).slice(2)}${allowInner.slice(2)}`);
  const stateOverride = [{ address: WETH, stateDiff: [{ slot: balSlot, value: word(10n ** 15n) }, { slot: allowSlot, value: word(maxUint256) }] }];
  const call = new sv.SwapVMContract(new sv.Address(ROUTER));
  const args = { order: sv.Order.decode(new sv.HexString(order)), amount: 10n ** 13n, takerTraits: sv.TakerTraits.default(), tokenIn: new sv.Address(WETH), tokenOut: new sv.Address(USDC) };
  const before = await virt(hash);
  const q = call.quote(args);
  const quoted = await pub.call({ account: taker, to: q.to.toString() as Address, data: q.data.toString() as Hex, stateOverride });
  const [amountIn, amountOut] = decodeFunctionResult({ abi: sv.ABI.SWAP_VM_ABI, functionName: "quote", data: quoted.data! }) as readonly bigint[];
  console.log(`  the router quotes ${formatUnits(amountIn!, 18)} WETH -> ${formatUnits(amountOut!, 6)} USDC (about $${(Number(amountOut) / 1e6 / (Number(amountIn) / 1e18)).toFixed(0)} per ETH)`);
  check(amountOut! > 0n && amountOut! <= before.usdc, "the quote is positive and within what the strategy holds");
  const s = call.swap(args);
  const res = await pub.call({ account: taker, to: s.to.toString() as Address, data: s.data.toString() as Hex, stateOverride });
  check(res.data !== undefined, "the swap executes: the router took WETH from the taker and Aqua pulled USDC out of the MANAGER to pay them");
  const mgrAllowance = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [MANAGER, AQUA] });
  check(mgrAllowance > amountOut!, "the manager's standing approval to Aqua covers the payout");
}

const code = await pub.getCode({ address: MANAGER });
check(Boolean(code && code.length > 2), `a contract is deployed at ${MANAGER}`);
console.log(`  wallet ${account.address}: ${formatUnits(await usdcOf(account.address), 6)} USDC`);

if (STEP === "open") {
  const amountUsd = Number(process.env.AMOUNT_USD ?? 0.5);
  if (!(amountUsd > 0 && amountUsd <= 2)) throw new Error("this smoke test is for tiny amounts only (up to $2)");
  step(`plan a $${amountUsd} USDC-only position (a range below today's price)`);
  const spot = await ethUsd({ maxStaleMs: MONEY_PRICE_MAX_AGE_MS, verify: true });
  const shape = (process.env.SHAPE ?? "spot") as SelfShape;
  const { bins, feeBps } = selfBins(shape, spot, spot * 0.5, spot * 0.9);
  const allowance = {
    eth: await pub.readContract({ address: WETH, abi: erc20, functionName: "allowance", args: [account.address, MANAGER] }),
    usdc: await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [account.address, MANAGER] }),
  };
  const plan = planManagerOpen({ wallet: account.address, manager: MANAGER, amountUsd, bins, feeBps, spot, pair: ARC_PAIR, allowance, symbols: { base: "WETH", quote: "USDC" } });
  console.log(`  ETH $${spot}, range $${Math.round(spot * 0.5)}–$${Math.round(spot * 0.9)}, ${shape}, takes ${formatUnits(plan.need.usdc, 6)} USDC + ${formatUnits(plan.need.eth, 18)} WETH, ${plan.strategies.length} strategies`);
  check(plan.need.eth === 0n && plan.need.usdc > 0n, "the position needs USDC only");
  const bal = await usdcOf(account.address);
  check(bal >= plan.need.usdc + 200_000n, `the wallet covers it and keeps 0.2 USDC for gas (${formatUnits(bal, 6)} USDC)`);
  if (failures) process.exit(1);

  const before = bal;
  let gas = 0n;
  const approvals = plan.steps.slice(0, -1);
  const openStep = plan.steps[plan.steps.length - 1]!;
  step("approve the manager for exactly what the position takes");
  for (const s of approvals) {
    console.log(`  ${s.description}`);
    gas += (await send(s.to, s.data)).cost;
  }
  step("dry-run the open, then send it");
  await simulate(openStep.to, openStep.data); // throws with the revert reason if it would fail
  console.log("  the simulation succeeds");
  const opened = await send(openStep.to, openStep.data);
  gas += opened.cost;
  console.log(`  gas used: ${opened.gasUsed}`);
  const rc = await pub.getTransactionReceipt({ hash: opened.hash });
  const ev = parseEventLogs({ abi: managerAbi, eventName: "Opened", logs: rc.logs.filter((l) => l.address.toLowerCase() === MANAGER.toLowerCase()) })[0]!;
  const id = ev.args.id;
  check(ev.args.owner.toLowerCase() === account.address.toLowerCase(), `the position (#${id}) is owned by this wallet`);
  check(ev.args.hashes.length === plan.strategies.length && ev.args.hashes.every((h, i) => h.toLowerCase() === plan.strategies[i]!.hash.toLowerCase()), "the contract's strategy hash equals the SDK's");
  const perStrategy = await Promise.all(plan.strategies.map((st) => virt(st.hash as Hex)));
  check(perStrategy.every((v, i) => v.usdc === BigInt(plan.strategies[i]!.usdc) && v.weth === 0n), `Aqua shows each of the ${plan.strategies.length} strategies with exactly its deposit`);
  console.log(`  ${perStrategy.map((v, i) => `$${Math.round(plan.strategies[i]!.min!)}–$${Math.round(plan.strategies[i]!.max!)}: ${formatUnits(v.usdc, 6)}`).join(" | ")}`);
  const held = await usdcOf(MANAGER);
  check(held === plan.need.usdc, `the manager holds exactly the deposit (${formatUnits(held, 6)} USDC)`);
  check((await wethOf(MANAGER)) === 0n, "the manager holds no WETH");
  await simulateTrade(plan.strategies.reduce((a, b) => (b.max! > a.max! ? b : a)).order, plan.strategies.reduce((a, b) => (b.max! > a.max! ? b : a)).hash as Hex);
  const after = await usdcOf(account.address);
  console.log(`  wallet USDC ${formatUnits(before, 6)} -> ${formatUnits(after, 6)} (deposit ${formatUnits(plan.need.usdc, 6)} + gas ${formatUnits(gas, 18)})`);
  check(before - after === plan.need.usdc + gas / 10n ** 12n || Math.abs(Number(before - after - plan.need.usdc - gas / 10n ** 12n)) <= 2, "the wallet paid the deposit plus gas and nothing else");
  console.log(`\nOpen. Close it with: MANAGER=${MANAGER} POSITION_ID=${id} STEP=close npx tsx --env-file=.env scripts/manager-smoke-arc.ts`);
} else if (STEP === "trade") {
  // Re-run the simulated trade against a position that is already open. The strategies are not stored
  // on chain (only their hashes), so read them back from the open transaction's calldata.
  const id = BigInt(process.env.POSITION_ID ?? "");
  const head = await pub.getBlockNumber();
  const logs = await pub.getLogs({ address: MANAGER, event: managerAbi.find((x) => x.type === "event")!, args: { id }, fromBlock: head - 2_000n, toBlock: head });
  if (!logs[0]) throw new Error("could not find the open transaction in the last 2,000 blocks");
  const tx = await pub.getTransaction({ hash: logs[0].transactionHash! });
  const call = decodeFunctionData({ abi: managerAbi, data: tx.input });
  const [orders] = call.args as readonly [readonly Hex[], readonly bigint[], readonly bigint[]];
  const [, , hashes] = await pub.readContract({ address: MANAGER, abi: managerAbi, functionName: "positionOf", args: [id] });
  console.log(`  position #${id}: ${orders.length} strategies read back from ${link(tx.hash)}`);
  const bal = await Promise.all(hashes.map((h) => virt(h)));
  const best = bal.reduce((bi, v, i) => (v.usdc > bal[bi]!.usdc ? i : bi), 0); // a curve holds the most near today's price
  await simulateTrade(orders[best]!, hashes[best]!);
} else {
  const id = BigInt(process.env.POSITION_ID ?? "");
  step(`close position #${id}`);
  const [owner, closed, hashes] = await pub.readContract({ address: MANAGER, abi: managerAbi, functionName: "positionOf", args: [id] });
  check(owner.toLowerCase() === account.address.toLowerCase() && !closed, "it is open and owned by this wallet");
  let expect = { weth: 0n, usdc: 0n };
  for (const h of hashes) {
    const v = await virt(h);
    expect = { weth: expect.weth + v.weth, usdc: expect.usdc + v.usdc };
  }
  console.log(`  Aqua says it holds ${formatUnits(expect.usdc, 6)} USDC + ${formatUnits(expect.weth, 18)} WETH`);
  const s = planManagerClose(MANAGER, id)[0]!;
  await simulate(s.to, s.data);
  console.log("  the simulation succeeds");
  const before = await usdcOf(account.address);
  const res = await send(s.to, s.data);
  console.log(`  gas used: ${res.gasUsed}`);
  const after = await usdcOf(account.address);
  const gas = res.cost / 10n ** 12n;
  check(after + gas - before === expect.usdc || Math.abs(Number(after + gas - before - expect.usdc)) <= 2, `the wallet got back exactly what Aqua held (${formatUnits(expect.usdc, 6)} USDC) less ${formatUnits(res.cost, 18)} gas`);
  check((await usdcOf(MANAGER)) === 0n && (await wethOf(MANAGER)) === 0n, "nothing is left in the manager");
  const [, nowClosed] = await pub.readContract({ address: MANAGER, abi: managerAbi, functionName: "positionOf", args: [id] });
  check(nowClosed, "the position is closed");
  console.log(`  wallet now: ${formatUnits(after, 6)} USDC`);
}
console.log(failures === 0 ? "\n✓ ok" : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
