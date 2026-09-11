# device-agent

The kiosk UI that runs on the Raspberry Pi 4 (PRD §7.1–§7.2). Zero build
step, zero dependencies — a static page (`public/`) served by a tiny Node
HTTP server, calling the backend directly over HTTP.

```
node server.js        # serves public/ on :8080
```

Point a browser (or the Pi's kiosk-mode Chromium) at `http://localhost:8080`.
The backend must be running separately (`../backend`) — see its README/`.env.example`.

## Current state (Phase 0–2 of the PRD build plan)

- The "insert cash" step is the **button fallback only** — build this first,
  per PRD §7.1: *"the entire on-chain + agent + ENS loop must demo perfectly
  without the validator."*
- The World ID step calls a **stub** `/verify` on the backend rather than a
  real World App Selfie Check — good enough to prove the loop; swap in real
  IDKit once World grants Selfie Check access (PRD §7.8, §13).

## Phase 4 (real hardware)

Replace the deposit button's `onclick` in `public/app.js` with a signal from
the actual bill acceptor:

- **Pulse protocol:** GPIO interrupt on the acceptor's pulse line, debounced,
  mapped pulse-count → denomination.
- **ccTalk/serial:** `pyserial`-based reader parsing the acceptor's serial
  frames — only attempt this if the pulse path is solid with time to spare.

Either path should call the same `/deposit` request the button already makes
— the UI and backend don't need to change, only what triggers the call.
