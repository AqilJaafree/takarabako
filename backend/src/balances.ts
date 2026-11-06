import type { Address } from "viem";
import { config, type CashChainKey } from "./config.js";
import { chainOps, readyChains } from "./chain.js";

/// A customer's box is one account (the same vault address on every chain),
/// holding a USDC balance on each chain they've deposited on.

export interface ChainBalance {
  chain: CashChainKey;
  name: string;
  chainId: number;
  balance: number;
  apyBps: number;
}

export async function balancesByChain(boundAddress: string): Promise<ChainBalance[]> {
  return Promise.all(
    readyChains().map(async (chain) => {
      const ops = chainOps(chain);
      const [balance, apyBps] = await Promise.all([
        ops.previewValueOnChain(boundAddress as Address).catch(() => 0),
        ops.currentApyBpsOnChain().catch(() => 0),
      ]);
      const net = config.chains[chain].network;
      return { chain, name: net.name, chainId: net.chain.id, balance, apyBps };
    }),
  );
}

export const totalOf = (b: ChainBalance[]) => b.reduce((s, x) => s + x.balance, 0);

/// The total across chains (0 when no chain is configured).
export async function totalBalance(boundAddress: string): Promise<number> {
  return totalOf(await balancesByChain(boundAddress));
}
