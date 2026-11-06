import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi, type Address } from "viem";
import { sv } from "../src/aquaSdk.js";
import { binsFor } from "../src/aquaMath.js";
import { ARC_PAIR, buildSelfOrder, matchesPrepared, planSelfClose, planSelfOpen } from "../src/selfCustody.js";

const MAKER = "0x00000000000000000000000000000000c0ffee01" as Address;
const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as Address;
const ROUTER = "0x111111338c5091e8440b67b168bae16a668ac0de" as Address;
const none = { eth: 0n, usdc: 0n };
const erc = parseAbi(["function approve(address,uint256) returns (bool)"]);
const SPOT = 2200;

const hybrid = () => binsFor("hybrid", SPOT * 0.5, SPOT * 2, SPOT);
const open = (over: Partial<Parameters<typeof planSelfOpen>[0]> = {}) =>
  planSelfOpen({ maker: MAKER, amountUsd: 100, bins: hybrid(), feeBps: 30, spot: SPOT, pair: ARC_PAIR, aqua: AQUA, router: ROUTER, allowance: none, owed: none, ...over });

test("every strategy belongs to the customer's wallet, and each is unique", () => {
  const { strategies } = open();
  assert.equal(strategies.length, 2);
  for (const s of strategies) assert.equal(sv.Order.decode(new sv.HexString(s.order)).maker.toString().toLowerCase(), MAKER);
  assert.notEqual(strategies[0]!.hash, strategies[1]!.hash);
});

test("the position is sized from the amount, split by weight", () => {
  const { strategies } = open();
  assert.equal(strategies[0]!.weight + strategies[1]!.weight, 1);
  const usdc = strategies.reduce((s, x) => s + Number(x.usdc) / 1e6, 0);
  const eth = strategies.reduce((s, x) => s + Number(x.eth) / 1e18, 0);
  assert.ok(Math.abs(usdc + eth * SPOT - 100) < 0.5, `worth ${usdc + eth * SPOT}`);
});

test("with no allowance it asks for two approvals first, then one ship per strategy", () => {
  const { steps, need } = open();
  assert.equal(steps.length, 4);
  const [a1, a2, s1, s2] = steps as [typeof steps[0], typeof steps[0], typeof steps[0], typeof steps[0]];
  assert.equal(a1.to.toLowerCase(), ARC_PAIR.eth.address);
  assert.equal(a2.to.toLowerCase(), ARC_PAIR.usdc.address);
  assert.equal(s1.to.toLowerCase(), AQUA);
  assert.equal(s2.to.toLowerCase(), AQUA);
  const d1 = decodeFunctionData({ abi: erc, data: a1.data });
  const d2 = decodeFunctionData({ abi: erc, data: a2.data });
  assert.equal((d1.args![0] as string).toLowerCase(), AQUA); // only Aqua is approved
  assert.equal((d2.args![0] as string).toLowerCase(), AQUA);
  assert.equal(d1.args![1], need.eth * 2n); // twice what the position holds
  assert.equal(d2.args![1], need.usdc * 2n);
});

test("approvals are never unlimited", () => {
  for (const s of open().steps.slice(0, 2)) {
    const amount = decodeFunctionData({ abi: erc, data: s.data }).args![1] as bigint;
    assert.ok(amount < 2n ** 128n, "an approval is far below the maximum");
  }
});

test("an allowance that is already big enough asks for no approval", () => {
  const first = open();
  const { steps } = open({ allowance: { eth: first.need.eth * 2n, usdc: first.need.usdc * 2n } });
  assert.equal(steps.length, 2); // just the two ships
  for (const s of steps) assert.equal(s.to.toLowerCase(), AQUA);
});

test("a short allowance on one token only asks for that token", () => {
  const first = open();
  const { steps } = open({ allowance: { eth: 0n, usdc: first.need.usdc * 2n } });
  assert.equal(steps.length, 3);
  assert.equal(steps[0]!.to.toLowerCase(), ARC_PAIR.eth.address);
});

test("the wallet's other open positions count towards what Aqua may pay out", () => {
  const alone = open();
  const withOthers = open({ owed: { eth: alone.need.eth * 3n, usdc: alone.need.usdc * 3n } });
  const amount = decodeFunctionData({ abi: erc, data: withOthers.steps[0]!.data }).args![1] as bigint;
  assert.equal(amount, (alone.need.eth * 3n + alone.need.eth) * 2n);
});

test("a range above the price holds only WETH, so only WETH is approved", () => {
  const { steps, need } = open({ bins: [{ min: SPOT * 1.2, max: SPOT * 1.5, weight: 1 }] });
  assert.equal(need.usdc, 0n);
  assert.equal(steps.length, 2); // one WETH approval and one ship
  assert.equal(steps[0]!.to.toLowerCase(), ARC_PAIR.eth.address);
});

test("a full-range position is both tokens", () => {
  const { strategies, need } = open({ bins: [null] });
  assert.equal(strategies.length, 1);
  assert.equal(strategies[0]!.min, null);
  assert.ok(need.eth > 0n && need.usdc > 0n);
});

test("the strategy program is the same one the treasury ships, for the given maker", () => {
  const a = buildSelfOrder(MAKER, { min: 2000, max: 2500 }, 30, ARC_PAIR, 1n).encode().toString();
  const b = buildSelfOrder(MAKER, { min: 2000, max: 2500 }, 30, ARC_PAIR, 1n).encode().toString();
  const other = buildSelfOrder("0x00000000000000000000000000000000c0ffee02" as Address, { min: 2000, max: 2500 }, 30, ARC_PAIR, 1n).encode().toString();
  assert.equal(a, b); // deterministic for a given salt
  assert.notEqual(a, other); // a different maker is a different strategy
});

test("closing is one dock per strategy, sent to Aqua", () => {
  const { strategies } = open();
  const steps = planSelfClose(strategies, ARC_PAIR, AQUA, ROUTER);
  assert.equal(steps.length, 2);
  for (const s of steps) assert.equal(s.to.toLowerCase(), AQUA);
  assert.notEqual(steps[0]!.data, steps[1]!.data);
});

const tx = (to: string, input: string, from = MAKER) => ({ to, input, from });

test("the transactions the wallet sent match the ones prepared, in any order", () => {
  const { steps } = open();
  const sent = steps.map((s) => tx(s.to, s.data)).reverse();
  assert.equal(matchesPrepared(MAKER, steps, sent), true);
});

test("a transaction from another wallet does not match", () => {
  const { steps } = open();
  const sent = steps.map((s, i) => tx(s.to, s.data, i === 0 ? ("0x00000000000000000000000000000000000bad01" as Address) : MAKER));
  assert.equal(matchesPrepared(MAKER, steps, sent), false);
});

test("a transaction with different data does not match (a different amount, say)", () => {
  const { steps } = open();
  const sent = steps.map((s, i) => tx(s.to, i === 0 ? s.data.slice(0, -2) + "ff" : s.data));
  assert.equal(matchesPrepared(MAKER, steps, sent), false);
});

test("a missing, extra or repeated transaction does not match", () => {
  const { steps } = open();
  const all = steps.map((s) => tx(s.to, s.data));
  assert.equal(matchesPrepared(MAKER, steps, all.slice(1)), false); // one missing
  assert.equal(matchesPrepared(MAKER, steps, [...all, all[0]!]), false); // one extra
  assert.equal(matchesPrepared(MAKER, steps, [all[0]!, all[0]!, all[2]!, all[3]!]), false); // one used twice
});

test("matching ignores the case of addresses and data", () => {
  const { steps } = open();
  const sent = steps.map((s) => tx(s.to.toUpperCase().replace("0X", "0x"), s.data.toUpperCase().replace("0X", "0x"), MAKER.toUpperCase().replace("0X", "0x") as Address));
  assert.equal(matchesPrepared(MAKER, steps, sent), true);
});
