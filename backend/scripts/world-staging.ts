// Opens (or closes) World ID staging verification for our app, so proofs from
// the sandbox World App verify for the next 24 hours, and writes the token the
// Developer Portal issues into backend/.env (WORLD_STAGING_VERIFICATION_TOKEN).
//
//   cd backend && npm run world:staging            open a 24h window
//   cd backend && npm run world:staging -- off     close it
//
// Needs WORLD_TEAM_API_KEY (a Developer Portal team API key, api_…) and
// WORLD_APP_ID in backend/.env. Restart the backend afterwards.
import { readFileSync, writeFileSync } from "node:fs";

const MCP = "https://developer.world.org/api/mcp";
const TOOL = "set_world_id_staging_verification";
const apiKey = process.env.WORLD_TEAM_API_KEY ?? "";
const appId = process.env.WORLD_APP_ID ?? "";
const enabled = process.argv[2] !== "off";

if (!apiKey.startsWith("api_")) throw new Error("set WORLD_TEAM_API_KEY (api_…) in backend/.env — Developer Portal → Team → API keys");
if (!appId) throw new Error("WORLD_APP_ID is not set");

let sessionId: string | null = null;
let nextId = 1;

/// One JSON-RPC call to the portal's MCP server (plain JSON or an SSE stream).
async function rpc(method: string, params: unknown, notify = false) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${apiKey}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params }),
  });
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  if (notify) return null;
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((m) => m.id !== undefined)
    : JSON.parse(text);
  if (json?.error) throw new Error(`${method}: ${json.error.message}`);
  return json?.result;
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "takarabako", version: "1" } });
await rpc("notifications/initialized", {}, true);
const result = await rpc("tools/call", { name: TOOL, arguments: { app_id: appId, enabled } });

// The tool answers with text and/or structured content; the token is in there somewhere.
const blob = JSON.stringify(result);
if (result?.isError) throw new Error(`${TOOL} failed: ${blob}`);
console.log(`${TOOL}(${appId}, enabled=${enabled}):`);
for (const c of result?.content ?? []) if (c.type === "text") console.log(`  ${c.text.replace(/stg_[A-Za-z0-9_-]+/g, "stg_…")}`);

if (enabled) {
  const token =
    (result?.structuredContent?.staging_verification_token as string | undefined) ??
    (result?.structuredContent?.token as string | undefined) ??
    blob.match(/stg_[A-Za-z0-9_-]+/)?.[0] ??
    blob.match(/"(?:staging_verification_)?token"\s*:\s*"([^"]+)"/)?.[1];
  if (!token) throw new Error("the window opened but no token came back — see the output above");
  const envPath = new URL("../.env", import.meta.url);
  const env = readFileSync(envPath, "utf8");
  const line = `WORLD_STAGING_VERIFICATION_TOKEN=${token}`;
  writeFileSync(envPath, /^WORLD_STAGING_VERIFICATION_TOKEN=.*$/m.test(env) ? env.replace(/^WORLD_STAGING_VERIFICATION_TOKEN=.*$/m, line) : `${env.trimEnd()}\n${line}\n`);
  console.log(`\n✓ token saved to backend/.env (${token.slice(0, 8)}…). Restart the backend; the window lasts 24h.`);
}
