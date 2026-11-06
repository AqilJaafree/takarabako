import { test } from "node:test";
import assert from "node:assert/strict";

// The chain and pair settings are read from the environment when the module loads, so set them first.
process.env.SELF_CUSTODY_ARC = "1";
process.env.SELF_EXTRA_PAIRS = "eurc";
process.env.SELF_MANAGER_ARC = "0x6cc5f175810e61A56508049f0527BC75EB7e77e4";
delete process.env.SELF_MANAGER_ARC_EURC;
const { selfNet, selfPairsInfo, withPair } = await import("../src/selfChain.js");

const WETH = "0x128cC466B61f542da60c70e3aA11c10e19B84EDB";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const USDC = "0x3600000000000000000000000000000000000000";

test("with no pair named, a chain is its default pair: WETH/USDC on Arc", () => {
  const net = selfNet("arc");
  assert.equal(net.pairKey, "weth");
  assert.deepEqual(net.pairKeys, ["weth", "eurc"]);
  assert.equal(net.pair.eth.address.toLowerCase(), WETH.toLowerCase());
  assert.equal(net.symbols.base, "WETH");
  assert.equal(net.stable, false);
  assert.equal(net.feeBps, null);
});

test("naming a pair specialises the chain to it: EURC has its own tokens, names, fee and price source", () => {
  const eurc = selfNet("arc", "eurc");
  const weth = selfNet("arc");
  assert.equal(eurc.pairKey, "eurc");
  assert.equal(eurc.pair.eth.address.toLowerCase(), EURC.toLowerCase());
  assert.equal(eurc.pair.eth.decimals, 6n);
  assert.equal(eurc.pair.usdc.address.toLowerCase(), USDC.toLowerCase());
  assert.equal(eurc.symbols.base, "EURC");
  assert.equal(eurc.stable, true);
  assert.equal(eurc.feeBps, 5);
  assert.notEqual(eurc.spot, weth.spot, "EURC is priced from its own sources, not the ETH feed");
  // everything else about the chain is shared
  assert.equal(eurc.chainId, weth.chainId);
  assert.equal(eurc.aqua, weth.aqua);
  assert.equal(eurc.router, weth.router);
});

test("every pair exits to the same quote token, USDC", () => {
  for (const key of selfNet("arc").pairKeys) assert.equal(selfNet("arc", key).pair.usdc.address.toLowerCase(), USDC.toLowerCase());
});

test("each pair has its own manager: WETH has one, EURC has none until one is deployed for it", () => {
  assert.equal(selfNet("arc").manager?.toLowerCase(), "0x6cc5f175810e61a56508049f0527bc75eb7e77e4");
  assert.equal(selfNet("arc", "eurc").manager, null);
});

test("an unknown pair is a 404, not the default", () => {
  assert.throws(() => selfNet("arc", "doge"), (e: Error & { status?: number }) => e.status === 404 && /unknown pair/.test(e.message));
});

test("a stored position's pair picks its specialisation; null is the default pair", () => {
  const net = selfNet("arc");
  assert.equal(withPair(net, null), net);
  assert.equal(withPair(net, undefined), net);
  assert.equal(withPair(net, "weth"), net);
  assert.equal(withPair(net, "eurc").pairKey, "eurc");
  assert.equal(withPair(withPair(net, "eurc"), "weth").pair.eth.address.toLowerCase(), WETH.toLowerCase());
});

test("the networks list says which pairs a chain offers, and which have a manager", () => {
  assert.deepEqual(selfPairsInfo("arc"), [
    { key: "weth", symbols: { base: "WETH", quote: "USDC" }, stable: false, manager: true },
    { key: "eurc", symbols: { base: "EURC", quote: "USDC" }, stable: true, manager: false },
  ]);
  assert.deepEqual(selfPairsInfo("nowhere"), []);
});
