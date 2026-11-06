import { pad, type Address, type Hex } from "viem";
import type { CashChainKey } from "./config.js";

/// Circle CCTP V2 on the testnets Takarabako bridges between. Addresses and
/// domains are from Circle's contract-addresses page
/// (developers.circle.com/cctp/references/contract-addresses): the same
/// TokenMessengerV2 and MessageTransmitterV2 are deployed at one address on
/// Ethereum Sepolia and Arc Testnet.

export const CCTP_TESTNET = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address,
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address,
} as const;

export const CCTP_DOMAIN: Partial<Record<CashChainKey, number>> = { sepolia: 0, "arc-testnet": 26 };

/// Hedera has no CCTP route, so only the chains above can bridge.
export const cctpSupported = (k: CashChainKey) => CCTP_DOMAIN[k] !== undefined;
export function cctpDomain(k: CashChainKey): number {
  const d = CCTP_DOMAIN[k];
  if (d === undefined) throw new Error(`${k} has no CCTP route`);
  return d;
}

/// Standard transfer (finality-based attestation): no fee, takes longer than Fast Transfer.
export const STANDARD_FINALITY = 2000;
export const NO_FEE = 0n;

/// An address as the bytes32 CCTP expects for the mint recipient.
export const addressToBytes32 = (a: string): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

export const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

/// What Circle's attestation service returns for a burn transaction
/// (GET /v2/messages/{sourceDomain}?transactionHash=...).
export type AttestationResult =
  | { ready: true; message: Hex; attestation: Hex }
  | { ready: false; reason: string };

export function parseAttestationResponse(body: unknown): AttestationResult {
  const messages = (body as { messages?: Array<{ status?: string; message?: string; attestation?: string }> } | null)?.messages;
  const m = messages?.[0];
  if (!m) return { ready: false, reason: "not indexed yet" };
  if (m.status !== "complete" || !m.attestation?.startsWith("0x") || !m.message?.startsWith("0x"))
    return { ready: false, reason: m.status ?? "pending" };
  return { ready: true, message: m.message as Hex, attestation: m.attestation as Hex };
}

export async function fetchAttestation(baseUrl: string, sourceDomain: number, burnTxHash: string): Promise<AttestationResult> {
  const res = await fetch(`${baseUrl}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`);
  if (res.status === 404) return { ready: false, reason: "not indexed yet" };
  if (!res.ok) throw new Error(`attestation service answered ${res.status}`);
  return parseAttestationResponse(await res.json());
}

/// Rough wait for the user: Standard transfers wait for source-chain finality, which is slow on Sepolia;
/// Shown as a rough estimate, never promised.
export function estimateMinutes(from: CashChainKey): number {
  return from === "sepolia" ? 20 : 5;
}
