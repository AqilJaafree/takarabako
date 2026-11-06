import { createPublicClient, http, parseAbi, type Address } from "viem";
import { config } from "./config.js";
import { describeNetworks, NETWORKS, type NetworkKey } from "./networks.js";

/// A read-only look at a network, for the web app's network switcher: is its
/// RPC the chain it says it is, what a transaction costs, and whether Aqua, the
/// SwapVM router and USDC really have code at the addresses we would use.
/// Nothing is sent and no key is used. Answers are cached for 30 seconds per
/// network (and shared while one is in flight), so a public page can ask freely.

export interface ContractCheck {
  address: string;
  hasCode: boolean | null; // null = the check itself failed
  codeBytes: number | null;
}

export interface NetworkStatus {
  key: NetworkKey;
  reachable: boolean;
  chainIdOk: boolean | null;
  block: number | null;
  rpcHost: string;
  fees: { maxFeeGwei: number | null; floorGwei: number };
  aqua: { deployed: boolean; registry: ContractCheck | null; router: ContractCheck | null };
  usdc: (ContractCheck & { symbol: string | null; decimals: number | null }) | null;
  checkedAt: string;
}

const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const TTL_MS = 30_000;
const cache = new Map<NetworkKey, { at: number; value: Promise<NetworkStatus> }>();

export const isNetworkKey = (k: string): k is NetworkKey => Object.prototype.hasOwnProperty.call(NETWORKS, k);

export function networkStatus(key: NetworkKey): Promise<NetworkStatus> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = check(key);
  cache.set(key, { at: Date.now(), value });
  return value;
}

const ok = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

async function check(key: NetworkKey): Promise<NetworkStatus> {
  const net = NETWORKS[key];
  const info = describeNetworks(config.network.key, {
    aqua: process.env.AQUA_ADDRESS,
    router: process.env.AQUA_ROUTER_ADDRESS,
    usdc: config.usdcAddress,
    baseToken: config.aqua.methAddress,
  }).find((n) => n.key === key)!;
  const rpc = info.active ? config.rpcUrl : net.defaultRpcUrl;
  const client = createPublicClient({ chain: net.chain, transport: http(rpc, { timeout: 8_000, retryCount: 1 }) });

  const codeOf = async (address: string): Promise<ContractCheck> => {
    try {
      const code = await client.getCode({ address: address as Address });
      return { address, hasCode: Boolean(code && code !== "0x"), codeBytes: code ? (code.length - 2) / 2 : 0 };
    } catch {
      return { address, hasCode: null, codeBytes: null };
    }
  };

  const [chainId, block, fees, registry, router, token] = await Promise.allSettled([
    client.getChainId(),
    client.getBlockNumber(),
    client.estimateFeesPerGas(),
    info.aqua ? codeOf(info.aqua.aqua) : Promise.resolve(null),
    info.aqua ? codeOf(info.aqua.router) : Promise.resolve(null),
    info.usdc
      ? (async () => {
          const base = await codeOf(info.usdc);
          if (!base.hasCode) return { ...base, symbol: null, decimals: null };
          const [symbol, decimals] = await Promise.allSettled([
            client.readContract({ address: info.usdc as Address, abi: erc20, functionName: "symbol" }),
            client.readContract({ address: info.usdc as Address, abi: erc20, functionName: "decimals" }),
          ]);
          return { ...base, symbol: ok(symbol), decimals: ok(decimals) === null ? null : Number(ok(decimals)) };
        })()
      : Promise.resolve(null),
  ]);

  const id = ok(chainId);
  const maxFee = ok(fees)?.maxFeePerGas;
  return {
    key,
    reachable: id !== null,
    chainIdOk: id === null ? null : id === net.chain.id,
    block: ok(block) === null ? null : Number(ok(block)),
    rpcHost: new URL(rpc).host,
    fees: { maxFeeGwei: maxFee === undefined ? null : Number(maxFee) / 1e9, floorGwei: Number(net.minMaxFeePerGas) / 1e9 },
    aqua: { deployed: Boolean(info.aqua), registry: ok(registry), router: ok(router) },
    usdc: ok(token),
    checkedAt: new Date().toISOString(),
  };
}
