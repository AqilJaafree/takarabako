// Registers (or rotates the key of) a kiosk so the backend accepts notes it signs.
//
//   npm run kiosk:register -- <kioskId> <deviceAddress> [sepolia|arc-testnet] [label]
//
// <deviceAddress> is the public address the kiosk reports (GET /device on the
// device agent, or the log line printed when it first generates its key).
import { isAddress } from "viem";
import { isCashChain } from "../src/config.js";
import { pool } from "../src/db.js";
import { registerKiosk } from "../src/kiosks.js";

const [id, signer, chain = "sepolia", ...label] = process.argv.slice(2);
if (!id || !signer || !isAddress(signer) || !isCashChain(chain)) {
  console.error("usage: npm run kiosk:register -- <kioskId> <deviceAddress> [sepolia|arc-testnet] [label]");
  process.exit(1);
}
const kiosk = await registerKiosk({ id, signer, chain, label: label.join(" ") || null });
console.log(`registered ${kiosk.id} on ${kiosk.chain}: signing key ${kiosk.signer}`);
await pool.end();
