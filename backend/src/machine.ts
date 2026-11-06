import { keccak256, recoverTypedDataAddress, toBytes, type Hex } from "viem";
import { config } from "./config.js";
import { pool } from "./db.js";
import { getKiosk } from "./kiosks.js";

/// Verifiable kiosks. Each kiosk generates a signing key on its own device
/// (device-agent/machine.js) and an operator registers the key's public
/// address against the kiosk id (kiosks.ts, POST /ops/kiosks). The machine
/// signs every note it takes; a note is credited as "verified" only if the
/// signer recovered from the signature is the registered key of an active
/// kiosk, so a fake box, or a replayed signature, can't mint deposits.
/// MACHINE_SIGNATURE=required rejects unsigned deposits outright.

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
  | { verified: true; kiosk: string; signer: string; nonce: string; signature: string; chain: string }
  | { verified: false; reason: string; kiosk?: string };

const MAX_AGE_S = 10 * 60;

export function sessionHash(token: string): Hex {
  return keccak256(toBytes(token));
}

/// Checks a signed note against the deposit it claims to be and the registered kiosk.
export async function checkMachine(
  att: MachineAttestation | undefined,
  deposit: { amount: number; currency: string; token: string },
): Promise<MachineCheck> {
  if (!att) return { verified: false, reason: "unsigned" };
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

  const kiosk = await getKiosk(att.kiosk);
  if (!kiosk) return { verified: false, reason: "kiosk isn't registered", kiosk: att.kiosk };
  if (!kiosk.active) return { verified: false, reason: "kiosk is switched off", kiosk: kiosk.id };
  if (kiosk.signer.toLowerCase() !== signer.toLowerCase())
    return { verified: false, reason: "signed by a different device than the registered key", kiosk: kiosk.id };

  const { rowCount } = await pool.query("select 1 from deposits where machine_name = $1 and machine_nonce = $2", [kiosk.id, att.nonce]);
  if (rowCount) return { verified: false, reason: "replayed signature", kiosk: kiosk.id };
  return { verified: true, kiosk: kiosk.id, signer, nonce: att.nonce, signature: att.signature, chain: kiosk.chain };
}

export const machineSignatureRequired = () => config.machineSignature === "required";
