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
//   3. app.js polls GET /events while showing the account screen. Each
//      stacked note appears there immediately as "pending", with an estimated
//      USD amount, then flips to "confirmed" (or "failed") once the deposit
//      transaction is mined. The customer sees the note register within a
//      second instead of after a Sepolia block.
//
// In-memory only, single active session — matches this kiosk's single-user-
// at-a-time design (one box, one person standing in front of it).
let session = null; // { userId, ensName, balance }

// Event feed for the browser. Every change bumps `seq`, and the browser asks
// for everything newer than the last seq it saw, so an update to an event
// (pending -> confirmed) is delivered again under its new seq.
//   { seq, id, type: "deposit", status: "pending"|"confirmed"|"failed",
//     amount, currency, estUsd, usdAmount?, balance?, txHash?, error? }
//   { seq, id, type: "rejected", reason }
let events = [];
let seqCounter = 0;
let idCounter = 0;

function putEvent(event) {
  event.seq = ++seqCounter;
  events = events.filter((e) => e.id !== event.id);
  events.push(event);
  if (events.length > 50) events = events.slice(-50);
  return event;
}

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
  events = [];
  sendJson(res, 200, { ok: true });
}

async function handleSessionEnd(_req, res) {
  session = null;
  events = [];
  sendJson(res, 200, { ok: true });
}

// The serial listener polls this so it can refuse a note held in escrow
// when nobody is logged in, instead of taking cash it can't credit.
function handleSessionStatus(res) {
  sendJson(res, 200, { active: session !== null });
}

async function handleBillRejected(req, res) {
  const { reason } = await readJsonBody(req);
  sendJson(res, 200, putEvent({ id: `r${++idCounter}`, type: "rejected", reason: reason || "note not recognised" }));
}

function handleEvents(url, res) {
  const since = Number(url.searchParams.get("since") ?? 0);
  sendJson(res, 200, { events: events.filter((e) => e.seq > since) });
}

// Best-effort USD estimate for the pending event; the confirmed amount comes
// from the backend's /deposit response. A slow or failed rate lookup only
// means the pending line shows the ringgit amount without a USD estimate.
async function estimateUsd(amount, currency) {
  if (!currency || currency === "USD") return amount;
  try {
    const r = await fetch(`${BACKEND_URL}/fx?currency=${currency}`, { signal: AbortSignal.timeout(1500) });
    const { rate } = await r.json();
    return rate > 0 ? Math.round(amount * rate * 100) / 100 : null;
  } catch {
    return null;
  }
}

async function handlePulseDeposit(req, res) {
  const { amount, currency } = await readJsonBody(req);
  if (!(amount > 0)) return sendJson(res, 400, { error: "amount must be a positive number" });
  if (!session) return sendJson(res, 409, { error: "no active session — insert cash after verifying" });
  const { userId } = session;

  const event = putEvent({
    id: `d${++idCounter}`,
    type: "deposit",
    status: "pending",
    amount,
    currency: currency ?? "USD",
    estUsd: await estimateUsd(amount, currency),
  });

  let body;
  try {
    const backendRes = await fetch(`${BACKEND_URL}/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // currency is passed through so the backend converts ringgit to USD;
      // the pulse listener doesn't send one and stays on the backend's USD default.
      body: JSON.stringify({ userId, amount, currency: currency ?? undefined }),
    });
    body = await backendRes.json();
    if (!backendRes.ok) throw new Error(typeof body.error === "string" ? body.error : JSON.stringify(body.error));
  } catch (err) {
    const error = err instanceof Error ? err.message : "deposit failed";
    putEvent({ ...event, status: "failed", error });
    return sendJson(res, 502, { error });
  }

  if (session?.userId === userId) session.balance = body.balance;
  sendJson(res, 200, putEvent({ ...event, ...body, status: "confirmed" }));
}
// ---------------------------------------------------------------------------

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (req.method === "POST" && url.pathname === "/session") return await handleSessionStart(req, res);
    if (req.method === "GET" && url.pathname === "/session") return handleSessionStatus(res);
    if (req.method === "POST" && url.pathname === "/session/end") return await handleSessionEnd(req, res);
    if (req.method === "POST" && url.pathname === "/bill-rejected") return await handleBillRejected(req, res);
    if (req.method === "POST" && url.pathname === "/pulse-deposit") return await handlePulseDeposit(req, res);
    if (req.method === "GET" && url.pathname === "/events") return handleEvents(url, res);
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
