import { keccak256, recoverTypedDataAddress, toBytes, type Hex } from "viem";
import { config } from "./config.js";
import { pool } from "./db.js";
import { resolveName, textRecord } from "./ens.js";

/// Verifiable kiosks. Each kiosk has an ENS name (tokyo-01.takarabako.eth)
/// whose addr record is a signing key generated on the machine itself
/// (device-agent/machine.js). The machine signs every note it takes; a note
/// is credited as "verified" only if the signer recovered from the signature
/// is the address the kiosk's name resolves to through the official ENS v2
/// Universal Resolver — so a fake box, or a replayed signature, can't mint
/// deposits. MACHINE_SIGNATURE=required rejects unsigned deposits outright.

export const DOMAIN = { name: "Takarabako Kiosk", version: "1", chainId: 11155111 } as const;
export const TYPES = {
  NoteAccepted: [
    { name: "kiosk", type: "string" },
    { name: "amount", type: "string" },
    { name: "currency", type: "string" },
    { name: "session", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export interface MachineAttestation {
  kiosk: string;
  amount: string;
  currency: string;
  nonce: string;
  issuedAt: string;
  signature: string;
  device?: string;
}

export type MachineCheck =
  | { verified: true; kiosk: string; signer: string; nonce: string; signature: string }
  | { verified: false; reason: string; kiosk?: string };

const MAX_AGE_S = 10 * 60;
const nameCache = new Map<string, { at: number; address: string | null; isKiosk: boolean }>();

/// The kiosk's published device address, from ENS (cached 5 min).
export async function kioskAddress(kiosk: string): Promise<{ address: string | null; isKiosk: boolean }> {
  const hit = nameCache.get(kiosk);
  if (hit && Date.now() - hit.at < 300_000) return hit;
  const [resolved, kind] = await Promise.all([resolveName(kiosk), textRecord(kiosk, "takarabako.kind")]);
  const entry = { at: Date.now(), address: resolved?.address ?? null, isKiosk: kind === "kiosk" };
  nameCache.set(kiosk, entry);
  return entry;
}

/// Tests only: pretend ENS says `kiosk` resolves to `address`.
export function primeKioskForTest(kiosk: string, address: string | null, isKiosk = true) {
  nameCache.set(kiosk, { at: Date.now(), address, isKiosk });
}

export function sessionHash(token: string): Hex {
  return keccak256(toBytes(token));
}

/// Checks a signed note against the deposit it claims to be and the kiosk's ENS name.
export async function checkMachine(
  att: MachineAttestation | undefined,
  deposit: { amount: number; currency: string; token: string },
): Promise<MachineCheck> {
  if (!att) return { verified: false, reason: "unsigned" };
  if (!att.kiosk.endsWith(`.${config.ens.parentName}`)) return { verified: false, reason: "not a Takarabako kiosk name", kiosk: att.kiosk };
  if (Number(att.amount) !== deposit.amount || att.currency !== deposit.currency)
    return { verified: false, reason: "signed amount doesn't match the deposit", kiosk: att.kiosk };
  const age = Math.floor(Date.now() / 1000) - Number(att.issuedAt);
  if (!(age >= -60 && age <= MAX_AGE_S)) return { verified: false, reason: "signature too old", kiosk: att.kiosk };

  let signer: string;
  try {
    signer = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "NoteAccepted",
      message: {
        kiosk: att.kiosk,
        amount: att.amount,
        currency: att.currency,
        session: sessionHash(deposit.token),
        nonce: BigInt(att.nonce),
        issuedAt: BigInt(att.issuedAt),
      },
      signature: att.signature as Hex,
    });
  } catch {
    return { verified: false, reason: "bad signature", kiosk: att.kiosk };
  }

  const published = await kioskAddress(att.kiosk);
  if (!published.address) return { verified: false, reason: "kiosk name has no device address", kiosk: att.kiosk };
  if (!published.isKiosk) return { verified: false, reason: "name is not registered as a kiosk", kiosk: att.kiosk };
  if (published.address.toLowerCase() !== signer.toLowerCase())
    return { verified: false, reason: "signed by a different device than the kiosk's ENS name", kiosk: att.kiosk };

  const { rowCount } = await pool.query("select 1 from deposits where machine_name = $1 and machine_nonce = $2", [att.kiosk, att.nonce]);
  if (rowCount) return { verified: false, reason: "replayed signature", kiosk: att.kiosk };
  return { verified: true, kiosk: att.kiosk, signer, nonce: att.nonce, signature: att.signature };
}
