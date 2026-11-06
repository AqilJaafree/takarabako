import type { ChainBalance } from "./types";

/// Yield runs on the chain 1inch Aqua is on, so it draws on that chain's box.
export const aquaBalance = (balances: ChainBalance[], chain: string | undefined): number =>
  (balances.find((b) => b.chain === (chain ?? "sepolia")) ?? balances[0])?.balance ?? 0;
