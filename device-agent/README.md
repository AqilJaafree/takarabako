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
  `GET /events` (the browser polls this every 0.75s while on the account
  screen: each note appears as *pending* with an estimated USD amount as
  soon as it's stacked, then *confirmed* with the new balance once the
  deposit transaction is mined).

See the TB74-to-Pi-4 wiring guide (linked from project notes) for the
physical GPIO hookup.

### Serial mode (recommended)

With the TB74 switched to serial (4-position DIP block, switch 2 OFF), the
acceptor reports each note before it is stacked, and reports notes it
couldn't recognise. `serial/bill_acceptor_serial.py` replaces the pulse
listener:

- Talks ICT protocol on `/dev/serial0` at 9600 8E1 through the TB74's 8-pin
  3.3V header (GND → Pi pin 14, TX1 → 1kΩ → pin 10, RX1 ← 1kΩ ← pin 8).
- Accepts a note only while an account is logged in (`GET /session`),
  otherwise refuses it so the acceptor hands it back.
- Posts stacked notes to `POST /pulse-deposit` with `currency: "MYR"`, and
  unrecognised or refused notes to `POST /bill-rejected`, which shows up in
  the same `GET /events` feed so the kiosk tells the customer to try again.
- `--simulate` works without hardware: type a ringgit value, or `x` for a
  rejected note.

Pi setup: `enable_uart=1` and `dtoverlay=disable-bt` in
`/boot/firmware/config.txt`, and `console=serial0,...` removed from
`cmdline.txt`. The mini UART the Pi uses by default can't do parity.

Note codes on this unit (ICT Malaysia sheet): `40` RM1, `41` RM2, `42` RM5,
`43` RM10, `44` RM50, `45` RM100, `46` RM20.

The backend converts ringgit to USD before crediting the vault
(`backend/src/fx.ts`): the live rate from open.er-api.com, cached for an
hour, or a fixed `MYR_USD_RATE` from `backend/.env`. At 0.2449, RM10 credits
about 2.45 test USDC.
