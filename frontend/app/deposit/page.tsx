import type { Metadata } from "next";
import { KioskApp } from "../kiosk/KioskApp";

export const metadata: Metadata = { title: "Deposit · Takarabako" };

/// Cash-deposit terminal for the laptop next to the box: scan the customer's
/// wallet QR (My QR on their phone), then the bill acceptor takes cash for
/// that account. Deposit-only sessions — no email login, no withdrawals.
export default function DepositPage() {
  return <KioskApp pools={[]} testDeposit={process.env.KIOSK_TEST_DEPOSIT === "1"} mode="deposit" />;
}
