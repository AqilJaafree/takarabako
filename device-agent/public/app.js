// Device agent kiosk UI — PRD §7.2. Talks to the backend over HTTPS/HTTP,
// holds no private keys and no Privy/agent credentials of its own.
// On the real Pi, point this at the backend's LAN address instead of localhost.
//
// ATM-style flow (PRD §6.1/§6.2): identify yourself first, then the machine
// knows which account any cash you insert gets credited to. Two ways in:
//   - email: full access (deposit, yield, withdraw) — also how you register
//   - wallet QR (emailed at registration): deposit only, no typing
// The backend enforces the difference; this page just follows the scope.
const BACKEND_URL = window.BACKEND_URL || "http://localhost:4000";

const screenEl = document.getElementById("screen");
const logEl = document.getElementById("log");

const state = {
  userId: null,
  token: null, // backend session token
  scope: null, // "full" (email login) | "deposit" (wallet-QR login)
  expiresAt: 0, // ms; the session slides forward on each deposit
  qrFallback: null, // QR image to show when the registration email couldn't be sent
  scanStream: null,
  ensName: null,
  balance: 0,
  position: null,
  lastEventSeq: 0,
  pending: {}, // bill-acceptor deposits stacked but not yet mined: id -> { amount, currency, estUsd }
  pulsePollTimer: null,
};

function log(msg) {
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.prepend(line);
}

async function api(path, body) {
  const headers = { "content-type": "application/json" };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(`${BACKEND_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  const json = await res.json();
  if (res.status === 401 && state.token) {
    log("session expired — please log in again");
    onDone();
  }
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : json.error ? JSON.stringify(json.error) : "request failed");
  return json;
}

// Adopt a session returned by /verify (full) or /login/qr (deposit).
function startSession(res) {
  Object.assign(state, {
    userId: res.userId,
    token: res.token,
    scope: res.scope,
    expiresAt: Date.parse(res.expiresAt),
    ensName: res.ensName,
    balance: res.balance,
  });
  registerSession();
  startPulsePolling();
  renderSession();
}

function renderSession() {
  if (state.scope === "deposit") screenDepositOnly();
  else screenAccount();
}

// Kiosk sessions are short. Once one lapses, go back to the start screen so
// the next person never lands in someone else's account.
setInterval(() => {
  if (state.token && Date.now() > state.expiresAt) {
    log("session timed out");
    onDone();
  }
}, 5000);

// GET /agent/pools — the real Uniswap v3 pool + asset each risk tier deposits
// into (PRD §7.6). Kicked off once at load so it's already resolved by the
// time the account screen needs it.
let poolsPromise = null;
function loadPools() {
  if (!poolsPromise) {
    poolsPromise = fetch(`${BACKEND_URL}/agent/pools`)
      .then((res) => res.json())
      .then((json) => json.pools)
      .catch(() => []);
  }
  return poolsPromise;
}
loadPools();

// Bill acceptor bridge (device-agent/server.js): polls its event feed while
// the account screen is up. A stacked note shows as pending within a poll
// (under a second), with an estimated USD amount; the balance updates when
// the deposit transaction is mined. Stopped on logout, receipt, or the yield
// page.
function moneyLabel(amount, currency) {
  return currency === "MYR" ? `RM${amount}` : `$${amount}`;
}

function onBridgeEvent(e) {
  if (e.type === "rejected") {
    log(`bill acceptor: note rejected (${e.reason}) — please try again`);
    return;
  }
  const cash = moneyLabel(e.amount, e.currency);
  if (e.status === "pending") {
    state.pending[e.id] = e;
    log(`bill acceptor: ${cash} received${e.estUsd != null ? ` → ≈$${e.estUsd}` : ""}, confirming on-chain…`);
  } else if (e.status === "confirmed") {
    delete state.pending[e.id];
    state.balance = e.balance;
    if (e.expiresAt) state.expiresAt = Date.parse(e.expiresAt);
    const usd = e.currency === "MYR" ? ` → $${e.usdAmount} (1 MYR = $${e.fxRate})` : "";
    log(`bill acceptor: ${cash}${usd} credited — tx ${e.txHash}`);
  } else if (e.status === "failed") {
    delete state.pending[e.id];
    log(`bill acceptor: ${cash} NOT credited (${e.error}) — please ask staff`);
  }
}

function startPulsePolling() {
  if (state.pulsePollTimer) return;
  state.pulsePollTimer = setInterval(async () => {
    try {
      // Same-origin call to device-agent/server.js itself (not BACKEND_URL) —
      // it holds the bridge state and already talks to the real backend.
      const res = await fetch(`/events?since=${state.lastEventSeq}`);
      const { events } = await res.json();
      if (!events.length) return;
      for (const e of events) {
        state.lastEventSeq = Math.max(state.lastEventSeq, e.seq);
        onBridgeEvent(e);
      }
      renderSession();
    } catch {
      // bridge or backend briefly unreachable — next poll retries
    }
  }, 750);
}

function stopPulsePolling() {
  if (state.pulsePollTimer) {
    clearInterval(state.pulsePollTimer);
    state.pulsePollTimer = null;
  }
}

// Hand the session to device-agent/server.js, so a note stacked later is
// deposited into this account (the bridge calls /deposit with the token).
// Fire-and-forget: if it fails, the listener refuses notes and hands them back.
function registerSession() {
  fetch("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: state.token, ensName: state.ensName, scope: state.scope, expiresAt: state.expiresAt }),
  }).catch(() => {});
}

function clearSession() {
  fetch("/session/end", { method: "POST" }).catch(() => {});
}

function render(html) {
  screenEl.innerHTML = html;
}

function screenAuth(message = "") {
  render(`
    <p class="sub">Enter your email to begin — like a card at an ATM.</p>
    <input type="email" id="email-input" placeholder="you@example.com" autofocus />
    <button class="primary" id="btn-verify">Continue</button>
    <p class="sub" id="verify-status">${message}</p>
    <div class="section-divider"></div>
    <p class="sub">Registered already? Show the QR from your welcome email to deposit cash.</p>
    <button id="btn-scan">Scan my QR to deposit</button>
  `);
  document.getElementById("btn-verify").onclick = onVerify;
  document.getElementById("btn-scan").onclick = screenScan;
  document.getElementById("email-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onVerify();
  });
}

// Wallet-QR quick login. Browsers only allow the camera on a secure page
// (https or localhost), so on the bench the kiosk is opened through a
// localhost tunnel to the Pi.
async function screenScan() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    screenAuth("Camera unavailable: open the kiosk via localhost, or log in with email.");
    return;
  }
  render(`
    <p class="section-label">Show your QR to the camera</p>
    <div class="scan-frame"><video id="scan-video" playsinline muted></video></div>
    <p class="sub" id="scan-status">Looking for a QR code…</p>
    <button id="btn-scan-cancel">Cancel</button>
  `);
  document.getElementById("btn-scan-cancel").onclick = () => {
    stopScan();
    screenAuth();
  };

  try {
    state.scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch (e) {
    screenAuth(`Camera unavailable (${e.name}) — log in with email instead.`);
    return;
  }
  const video = document.getElementById("scan-video");
  video.srcObject = state.scanStream;
  await video.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const tick = async () => {
    if (!state.scanStream) return; // cancelled
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      if (code?.data) {
        stopScan();
        await onLoginQr(code.data);
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopScan() {
  state.scanStream?.getTracks().forEach((t) => t.stop());
  state.scanStream = null;
}

async function onLoginQr(text) {
  try {
    const res = await api("/login/qr", { qr: text });
    log(`quick login — ${res.ensName} (deposit only)`);
    startSession(res);
  } catch (e) {
    log(`QR login failed: ${e.message}`);
    screenAuth(e.message);
  }
}

// Wallet-QR sessions can only deposit: no yield, no withdraw, no test button.
function screenDepositOnly() {
  render(`
    <div class="ens">${state.ensName}</div>
    <div class="balance">$${state.balance.toLocaleString()}</div>
    ${pendingHtml()}
    <p class="sub">Insert your cash now. Notes are credited to this account.</p>
    <p class="sub">To withdraw or earn yield, log in with your email.</p>
    <button class="primary" id="btn-done">Done — log out</button>
  `);
  document.getElementById("btn-done").onclick = onDone;
}

function formatRange(pool) {
  if (pool.fullRange) return "Full range (0 → ∞)";
  const fmt = (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `${fmt(pool.priceLowUsdc)} – ${fmt(pool.priceHighUsdc)}`;
}

function yieldOptionHtml(pool) {
  const pair = pool.pair.replace("/", " / ");
  const apy = (pool.apyBps / 100).toFixed(1);
  const fee = (pool.feeBps / 100).toFixed(2);
  return `
    <button class="yield-option risk-${pool.riskTier}" id="btn-${pool.riskTier}">
      <div class="yield-option-top">
        <span class="yield-tier">${pool.riskTier}</span>
        <span class="yield-pair">${pair}</span>
        <span class="yield-apy">${apy}% APY</span>
      </div>
      <div class="yield-option-bottom">
        <span>${fee}% fee</span>
        <span class="yield-range">${formatRange(pool)}</span>
      </div>
    </button>
  `;
}

// Dedicated yield page — its own screen (not a section bolted onto the
// account view), showing each real Uniswap v3 pool's fee tier and price
// range alongside the pair and APY, so the risk choice is fully informed.
async function screenYield() {
  const pools = await loadPools();
  render(`
    <button class="back-link" id="btn-yield-back">← Back to account</button>
    <p class="section-label">Get yield — real Uniswap v3 pools</p>
    <p class="sub">Every option below mints a real concentrated-liquidity position on Sepolia.</p>
    <div class="yield-list">
      ${pools.map(yieldOptionHtml).join("")}
    </div>
  `);
  document.getElementById("btn-yield-back").onclick = screenAccount;
  for (const pool of pools) {
    document.getElementById(`btn-${pool.riskTier}`).onclick = () => onOpenPosition(pool.riskTier);
  }
}

function pendingHtml() {
  const items = Object.values(state.pending);
  if (!items.length) return "";
  const est = items.reduce((sum, e) => sum + (e.estUsd ?? 0), 0);
  const cash = items.map((e) => moneyLabel(e.amount, e.currency)).join(" + ");
  return `<p class="sub pending">+ ≈$${est.toFixed(2)} confirming (${cash})</p>`;
}

function screenAccount() {
  const positionHtml = state.position
    ? `<p class="sub">Active: <span class="ens">${state.position.ensName}</span> — ${state.position.pair} @ ${(state.position.apyBps / 100).toFixed(1)}% APY</p>`
    : "";

  const canWithdraw = state.balance > 0 || !!state.position;

  const yieldHtml = state.balance > 0
    ? `<div class="section-divider"></div><button id="btn-get-yield">Get yield →</button>`
    : "";

  const qrHtml = state.qrFallback
    ? `<div class="qr-fallback">
         <p class="sub">We couldn't email your quick-deposit QR. Take a photo of it now:</p>
         <img src="${state.qrFallback}" alt="Your wallet QR" width="200" height="200" />
       </div>`
    : "";

  render(`
    <div class="ens">${state.ensName}</div>
    <div class="balance">$${state.balance.toLocaleString()}</div>
    ${pendingHtml()}
    ${positionHtml}
    <div class="row">
      <button class="primary" id="btn-deposit">Deposit</button>
      <button class="tx-withdraw" id="btn-withdraw-cash" ${canWithdraw ? "" : "disabled"}>Withdraw as cash</button>
      <button class="tx-withdraw" id="btn-withdraw-wallet" ${canWithdraw ? "" : "disabled"}>Withdraw to my wallet</button>
    </div>
    ${yieldHtml}
    ${qrHtml}
    <button id="btn-done">Done — log out</button>
  `);
  document.getElementById("btn-deposit").onclick = onDeposit;
  document.getElementById("btn-done").onclick = onDone;
  if (canWithdraw) {
    document.getElementById("btn-withdraw-cash").onclick = () => onWithdraw("cash");
    document.getElementById("btn-withdraw-wallet").onclick = () => onWithdraw("wallet");
  }
  if (state.balance > 0) document.getElementById("btn-get-yield").onclick = screenYield;
}

function screenReceipt(receipt) {
  render(`
    <p class="sub">Withdraw complete.</p>
    <div class="balance">${receipt.receipt}</div>
    <p class="sub">${receipt.destination === "wallet"
      ? "USDC sent to your own wallet on Sepolia."
      : "USDC settled to the dev/treasury wallet — cash payout is a redemption receipt in v1 (PRD §6.6)."}</p>
    <button class="primary" id="btn-reset">Done</button>
  `);
  document.getElementById("btn-reset").onclick = onDone;
}

function onDone() {
  stopScan();
  stopPulsePolling();
  clearSession();
  if (state.token) {
    // End the backend session too, so the token is useless once they walk away.
    fetch(`${BACKEND_URL}/logout`, { method: "POST", headers: { authorization: `Bearer ${state.token}` } }).catch(() => {});
  }
  Object.assign(state, {
    userId: null, token: null, scope: null, expiresAt: 0, qrFallback: null,
    ensName: null, balance: 0, position: null, lastEventSeq: 0, pending: {},
  });
  screenAuth();
}

async function onVerify() {
  const email = document.getElementById("email-input").value.trim();
  const statusEl = document.getElementById("verify-status");
  if (!email) {
    statusEl.textContent = "Enter an email first.";
    return;
  }
  statusEl.textContent = "Verifying…";
  try {
    const res = await api("/verify", { email });
    log(`verified — user ${res.userId}, ${res.ensName}`);
    if (res.fundingTxHash) log(`new wallet funded with 0.001 ETH — tx ${res.fundingTxHash}`);
    if (res.qrEmailed) log(`quick-deposit QR emailed to ${email}`);
    state.qrFallback = res.qrFallback;
    startSession(res);
  } catch (e) {
    log(`verify failed: ${e.message}`);
    statusEl.textContent = `Failed: ${e.message}`;
  }
}

async function onDeposit() {
  try {
    const res = await api("/deposit", { amount: 1000 });
    state.balance = res.balance;
    log(`deposit ok — ${res.ensName}, tx ${res.txHash}`);
    screenAccount();
  } catch (e) {
    log(`deposit failed: ${e.message}`);
  }
}

async function onOpenPosition(riskLevel) {
  try {
    const res = await api("/agent/open-position", {
      riskLevel,
      amount: state.balance,
    });
    state.position = res;
    log(`agent opened ${res.pair} — ${res.ensName}`);
    if (res.rationale) log(`agent: "${res.rationale}"`);
    screenAccount();
  } catch (e) {
    log(`open-position failed: ${e.message}`);
  }
}

async function onWithdraw(destination) {
  try {
    const res = await api("/withdraw", { destination });
    log(`withdraw ok — ${res.receipt}`);
    screenReceipt(res);
  } catch (e) {
    log(`withdraw failed: ${e.message}`);
  }
}

screenAuth();
