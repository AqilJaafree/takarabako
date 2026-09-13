#!/usr/bin/env python3
"""TB74 pulse bill acceptor listener for the Takarabako kiosk (PRD §7.1/§7.2,
Phase 4 — see the TB74-to-Pi-4 wiring guide for the physical hookup).

Wiring recap: PULSE+ (harness pin 7) -> Pi physical pin 11 (GPIO17);
PULSE- (harness pin 8) -> any Pi GND. The pull-up is enabled here in
software, not by wiring 5V/12V onto the pin — see the wiring guide's
safety note before touching the harness.

This script holds no backend credentials and never calls the backend
directly. It only counts pulses, converts a settled burst into a dollar
amount, and POSTs that amount to device-agent/server.js's own
/pulse-deposit endpoint (same machine, or --bridge-url for a Pi that isn't
also running the kiosk server). The bridge is what knows which account is
currently verified and calls the real POST /deposit.

Run against real hardware:
    python3 bill_acceptor.py

Run without hardware, to test the bridge/backend path end to end:
    python3 bill_acceptor.py --simulate
    (then press Enter once per simulated pulse; a run of presses within
    DEBOUNCE_S counts as one burst, same as rapid real pulses would)
"""
import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request

GPIO_PIN = 17

# How long to wait after the last pulse before treating a burst as finished.
# Not sourced from the TB74 manual (its inter-pulse timing isn't documented
# anywhere we could verify — see the wiring guide's sourcing caveat); this is
# a starting value to tune against the real unit's actual pulse spacing.
DEBOUNCE_S = 0.28

# Must match the TB74's on-board DIP pulse-per-currency-unit setting for your
# region/denomination table (see DEPLOYMENTS.md / the wiring guide) — this is
# NOT auto-detected from the hardware.
PULSES_PER_DOLLAR = 1


class BurstDetector:
    """Counts pulses arriving close together and fires once per burst,
    DEBOUNCE_S after the last pulse in it — not on every individual pulse."""

    def __init__(self, debounce_s, on_settle):
        self.debounce_s = debounce_s
        self.on_settle = on_settle
        self.count = 0
        self.timer = None
        self.lock = threading.Lock()

    def pulse(self):
        with self.lock:
            self.count += 1
            n = self.count
            if self.timer:
                self.timer.cancel()
            self.timer = threading.Timer(self.debounce_s, self._settle)
            self.timer.daemon = True
            self.timer.start()
        print(f"[bill-acceptor] pulse {n}")

    def _settle(self):
        with self.lock:
            count, self.count, self.timer = self.count, 0, None
        if count > 0:
            self.on_settle(count)


def post_deposit(bridge_url, amount):
    data = json.dumps({"amount": amount}).encode()
    req = urllib.request.Request(
        f"{bridge_url}/pulse-deposit",
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read())
            print(f"[bill-acceptor] deposit ok: {body}")
    except urllib.error.HTTPError as e:
        print(f"[bill-acceptor] deposit rejected ({e.code}): {e.read().decode(errors='replace')}", file=sys.stderr)
    except Exception as e:
        print(f"[bill-acceptor] deposit failed: {e}", file=sys.stderr)


def run(bridge_url, simulate):
    def on_settle(pulse_count):
        amount = pulse_count / PULSES_PER_DOLLAR
        print(f"[bill-acceptor] burst settled: {pulse_count} pulse(s) -> ${amount:.2f}")
        post_deposit(bridge_url, amount)

    detector = BurstDetector(DEBOUNCE_S, on_settle)

    print(
        f"[bill-acceptor] {'SIMULATE' if simulate else 'GPIO' + str(GPIO_PIN)} mode, "
        f"debounce={DEBOUNCE_S}s, {PULSES_PER_DOLLAR} pulse(s)/$1, bridge={bridge_url}"
    )

    if simulate:
        print("[bill-acceptor] press Enter to fire a pulse, Ctrl-C to quit")
        try:
            while True:
                input()
                detector.pulse()
        except KeyboardInterrupt:
            print("\n[bill-acceptor] stopped")
        return

    # Real hardware path — imported here so --simulate works on a dev
    # machine with no GPIO library (or signal.pause, on some platforms)
    # available at all.
    import signal

    from gpiozero import Button

    button = Button(GPIO_PIN, pull_up=True, bounce_time=0.01)
    button.when_pressed = detector.pulse

    try:
        signal.pause()
    except KeyboardInterrupt:
        print("\n[bill-acceptor] stopped")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--bridge-url",
        default="http://localhost:8080",
        help="device-agent kiosk server that bridges to the backend (default: http://localhost:8080)",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="run without real GPIO hardware — press Enter to simulate a pulse",
    )
    args = parser.parse_args()
    run(args.bridge_url, args.simulate)
