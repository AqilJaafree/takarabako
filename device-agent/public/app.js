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

function screenAccount() {
  const positionHtml = state.position
    ? `<p class="sub">Active: <span class="ens">${state.position.ensName}</span> — ${state.position.pair} @ ${(state.position.apyBps / 100).toFixed(1)}% APY</p>`
    : "";

  const canWithdraw = state.balance > 0 || !!state.position;

  const yieldHtml = state.balance > 0
    ? `
      <p class="sub">Get yield:</p>
      <div class="row">
        <button class="risk-low" id="btn-low">Low</button>
        <button class="risk-medium" id="btn-medium">Medium</button>
        <button class="risk-high" id="btn-high">High</button>
      </div>
    `
    : "";

  render(`
    <div class="ens">${state.ensName}</div>
    <div class="balance">$${state.balance.toLocaleString()}</div>
    ${positionHtml}
    <p class="sub">Transaction type — ⚠️ deposit is a fallback for "insert $1,000" until the bill acceptor is wired:</p>
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
  if (state.balance > 0) {
    document.getElementById("btn-low").onclick = () => onOpenPosition("low");
    document.getElementById("btn-medium").onclick = () => onOpenPosition("medium");
    document.getElementById("btn-high").onclick = () => onOpenPosition("high");
  }
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
  Object.assign(state, { userId: null, ensName: null, balance: 0, position: null });
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
