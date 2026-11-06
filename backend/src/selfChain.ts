import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem";
import { arc, sepolia } from "viem/chains";
import { config } from "./config.js";
import { NETWORKS, resolveAquaDeployment } from "./networks.js";
import type { PairTokens } from "./aquaMath.js";
import { ARC_CHAIN_ID, ARC_PAIR } from "./selfCustody.js";

/// The chains a customer can sign Aqua positions on with their own wallet, and what differs between
/// them: the token pair, who pays gas in what, the fee floor, and whether an AquaPositionManager is
/// deployed there. Arc mainnet is real money; Sepolia is the same flow with worthless tokens, for
/// trying it out first.
export type SelfNetKey = "arc" | "sepolia";

export interface SelfNet {
  key: SelfNetKey;
  name: string;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  pair: PairTokens;
  /// Names for the tokens as a customer knows them on this chain.
  symbols: { base: string; quote: string; gas: string };
  /// The most gas a transaction can pay below, as a mempool floor (0 = none).
  minMaxFeePerGas: bigint;
  /// Native balance (wei) a wallet needs to pay for the transactions of one position.
  minGasWei: bigint;
  aqua: Address | null;
  router: Address | null;
  /// The AquaPositionManager on this chain, or null: then the wallet signs each strategy itself.
  manager: Address | null;
  enabled: boolean;
  /// Why it is off (shown instead of a bare 404).
  disabledReason: string;
}

const addr = (v: string | undefined | null): Address | null => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null);

function arcNet(): SelfNet {
  const d = resolveAquaDeployment(ARC_CHAIN_ID, {});
  return {
    key: "arc",
    name: NETWORKS.arc.name,
    chainId: ARC_CHAIN_ID,
    chain: arc,
    rpcUrl: config.selfCustody.arcRpcUrl,
    pair: ARC_PAIR,
    symbols: { base: "WETH", quote: "USDC", gas: "USDC" },
    minMaxFeePerGas: NETWORKS.arc.minMaxFeePerGas,
    minGasWei: 500_000_000_000_000_000n, // 0.5 USDC: Arc's native coin has 18 decimals
    aqua: addr(d?.aqua),
    router: addr(d?.router),
    manager: addr(config.selfCustody.arcManager),
    enabled: config.selfCustody.arcEnabled && Boolean(d),
    disabledReason: "signing with your own wallet on Arc is not turned on",
  };
}

function sepoliaNet(): SelfNet {
  // Sepolia's token addresses are this backend's own (USDC_ADDRESS, METH_ADDRESS), so it only works
  // when this backend runs on Sepolia.
  const here = config.network.key === "sepolia";
  const pair: PairTokens = {
    eth: { address: config.aqua.methAddress, decimals: 18n },
    usdc: { address: config.usdcAddress, decimals: 6n },
  };
  return {
    key: "sepolia",
    name: NETWORKS.sepolia.name,
    chainId: sepolia.id,
    chain: sepolia,
    rpcUrl: config.rpcUrl,
    pair,
    symbols: { base: "mETH", quote: "mUSDC", gas: "ETH" },
    minMaxFeePerGas: NETWORKS.sepolia.minMaxFeePerGas,
    minGasWei: 500_000_000_000_000n, // 0.0005 ETH
    aqua: addr(config.aqua.address),
    router: addr(config.aqua.router),
    manager: addr(config.selfCustody.sepoliaManager),
    enabled: config.selfCustody.sepoliaEnabled && here && config.aqua.deployed && Boolean(pair.eth.address && pair.usdc.address),
    disabledReason: "signing with your own wallet on Sepolia is not turned on",
  };
}

export const SELF_NET_KEYS: SelfNetKey[] = ["arc", "sepolia"];
export const isSelfNetKey = (k: string): k is SelfNetKey => (SELF_NET_KEYS as string[]).includes(k);

/// The chain for a route; 404 if it is unknown or turned off.
export function selfNet(key: string): SelfNet {
  if (!isSelfNetKey(key)) throw Object.assign(new Error(`unknown network "${key}"`), { status: 404 });
  const net = key === "arc" ? arcNet() : sepoliaNet();
  if (!net.enabled) throw Object.assign(new Error(net.disabledReason), { status: 404 });
  return net;
}

/// Whether self-custody is on for `key` (for the networks list; never throws).
export function selfNetEnabled(key: string): boolean {
  return isSelfNetKey(key) && (key === "arc" ? arcNet() : sepoliaNet()).enabled;
}

const clients = new Map<string, PublicClient>();
export function selfClient(net: SelfNet): PublicClient {
  let c = clients.get(net.key);
  if (!c) {
    c = createPublicClient({ chain: net.chain, transport: http(net.rpcUrl, { timeout: 10_000 }) }) as PublicClient;
    clients.set(net.key, c);
  }
  return c;
}
