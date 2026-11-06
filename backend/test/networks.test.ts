import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFeeFloor, describeNetworks, resolveAquaDeployment, resolveNetwork, showApyEstimates } from "../src/networks.js";

const GWEI = 1_000_000_000n;

test("Sepolia is the default network", () => {
  const n = resolveNetwork(undefined);
  assert.equal(n.key, "sepolia");
  assert.equal(n.chain.id, 11155111);
  assert.equal(n.minMaxFeePerGas, 0n);
});

test("Arc Testnet and Arc mainnet use the chain ids from the Arc docs", () => {
  assert.equal(resolveNetwork("arc-testnet").chain.id, 5042002);
  assert.equal(resolveNetwork("arc").chain.id, 5042);
});

test("Arc Testnet knows its ERC-20 USDC (6 decimals) address and the 20 gwei fee floor", () => {
  const n = resolveNetwork("arc-testnet");
  assert.equal(n.defaults.usdc, "0x3600000000000000000000000000000000000000");
  assert.equal(n.minMaxFeePerGas, 20n * GWEI);
  assert.equal(n.nativeSymbol, "USDC");
});

test("an unknown CHAIN is rejected with the valid choices", () => {
  assert.throws(() => resolveNetwork("polygon"), /sepolia, arc-testnet, hedera-testnet, arc/);
});

test("Sepolia: shared Aqua registry, earlier SwapVM router", () => {
  const d = resolveAquaDeployment(11155111);
  assert.deepEqual(d, {
    aqua: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
    router: "0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de",
    origin: "sepolia",
  });
});

test("Arc mainnet: addresses come from the official SDK maps", () => {
  const d = resolveAquaDeployment(5042);
  assert.equal(d?.origin, "sdk");
  assert.equal(d?.aqua, "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a");
  assert.equal(d?.router, "0x111111338c5091e8440b67b168bae16a668ac0de");
});

test("Arc Testnet: Aqua is not deployed, so there is no deployment unless both addresses are given", () => {
  assert.equal(resolveAquaDeployment(5042002), null);
  assert.equal(resolveAquaDeployment(5042002, { aqua: "0x1111111111111111111111111111111111111111" }), null);
  const ours = resolveAquaDeployment(5042002, {
    aqua: "0x1111111111111111111111111111111111111111",
    router: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(ours?.origin, "env");
  assert.equal(ours?.router, "0x2222222222222222222222222222222222222222");
});

test("env addresses override the built-in ones", () => {
  const d = resolveAquaDeployment(11155111, { router: "0x3333333333333333333333333333333333333333" });
  assert.equal(d?.origin, "env");
  assert.equal(d?.router, "0x3333333333333333333333333333333333333333");
  assert.equal(d?.aqua, "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a");
});

test("fee floor: none leaves fees alone", () => {
  const fees = { maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 1n * GWEI };
  assert.equal(applyFeeFloor(fees, 0n), fees);
});

test("fee floor: raises a low maxFeePerGas to 20 gwei and keeps the tip within it", () => {
  const out = applyFeeFloor({ maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 1n * GWEI }, 20n * GWEI);
  assert.equal(out.maxFeePerGas, 20n * GWEI);
  assert.equal(out.maxPriorityFeePerGas, 1n * GWEI);
});

test("fee floor: keeps a higher maxFeePerGas and fills in missing fees", () => {
  assert.equal(applyFeeFloor({ maxFeePerGas: 50n * GWEI }, 20n * GWEI).maxFeePerGas, 50n * GWEI);
  assert.deepEqual(applyFeeFloor({}, 20n * GWEI), { maxFeePerGas: 20n * GWEI, maxPriorityFeePerGas: 0n });
});

test("fee floor: a tip above the fee cap is clamped to it", () => {
  const out = applyFeeFloor({ maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 30n * GWEI }, 20n * GWEI);
  assert.equal(out.maxPriorityFeePerGas, 20n * GWEI);
});

test("describeNetworks lists all four networks with exactly one active", () => {
  const list = describeNetworks("sepolia");
  assert.deepEqual(list.map((n) => n.key), ["sepolia", "arc-testnet", "hedera-testnet", "arc"]);
  assert.deepEqual(list.map((n) => n.active), [true, false, false, false]);
  assert.deepEqual(list.map((n) => n.chainId), [11155111, 5042002, 296, 5042]);
});

test("describeNetworks: Aqua is on Sepolia and Arc mainnet but not on Arc Testnet", () => {
  const byKey = Object.fromEntries(describeNetworks("sepolia").map((n) => [n.key, n]));
  assert.equal(byKey.sepolia!.aqua?.origin, "sepolia");
  assert.equal(byKey.arc!.aqua?.origin, "sdk");
  assert.equal(byKey["arc-testnet"]!.aqua, null);
  assert.equal(byKey["arc-testnet"]!.feeFloorGwei, 20);
  assert.equal(byKey.sepolia!.feeFloorGwei, 0);
});

test("describeNetworks: env overrides apply to the active network only", () => {
  const ours = { aqua: "0x1111111111111111111111111111111111111111", router: "0x2222222222222222222222222222222222222222" };
  const byKey = Object.fromEntries(describeNetworks("arc-testnet", ours).map((n) => [n.key, n]));
  assert.equal(byKey["arc-testnet"]!.aqua?.origin, "env");
  assert.equal(byKey["arc-testnet"]!.aqua?.router, ours.router);
  assert.equal(byKey.arc!.aqua?.origin, "sdk"); // mainnet still shows the SDK's addresses
  assert.equal(byKey.sepolia!.aqua?.origin, "sepolia");
});

test("describeNetworks: a configured USDC replaces the default for the active network only", () => {
  const usdc = "0x6cc5f175810e61A56508049f0527BC75EB7e77e4";
  const byKey = Object.fromEntries(describeNetworks("sepolia", { usdc }).map((n) => [n.key, n]));
  assert.equal(byKey.sepolia!.usdc, usdc);
  assert.equal(byKey["arc-testnet"]!.usdc, "0x3600000000000000000000000000000000000000");
});

test("only Arc mainnet is real money", () => {
  assert.deepEqual(describeNetworks("sepolia").map((n) => [n.key, n.real]), [["sepolia", false], ["arc-testnet", false], ["hedera-testnet", false], ["arc", true]]);
  assert.equal(resolveNetwork("arc").real, true);
  assert.equal(resolveNetwork("arc-testnet").real, false);
});

test("APY estimates show on testnets and are hidden where money is real", () => {
  assert.equal(showApyEstimates(false), true);
  assert.equal(showApyEstimates(true), false);
});

test("SHOW_APY_ESTIMATES overrides either way", () => {
  assert.equal(showApyEstimates(true, "1"), true);
  assert.equal(showApyEstimates(false, "0"), false);
  assert.equal(showApyEstimates(true, ""), false); // blank means no override
  assert.equal(showApyEstimates(false, "maybe"), true); // anything else is ignored
});

test("hedera testnet: chain 296, HBAR gas, the HTS USDC facade, no fee floor and a 1000-block log cap", () => {
  const n = resolveNetwork("hedera-testnet");
  assert.equal(n.chain.id, 296);
  assert.equal(n.nativeSymbol, "HBAR");
  assert.equal(n.real, false);
  assert.equal(n.minMaxFeePerGas, 0n);
  assert.equal(n.defaults.usdc, "0x0000000000000000000000000000000000068cda");
  assert.equal(BigInt(n.defaults.usdc), 429274n); // token 0.0.429274
  assert.ok(n.logBatchBlocks <= 1000n);
  assert.ok(n.gas.minBalance > n.gas.topUp / 10, "hbar top-ups are far bigger than eth ones");
});
