import Link from "next/link";
import type { Metadata } from "next";
import { loadForPage } from "@/lib/serverData";
import { DepositQr, type DepositQrCode } from "./DepositQr";

export const metadata: Metadata = { title: "Deposit · Takarabako" };

/// Deposit: a QR for the kiosk camera that logs in to a deposit-only session.
/// Every visit makes a new one (valid 5 minutes, refreshed while on screen).
export default async function DepositPage() {
  const initial = await loadForPage<DepositQrCode>("/me/qr");
  return (
    <section style={{ textAlign: "center" }}>
      <h1 style={{ fontSize: 26 }}>Deposit cash</h1>
      <p className="muted">
        Tap “Scan my QR” on the box and hold your phone up to the camera. <Link href="/kiosks">Find a kiosk →</Link>
      </p>
      <DepositQr initial={initial} />
      <div className="notice" style={{ textAlign: "left", marginTop: 16 }}>
        💡 This QR changes every 5 minutes and stops working as soon as a new one appears, so a screenshot
        won’t work later. It only lets someone <strong>put cash into</strong> your box — withdrawing always
        needs your email login. Turn your brightness up so the camera reads it first time.
      </div>
    </section>
  );
}
