// Device agent kiosk UI — PRD §7.2. Talks to the backend over HTTPS/HTTP,
// holds no private keys and no World ID/agent credentials of its own.
// On the real Pi, point this at the backend's LAN address instead of localhost.
const BACKEND_URL = window.BACKEND_URL || "http://localhost:4000";

const screenEl = document.getElementById("screen");
const logEl = document.getElementById("log");

const state = {
  handle: "machina",
  ensName: null,
  balance: 0,
  nullifier: null,
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

function screenIdle() {
  render(`
    <p class="sub">No wallet yet — insert cash to begin.</p>
    <button class="primary" id="btn-deposit">⚠️ Fallback: insert ¥1,000</button>
  `);
  document.getElementById("btn-deposit").onclick = onDeposit;
}

function screenDeposited() {
  render(`
    <div class="ens">${state.ensName}</div>
    <div class="balance">¥${state.balance.toLocaleString()}</div>
    <p class="sub">Wallet created. Prove you're human to unlock it.</p>
    <div class="qr">World ID<br/>Selfie Check QR<br/>(Sandbox simulator)</div>
    <button class="primary" id="btn-verify">Simulate Selfie Check (Sandbox)</button>
  `);
  document.getElementById("btn-verify").onclick = onVerify;
}

function screenHandleWallet() {
  const positionHtml = state.position
    ? `<p class="sub">Active: <span class="ens">${state.position.ensName}</span> — ${state.position.pair} @ ${(state.position.apyBps / 100).toFixed(1)}% APY</p>`
    : `<p class="sub">Idle in wallet — no open position.</p>`;

  render(`
    <div class="ens">${state.ensName}</div>
    <div class="balance">¥${state.balance.toLocaleString()}</div>
    ${positionHtml}
    <p class="sub">Get yield:</p>
    <div class="row">
      <button class="risk-low" id="btn-low">Low</button>
      <button class="risk-medium" id="btn-medium">Medium</button>
      <button class="risk-high" id="btn-high">High</button>
    </div>
    <button id="btn-withdraw">Withdraw</button>
  `);
  document.getElementById("btn-low").onclick = () => onOpenPosition("low");
  document.getElementById("btn-medium").onclick = () => onOpenPosition("medium");
  document.getElementById("btn-high").onclick = () => onOpenPosition("high");
  document.getElementById("btn-withdraw").onclick = onWithdraw;
}

function screenReceipt(receipt) {
  render(`
    <p class="sub">Withdraw complete.</p>
    <div class="balance">${receipt.receipt}</div>
    <p class="sub">JPYC settled to the dev/treasury wallet — cash payout is a redemption receipt in v1 (PRD §6.6).</p>
    <button class="primary" id="btn-reset">New deposit</button>
  `);
  document.getElementById("btn-reset").onclick = () => {
    Object.assign(state, { ensName: null, balance: 0, nullifier: null, position: null });
    screenIdle();
  };
}

async function onDeposit() {
  try {
    const res = await api("/deposit", { amount: 1000, handle: state.handle });
    state.ensName = res.ensName;
    state.balance = res.balance;
    log(`deposit ok — ${res.ensName}, tx ${res.txHash}`);
    screenDeposited();
  } catch (e) {
    log(`deposit failed: ${e.message}`);
  }
}

async function onVerify() {
  try {
    const res = await api("/verify", {
      handle: state.handle,
      worldIdProof: {
        nullifier_hash: `0xdemo-${state.handle}`,
        merkle_root: "0xroot",
        proof: "0xproof",
        verification_level: "device",
      },
    });
    state.nullifier = res.nullifierHash;
    log(`verified — nullifier ${res.nullifierHash}`);
    screenHandleWallet();
  } catch (e) {
    log(`verify failed: ${e.message}`);
  }
}

async function onOpenPosition(riskLevel) {
  try {
    const res = await api("/agent/open-position", {
      nullifier: state.nullifier,
      riskLevel,
      amount: state.balance,
    });
    state.position = res;
    log(`agent opened ${res.pair} — ${res.ensName}`);
    screenHandleWallet();
  } catch (e) {
    log(`open-position failed: ${e.message}`);
  }
}

async function onWithdraw() {
  try {
    const res = await api("/withdraw", { nullifier: state.nullifier });
    log(`withdraw ok — ${res.receipt}`);
    screenReceipt(res);
  } catch (e) {
    log(`withdraw failed: ${e.message}`);
  }
}

screenIdle();
