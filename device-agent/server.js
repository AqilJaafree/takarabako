// Zero-dependency static server for the kiosk page — PRD §7.1/§7.2: the Pi
// drives a local browser kiosk page. This also carries the Phase 4 bridge
// between the real TB74 pulse bill acceptor (device-agent/gpio/bill_acceptor.py,
// which holds no backend credentials of its own) and the backend's real
// POST /deposit — see the "Bill acceptor bridge" section below.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deviceInfo, signNote } from "./machine.js";

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
// The browser holds the login session in its own JS state and has
// no way for a GPIO-triggered pulse count to reach it directly — the pulse
// listener is a separate OS process, not a click. So the kiosk's own local
// server holds the minimal state needed to bridge the two:
//
//   1. app.js POSTs the logged-in session here (its backend token, scope and
//      expiry) right after an email or wallet-QR login.
//   2. The bill listener POSTs each stacked note here; this server (not the
//      Python script) calls the backend's POST /deposit with the session's
//      bearer token — the listener never sees the token or talks to the
//      backend directly.
//   3. The backend queues each deposit and reports it on its live stream
//      (GET /events/stream): pending → confirmed | retrying | failed. This
//      server follows that stream for the logged-in session and mirrors it
//      into its own GET /events feed, which the old kiosk page polls. The new
//      Next.js kiosk reads the backend stream directly.
//
// In-memory only, single active session — matches this kiosk's single-user-
// at-a-time design (one box, one person standing in front of it).
let session = null; // { token, ensName, scope, expiresAt (ms) }

// A session the backend will still honour. Past expiresAt the serial
// listener must hand notes back rather than stack cash nobody is logged in for.
function sessionActive() {
  return session !== null && Date.now() < session.expiresAt;
}

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

// ---- Backend live stream -----------------------------------------------
let streamAbort = null;

function closeBackendStream() {
  streamAbort?.abort();
  streamAbort = null;
}

// Follows the backend's SSE stream for this session until closed, reconnecting
// after drops. Stops on 401 (session over).
function openBackendStream(token) {
  closeBackendStream();
  const ctrl = new AbortController();
  streamAbort = ctrl;
  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch(`${BACKEND_URL}/events/stream`, {
          headers: { authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        if (res.status === 401) return;
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, end);
            buf = buf.slice(end + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) onBackendEvent(JSON.parse(line.slice(6)));
            }
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}

// Mirrors a backend deposit event into this server's feed, keyed by depositId.
function onBackendEvent(e) {
  if (!e.depositId) return;
  const prev = events.find((x) => x.id === e.depositId) ?? {
    id: e.depositId,
    type: "deposit",
    amount: e.amount,
    currency: e.currency,
    estUsd: null,
  };
  if (e.type === "deposit.pending") {
    putEvent({ ...prev, status: "pending", amount: e.amount, currency: e.currency, estUsd: e.estUsd });
  } else if (e.type === "deposit.retrying") {
    putEvent({ ...prev, status: "pending", retry: { attempt: e.attempt, of: e.maxAttempts, error: e.error } });
  } else if (e.type === "deposit.confirmed") {
    putEvent({
      ...prev,
      status: "confirmed",
      usdAmount: e.usdAmount,
      fxRate: e.fxRate,
      txHash: e.txHash,
      balance: e.balance,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : undefined,
    });
  } else if (e.type === "deposit.failed") {
    putEvent({ ...prev, status: "failed", error: e.error });
  }
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
  const { token, ensName, scope, expiresAt } = await readJsonBody(req);
  if (!token || !(expiresAt > 0)) return sendJson(res, 400, { error: "token and expiresAt required" });
  session = { token, ensName: ensName ?? null, scope: scope ?? "deposit", expiresAt };
  events = [];
  openBackendStream(token);
  sendJson(res, 200, { ok: true });
}

async function handleSessionEnd(_req, res) {
  closeBackendStream();
  session = null;
  events = [];
  sendJson(res, 200, { ok: true });
}

// The serial listener polls this so it can refuse a note held in escrow
// when nobody is logged in, instead of taking cash it can't credit.
function handleSessionStatus(res) {
  sendJson(res, 200, { active: sessionActive() });
}

// The serial listener's reasons, as the backend's History codes.
const REFUSED_CODE = {
  "unknown note": "unsupported",
  "note not recognised": "bad_condition",
};

async function handleBillRejected(req, res) {
  const { reason } = await readJsonBody(req);
  const text = reason || "note not recognised";
  const code = REFUSED_CODE[text] ?? (text.startsWith("log in") ? "no_session" : "bad_condition");
  const event = putEvent({ id: `r${++idCounter}`, type: "rejected", reason: text, code });

  // Logged in: save it to the customer's History and push it to their
  // screens. With nobody logged in there's no account to record it against.
  if (sessionActive() && code !== "no_session") {
    fetch(`${BACKEND_URL}/refused`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ reason: code }),
    }).catch((err) => console.error("[bridge] could not report refused note:", err.message));
  }
  sendJson(res, 200, event);
}

function handleEvents(url, res) {
  const since = Number(url.searchParams.get("since") ?? 0);
  sendJson(res, 200, { events: events.filter((e) => e.seq > since) });
}

// The backend answers 202 as soon as the deposit is queued; its progress
// arrives on the live stream (onBackendEvent). The pending entry is also
// recorded here from the 202, in case the stream is momentarily down.
async function handlePulseDeposit(req, res) {
  const { amount, currency } = await readJsonBody(req);
  if (!(amount > 0)) return sendJson(res, 400, { error: "amount must be a positive number" });
  if (!sessionActive()) return sendJson(res, 409, { error: "no active session — log in before inserting cash" });
  const { token } = session;
  // This machine signs the note it just took; the backend checks the
  // signature against the kiosk's ENS name before crediting it.
  const machine = await signNote({ amount, currency: currency ?? "USD", token });

  let body;
  try {
    const backendRes = await fetch(`${BACKEND_URL}/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // currency is passed through so the backend converts ringgit to USD;
      // the pulse listener doesn't send one and stays on the backend's USD default.
      body: JSON.stringify({ amount, currency: currency ?? "USD", machine: machine ?? undefined }),
    });
    body = await backendRes.json();
    if (!backendRes.ok) throw new Error(typeof body.error === "string" ? body.error : JSON.stringify(body.error));
  } catch (err) {
    const error = err instanceof Error ? err.message : "deposit failed";
    putEvent({ id: `local${++idCounter}`, type: "deposit", status: "failed", amount, currency: currency ?? "USD", error });
    return sendJson(res, 502, { error });
  }

  // Each deposit slides the backend session forward; keep our copy in step.
  if (session?.token === token && body.expiresAt) session.expiresAt = Date.parse(body.expiresAt);
  if (!events.some((e) => e.id === body.depositId)) {
    putEvent({ id: body.depositId, type: "deposit", status: "pending", amount, currency: currency ?? "USD", estUsd: body.estUsd });
  }
  sendJson(res, 202, body);
}
// ---------------------------------------------------------------------------

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (req.method === "POST" && url.pathname === "/session") return await handleSessionStart(req, res);
    if (req.method === "GET" && url.pathname === "/session") return handleSessionStatus(res);
    if (req.method === "GET" && url.pathname === "/device") return sendJson(res, 200, await deviceInfo());
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
