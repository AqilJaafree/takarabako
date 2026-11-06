// Shapes returned by the Express backend's GET /networks and
// GET /networks/:key/status (backend/src/routes/networkRoutes.ts).

export type NetworkKey = "sepolia" | "arc-testnet" | "hedera-testnet" | "arc";

export interface AquaDeployment {
  aqua: string;
  router: string;
  /// Where the addresses come from: the app's settings, the 1inch SDK, or the built-in Sepolia pair.
  origin: "env" | "sdk" | "sepolia";
}

export interface NetworkInfo {
  key: NetworkKey;
  name: string;
  chainId: number;
  nativeSymbol: string;
  explorerUrl: string;
  feeFloorGwei: number;
  usdc: string;
  baseToken: string;
  aqua: AquaDeployment | null;
  /// The one network this backend opens and closes real positions on.
  active: boolean;
  /// The customer can sign positions with their own wallet here.
  selfCustody?: boolean;
  /// A position manager contract is deployed here: one transaction opens a position and one closes it.
  selfManager?: boolean;
  /// The pairs offered here (a base token against USDC, the quote token every position exits to), the
  /// first being the default, and whether a position manager is deployed for each.
  selfPairs?: Array<{ key: string; symbols: { base: string; quote: string }; stable: boolean; manager: boolean }>;
}

export interface NetworksResponse {
  active: NetworkKey;
  networks: NetworkInfo[];
}

export interface ContractCheck {
  address: string;
  hasCode: boolean | null;
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
