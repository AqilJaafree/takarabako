// Read-only check of the configured network: nothing is sent, no key needed.
//
//   cd backend && CHAIN=arc-testnet npm run chain:check
//   cd backend && CHAIN=sepolia     npm run chain:check
//
// Confirms the RPC is the chain CHAIN says it is, the USDC token answers with
// the expected decimals, the Arc fee floor is applied to a live estimate, and
// whether 1inch Aqua + the SwapVM router have code at the resolved addresses.
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { config } from "../src/config.js";
import { applyFeeFloor } from "../src/networks.js";
import { verifyAquaOnChain } from "../src/aqua.js";

const net = config.network;
const client = createPublicClient({ chain: net.chain, transport: http(config.rpcUrl) });
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

let failed = false;
const line = (ok: boolean | null, label: string, detail = "") => {
  if (ok === false) failed = true;
  console.log(`${ok === null ? "·" : ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
};

console.log(`${net.name} · CHAIN=${net.key} · ${config.rpcUrl}`);

const chainId = await client.getChainId();
line(chainId === net.chain.id, "RPC chain id", `${chainId}${chainId === net.chain.id ? "" : ` (expected ${net.chain.id})`}`);
line(true, "latest block", String(await client.getBlockNumber()));

if (config.usdcAddress) {
  const code = await client.getCode({ address: config.usdcAddress as Address });
  if (!code || code === "0x") line(false, "USDC token", `no code at ${config.usdcAddress}`);
  else {
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: config.usdcAddress as Address, abi: erc20, functionName: "decimals" }),
      client.readContract({ address: config.usdcAddress as Address, abi: erc20, functionName: "symbol" }).catch(() => "?"),
    ]);
    line(decimals === 6, "USDC ERC-20", `${symbol}, ${decimals} decimals at ${config.usdcAddress}`);
  }
} else line(null, "USDC token", "USDC_ADDRESS not set");

const est = await client.estimateFeesPerGas();
const floored = applyFeeFloor(est, net.minMaxFeePerGas);
const gwei = (v?: bigint) => (v === undefined ? "?" : (Number(v) / 1e9).toFixed(2));
line(
  floored.maxFeePerGas === undefined || floored.maxFeePerGas >= net.minMaxFeePerGas,
  "fee floor",
  `node estimate ${gwei(est.maxFeePerGas)} gwei → send with ${gwei(floored.maxFeePerGas)} gwei (floor ${gwei(net.minMaxFeePerGas)})`,
);

if (!config.aqua.deployed) {
  line(false, "1inch Aqua", `not available on ${net.name}: no SDK address for chain ${net.chain.id}; set AQUA_ADDRESS and AQUA_ROUTER_ADDRESS to use your own deployment`);
} else {
  line(null, "Aqua addresses", `${config.aqua.origin}: registry ${config.aqua.address}, router ${config.aqua.router}`);
  const r = await verifyAquaOnChain();
  line(r.ok, "Aqua contracts on chain", r.ok ? "registry, router and pair tokens have code" : `missing: ${r.missing.join("; ")}`);
}

process.exit(failed ? 1 : 0);
