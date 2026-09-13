# device-agent

The kiosk UI that runs on the Raspberry Pi 4 (PRD §7.1–§7.2). Zero build
step, zero dependencies — a static page (`public/`) served by a tiny Node
HTTP server that also bridges the real bill acceptor into the backend (see
Phase 4 below).

```
node server.js        # serves public/ on :8080
```

Point a browser (or the Pi's kiosk-mode Chromium) at `http://localhost:8080`.
The backend must be running separately (`../backend`) — see its README/`.env.example`.

## Pointing the kiosk at a backend

`public/index.html` loads `config.js` before `app.js`, and `config.js` is
gitignored on purpose — copy `public/config.example.js` to `public/config.js`
and set `window.BACKEND_URL` for wherever this build is running:

- **Local dev / the Pi**, backend on the same machine or LAN: `http://localhost:4000`
  or `http://<laptop-LAN-IP>:4000`.
- **A public demo build** (e.g. deployed to Netlify): the deployed backend's
  URL (e.g. a Railway `*.up.railway.app` address).

Each deployment target gets its own `config.js` — that's why it isn't
committed. For a static-hosting deploy (Netlify), build a copy of `public/`
with the right `config.js` swapped in before uploading, rather than
overwriting the local dev one.

## Current state

- Full ATM-style flow (identify → deposit → risk-tiered yield → withdraw) is
  real end to end against the backend — see the repo root `DEPLOYMENTS.md`.
- "Insert cash" has two paths now: the on-screen fallback button, and a real
  hardware path (below) — both call the same backend `/deposit` flow.

## Phase 4 — real hardware (bill acceptor bridge)

`server.js` bridges a real TB74 pulse bill acceptor into the same deposit
flow as the fallback button, without the kiosk's own browser code needing to
know a physical device exists:

- `gpio/bill_acceptor.py` — runs on the Pi, debounces GPIO pulses into a
  settled amount (`--simulate` mode works without real hardware attached).
- `server.js` exposes `POST /session` (the browser registers the currently
  verified account here right after `/verify`), `POST /pulse-deposit` (the
  Python script posts a settled amount here; the server resolves the
  session's `userId` and calls the real backend `/deposit` — the Python
  script never sees `userId` or talks to the backend directly), and
  `GET /pulse-deposit/latest` (the browser polls this while on the account
  screen so a hardware deposit updates the balance live, no click needed).

See the TB74-to-Pi-4 wiring guide (linked from project notes) for the
physical GPIO hookup.
