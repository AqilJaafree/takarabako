// Block-explorer links for the chain the backend runs on. Set
// NEXT_PUBLIC_CHAIN to the same value as the backend's CHAIN; anything else
// (or nothing) means Ethereum Sepolia, which is what the app has always used.
// Explorer URLs are from https://docs.arc.io/arc/references/connect-to-arc.

const NETWORKS = {
  sepolia: { name: "Sepolia", url: "https://sepolia.etherscan.io", etherscan: true },
  "arc-testnet": { name: "Arc Testnet", url: "https://explorer.testnet.arc.io", etherscan: false },
  // HashScan pages are keyed by the EVM tx hash / address too (Hedera's EVM side).
  "hedera-testnet": { name: "Hedera Testnet", url: "https://hashscan.io/testnet", etherscan: false },
  arc: { name: "Arc", url: "https://explorer.arc.io", etherscan: false },
} as const;

type Key = keyof typeof NETWORKS;

export function resolveExplorer(chain: string | undefined) {
  return NETWORKS[(chain && chain in NETWORKS ? chain : "sepolia") as Key];
}

const net = resolveExplorer(process.env.NEXT_PUBLIC_CHAIN);

/// The chains Takarabako runs on at once. Hedera has no CCTP route, so only BRIDGE_CHAINS can bridge.
export type CashChain = "sepolia" | "arc-testnet" | "hedera-testnet";
export const CASH_CHAINS: readonly CashChain[] = ["sepolia", "arc-testnet", "hedera-testnet"];
export const BRIDGE_CHAINS: readonly CashChain[] = ["sepolia", "arc-testnet"];
export const chainName = (chain: string | undefined | null) => resolveExplorer(chain ?? undefined).name;
const pick = (chain?: string | null) => (chain ? resolveExplorer(chain) : net);

export const NETWORK_NAME = net.name;
/// Link to a transaction. Pass the chain a hash belongs to (default: the primary chain).
const isHashscan = (chain?: string | null) => pick(chain).url.includes("hashscan.io");
export const txUrl = (hash: string, chain?: string | null) => `${pick(chain).url}/${isHashscan(chain) ? "transaction" : "tx"}/${hash}`;
export const addressUrl = (address: string, chain?: string | null) => `${pick(chain).url}/${isHashscan(chain) ? "account" : "address"}/${address}`;
/// Etherscan has a token page; other explorers show tokens on the address page.
export const tokenUrl = (address: string, chain?: string | null) => {
  const n = pick(chain);
  return `${n.url}/${n.etherscan ? "token" : isHashscan(chain) ? "contract" : "address"}/${address}`;
};
