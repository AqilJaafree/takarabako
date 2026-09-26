// Publishes a kiosk's identity on ENS: <kioskId>.takarabako.eth, owned by the
// treasury, whose addr record is the kiosk's device key (the key that signs
// every note — device-agent/machine.js) and whose text records describe it.
//   npm run ens:kiosk -- <deviceAddress> [kioskId]
// or read the address from a running bridge:
//   npm run ens:kiosk -- http://10.42.0.225:8080 [kioskId]
import { config } from "../src/config.js";
import { issueName, kioskSubname, resolveName, textRecord } from "../src/ens.js";
import { treasuryAddress } from "../src/chain.js";

const [source, kioskIdArg] = process.argv.slice(2);
if (!source) throw new Error("usage: npm run ens:kiosk -- <deviceAddress | bridge URL> [kioskId]");
const device = source.startsWith("http") ? (await (await fetch(`${source.replace(/\/$/, "")}/device`)).json()).address : source;
if (!/^0x[0-9a-fA-F]{40}$/.test(device ?? "")) throw new Error(`no device address from ${source}`);
const kioskId = kioskIdArg ?? config.kioskId;
const name = kioskSubname(kioskId);

await issueName({
  name,
  owner: treasuryAddress!,
  transferable: false,
  addr: device,
  texts: {
    "takarabako.kind": "kiosk",
    "takarabako.kioskId": kioskId,
    "takarabako.tkcash": config.cashReceiptAddress,
    "takarabako.operator": treasuryAddress!,
    description: `Takarabako cash-in kiosk ${kioskId}. Every note it accepts is signed by the device key this name resolves to.`,
  },
});
const r = await resolveName(name);
console.log(`${name} → ${r?.address} ${r?.address?.toLowerCase() === device.toLowerCase() ? "✓ matches the device" : "✗"}`);
console.log(`takarabako.kind = ${await textRecord(name, "takarabako.kind")}`);
