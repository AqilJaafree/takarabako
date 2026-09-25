#!/usr/bin/env python3
"""TB74 bill acceptor listener over ICT serial, for the Takarabako kiosk.

Replaces the pulse listener (device-agent/gpio/bill_acceptor.py) when the
acceptor is switched to serial mode. Unlike pulses, serial tells the Pi
which note is in the acceptor *before* it is stacked, lets the Pi accept or
refuse it, and reports notes the acceptor could not recognise.

Hardware (see the "TB74 Serial Hookup" guide for photos):
  - TB74 4-position DIP block (next to the TB74A1125 label): switch 2 OFF
    selects RS232/serial protocol; switch 3 OFF keeps the harness enabled.
  - 8-pin serial header, 3.3V TTL, 9600 baud 8E1:
      GND -> Pi pin 14
      TX1 -> 1k -> Pi pin 10 (GPIO15 / RXD)
      RX1 <- 1k <- Pi pin 8  (GPIO14 / TXD)
  - Pi: enable_uart=1 and dtoverlay=disable-bt in /boot/firmware/config.txt,
    serial console removed from cmdline.txt. /dev/serial0 -> ttyAMA0 (the
    full UART; the mini UART cannot do parity).

Protocol, as observed on this unit (TB74A1125, config 10MY6009):
  acceptor -> Pi                    Pi -> acceptor
  80 8F   powered up                02  enable
  2F 29 2F  note entering, checking
  81 nn   note recognised, held     02  accept / 0F  refuse
  10      note stacked (final)
  2F 29 2F with no 81 after it  ->  note not recognised, pushed back out

Note codes (ICT Malaysia sheet; 40 and 43 confirmed on the unit):
  40 RM1, 41 RM2, 42 RM5, 43 RM10, 44 RM50, 45 RM100, 46 RM20

Like the pulse listener, this script holds no backend credentials and never
calls the backend. It asks device-agent/server.js whether an account is
logged in, and posts accepted amounts and rejections back to it.

Run on the Pi:
    python3 bill_acceptor_serial.py

Run without hardware, to test the bridge/backend path end to end:
    python3 bill_acceptor_serial.py --simulate
    (type a ringgit value such as 10 to simulate that note being stacked,
    or x to simulate a note the acceptor could not recognise)
"""
import argparse
import json
import os
import select
import sys
import termios
import threading
import time
import urllib.error
import urllib.request

SERIAL_DEV = "/dev/serial0"

# ICT protocol bytes.
POWER_UP = 0x80
POWER_UP_2 = 0x8F
NOTE_HELD = 0x81
STACKED = 0x10
CHECKING = 0x29
STATUS_END = 0x2F
ENABLE = 0x02
ACCEPT = 0x02
REFUSE = 0x0F

NOTE_VALUES_MYR = {0x40: 1, 0x41: 2, 0x42: 5, 0x43: 10, 0x44: 50, 0x45: 100, 0x46: 20}

# A 29 followed by 81 is a note being accepted. A 29 with no 81 within this
# window is a note the acceptor pushed back out. Observed gap on the unit is
# about 1.7s, so 3.5s leaves margin without delaying the kiosk message much.
REJECT_WINDOW_S = 3.5

# After the Pi refuses a note (0F), the acceptor reports 29 again while it
# hands the note back. That isn't a second rejection, so 29 is ignored for
# this long after a refusal.
AFTER_REFUSE_QUIET_S = 6.0

DEPOSIT_TIMEOUT_S = 120

# How often the logged-in state is refreshed from the bridge. The acceptor
# holds a note while it waits for 02/0F, so the answer must be ready
# instantly rather than fetched after 81 arrives.
SESSION_POLL_S = 1.0


def log(msg):
    print(f"[bill-acceptor] {msg}", flush=True)


class Bridge:
    """Talks to device-agent/server.js on this machine."""

    def __init__(self, url):
        self.url = url
        self.session_active = False

    def _request(self, method, path, body=None, timeout=5):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.url}{path}",
            data=data,
            headers={"content-type": "application/json"},
            method=method,
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"{}")

    def poll_session_forever(self):
        while True:
            try:
                self.session_active = bool(self._request("GET", "/session").get("active"))
            except Exception:
                # Bridge down: refuse notes rather than take cash nobody can be credited for.
                self.session_active = False
            time.sleep(SESSION_POLL_S)

    def deposit(self, amount):
        # The bridge answers only after the deposit is mined, and deposits
        # queue behind each other, so allow well over one Sepolia block per note.
        try:
            body = self._request("POST", "/pulse-deposit", {"amount": amount, "currency": "MYR"}, timeout=DEPOSIT_TIMEOUT_S)
            log(f"RM{amount} credited: tx {body.get('txHash')} balance {body.get('balance')}")
        except urllib.error.HTTPError as e:
            log(f"RM{amount} NOT CREDITED, note is in the box ({e.code}): {e.read().decode(errors='replace')}")
        except Exception as e:
            log(f"RM{amount} credit unconfirmed, note is in the box: {e}")

    def rejected(self, reason):
        try:
            self._request("POST", "/bill-rejected", {"reason": reason})
        except Exception as e:
            log(f"could not report rejection: {e}")


def open_serial(dev):
    fd = os.open(dev, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    attrs[0] = 0  # iflag
    attrs[1] = 0  # oflag
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL | termios.PARENB  # 8E1
    attrs[3] = 0  # lflag: raw
    attrs[4] = attrs[5] = termios.B9600
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


class Acceptor:
    """ICT protocol state machine: one byte in at a time."""

    def __init__(self, fd, bridge):
        self.fd = fd
        self.bridge = bridge
        self.prev = None
        self.held_value = None      # RM value of the note accepted and waiting to stack
        self.checking_since = None  # time of the last 29 not yet followed by 81
        self.quiet_until = 0.0      # ignore 29 until then (note being handed back after a refusal)

    def send(self, byte):
        os.write(self.fd, bytes([byte]))

    def refuse(self, reason):
        self.send(REFUSE)
        self.quiet_until = time.monotonic() + AFTER_REFUSE_QUIET_S
        self.bridge.rejected(reason)

    def on_byte(self, b):
        now = time.monotonic()

        if self.prev == POWER_UP and b == POWER_UP_2:
            log("acceptor powered up -> enabling")
            self.send(ENABLE)

        elif self.prev == NOTE_HELD:
            self.checking_since = None
            value = NOTE_VALUES_MYR.get(b)
            if value is None:
                log(f"unknown note code 0x{b:02X} -> refusing")
                self.refuse("unknown note")
            elif not self.bridge.session_active:
                log(f"RM{value} inserted with nobody logged in -> refusing")
                self.refuse("log in before inserting cash")
            else:
                log(f"RM{value} held -> accepting")
                self.send(ACCEPT)
                self.held_value = value

        elif b == STACKED:
            if self.held_value is not None:
                log(f"RM{self.held_value} stacked")
                value, self.held_value = self.held_value, None
                # Off the read loop so a slow backend never delays the next byte.
                threading.Thread(target=self.bridge.deposit, args=(value,), daemon=True).start()

        elif b == CHECKING:
            if now >= self.quiet_until:
                self.checking_since = now

        elif b not in (NOTE_HELD, POWER_UP, STATUS_END):
            log(f"unhandled byte 0x{b:02X}")

        self.prev = b

    def on_tick(self):
        """Called between reads: turns a 29 with no 81 after it into a rejection."""
        if self.checking_since is not None and time.monotonic() - self.checking_since > REJECT_WINDOW_S:
            self.checking_since = None
            log("note not recognised, returned to customer")
            self.bridge.rejected("note not recognised")


def run_serial(dev, bridge):
    fd = open_serial(dev)
    acceptor = Acceptor(fd, bridge)
    log(f"listening on {dev} at 9600 8E1")
    while True:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                data = os.read(fd, 64)
            except BlockingIOError:
                data = b""
            for b in data:
                acceptor.on_byte(b)
        acceptor.on_tick()


def run_simulate(bridge):
    log("SIMULATE mode: type a ringgit value (1, 5, 10, 20, 50, 100) or x for a rejected note")
    for line in sys.stdin:
        line = line.strip().lower()
        if line == "x":
            bridge.rejected("note not recognised")
            log("simulated rejection sent")
        elif line.isdigit() and int(line) in NOTE_VALUES_MYR.values():
            if bridge.session_active:
                bridge.deposit(int(line))
            else:
                bridge.rejected("log in before inserting cash")
                log("nobody logged in, simulated refusal sent")
        elif line:
            log(f"ignored: {line!r}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--bridge-url",
        default="http://localhost:8080",
        help="device-agent kiosk server that bridges to the backend (default: http://localhost:8080)",
    )
    parser.add_argument("--dev", default=SERIAL_DEV, help=f"serial device (default: {SERIAL_DEV})")
    parser.add_argument("--simulate", action="store_true", help="run without the acceptor attached")
    args = parser.parse_args()

    bridge = Bridge(args.bridge_url)
    threading.Thread(target=bridge.poll_session_forever, daemon=True).start()
    try:
        if args.simulate:
            time.sleep(SESSION_POLL_S)  # let the first session check land
            run_simulate(bridge)
        else:
            run_serial(args.dev, bridge)
    except KeyboardInterrupt:
        log("stopped")
