// Writes contracts/test/Fixtures.sol: real SwapVM strategies (built by the same SDK code the
// app uses) with the AquaPositionManager's test address as the maker, plus swap calldata, so
// the Foundry fork tests exercise the real Aqua and router on Arc mainnet.
//
//   npx tsx scripts/gen-manager-fixtures.ts
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";
import { sv } from "../src/aquaSdk.js";
import { ARC_PAIR, planSelfOpen } from "../src/selfCustody.js";
import { selfBins } from "../src/selfShapes.js";

const { Interaction } = createRequire(import.meta.url)("@1inch/sdk-core") as typeof import("@1inch/sdk-core");
const MANAGER = "0x00000000000000000000000000000000c0ffee02" as Address;
// CHAIN=sepolia builds the fixtures for the Sepolia pair (our mock mETH and MockUSDC) and the
// older Sepolia router; the default is Arc mainnet.
// CHAIN=arc-eurc builds them for Arc's EURC/USDC stable pair: EURC takes the "base" slot, priced in USDC
// (the EUR/USD rate), with a narrow range and a 5 bps fee.
const SEPOLIA = process.env.CHAIN === "sepolia";
const EURC = process.env.CHAIN === "arc-eurc";
const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as Address;
const ROUTER = (SEPOLIA ? "0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de" : "0x111111338c5091e8440b67b168bae16a668ac0de") as Address;
const PAIR = EURC
  ? {
      eth: { address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", decimals: 6n },
      usdc: ARC_PAIR.usdc,
    }
  : SEPOLIA
  ? {
      eth: { address: "0x5A9E9fF59AeBb96C14DFaB7C2a43d0C130ba9282", decimals: 18n },
      usdc: { address: "0x6cc5f175810e61A56508049f0527BC75EB7e77e4", decimals: 6n },
    }
  : ARC_PAIR;
const RPC = SEPOLIA ? "https://ethereum-sepolia-rpc.publicnode.com" : "https://rpc.mainnet.arc.io";
const SPOT = EURC ? 1.1165 : 2200;
const none = { eth: 0n, usdc: 0n };

// Fixed salts keep the output (and so the committed fixtures) reproducible. A strategy's salt mixes
// Math.random with the clock (selfCustody.ts buildSelfOrder), so both are pinned.
let salt = 1000n;
const realRandom = Math.random;
const realNow = Date.now;
Math.random = () => Number(salt++) / 2 ** 48;
Date.now = () => 0;

const sel = selfBins("curve", SPOT, EURC ? 1.1 : 1800, EURC ? 1.135 : 2900);
const bins = sel.bins;
const feeBps = EURC ? 5 : sel.feeBps;
const plan = planSelfOpen({ maker: MANAGER, amountUsd: 50, bins, feeBps, spot: SPOT, pair: PAIR, aqua: AQUA, router: ROUTER, allowance: none, owed: none });
Math.random = realRandom;
Date.now = realNow;

const call = new sv.SwapVMContract(new sv.Address(ROUTER));
const swap = (idx: number, tokenIn: string, tokenOut: string, amount: bigint) =>
  call
    .swap({
      order: sv.Order.decode(new sv.HexString(plan.strategies[idx]!.order)),
      amount,
      takerTraits: sv.TakerTraits.default(),
      tokenIn: new sv.Address(tokenIn),
      tokenOut: new sv.Address(tokenOut),
    })
    .data.toString();

// A hostile strategy for the security tests: same program as the middle strategy, but the
// maker's proceeds are routed to an attacker (customReceiver) instead of the maker.
const ATTACKER = "0x000000000000000000000000000000000000bad1" as Address;
const hostileOrder = (() => {
  const base = sv.Order.decode(new sv.HexString(plan.strategies[2]!.order));
  return sv.Order.new({
    maker: new sv.Address(MANAGER),
    program: base.program,
    traits: sv.MakerTraits.default().with({ customReceiver: new sv.Address(ATTACKER) }),
  });
})();
const hostile = hostileOrder.encode().toString();
const hostileSwap = call
  .swap({ order: hostileOrder, amount: 500_000n, takerTraits: sv.TakerTraits.default(), tokenIn: new sv.Address(PAIR.usdc.address), tokenOut: new sv.Address(PAIR.eth.address) })
  .data.toString();

// Hostile strategies whose maker hook makes the router call something on the attacker's behalf.
// The router is the registered Aqua app, so a hook that calls aqua.pull would act as the app.
const hooked = (target: Address, data: `0x${string}`) => {
  const base = sv.Order.decode(new sv.HexString(plan.strategies[2]!.order));
  const hook = new Interaction(new sv.Address(target), new sv.HexString(data));
  const order = sv.Order.new({
    maker: new sv.Address(MANAGER),
    program: base.program,
    traits: sv.MakerTraits.default().with({ preTransferOutHook: hook }),
  });
  const swapData = call
    .swap({ order, amount: 500_000n, takerTraits: sv.TakerTraits.default(), tokenIn: new sv.Address(PAIR.usdc.address), tokenOut: new sv.Address(PAIR.eth.address) })
    .data.toString();
  return { strategy: order.encode().toString(), swap: swapData };
};
// The router calls preTransferOut(maker, taker, tokenIn, tokenOut, amountIn, amountOut, hash, data)
// on the hook target, so a hook is a contract the attacker wrote. The test etches one at HOOK.
const HOOK = "0x000000000000000000000000000000000000bad2" as Address;
const evil = hooked(HOOK, "0x1234");

const hex = (h: string) => `hex"${h.replace(/^0x/, "")}"`;
const lines: string[] = [];
lines.push("// SPDX-License-Identifier: MIT", "pragma solidity ^0.8.24;", "", "// GENERATED by backend/scripts/gen-manager-fixtures.ts. Do not edit.", "library Fixtures {");
lines.push(`    address internal constant MANAGER = ${getAddress(MANAGER)};`);
lines.push(`    string internal constant RPC = "${RPC}";`);
lines.push(`    address internal constant AQUA = ${getAddress(AQUA)};`);
lines.push(`    address internal constant ROUTER = ${getAddress(ROUTER)};`);
lines.push(`    address internal constant WETH = ${getAddress(PAIR.eth.address)};`);
lines.push(`    address internal constant USDC = ${getAddress(PAIR.usdc.address)};`);
lines.push(`    uint256 internal constant COUNT = ${plan.strategies.length};`);
lines.push("", "    function strategies() internal pure returns (bytes[] memory s) {", `        s = new bytes[](${plan.strategies.length});`);
plan.strategies.forEach((s, i) => lines.push(`        s[${i}] = ${hex(s.order)};`));
lines.push("    }", "", "    function wethAmounts() internal pure returns (uint256[] memory a) {", `        a = new uint256[](${plan.strategies.length});`);
plan.strategies.forEach((s, i) => lines.push(`        a[${i}] = ${s.eth};`));
lines.push("    }", "", "    function usdcAmounts() internal pure returns (uint256[] memory a) {", `        a = new uint256[](${plan.strategies.length});`);
plan.strategies.forEach((s, i) => lines.push(`        a[${i}] = ${s.usdc};`));
lines.push("    }", "");
// 0.5 USDC in against the middle strategy, and 0.0001 WETH in against it.
lines.push(`    function swapUsdcForWeth() internal pure returns (bytes memory) {\n        return ${hex(swap(2, PAIR.usdc.address, PAIR.eth.address, 500_000n))};\n    }`);
lines.push(`    function swapWethForUsdc() internal pure returns (bytes memory) {\n        return ${hex(swap(2, PAIR.eth.address, PAIR.usdc.address, EURC ? 400_000n : 100_000_000_000_000n))};\n    }`);
lines.push(`    function hostileStrategy() internal pure returns (bytes memory) {\n        return ${hex(hostile)};\n    }`);
lines.push(`    function hostileSwap() internal pure returns (bytes memory) {\n        return ${hex(hostileSwap)};\n    }`);
for (const [name, v] of [["hook", evil]] as const) {
  lines.push(`    function ${name}Strategy() internal pure returns (bytes memory) {\n        return ${hex(v.strategy)};\n    }`);
  lines.push(`    function ${name}Swap() internal pure returns (bytes memory) {\n        return ${hex(v.swap)};\n    }`);
}
lines.push("}", "");

const out = fileURLToPath(new URL("../../contracts/test/Fixtures.sol", import.meta.url));
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out}: ${plan.strategies.length} strategies, need ${plan.need.eth} wei WETH + ${plan.need.usdc} USDC units`);
