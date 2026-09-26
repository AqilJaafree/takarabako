// The kiosk's device identity. A signing key generated on this machine the
// first time the bridge starts (kept in ~/.takarabako/device-key.json,
// readable only by this user) signs every note the bill acceptor takes. Its
// address is published as the addr record of the kiosk's ENS name (e.g.
// kl-sentral-01.takarabako.eth), so the backend — or anyone — can check that
// a deposit really came from this machine: resolve the name, recover the
// signer, compare.
//
// EIP-712, mirrored in backend/src/machine.ts:
//   NoteAccepted(string kiosk, string amount, string currency, bytes32 session, uint256 nonce, uint64 issuedAt)
// `session` is the keccak256 of the customer's session token, so a signature
// can't be replayed into someone else's session; `nonce` only ever goes up.
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const KEY_FILE = process.env.DEVICE_KEY_FILE || join(homedir(), ".takarabako", "device-key.json");
export const KIOSK_NAME = process.env.KIOSK_ENS_NAME || "kl-sentral-01.takarabako.eth";

export const DOMAIN = { name: "Takarabako Kiosk", version: "1", chainId: 11155111 };
export const TYPES = {
  NoteAccepted: [
    { name: "kiosk", type: "string" },
    { name: "amount", type: "string" },
    { name: "currency", type: "string" },
    { name: "session", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
  ],
};

let state = null; // { account, nonce, viem }

async function load() {
  if (state) return state;
  // viem is the only dependency; without it the bridge still runs, unsigned.
  const viem = await import("viem");
  const accounts = await import("viem/accounts");
  let stored;
  try {
    stored = JSON.parse(await readFile(KEY_FILE, "utf8"));
  } catch {
    stored = { privateKey: accounts.generatePrivateKey(), nonce: 0 };
    await mkdir(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    await writeFile(KEY_FILE, JSON.stringify(stored), { mode: 0o600 });
    console.log(`[machine] generated a device key at ${KEY_FILE}`);
  }
  await chmod(KEY_FILE, 0o600).catch(() => {});
  state = { account: accounts.privateKeyToAccount(stored.privateKey), nonce: stored.nonce ?? 0, privateKey: stored.privateKey, viem };
  return state;
}

/// The device address (for GET /device and the kiosk's ENS addr record).
export async function deviceInfo() {
  try {
    const s = await load();
    return { kiosk: KIOSK_NAME, address: s.account.address, nonce: s.nonce, signing: true };
  } catch (err) {
    return { kiosk: KIOSK_NAME, address: null, signing: false, error: err.message };
  }
}

/// Signs one accepted note. Returns null (unsigned) if signing isn't available.
export async function signNote({ amount, currency, token }) {
  let s;
  try {
    s = await load();
  } catch (err) {
    console.error("[machine] signing unavailable (npm install in device-agent?):", err.message);
    return null;
  }
  s.nonce += 1;
  await writeFile(KEY_FILE, JSON.stringify({ privateKey: s.privateKey, nonce: s.nonce }), { mode: 0o600 });
  const message = {
    kiosk: KIOSK_NAME,
    amount: String(amount),
    currency,
    session: s.viem.keccak256(s.viem.toBytes(token)),
    nonce: BigInt(s.nonce),
    issuedAt: BigInt(Math.floor(Date.now() / 1000)),
  };
  const signature = await s.account.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "NoteAccepted", message });
  return {
    kiosk: message.kiosk,
    amount: message.amount,
    currency,
    nonce: message.nonce.toString(),
    issuedAt: message.issuedAt.toString(),
    signature,
    device: s.account.address,
  };
}
