// Dash out end to end on Sepolia: an LP position (opened through the position manager) is the liquidity,
// a fresh wallet that holds only mETH is the customer who sells it for mUSDC through Aqua, signed with its
// own key. Checks the quote, the discount guard, the minimum-payout guard and the actual balances, then
// closes the LP position. Needs SELF_CUSTODY_SEPOLIA=1 and SELF_MANAGER_SEPOLIA.
//
//   npx tsx --env-file=.env scripts/dashout-e2e.ts
process.env.DASH_OUT_MAX_DISCOUNT_PCT = "30"; // the LP's ranges sit below the market; the real default is 3
const { migrate, pool } = await import("../src/db.js");
const { insertAccount } = await import("../src/accounts.js");
const { ethUsd } = await import("../src/aqua.js");
const { sv } = await import("../src/aquaSdk.js");
const { selfNet, selfClient } = await import("../src/selfChain.js");
const { prepareClose, prepareOpen, recordClose, recordOpen } = await import("../src/selfPositions.js");
const { dashOutQuote, prepareDashOut } = await import("../src/dashOut.js");
const { sendTreasuryTx, treasuryAddress } = await import("../src/chain.js");
const { config } = await import("../src/config.js");
const { createWalletClient, encodeFunctionData, formatUnits, http, parseAbi, parseUnits } = await import("viem");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
type Address = `0x${string}`;
type Hex = `0x${string}`;

if (!treasuryAddress) throw new Error("no treasury key configured");
let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`  ${c ? "✓" : "✗"} ${m}`);
  if (!c) failures++;
};
const step = (s: string) => console.log(`\n▸ ${s}`);
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const treasurySign = async (steps: Array<{ to: string; data: string; description: string }>) => {
  const hashes: string[] = [];
  for (const s of steps) {
    console.log(`  signing (LP): ${s.description}`);
    hashes.push(await sendTreasuryTx({ to: s.to as Address, data: s.data as Hex }));
  }
  return hashes;
};

await migrate();
const net = selfNet("sepolia");
const c = selfClient(net);
const MUSDC = net.pair.usdc.address as Address;
const METH = net.pair.eth.address as Address;
const bal = (t: Address, a: Address) => c.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] });

const lpId = `e2e-dashout-${Date.now()}`;
const lp = await insertAccount({ privyUserId: lpId, email: `${lpId}@example.test`, privyWallet: treasuryAddress.toLowerCase(), boundAddress: `0x${Date.now().toString(16).padStart(40, "0")}`, ensName: null });
let lpPositionId: string | null = null;
try {
  step("LP: open a USDC-only Bid-Ask position below the market, through the manager (the liquidity to trade against)");
  const spot = await ethUsd();
  const prepared = await prepareOpen(net, lp, { shape: "bidask", priceMin: spot * 0.6, priceMax: spot * 0.95, amount: 15 });
  lpPositionId = prepared.positionId;
  await recordOpen(net, lp, prepared.positionId, await treasurySign(prepared.steps));
  check(true, `LP position ${prepared.positionId.slice(0, 8)} is open (${prepared.summary.strategies} strategies, ${prepared.summary.usdc} mUSDC, market $${spot})`);

  step("customer: a fresh wallet that holds only mETH (and a little ETH for gas)");
  const key = generatePrivateKey();
  const customer = privateKeyToAccount(key);
  const wallet = createWalletClient({ account: customer, chain: net.chain, transport: http(net.rpcUrl) });
  await sendTreasuryTx({ to: customer.address, data: "0x", value: parseUnits("0.0001", 18) });
  const sell = parseUnits("0.002", 18);
  await sendTreasuryTx({ to: METH, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [customer.address, sell] }) });
  // a public RPC can be a block behind right after a transfer: wait for the balance to show
  await retryRead(() => bal(METH, customer.address), (v) => v === sell);
  check((await bal(METH, customer.address)) === sell && (await bal(MUSDC, customer.address)) === 0n, `customer ${customer.address} holds ${formatUnits(sell, 18)} mETH and no mUSDC`);

  step("quote: what dashing out would get");
  const q = await dashOutQuote(net, customer.address);
  console.log(`  ${formatUnits(q.amountIn, 18)} mETH -> ${formatUnits(q.amountOut, 6)} mUSDC across ${q.fills.length} strategies, ${q.rate?.toFixed(0)} per mETH vs market ${q.marketRate?.toFixed(0)} (${q.discountPct?.toFixed(1)}% below)`);
  check(q.fills.length > 0 && q.unfilled === 0n, "every mETH can be sold");
  check(q.fills.every((f) => f.candidate.owner?.toLowerCase() !== customer.address.toLowerCase()), "it does not trade against the customer's own positions");
  check(q.discountPct !== null && q.discountPct > 3, `the best price is ${q.discountPct?.toFixed(1)}% below the market, so the real 3% guard would REFUSE this swap (limit raised to ${config.dashOut.maxDiscountPct}% for the test)`);
  check(q.allowed, "and with the test limit it is allowed");

  step("the minimum-payout guard: a swap that demands more than the quote must fail");
  const call = new sv.SwapVMContract(new sv.Address(net.router!));
  const f0 = q.fills[0]!;
  const tooGreedy = call.swap({ order: sv.Order.decode(new sv.HexString(f0.candidate.order)), amount: f0.amountIn, takerTraits: sv.TakerTraits.default().with({ threshold: f0.amountOut + 1n }), tokenIn: new sv.Address(METH), tokenOut: new sv.Address(MUSDC) });
  const approveHash = await wallet.sendTransaction({ to: METH, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256) returns (bool)"]), functionName: "approve", args: [net.router!, sell] }) });
  await c.waitForTransactionReceipt({ hash: approveHash });
  let refused = false;
  try {
    await c.call({ account: customer.address, to: tooGreedy.to.toString() as Address, data: tooGreedy.data.toString() as Hex });
  } catch {
    refused = true;
  }
  check(refused, "demanding quote+1 is rejected by the router");

  step("prepare and sign the dash out with the customer's own key");
  const { steps, minOut } = await prepareDashOut(net, customer.address);
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.description}`));
  const hashes: Hex[] = [];
  for (const s of steps) {
    const h = await wallet.sendTransaction({ to: s.to as Address, data: s.data as Hex });
    const rc = await c.waitForTransactionReceipt({ hash: h });
    if (rc.status !== "success") throw new Error(`swap failed: ${h}`);
    hashes.push(h);
  }
  const mUsdcAfter = await retryRead(() => bal(MUSDC, customer.address), (v) => v > 0n);
  const mEthAfter = await bal(METH, customer.address);
  console.log(`  customer now: ${formatUnits(mEthAfter, 18)} mETH, ${formatUnits(mUsdcAfter, 6)} mUSDC`);
  check(mEthAfter === 0n, "all the mETH was sold");
  check(mUsdcAfter >= minOut, `the customer received ${formatUnits(mUsdcAfter, 6)} mUSDC, at least the guaranteed ${formatUnits(minOut, 6)}`);
  check(mUsdcAfter >= q.amountOut - q.amountOut / 100n, "and within 1% of the quote");

  step("the LP position took the mETH (its balances moved), then close it");
  const closing = await prepareClose(net, lp, prepared.positionId);
  await recordClose(net, lp, prepared.positionId, await treasurySign(closing.steps));
  lpPositionId = null;
  check(true, "LP position closed and paid out");
} finally {
  if (lpPositionId) {
    // the test failed before closing: do not leave the LP position open
    try {
      const closing = await prepareClose(net, lp, lpPositionId);
      await recordClose(net, lp, lpPositionId, await treasurySign(closing.steps));
      console.log(`\n(cleanup) closed the LP position ${lpPositionId.slice(0, 8)}`);
    } catch (e) {
      console.log(`\n!! LP position ${lpPositionId} was left open and could not be closed here (${e instanceof Error ? e.message : e}): close it with the position manager`);
    }
  }
  await pool.query("delete from accounts where privy_user_id = $1", [lpId]);
  await pool.end();
}
async function retryRead<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 15; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return read();
}
console.log(failures === 0 ? "\n✓ dash out works end to end on Sepolia" : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
