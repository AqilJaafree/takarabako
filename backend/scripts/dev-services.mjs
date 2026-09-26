// Runs Postgres and Redis as plain user processes, for machines where Docker
// isn't available (docker-compose.yml is the normal route). No root, no system
// services: everything lives in backend/.devservices/ — delete it to remove.
//
//   npm run services      (Ctrl-C stops both)
//
// Redis is built from source into .devservices/redis-7.2.7 (last BSD release):
//   curl -sL https://download.redis.io/releases/redis-7.2.7.tar.gz | tar xz -C .devservices
//   make -C .devservices/redis-7.2.7 BUILD_TLS=no MALLOC=libc
import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../.devservices/", import.meta.url));
const pgDir = `${root}pgdata`;
const redisDir = `${root}redisdata`;
const redisBin = `${root}redis-7.2.7/src/redis-server`;

// Same credentials and ports as docker-compose.yml, so DATABASE_URL and
// REDIS_URL in .env work unchanged either way.
const pg = new EmbeddedPostgres({
  databaseDir: pgDir,
  user: "takarabako",
  password: "takarabako",
  port: 5432,
  persistent: true,
  onLog: () => {},
});

const fresh = !existsSync(`${pgDir}/PG_VERSION`);
if (fresh) await pg.initialise();
await pg.start();
if (fresh) {
  await pg.createDatabase("takarabako");
  await pg.createDatabase("takarabako_test");
}
console.log("[services] postgres on :5432 (takarabako, takarabako_test)");

if (!existsSync(redisBin)) {
  console.error(`[services] redis not built — see the build steps at the top of ${fileURLToPath(import.meta.url)}`);
  await pg.stop();
  process.exit(1);
}
mkdirSync(redisDir, { recursive: true });
const redis = spawn(redisBin, ["--port", "6379", "--bind", "127.0.0.1", "--appendonly", "yes", "--dir", redisDir, "--save", ""], { stdio: "ignore" });
console.log("[services] redis on :6379 (append-only file in .devservices/redisdata)");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  redis.kill("SIGTERM");
  await pg.stop();
  console.log("[services] stopped");
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
redis.on("exit", (code) => {
  if (!stopping) console.error(`[services] redis exited (${code})`);
});
