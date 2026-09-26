import type { Metadata } from "next";
import { loadForPage } from "@/lib/serverData";
import { shortHex } from "@/lib/format";

export const metadata: Metadata = { title: "My QR · Takarabako" };

/// The quick-deposit QR: shown to the kiosk camera for a deposit-only login.
export default async function QrPage() {
  const { wallet, dataUrl } = await loadForPage<{ wallet: string; dataUrl: string }>("/me/qr");
  return (
    <section style={{ textAlign: "center" }}>
      <h1 style={{ fontSize: 26 }}>Show this at the kiosk</h1>
      <p className="muted">Tap “Scan my QR” on the box and hold your phone up to the camera.</p>
      <div className="qr-frame">
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the backend */}
        <img src={dataUrl} alt={`QR code for wallet ${wallet}`} width={480} height={480} />
      </div>
      <p className="mono muted small">{shortHex(wallet, 10, 8)}</p>
      <div className="notice" style={{ textAlign: "left" }}>
        💡 Turn your screen brightness up so the camera reads it first time. This QR only lets someone
        <strong> put cash into</strong> your box — withdrawing always needs your email login.
      </div>
    </section>
  );
}
