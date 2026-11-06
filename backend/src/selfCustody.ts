import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { aq, sv } from "./aquaSdk.js";
import { allocate, sqrtBounds, type Bin, type PairTokens } from "./aquaMath.js";
import { allowanceAction } from "./allowances.js";

/// Self-custody Aqua positions on Arc mainnet. The customer's own wallet is the
/// Aqua maker: it approves Aqua to pay trades out of its tokens and ships the
/// strategies itself, so the tokens never leave the wallet and the treasury is
/// not involved. This file only builds the transactions the customer signs;
/// nothing here sends anything.

export const ARC_CHAIN_ID = 5042;

/// USDC (6 decimals as an ERC-20) and WETH (18) on Arc mainnet, both checked on
/// chain: 0x3600…0000 is the system USDC token; 0x128c…4edb is "Wrapped Ether".
export const ARC_PAIR: PairTokens = {
  eth: { address: "0x128cc466b61f542da60c70e3aa11c10e19b84edb", decimals: 18n },
  usdc: { address: "0x3600000000000000000000000000000000000000", decimals: 6n },
};

export interface SelfStrategy {
  order: string; // the encoded SwapVM order (the Aqua strategy bytes)
  hash: string; // Aqua strategy hash
  min: number | null;
  max: number | null;
  weight: number;
  eth: string; // shipped amounts (raw)
  usdc: string;
}

export interface Step {
  to: Address;
  data: Hex;
  /// What the wallet's confirmation sheet says.
  description: string;
}

export interface Amounts {
  eth: bigint;
  usdc: bigint;
}

const erc20Abi = parseAbi(["function approve(address,uint256) returns (bool)"]);

/// A strategy owned by `maker`: the same programs the treasury ships
/// (aqua.ts buildOrder), for any maker and token pair.
export function buildSelfOrder(maker: Address, bin: { min: number; max: number } | null, feeBps: number, pair: PairTokens, salt?: bigint) {
  const strategy = bin
    ? (() => {
        const [sqrtPriceMin, sqrtPriceMax] = sqrtBounds(bin.min, bin.max, pair);
        return sv.AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin, sqrtPriceMax });
      })()
    : sv.AquaXYCAmmStrategy.new();
  // A random salt makes every strategy hash unique, even for identical ranges.
  const s = salt ?? BigInt(Math.floor(Math.random() * 2 ** 48)) * 65536n + BigInt(Date.now() % 65536);
  const program = strategy.withFeeTokenIn(feeBps).withSalt(s).build();
  return sv.Order.new({ maker: new sv.Address(maker), program, traits: sv.MakerTraits.default() });
}

export interface OpenInput {
  maker: Address;
  amountUsd: number;
  bins: Array<Bin | null>;
  feeBps: number;
  spot: number;
  pair: PairTokens;
  aqua: Address;
  router: Address;
  /// What Aqua may already pull from the maker's wallet, per token.
  allowance: Amounts;
  /// What the maker's other open strategies could already pay out.
  owed: Amounts;
}

const fmt = (v: bigint, decimals: bigint, digits: number) => (Number(v) / 10 ** Number(decimals)).toLocaleString("en-US", { maximumFractionDigits: digits });

/// The strategies for a position, each owned by `i.maker`, sized from the amount and split by weight.
function buildStrategies(i: Pick<OpenInput, "maker" | "amountUsd" | "bins" | "feeBps" | "spot" | "pair">): { strategies: SelfStrategy[]; need: Amounts } {
  const strategies: SelfStrategy[] = [];
  const need: Amounts = { eth: 0n, usdc: 0n };
  for (const bin of i.bins) {
    const usd = i.amountUsd * (bin?.weight ?? 1);
    if (usd < 0.01) continue;
    const { eth, usdc } = allocate(usd, bin, i.spot, i.pair);
    const encoded = buildSelfOrder(i.maker, bin, i.feeBps, i.pair).encode().toString();
    strategies.push({
      order: encoded,
      hash: aq.AquaProtocolContract.calculateStrategyHash(new aq.HexString(encoded)).toString(),
      min: bin?.min ?? null,
      max: bin?.max ?? null,
      weight: bin?.weight ?? 1,
      eth: eth.toString(),
      usdc: usdc.toString(),
    });
    need.eth += eth;
    need.usdc += usdc;
  }
  return { strategies, need };
}

/// The strategies for a new position and the transactions that open it: first
/// any approval Aqua is short of, then one ship per strategy. Aqua pulls the
/// token a swap pays out from the wallet, so its allowance has to cover what the
/// position (and the wallet's other positions) could pay out; an approval is
/// only asked for when the current one falls short, and then for twice the need
/// (allowances.ts), so ordinary growth does not need another signature.
export function planSelfOpen(i: OpenInput): { strategies: SelfStrategy[]; steps: Step[]; need: Amounts } {
  const { strategies, need } = buildStrategies(i);

  const steps: Step[] = [];
  for (const [symbol, token, current, total, decimals] of [
    ["WETH", i.pair.eth.address, i.allowance.eth, i.owed.eth + need.eth, i.pair.eth.decimals],
    ["USDC", i.pair.usdc.address, i.allowance.usdc, i.owed.usdc + need.usdc, i.pair.usdc.decimals],
  ] as Array<[string, string, bigint, bigint, bigint]>) {
    if (total === 0n) continue;
    const action = allowanceAction(current, total, false);
    if (action.kind === "set")
      steps.push({
        to: token as Address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [i.aqua, action.amount] }),
        description: `Let 1inch Aqua pay trades out of your ${symbol}, up to ${fmt(action.amount, decimals, symbol === "WETH" ? 6 : 2)}. Your ${symbol} stays in your wallet.`,
      });
  }
  const aquaContract = new aq.AquaProtocolContract(new aq.Address(i.aqua));
  for (const s of strategies) {
    const tx = aquaContract.ship({
      app: new aq.Address(i.router),
      strategy: new aq.HexString(s.order),
      amountsAndTokens: [
        { token: new aq.Address(i.pair.eth.address), amount: BigInt(s.eth) },
        { token: new aq.Address(i.pair.usdc.address), amount: BigInt(s.usdc) },
      ],
    });
    steps.push({
      to: tx.to.toString() as Address,
      data: tx.data.toString() as Hex,
      description:
        s.min === null || s.max === null
          ? "Open a full-range strategy on 1inch Aqua"
          : `Open a strategy on 1inch Aqua for ETH between $${Math.round(s.min).toLocaleString("en-US")} and $${Math.round(s.max).toLocaleString("en-US")}`,
    });
  }
  return { strategies, steps, need };
}

/// The transactions that close a position: one dock per strategy.
export function planSelfClose(strategies: Array<{ hash: string }>, pair: PairTokens, aqua: Address, router: Address): Step[] {
  const aquaContract = new aq.AquaProtocolContract(new aq.Address(aqua));
  return strategies.map((s, i) => {
    const tx = aquaContract.dock({
      app: new aq.Address(router),
      strategyHash: new aq.HexString(s.hash),
      tokens: [new aq.Address(pair.eth.address), new aq.Address(pair.usdc.address)],
    });
    return {
      to: tx.to.toString() as Address,
      data: tx.data.toString() as Hex,
      description: strategies.length > 1 ? `Close strategy ${i + 1} of ${strategies.length} on 1inch Aqua` : "Close your strategy on 1inch Aqua",
    };
  });
}

/// Whether `txs` are exactly the transactions that were prepared for `wallet`:
/// every step has one transaction with the same target and data, sent from the
/// wallet, and none is used twice or left over. This is what stops a customer's
/// record from vouching for transactions that were not prepared for them.
export function matchesPrepared(wallet: string, steps: Array<{ to: string; data: string }>, txs: Array<{ to: string | null | undefined; input: string; from: string }>): boolean {
  if (steps.length !== txs.length) return false;
  const used = new Set<number>();
  for (const s of steps) {
    const i = txs.findIndex(
      (t, k) => !used.has(k) && t.to?.toLowerCase() === s.to.toLowerCase() && t.input.toLowerCase() === s.data.toLowerCase() && t.from.toLowerCase() === wallet.toLowerCase(),
    );
    if (i < 0) return false;
    used.add(i);
  }
  return true;
}

// ---- through the position manager --------------------------------------------------------------
// On a chain that has an AquaPositionManager (contracts/src/AquaPositionManager.sol) the customer
// signs one `open` instead of an approval and a `ship` per strategy, and one `close` instead of a
// `dock` per strategy. The manager is the Aqua maker, so the strategies are built with it as the
// maker, and the tokens move into it when the position opens.

export const managerAbi = parseAbi([
  "function open(bytes[] strategies, uint256[] wethAmounts, uint256[] usdcAmounts) returns (uint256)",
  "function close(uint256 id)",
  "function positionOf(uint256 id) view returns (address owner, bool closed, bytes32[] hashes)",
  "event Opened(uint256 indexed id, address indexed owner, bytes32[] hashes, uint256 weth, uint256 usdc)",
]);

export interface ManagerOpenInput {
  /// The customer's wallet: it pays in and owns the position.
  wallet: Address;
  manager: Address;
  amountUsd: number;
  bins: Array<Bin | null>;
  feeBps: number;
  spot: number;
  pair: PairTokens;
  /// What the wallet has already approved the manager for, per token.
  allowance: Amounts;
  /// Token names for the wallet's confirmation sheet.
  symbols?: { base: string; quote: string };
}

/// The transactions that open a position through the manager: an approval for exactly what this
/// position takes, for each token the manager is short of, then one `open`. The approval is exact
/// (not padded) because the manager pulls the tokens once, at open.
export function planManagerOpen(i: ManagerOpenInput): { strategies: SelfStrategy[]; steps: Step[]; need: Amounts } {
  const { strategies, need } = buildStrategies({ maker: i.manager, amountUsd: i.amountUsd, bins: i.bins, feeBps: i.feeBps, spot: i.spot, pair: i.pair });
  const base = i.symbols?.base ?? "WETH";
  const quote = i.symbols?.quote ?? "USDC";
  const steps: Step[] = [];
  for (const [symbol, token, current, total, decimals] of [
    [base, i.pair.eth.address, i.allowance.eth, need.eth, i.pair.eth.decimals],
    [quote, i.pair.usdc.address, i.allowance.usdc, need.usdc, i.pair.usdc.decimals],
  ] as Array<[string, string, bigint, bigint, bigint]>) {
    if (total === 0n || current >= total) continue;
    steps.push({
      to: token as Address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [i.manager, total] }),
      description: `Let the Takarabako position contract take ${fmt(total, decimals, symbol === base ? 6 : 2)} ${symbol} from your wallet, for this position only.`,
    });
  }
  steps.push({
    to: i.manager,
    data: encodeFunctionData({
      abi: managerAbi,
      functionName: "open",
      args: [strategies.map((s) => s.order as Hex), strategies.map((s) => BigInt(s.eth)), strategies.map((s) => BigInt(s.usdc))],
    }),
    description: `Open your position (${strategies.length} ${strategies.length === 1 ? "strategy" : "strategies"}) on 1inch Aqua in one transaction`,
  });
  return { strategies, steps, need };
}

/// The one transaction that closes a manager position and returns everything it holds to the owner.
export function planManagerClose(manager: Address, positionId: bigint): Step[] {
  return [
    {
      to: manager,
      data: encodeFunctionData({ abi: managerAbi, functionName: "close", args: [positionId] }),
      description: "Close your position and send everything it holds back to your wallet",
    },
  ];
}
