import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { config } from "./config.js";

/// Postgres holds accounts, sessions and deposits (spec 2026-09-26), so a
/// backend restart no longer forgets who is registered or logged in.
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function migrate() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is not set — see backend/.env.example");
  // Every migration is idempotent (if not exists / if exists), so all of
  // them run in filename order at each startup.
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await pool.query(await readFile(new URL(file, dir), "utf8"));
  }
}
