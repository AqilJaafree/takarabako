process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://takarabako:takarabako@localhost:5432/takarabako_test";

export async function freshDb() {
  const { pool, migrate } = await import("../src/db.js");
  await migrate();
  await pool.query("truncate accounts, sessions, deposits cascade");
  return pool;
}
