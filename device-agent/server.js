// Zero-dependency static server for the kiosk page — PRD §7.1/§7.2: the Pi
// drives a local browser kiosk page. This also carries the Phase 4 bridge
// between the real TB74 pulse bill acceptor (device-agent/gpio/bill_acceptor.py,
// which holds no backend credentials of its own) and the backend's real
// POST /deposit — see the "Bill acceptor bridge" section below.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.KIOSK_PORT || 8080;
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

// ---- Bill acceptor bridge -------------------------------------------------
//
// The browser holds `userId` in its own JS state (set after /verify) and has
// no way for a GPIO-triggered pulse count to reach it directly — the pulse
// listener is a separate OS process, not a click. So the kiosk's own local
// server holds the minimal state needed to bridge the two:
//
//   1. app.js POSTs the verified session here right after /verify succeeds.
//   2. bill_acceptor.py POSTs a settled pulse-burst amount here; this server
//      (not the Python script) calls the real backend's POST /deposit using
//      the session's userId — the GPIO script never sees userId or talks to
//      the backend directly.
//   3. app.js polls for a new deposit while showing the account screen and
//      re-renders when one lands, the same way the fallback button already
//      updates the screen after its own POST /deposit.
//
// In-memory only, single active session — matches this kiosk's single-user-
// at-a-time design (one box, one person standing in front of it).
let session = null; // { userId, ensName, balance }
let lastPulseDeposit = null; // { ensName, boundAddress, balance, txHash, amount, ts }

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleSessionStart(req, res) {
  const { userId, ensName, balance } = await readJsonBody(req);
  if (!userId) return sendJson(res, 400, { error: "userId required" });
  session = { userId, ensName: ensName ?? null, balance: balance ?? 0 };
  lastPulseDeposit = null;
  sendJson(res, 200, { ok: true });
}

async function handleSessionEnd(_req, res) {
  session = null;
  lastPulseDeposit = null;
  sendJson(res, 200, { ok: true });
}

async function handlePulseDeposit(req, res) {
  const { amount } = await readJsonBody(req);
  if (!(amount > 0)) return sendJson(res, 400, { error: "amount must be a positive number" });
  if (!session) return sendJson(res, 409, { error: "no active session — insert cash after verifying" });

  const backendRes = await fetch(`${BACKEND_URL}/deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: session.userId, amount }),
  });
  const body = await backendRes.json();
  if (!backendRes.ok) return sendJson(res, backendRes.status, body);

  session.balance = body.balance;
  lastPulseDeposit = { ...body, amount, ts: Date.now() };
  sendJson(res, 200, lastPulseDeposit);
}

function handlePulseDepositLatest(url, res) {
  const since = Number(url.searchParams.get("since") ?? 0);
  if (lastPulseDeposit && lastPulseDeposit.ts > since) return sendJson(res, 200, lastPulseDeposit);
  sendJson(res, 200, {});
}
// ---------------------------------------------------------------------------

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (req.method === "POST" && url.pathname === "/session") return await handleSessionStart(req, res);
    if (req.method === "POST" && url.pathname === "/session/end") return await handleSessionEnd(req, res);
    if (req.method === "POST" && url.pathname === "/pulse-deposit") return await handlePulseDeposit(req, res);
    if (req.method === "GET" && url.pathname === "/pulse-deposit/latest") return handlePulseDepositLatest(url, res);
  } catch (err) {
    return sendJson(res, 502, { error: err instanceof Error ? err.message : "bridge error" });
  }

  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const filePath = join(PUBLIC_DIR, path);
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => {
  console.log(`kiosk page on :${PORT}, bridging pulses to backend at ${BACKEND_URL}`);
});
