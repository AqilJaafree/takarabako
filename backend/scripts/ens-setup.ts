// One-time setup of Takarabako's ENS v2 namespace on the official Sepolia
// deployment. Safe to re-run: every step checks what's already there.
//
//   cd backend && npm run ens:setup [-- label]      (default label: takarabako)
//
// 1. registers <label>.eth with the official ETHRegistrar (commit → wait → register),
//    paid in the deployment's open-mint MockUSDC
// 2. deploys our own UserRegistry (subnames) and PermissionedResolver (records)
//    through the official VerifiableFactory, both administered by the treasury
// 3. points <label>.eth at them and sets its address record to the treasury
// 4. resolves <label>.eth through the official UniversalResolverV2 to prove it
import { createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, http, keccak256, parseAbi, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  ALL_REGISTRY_ROLES,
  ALL_RESOLVER_ROLES,
  ENSV2,
  ONE_YEAR,
  dnsEncode,
  factoryAbi,
  namehash,
  registrarAbi,
  registryAbi,
  resolverAbi,
  universalResolverAbi,
} from "../src/ensV2.js";

const label = process.argv[2] ?? "takarabako";
const name = `${label}.eth`;
const account = privateKeyToAccount(process.env.TREASURY_PRIVATE_KEY as `0x${string}`);
const treasury = account.address;
const pub = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(process.env.RPC_URL) });
const erc20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const zero = "0x0000000000000000000000000000000000000000" as Address;

async function send(what: string, to: Address, data: `0x${string}`) {
  const hash = await wallet.sendTransaction({ to, data });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted (${hash})`);
  console.log(`  ✓ ${what}  ${hash}`);
  return r;
}

console.log(`ENS v2 setup for ${name} (treasury ${treasury})`);

// ---- 1. register <label>.eth ------------------------------------------------
let tokenId = await pub.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: "findTokenId", args: [label] }).catch(() => 0n);
const owner = tokenId ? await pub.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: "ownerOf", args: [tokenId] }).catch(() => zero) : zero;
if (owner.toLowerCase() === treasury.toLowerCase()) {
  console.log(`1. ${name} already registered to the treasury (token ${tokenId})`);
} else {
  const available = await pub.readContract({ address: ENSV2.ethRegistrar, abi: registrarAbi, functionName: "isAvailable", args: [label] });
  if (!available) throw new Error(`${name} is taken by ${owner}`);
  const [base, premium] = await pub.readContract({ address: ENSV2.ethRegistrar, abi: registrarAbi, functionName: "getRegisterPrice", args: [label, ONE_YEAR, ENSV2.mockUsdc] });
  const price = base + premium;
  console.log(`1. registering ${name} for 1 year: ${Number(price) / 1e6} MockUSDC`);
  const bal = await pub.readContract({ address: ENSV2.mockUsdc, abi: erc20, functionName: "balanceOf", args: [treasury] });
  if (bal < price) await send("mint MockUSDC (open faucet)", ENSV2.mockUsdc, encodeFunctionData({ abi: erc20, functionName: "mint", args: [treasury, price * 2n] }));
  await send("approve registrar", ENSV2.mockUsdc, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ENSV2.ethRegistrar, price * 2n] }));
  const secret = keccak256(toHex(`${label}:${treasury}:${Date.now()}`));
  const commitment = await pub.readContract({
    address: ENSV2.ethRegistrar, abi: registrarAbi, functionName: "makeCommitment",
    args: [label, treasury, secret, zero, zero, ONE_YEAR, `0x${"0".repeat(64)}`],
  });
  await send("commit", ENSV2.ethRegistrar, encodeFunctionData({ abi: registrarAbi, functionName: "commit", args: [commitment] }));
  console.log("  … waiting 70s (minimum commitment age is 60s)");
  await new Promise((r) => setTimeout(r, 70_000));
  await send("register", ENSV2.ethRegistrar, encodeFunctionData({
    abi: registrarAbi, functionName: "register",
    args: [label, treasury, secret, zero, zero, ONE_YEAR, ENSV2.mockUsdc, `0x${"0".repeat(64)}`],
  }));
  tokenId = await pub.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: "findTokenId", args: [label] });
}

// ---- 2. our subregistry + resolver ------------------------------------------
async function proxy(kind: string, impl: Address, init: `0x${string}`, existing: Address) {
  if (existing !== zero) {
    console.log(`  · ${kind} already set: ${existing}`);
    return existing;
  }
  const salt = BigInt(keccak256(toHex(`takarabako:${name}:${kind}`)));
  const r = await send(`deploy ${kind}`, ENSV2.verifiableFactory, encodeFunctionData({ abi: factoryAbi, functionName: "deployProxy", args: [impl, salt, init] }));
  const log = r.logs.find((l) => l.address.toLowerCase() === ENSV2.verifiableFactory.toLowerCase());
  const addr = `0x${log!.topics[2]!.slice(26)}` as Address;
  const ok = await pub.readContract({ address: ENSV2.verifiableFactory, abi: factoryAbi, functionName: "verifyContract", args: [addr, impl] });
  console.log(`    ${kind} at ${addr} (factory verifies implementation: ${ok})`);
  return addr;
}

console.log("2. subregistry and resolver");
const currentSub = await pub.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: "getSubregistry", args: [label] });
const currentRes = await pub.readContract({ address: ENSV2.ethRegistry, abi: registryAbi, functionName: "getResolver", args: [label] });
const subregistry = await proxy("UserRegistry", ENSV2.userRegistryImpl, encodeFunctionData({ abi: registryAbi, functionName: "initialize", args: [treasury, ALL_REGISTRY_ROLES] }), currentSub);
const resolver = await proxy("PermissionedResolver", ENSV2.permissionedResolverImpl, encodeFunctionData({ abi: resolverAbi, functionName: "initialize", args: [treasury, ALL_RESOLVER_ROLES] }), currentRes);

// ---- 3. wire them to <label>.eth ---------------------------------------------
console.log(`3. wiring ${name}`);
if (currentSub === zero) await send("setSubregistry", ENSV2.ethRegistry, encodeFunctionData({ abi: registryAbi, functionName: "setSubregistry", args: [tokenId, subregistry] }));
if (currentRes === zero) await send("setResolver", ENSV2.ethRegistry, encodeFunctionData({ abi: registryAbi, functionName: "setResolver", args: [tokenId, resolver] }));
const node = namehash(name);
const addrNow = await pub.readContract({ address: resolver, abi: resolverAbi, functionName: "addr", args: [node] }).catch(() => zero);
if (addrNow.toLowerCase() !== treasury.toLowerCase()) {
  await send("records (addr, description, url)", resolver, encodeFunctionData({
    abi: resolverAbi, functionName: "multicall",
    args: [[
      encodeFunctionData({ abi: resolverAbi, functionName: "setAddr", args: [node, treasury] }),
      encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, "description", "Takarabako — cash-in kiosks that turn banknotes into on-chain money"] }),
      encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, "url", "https://github.com/AqilJaafree/takarabako"] }),
    ]],
  }));
}

// ---- 4. prove it through the official Universal Resolver ---------------------
const [result, via] = await pub.readContract({
  address: ENSV2.universalResolver, abi: universalResolverAbi, functionName: "resolve",
  args: [dnsEncode(name), encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [node] })],
});
const resolved = decodeFunctionResult({ abi: resolverAbi, functionName: "addr", data: result });
console.log(`4. UniversalResolverV2: ${name} → ${resolved} (via resolver ${via}) ${resolved.toLowerCase() === treasury.toLowerCase() ? "✓" : "✗"}`);
console.log(`\nPut these in backend/.env:\nENS_PARENT_NAME=${name}\nENS_REGISTRY_ADDRESS=${subregistry}\nENS_RESOLVER_ADDRESS=${resolver}`);
