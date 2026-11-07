// JY-616 coin counter for the Takarabako kiosk (ESP32-S3, Arduino-ESP32 core).
//
// The JY-616's white COIN wire pulls to ground once per 10 sen (open collector,
// output switch on NO). This counts those pulses and, once they stop, sends one
// line over USB to the Pi:  COIN <pulses>
// The Pi turns pulses into ringgit (device-agent/serial/bill_acceptor_serial.py).
//
// Board: "ESP32S3 Dev Module". Plugged into the board's UART port (the CH343 one),
// leave USB CDC On Boot: Disabled so Serial goes to that port.

const int COIN_PIN = 4;                 // white wire, through a 10k resistor
const unsigned long MIN_GAP_US = 15000; // ignore edges closer than 15 ms (contact bounce)
const unsigned long SETTLE_MS = 400;    // a burst is over after 400 ms of silence

volatile unsigned long pulses = 0;
volatile unsigned long lastEdgeUs = 0;
volatile unsigned long lastPulseMs = 0;

void IRAM_ATTR onPulse() {
  unsigned long now = micros();
  if (now - lastEdgeUs < MIN_GAP_US) return;
  lastEdgeUs = now;
  pulses++;
  lastPulseMs = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(COIN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), onPulse, FALLING);
  Serial.println("READY");
}

void loop() {
  noInterrupts();
  unsigned long n = pulses;
  unsigned long last = lastPulseMs;
  interrupts();

  if (n > 0 && millis() - last >= SETTLE_MS) {
    noInterrupts();
    pulses = 0;
    interrupts();
    Serial.print("COIN ");
    Serial.println(n);
  }
  delay(10);
}
