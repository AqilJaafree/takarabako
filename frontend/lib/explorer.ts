// Block-explorer links for the chain the backend runs on. Set
// NEXT_PUBLIC_CHAIN to the same value as the backend's CHAIN; anything else
// (or nothing) means Ethereum Sepolia, which is what the app has always used.
// Explorer URLs are from https://docs.arc.io/arc/references/connect-to-arc.

const NETWORKS = {
  sepolia: { name: "Sepolia", url: "https://sepolia.etherscan.io", etherscan: true },
  "arc-testnet": { name: "Arc Testnet", url: "https://explorer.testnet.arc.io", etherscan: false },
  arc: { name: "Arc", url: "https://explorer.arc.io", etherscan: false },
} as const;

type Key = keyof typeof NETWORKS;

export function resolveExplorer(chain: string | undefined) {
  return NETWORKS[(chain && chain in NETWORKS ? chain : "sepolia") as Key];
}

const net = resolveExplorer(process.env.NEXT_PUBLIC_CHAIN);

/// The two chains Takarabako runs on at once.
export type CashChain = "sepolia" | "arc-testnet";
export const CASH_CHAINS: readonly CashChain[] = ["sepolia", "arc-testnet"];
export const chainName = (chain: string | undefined | null) => resolveExplorer(chain ?? undefined).name;
const pick = (chain?: string | null) => (chain ? resolveExplorer(chain) : net);

export const NETWORK_NAME = net.name;
/// Link to a transaction. Pass the chain a hash belongs to (default: the primary chain).
export const txUrl = (hash: string, chain?: string | null) => `${pick(chain).url}/tx/${hash}`;
export const addressUrl = (address: string, chain?: string | null) => `${pick(chain).url}/address/${address}`;
/// Etherscan has a token page; other explorers show tokens on the address page.
export const tokenUrl = (address: string, chain?: string | null) => {
  const n = pick(chain);
  return `${n.url}/${n.etherscan ? "token" : "address"}/${address}`;
};
