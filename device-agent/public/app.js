// Device agent kiosk UI — PRD §7.2. Talks to the backend over HTTPS/HTTP,
// holds no private keys and no Privy/agent credentials of its own.
// On the real Pi, point this at the backend's LAN address instead of localhost.
//
// ATM-style flow (PRD §6.1/§6.2): identify yourself first (email), then the
// machine knows which account any cash you insert gets credited to — not
// the other way around.
const BACKEND_URL = window.BACKEND_URL || "http://localhost:4000";

const screenEl = document.getElementById("screen");
const logEl = document.getElementById("log");

const state = {
  userId: null,
  ensName: null,
  balance: 0,
  position: null,
  lastPulseTs: 0,
  pulsePollTimer: null,
};

function log(msg) {
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.prepend(line);
}

async function api(path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : "request failed");
  return json;
}

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

// Bill acceptor bridge (device-agent/server.js): polls for a real pulse-
// triggered deposit landing while this screen is up, the same way the
// fallback button's own POST /deposit already updates the screen — just
// without a click. Runs only while an account screen showing a balance is
// visible; stopped on logout, receipt, or the yield page.
function startPulsePolling() {
  if (state.pulsePollTimer) return;
  state.pulsePollTimer = setInterval(async () => {
    try {
      // Same-origin call to device-agent/server.js itself (not BACKEND_URL) —
      // it holds the bridge state and already talks to the real backend.
      const res = await fetch(`/pulse-deposit/latest?since=${state.lastPulseTs}`);
      const deposit = await res.json();
      if (deposit.ts && deposit.ts > state.lastPulseTs) {
        state.lastPulseTs = deposit.ts;
        state.balance = deposit.balance;
        log(`bill acceptor: $${deposit.amount} accepted — tx ${deposit.txHash}`);
        screenAccount();
      }
    } catch {
      // bridge or backend briefly unreachable — next poll retries
    }
  }, 2000);
}

function stopPulsePolling() {
  if (state.pulsePollTimer) {
    clearInterval(state.pulsePollTimer);
    state.pulsePollTimer = null;
  }
}

// Tell device-agent/server.js which account is currently verified, so a
// pulse arriving later knows whose /deposit to call — fire-and-forget, since
// a transient failure here just means the fallback button still works.
function registerSession() {
  fetch("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: state.userId, ensName: state.ensName, balance: state.balance }),
  }).catch(() => {});
}

function clearSession() {
  fetch("/session/end", { method: "POST" }).catch(() => {});
}

function render(html) {
  screenEl.innerHTML = html;
}

function screenAuth() {
  render(`
    <p class="sub">Enter your email to begin — like a card at an ATM.</p>
    <input type="email" id="email-input" placeholder="you@example.com" autofocus />
    <button class="primary" id="btn-verify">Continue</button>
    <p class="sub" id="verify-status"></p>
  `);
  document.getElementById("btn-verify").onclick = onVerify;
  document.getElementById("email-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onVerify();
  });
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

function screenAccount() {
  const positionHtml = state.position
    ? `<p class="sub">Active: <span class="ens">${state.position.ensName}</span> — ${state.position.pair} @ ${(state.position.apyBps / 100).toFixed(1)}% APY</p>`
    : "";

  const canWithdraw = state.balance > 0 || !!state.position;

  const yieldHtml = state.balance > 0
    ? `<div class="section-divider"></div><button id="btn-get-yield">Get yield →</button>`
    : "";

  render(`
    <div class="ens">${state.ensName}</div>
    <div class="balance">$${state.balance.toLocaleString()}</div>
    ${positionHtml}
    <div class="row">
      <button class="primary" id="btn-deposit">Deposit</button>
      <button class="tx-withdraw" id="btn-withdraw" ${canWithdraw ? "" : "disabled"}>Withdraw</button>
    </div>
    ${yieldHtml}
    <button id="btn-done">Done — log out</button>
  `);
  document.getElementById("btn-deposit").onclick = onDeposit;
  document.getElementById("btn-done").onclick = onDone;
  if (canWithdraw) document.getElementById("btn-withdraw").onclick = onWithdraw;
  if (state.balance > 0) document.getElementById("btn-get-yield").onclick = screenYield;
}

function screenReceipt(receipt) {
  render(`
    <p class="sub">Withdraw complete.</p>
    <div class="balance">${receipt.receipt}</div>
    <p class="sub">USDC settled to the dev/treasury wallet — cash payout is a redemption receipt in v1 (PRD §6.6).</p>
    <button class="primary" id="btn-reset">Done</button>
  `);
  document.getElementById("btn-reset").onclick = onDone;
}

function onDone() {
  stopPulsePolling();
  clearSession();
  Object.assign(state, { userId: null, ensName: null, balance: 0, position: null, lastPulseTs: 0 });
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
    state.userId = res.userId;
    state.ensName = res.ensName;
    state.balance = res.balance;
    log(`verified — user ${res.userId}, ${res.ensName}`);
    if (res.fundingTxHash) log(`new wallet funded with 0.001 ETH — tx ${res.fundingTxHash}`);
    registerSession();
    startPulsePolling();
    screenAccount();
  } catch (e) {
    log(`verify failed: ${e.message}`);
    statusEl.textContent = `Failed: ${e.message}`;
  }
}

async function onDeposit() {
  try {
    const res = await api("/deposit", { userId: state.userId, amount: 1000 });
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
      userId: state.userId,
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

async function onWithdraw() {
  try {
    const res = await api("/withdraw", { userId: state.userId });
    log(`withdraw ok — ${res.receipt}`);
    screenReceipt(res);
  } catch (e) {
    log(`withdraw failed: ${e.message}`);
  }
}

screenAuth();
