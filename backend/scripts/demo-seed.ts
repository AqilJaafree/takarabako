// Fills a LOCAL demo (two anvil chains, see README) with a few customers, cash-ins on both
// chains, a registered kiosk per chain and a counted reserve, so /ops has something to show.
//   npm run demo:seed
import { pool, migrate } from "../src/db.js";
import { chainOps } from "../src/chain.js";
import { allowlist, recordCashIn } from "../src/cashReceipt.js";
import { attestReserve } from "../src/treasury.js";
import { registerKiosk } from "../src/kiosks.js";
import { deriveLabel } from "../src/labels.js";
import { deriveBoundAddress } from "../src/store.js";
import { indexChainOnce } from "../src/logIndexer.js";
import { config } from "../src/config.js";

await migrate();
await registerKiosk({ id: "tokyo-01", signer: "0x00000000000000000000000000000000000000a1", chain: "sepolia", label: "ETHTokyo" });
await registerKiosk({ id: "hedera-01", signer: "0x00000000000000000000000000000000000000a3", chain: "hedera-testnet", label: "Hedera demo kiosk" });
await registerKiosk({ id: "arc-01", signer: "0x00000000000000000000000000000000000000a2", chain: "arc-testnet", label: "Arc demo kiosk" });
const mail = (n: string) => `${n}${String.fromCharCode(64)}example.com`;

const kioskFor = (c: string) => (c === "sepolia" ? "tokyo-01" : c === "arc-testnet" ? "arc-01" : "hedera-01");
const people = [
  { id: "demo-alice", name: "alice", wallet: "0x000000000000000000000000000000000000d001", cash: [{ chain: "sepolia" as const, usd: 120 }, { chain: "arc-testnet" as const, usd: 60 }] },
  { id: "demo-bob", name: "bob", wallet: "0x000000000000000000000000000000000000d002", cash: [{ chain: "arc-testnet" as const, usd: 200 }, { chain: "hedera-testnet" as const, usd: 35 }] },
  { id: "demo-chen", name: "chen", wallet: "0x000000000000000000000000000000000000d003", cash: [{ chain: "sepolia" as const, usd: 45 }, { chain: "hedera-testnet" as const, usd: 80 }] },
];
for (const c of config.enabledChains) await chainOps(c).ensureVaultApproval();
for (const p of people) {
  const bound = deriveBoundAddress(p.id);
  await pool.query(
    "insert into accounts (privy_user_id, email, privy_wallet, bound_address, label) values ($1, $2, $3, $4, $5) on conflict do nothing",
    [p.id, mail(p.name), p.wallet, bound, deriveLabel(mail(p.name))],
  );
  for (const c of p.cash) {
    const id = crypto.randomUUID();
    await allowlist(p.wallet, c.chain);
    await chainOps(c.chain).depositOnChain(bound as `0x${string}`, c.usd);
    await pool.query("insert into deposits (id, privy_user_id, currency, amount, usd_amount, status, chain, machine_name) values ($1, $2, 'USD', $3, $3, 'confirmed', $4, $5)", [id, p.id, c.usd, c.chain, kioskFor(c.chain)]);
    await recordCashIn({ depositId: id, wallet: p.wallet, usdAmount: c.usd, denomination: 20, currency: "USD", chain: c.chain, kioskId: kioskFor(c.chain) });
  }
}
// A counted reserve on Sepolia (matches the chain).
await attestReserve("tokyo-01", 165, "demo-count", "sepolia").catch((e) => console.log("count skipped:", e.message));
for (const c of config.enabledChains) console.log(c, "indexed", await indexChainOnce(c), "events");
console.log("seeded");
await pool.end();
