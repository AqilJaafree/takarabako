import { encodeFunctionData, namehash, parseAbi, toHex, type Address } from "viem";
import { packetToBytes } from "viem/ens";

/// The official ENS v2 deployment on Sepolia (ensdomains/contracts-v2,
/// deployments/sepolia-official-v1-20260525-r2) — the one the official
/// UniversalResolverV2 resolves through — plus the helpers our names need.
/// Addresses were read from that deployment and checked on-chain.
export const ENSV2 = {
  ethRegistrar: "0x8c2e866b439358c41ae05de9cbe8a00bfefaffca" as Address,
  ethRegistry: "0xdedb92913a25abe1f7bcdd85d8a344a43b398b67" as Address,
  verifiableFactory: "0xd2a632d8a8b67c2c4398c255cbd7af8dd7236198" as Address,
  userRegistryImpl: "0x0f99e7ea74903afcb7224d0354fd7428a6f92917" as Address,
  permissionedResolverImpl: "0xdce5205a553573ffd47629327dddf36186022ffa" as Address,
  universalResolver: "0x2f8a180604c42457cb56c7c4f708748ff1f91df1" as Address,
  mockUsdc: "0xba11ebdb3f9a2c5946d8629517f06364e53a2e10" as Address, // registration payment token (open mint)
};

export const registrarAbi = parseAbi([
  "function isAvailable(string label) view returns (bool)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) view returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function commitmentAt(bytes32 commitment) view returns (uint64)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)",
]);

/// PermissionedRegistry / UserRegistry (ERC-1155 names).
export const registryAbi = parseAbi([
  "function initialize(address rootAccount, uint256 roleBitmap)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function findTokenId(string label) view returns (uint256)",
  "function getTokenId(uint256 anyId) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function setSubregistry(uint256 anyId, address registry)",
  "function setResolver(uint256 anyId, address resolver)",
  "function roles(uint256 anyId, address account) view returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
]);

export const resolverAbi = parseAbi([
  "function initialize(address admin, uint256 roleBitmap)",
  "function setAddr(bytes32 node, address addr_)",
  "function setText(bytes32 node, string key, string value)",
  "function addr(bytes32 node) view returns (address)",
  "function text(bytes32 node, string key) view returns (string)",
  "function multicall(bytes[] calls) returns (bytes[])",
]);

export const universalResolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
  "function findResolver(bytes name) view returns (address, bytes32, uint256)",
]);

export const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "function verifyContract(address proxy, address expectedImplementation) view returns (bool)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);

// Role bitmaps (EnhancedAccessControl: one nybble per role, admin roles 128 bits up).
const nybbles = (from: number, to: number) => {
  let bits = 0n;
  for (let n = from; n <= to; n++) bits |= 1n << BigInt(n * 4);
  return bits;
};
/// Every registry role and its admin (RegistryRolesLib nybbles 0–9, 32–41) — for our own registry's root.
export const ALL_REGISTRY_ROLES = nybbles(0, 9) | nybbles(32, 41);
/// Every resolver role and its admin (PermissionedResolverLib nybbles 0–7, 32–39).
export const ALL_RESOLVER_ROLES = nybbles(0, 7) | nybbles(32, 39);

/// RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN — the owner may transfer the name token.
export const ROLE_CAN_TRANSFER = (1n << 28n) << 128n;

export const ONE_YEAR = 365n * 24n * 60n * 60n;

export function dnsEncode(name: string): `0x${string}` {
  return toHex(packetToBytes(name));
}

export { namehash, encodeFunctionData };
