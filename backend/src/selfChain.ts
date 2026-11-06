import { createPublicClient, http, type Address, type Chain, type PublicClient } from "viem";
import { arc, sepolia } from "viem/chains";
import { config } from "./config.js";
import { ethUsd, MONEY_PRICE_MAX_AGE_MS } from "./aqua.js";
import { NETWORKS, resolveAquaDeployment } from "./networks.js";
import type { PairTokens } from "./aquaMath.js";
import { eurcUsdc } from "./pairPrice.js";
import { ARC_CHAIN_ID, ARC_PAIR } from "./selfCustody.js";

/// The chains a customer can sign Aqua positions on with their own wallet, and the pairs (a base token
/// against USDC) offered on each. Arc mainnet is real money; Sepolia is the same flow with worthless
/// tokens, for trying it out first.
///
/// A SelfNet is a chain *specialised to one pair*: `selfNet("arc", "eurc")` carries EURC's tokens, names,
/// position manager, price source and fee, so everything that opens, closes, values or dashes out a
/// position takes a SelfNet and works for any pair unchanged. With no pair named it is the chain's
/// default pair (the first listed).
export type SelfNetKey = "arc" | "sepolia";

/// One tradable pair on a chain: a base token priced in USDC (the quote token every position exits to).
export interface PairSpec {
  key: string;
  pair: PairTokens;
  /// Names for the tokens as a customer knows them on this chain.
  symbols: { base: string; quote: string; gas: string };
  /// The AquaPositionManager deployed for exactly this pair, or null: then the wallet signs each strategy.
  manager: Address | null;
  /// A pair that trades near a fixed ratio (EURC/USDC): narrow ranges and a low fee.
  stable: boolean;
  /// The pool fee to ship with, in bps; null = the advanced default.
  feeBps: number | null;
  /// The base token's price in USDC. It moves money, so it must be a checked price (two sources).
  spot: () => Promise<number>;
}

export interface SelfNet {
  key: SelfNetKey;
  name: string;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  /// The pair this SelfNet is specialised to, and the keys of every pair offered on the chain.
  pairKey: string;
  pairKeys: string[];
  pair: PairTokens;
  symbols: { base: string; quote: string; gas: string };
  stable: boolean;
  feeBps: number | null;
  spot: () => Promise<number>;
  /// The most gas a transaction can pay below, as a mempool floor (0 = none).
  minMaxFeePerGas: bigint;
  /// Native balance (wei) a wallet needs to pay for the transactions of one position.
  minGasWei: bigint;
  aqua: Address | null;
  router: Address | null;
  /// The AquaPositionManager for this pair, or null: then the wallet signs each strategy itself.
  manager: Address | null;
  enabled: boolean;
  /// Why it is off (shown instead of a bare 404).
  disabledReason: string;
}

const addr = (v: string | undefined | null): Address | null => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null);

const checkedEthUsd = () => ethUsd({ maxStaleMs: MONEY_PRICE_MAX_AGE_MS, verify: true });

/// EURC on Arc mainnet (checked on chain: "EURC", 6 decimals) against USDC, the quote token.
const EURC_PAIR: PairTokens = { eth: { address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", decimals: 6n }, usdc: ARC_PAIR.usdc };

/// Pairs beyond a chain's first are real-money products of their own, so they are off unless named in
/// SELF_EXTRA_PAIRS (comma separated, for example "eurc").
const extraPairs = () => new Set((process.env.SELF_EXTRA_PAIRS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

function arcPairs(): PairSpec[] {
  const list: PairSpec[] = [
    { key: "weth", pair: ARC_PAIR, symbols: { base: "WETH", quote: "USDC", gas: "USDC" }, manager: addr(config.selfCustody.arcManager), stable: false, feeBps: null, spot: checkedEthUsd },
  ];
  if (extraPairs().has("eurc")) {
    list.push({ key: "eurc", pair: EURC_PAIR, symbols: { base: "EURC", quote: "USDC", gas: "USDC" }, manager: addr(process.env.SELF_MANAGER_ARC_EURC), stable: true, feeBps: 5, spot: eurcUsdc });
  }
  return list;
}

function sepoliaPairs(): PairSpec[] {
  return [
    {
      key: "meth",
      // Sepolia's token addresses are this backend's own (USDC_ADDRESS, METH_ADDRESS).
      pair: { eth: { address: config.aqua.methAddress, decimals: 18n }, usdc: { address: config.usdcAddress, decimals: 6n } },
      symbols: { base: "mETH", quote: "mUSDC", gas: "ETH" },
      manager: addr(config.selfCustody.sepoliaManager),
      stable: false,
      feeBps: null,
      spot: checkedEthUsd,
    },
  ];
}

function build(key: SelfNetKey, pairKey?: string): SelfNet {
  const arcNet = key === "arc";
  const pairs = arcNet ? arcPairs() : sepoliaPairs();
  const spec = pairKey ? pairs.find((p) => p.key === pairKey.toLowerCase()) : pairs[0];
  if (!spec) throw Object.assign(new Error(`unknown pair "${pairKey}" on ${key}`), { status: 404 });
  const d = arcNet ? resolveAquaDeployment(ARC_CHAIN_ID, {}) : null;
  const common = { pairKey: spec.key, pairKeys: pairs.map((p) => p.key), pair: spec.pair, symbols: spec.symbols, stable: spec.stable, feeBps: spec.feeBps, spot: spec.spot, manager: spec.manager };
  if (arcNet) {
    return {
      ...common,
      key: "arc",
      name: NETWORKS.arc.name,
      chainId: ARC_CHAIN_ID,
      chain: arc,
      rpcUrl: config.selfCustody.arcRpcUrl,
      minMaxFeePerGas: NETWORKS.arc.minMaxFeePerGas,
      minGasWei: 500_000_000_000_000_000n, // 0.5 USDC: Arc's native coin has 18 decimals
      aqua: addr(d?.aqua),
      router: addr(d?.router),
      enabled: config.selfCustody.arcEnabled && Boolean(d),
      disabledReason: "signing with your own wallet on Arc is not turned on",
    };
  }
  // Sepolia only works when this backend runs on Sepolia (its token addresses are this backend's own).
  const here = config.network.key === "sepolia";
  return {
    ...common,
    key: "sepolia",
    name: NETWORKS.sepolia.name,
    chainId: sepolia.id,
    chain: sepolia,
    rpcUrl: config.rpcUrl,
    minMaxFeePerGas: NETWORKS.sepolia.minMaxFeePerGas,
    minGasWei: 500_000_000_000_000n, // 0.0005 ETH
    aqua: addr(config.aqua.address),
    router: addr(config.aqua.router),
    enabled: config.selfCustody.sepoliaEnabled && here && config.aqua.deployed && Boolean(spec.pair.eth.address && spec.pair.usdc.address),
    disabledReason: "signing with your own wallet on Sepolia is not turned on",
  };
}

export const SELF_NET_KEYS: SelfNetKey[] = ["arc", "sepolia"];
export const isSelfNetKey = (k: string): k is SelfNetKey => (SELF_NET_KEYS as string[]).includes(k);

/// The chain for a route, specialised to `pairKey` (default: the chain's first pair); 404 if the chain or
/// pair is unknown or turned off.
export function selfNet(key: string, pairKey?: string): SelfNet {
  if (!isSelfNetKey(key)) throw Object.assign(new Error(`unknown network "${key}"`), { status: 404 });
  const net = build(key, pairKey);
  if (!net.enabled) throw Object.assign(new Error(net.disabledReason), { status: 404 });
  return net;
}

/// The same chain specialised to another of its pairs (a stored position's pair, say). A null or unknown
/// pair key is the chain's default pair.
export function withPair(net: SelfNet, pairKey: string | null | undefined): SelfNet {
  if (!pairKey || pairKey === net.pairKey) return net;
  return build(net.key, pairKey);
}

/// Whether self-custody is on for `key` (for the networks list; never throws).
export function selfNetEnabled(key: string): boolean {
  return isSelfNetKey(key) && build(key).enabled;
}

/// The pairs offered on a chain, with their names and whether a manager is deployed for each (never throws).
export function selfPairsInfo(key: string): Array<{ key: string; symbols: { base: string; quote: string }; stable: boolean; manager: boolean }> {
  if (!isSelfNetKey(key)) return [];
  const net = build(key);
  return net.pairKeys.map((k) => {
    const n = build(key, k);
    return { key: k, symbols: { base: n.symbols.base, quote: n.symbols.quote }, stable: n.stable, manager: n.manager !== null };
  });
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
