import type { Chain } from "viem";
import { arc, arcTestnet, hederaTestnet } from "viem/chains";

export const ARC_CHAIN_ID = 5042;

/// viem ships Arc mainnet with no RPC URL and no block explorer. Privy reads both
/// from the chain it is given: an embedded wallet reaches the network through that
/// RPC, and when a customer's own wallet (MetaMask and others) does not know Arc,
/// Privy adds it with `wallet_addEthereumChain` using this name, currency, RPC
/// URL and explorer, which a wallet refuses without an RPC URL. NEXT_PUBLIC_ARC_RPC_URL
/// points it at a paid RPC; the public one is rate-limited.
export const ARC_MAINNET: Chain = {
  ...arc,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
};

/// Arc Testnet, with the RPC and explorer from Circle's contract docs (viem's own defaults point at
/// other hosts). Customers sign their tkCASH transfers here.
export const ARC_TESTNET: Chain = {
  ...arcTestnet,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" } },
};

/// "eip155:5042" (how Privy reports a wallet's chain) to 5042.
export function parseChainId(caip: string | undefined | null): number | null {
  const n = Number(String(caip ?? "").split(":").pop());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/// Hedera's EVM side (JSON-RPC relay). Gas is HBAR; customers sign tkCASH sends here too.
export const HEDERA_TESTNET: Chain = {
  ...hederaTestnet,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL || "https://testnet.hashio.io/api"] } },
};
