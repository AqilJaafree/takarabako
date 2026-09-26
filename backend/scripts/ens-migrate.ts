// Re-issues existing names under the official-ENS parent (ens-setup.ts):
// each customer's identity name (owned by their own wallet) and a
// transferable deed name for every open Aqua position. Safe to re-run.
//   cd backend && npm run ens:migrate
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { deriveEnsLabel, issueName, positionSubname, resolveName, walletSubname } from "../src/ens.js";

const { rows: accounts } = await pool.query("select privy_user_id, email, privy_wallet, ens_name from accounts order by created_at");
for (const a of accounts) {
  const name = walletSubname(deriveEnsLabel(a.email));
  await issueName({ name, owner: a.privy_wallet, transferable: false, texts: { "takarabako.kind": "customer" } });
  if (a.ens_name !== name) await pool.query("update accounts set ens_name = $2 where privy_user_id = $1", [a.privy_user_id, name]);
  const r = await resolveName(name);
  console.log(`customer ${a.ens_name} → ${name}: resolves to ${r?.address ?? "nothing"} ${r?.address?.toLowerCase() === a.privy_wallet.toLowerCase() ? "✓" : "✗"}`);

  const { rows: positions } = await pool.query("select id, mode, shape from aqua_positions where privy_user_id = $1 and status = 'open'", [a.privy_user_id]);
  for (const p of positions) {
    const pname = positionSubname(p.id);
    await issueName({
      name: pname,
      owner: a.privy_wallet,
      transferable: true,
      texts: { "takarabako.kind": "aqua-position", "takarabako.position": p.id, "takarabako.strategy": `${p.mode}/${p.shape}` },
    });
    console.log(`  position ${p.id.slice(0, 8)} → ${pname}: resolves to ${(await resolveName(pname))?.address ?? "nothing"}`);
  }
}
console.log(`parent: ${config.ens.parentName}`);
await pool.end();
