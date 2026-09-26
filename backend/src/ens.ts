import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Address } from "viem";
import { config } from "./config.js";
import { chainReady, publicClient, sendTreasuryTx, sendTreasuryTxNoWait, waitForTx } from "./chain.js";
import { ENSV2, ONE_YEAR, ROLE_CAN_TRANSFER, dnsEncode, namehash, registryAbi, resolverAbi, universalResolverAbi } from "./ensV2.js";

/// Takarabako's names on the official ENS v2 deployment on Sepolia
/// (scripts/ens-setup.ts): `takarabako.eth` points at our own UserRegistry
/// (subnames are ERC-1155 tokens there) and our own PermissionedResolver
/// (records), so every name resolves through the official
/// UniversalResolverV2 like any other ENS name.
///
/// Three kinds of names:
///   customers  <label>.takarabako.eth        owned by the customer's own wallet, not
///                                            transferable (it's their identity);
///                                            addr → their wallet
///   positions  aqua-<id>.takarabako.eth      owned by the customer's wallet and
///                                            transferable: the name is the position's
///                                            deed — send it and the position follows
///   kiosks     <kioskId>.takarabako.eth      owned by the treasury; addr → the kiosk's
///                                            device key, which signs every note it takes

const registry = () => config.ens.registryAddress as Address;
const resolver = () => config.ens.resolverAddress as Address;
export const ensReady = chainReady && Boolean(config.ens.registryAddress && config.ens.resolverAddress);

/// A customer's label comes from their email: the local part, cleaned to
/// valid label characters, plus a short hash so alice@gmail.com and
/// alice@yahoo.com get different names.
export function deriveEnsLabel(email: string): string {
  const [localPart] = email.toLowerCase().split("@");
  const sanitized = (localPart ?? "user").replace(/[^a-z0-9-]/g, "").slice(0, 20) || "user";
  const disambiguator = keccak256(toBytes(email)).slice(2, 6);
  return `${sanitized}-${disambiguator}`;
}

export const fullName = (label: string) => `${label}.${config.ens.parentName}`;
export const walletSubname = fullName;
export const labelOf = (name: string) => name.slice(0, name.length - config.ens.parentName.length - 1);

export function positionSubname(positionId: string): string {
  return fullName(`aqua-${positionId.replace(/-/g, "").slice(0, 8)}`);
}

export function kioskSubname(kioskId: string): string {
  return fullName(kioskId.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
}

export interface IssueRequest {
  name: string; // full name under the parent
  owner: string;
  transferable: boolean;
  addr?: string; // address record (defaults to the owner)
  texts?: Record<string, string>;
}

/// Registers a subname (if it isn't already) and sets its records. The
/// registration and the records go out back to back; returns the register tx.
export async function issueName(req: IssueRequest): Promise<{ txHash: string | null; tokenId: bigint | null }> {
  if (!ensReady) {
    console.log(`[ens] not configured — not registering ${req.name}`);
    return { txHash: null, tokenId: null };
  }
  const label = labelOf(req.name);
  const existing = await ownerOfName(req.name);
  let txHash: `0x${string}` | null = null;
  if (!existing) {
    txHash = await sendTreasuryTxNoWait({
      to: registry(),
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "register",
        args: [label, req.owner as Address, "0x0000000000000000000000000000000000000000", resolver(), req.transferable ? ROLE_CAN_TRANSFER : 0n, expiry()],
      }),
    });
  }
  const node = namehash(req.name);
  const calls = [
    encodeFunctionData({ abi: resolverAbi, functionName: "setAddr", args: [node, (req.addr ?? req.owner) as Address] }),
    ...Object.entries(req.texts ?? {}).map(([k, v]) => encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, k, v] })),
  ];
  const recordsTx = await sendTreasuryTxNoWait({ to: resolver(), data: encodeFunctionData({ abi: resolverAbi, functionName: "multicall", args: [calls] }) });
  if (txHash) await waitForTx(txHash);
  await waitForTx(recordsTx);
  const tokenId = await tokenIdOf(req.name);
  console.log(`[ens] ${existing ? "updated" : "registered"} ${req.name} → ${req.owner}${req.transferable ? " (transferable)" : ""}`);
  return { txHash: txHash ?? recordsTx, tokenId };
}

/// Updates a name's records only (e.g. a position deed's addr after a transfer).
export async function setRecords(name: string, records: { addr?: string; texts?: Record<string, string> }) {
  const node = namehash(name);
  const calls = [
    ...(records.addr ? [encodeFunctionData({ abi: resolverAbi, functionName: "setAddr", args: [node, records.addr as Address] })] : []),
    ...Object.entries(records.texts ?? {}).map(([k, v]) => encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, k, v] })),
  ];
  if (!calls.length) return null;
  return sendTreasuryTx({ to: resolver(), data: encodeFunctionData({ abi: resolverAbi, functionName: "multicall", args: [calls] }) });
}

// Subnames can't outlive takarabako.eth (registered for a year); renew both together.
const expiry = () => BigInt(Math.floor(Date.now() / 1000)) + ONE_YEAR - 7n * 24n * 3600n;

export async function tokenIdOf(name: string): Promise<bigint | null> {
  if (!ensReady) return null;
  const id = await publicClient.readContract({ address: registry(), abi: registryAbi, functionName: "findTokenId", args: [labelOf(name)] }).catch(() => 0n);
  return id || null;
}

/// Who holds the name's ERC-1155 token right now (null if unregistered).
export async function ownerOfName(name: string): Promise<string | null> {
  const id = await tokenIdOf(name);
  if (!id) return null;
  const owner = await publicClient.readContract({ address: registry(), abi: registryAbi, functionName: "ownerOf", args: [id] }).catch(() => null);
  return owner && owner !== "0x0000000000000000000000000000000000000000" ? owner : null;
}

/// Resolves any ENS name to an address through the official UniversalResolverV2.
export async function resolveName(name: string): Promise<{ address: string; resolver: string } | null> {
  try {
    const [result, via] = await publicClient.readContract({
      address: ENSV2.universalResolver,
      abi: universalResolverAbi,
      functionName: "resolve",
      args: [dnsEncode(name), encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [namehash(name)] })],
    });
    const address = decodeFunctionResult({ abi: resolverAbi, functionName: "addr", data: result });
    return address === "0x0000000000000000000000000000000000000000" ? null : { address, resolver: via };
  } catch {
    return null; // no resolver / no record
  }
}

/// A text record, read through the official UniversalResolverV2.
export async function textRecord(name: string, key: string): Promise<string | null> {
  try {
    const [result] = await publicClient.readContract({
      address: ENSV2.universalResolver,
      abi: universalResolverAbi,
      functionName: "resolve",
      args: [dnsEncode(name), encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [namehash(name), key] })],
    });
    return decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: result }) || null;
  } catch {
    return null;
  }
}

/// Old callers: a customer's identity name, owned by their wallet.
export async function registerSubname(name: string, owner: string, opts: Partial<IssueRequest> = {}) {
  const { txHash } = await issueName({ name, owner, transferable: false, ...opts });
  return { txHash };
}
