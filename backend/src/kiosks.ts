import { pool } from "./db.js";

/// Registered kiosks (table `kiosks`). An operator registers the public address
/// of the key a kiosk generated on its own device (device-agent/machine.js);
/// the backend then accepts notes signed by that key.

export interface Kiosk {
  id: string;
  label: string | null;
  signer: string;
  chain: string;
  active: boolean;
}

const COLUMNS = "id, label, signer, chain, active";

export const normalizeKioskId = (id: string) => id.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");

export async function getKiosk(id: string): Promise<Kiosk | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from kiosks where id = $1`, [normalizeKioskId(id)]);
  return rows[0] ?? null;
}

export async function listKiosks(): Promise<Kiosk[]> {
  const { rows } = await pool.query(`select ${COLUMNS} from kiosks order by id`);
  return rows;
}

/// Registers a kiosk, or replaces its key and chain (key rotation).
export async function registerKiosk(k: { id: string; signer: string; label?: string | null; chain?: string }): Promise<Kiosk> {
  const { rows } = await pool.query(
    `insert into kiosks (id, label, signer, chain) values ($1, $2, $3, $4)
     on conflict (id) do update set signer = excluded.signer, label = coalesce(excluded.label, kiosks.label),
       chain = excluded.chain, active = true
     returning ${COLUMNS}`,
    [normalizeKioskId(k.id), k.label ?? null, k.signer.toLowerCase(), k.chain ?? "sepolia"],
  );
  return rows[0];
}

export async function setKioskActive(id: string, active: boolean): Promise<boolean> {
  const { rowCount } = await pool.query("update kiosks set active = $2 where id = $1", [normalizeKioskId(id), active]);
  return Boolean(rowCount);
}
