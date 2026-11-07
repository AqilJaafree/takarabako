# JY-616 → ESP32-S3 → Pi 4 (simplest route)

The ESP32-S3 counts the coin pulses and tells the Pi over its USB cable. **No wire
goes to the Pi's GPIO pins**, so the 3.3V risk and the optocoupler's unexplained
9V output both drop out. The USB cable also powers the ESP32.

```text
12V charger ── splitter ── JY-616 red (DC12V)
                           JY-616 black (GND) ──┬── ESP32-S3 GND
                                                │
            JY-616 white (COIN) ── 10kΩ ────────┼── ESP32-S3 GPIO4
                                                │
ESP32-S3 USB-C ───────────── USB ──────────── Pi 4 USB port  (/dev/ttyACM0)
```

Only three wires touch the ESP32: black → GND, white → 10kΩ → GPIO4, and USB.
The optocoupler board is not used. JY-616 stays on NO + Slow.

## Why it works

From `jy616-coin-wiring.md`: the white wire floats at 0.14V when idle, which
fits an open-collector output that only pulls to the module's GND during a
pulse. The ESP32's internal pull-up supplies the high level (3.3V), so each coin
shows up as 1 falling edge per 10 sen. The 10kΩ resistor limits the current if
the white wire ever turns out to swing above 3.3V.

## Check before the first power-up (2 minutes)

1. 12V on, ESP32 **not** connected. Meter: black probe on JY-616 black, red probe
   on white. Drop a coin and watch the peak.
   - Stays at or under about 1V, or dips to 0V: open collector, go ahead.
   - Rises toward 12V on a pulse: **stop**, the output drives high. Put the
     optocoupler back in the path instead (`jy616-coin-wiring.md`).
2. Unplug the 12V, build the three wires, plug the ESP32 into the Pi, then the 12V.

## Flash the ESP32-S3

Arduino IDE, board `ESP32S3 Dev Module`, `USB CDC On Boot: Disabled` (the board's UART port), open
`device-agent/esp32/coin_counter/coin_counter.ino`, upload. Serial monitor at
115200 shows `READY`, then `COIN 1` for 10 sen, `COIN 2` for 20 sen, `COIN 5` for
50 sen (the coin-test flashes recorded earlier). Change `COIN_PIN` in the sketch if
GPIO4 is taken on your board.

## On the Pi

The coin counter is read by the same listener as the TB74, so one process
credits notes and coins and one login covers both.

```bash
cd device-agent
node server.js &                          # the bridge, as usual
python3 -u serial/bill_acceptor_serial.py # TB74 on /dev/serial0, coins on /dev/ttyACM0
```

Options: `--coin-dev` for another port, `--no-coins` to leave the counter out. If
the ESP32 is unplugged the listener keeps retrying and the note acceptor keeps
working.

Test without hardware: `--simulate`, then type `c50` for a 50 sen coin or `5` for
an RM5 note. A coin posts `{"amount": 0.5, "currency": "MYR"}` to
`/pulse-deposit`. With nobody logged in a coin can't be handed back, so it is only
logged.

## Known gaps

- `Math.round(d.denomination)` in `backend/src/cashReceipt.ts` turns RM0.50 into 1 and
  RM0.10 into 0 on the receipt.
- `cash()` in `frontend/lib/format.ts` would show `RM0.5`.
- Each coin is its own two-transaction deposit. Batching would need a wait window in
  the listener.
- Pulses per coin: 50 sen read as `COIN 5` on the Pi. One burst in five read `COIN 6`, so a debounce above 15 ms may be needed.
