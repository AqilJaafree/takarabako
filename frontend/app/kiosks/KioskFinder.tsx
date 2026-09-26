"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef, useState } from "react";
import { directionsUrl, distanceM, type KioskLocation } from "@/lib/kiosks";
import type { KioskMapHandle } from "./KioskMap";
import { FloorPlan } from "./FloorPlan";

// WebGL map: browser only.
const KioskMap = dynamic(() => import("./KioskMap"), { ssr: false, loading: () => <div className="kiosk-map kiosk-map-loading" /> });

type Kiosk = KioskLocation & { status: "open" | "paused" | "unknown" };

const fmtDistance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`);
const fmtWalk = (m: number) => {
  const min = Math.round(m / 80); // ~4.8 km/h
  return min < 1 ? "under a minute" : min < 90 ? `${min} min walk` : `${Math.round(min / 60)} h walk`;
};

export function KioskFinder({ kiosks }: { kiosks: Kiosk[] }) {
  const kiosk = kiosks[0];
  const map = useRef<KioskMapHandle>(null);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");
  const distance = me ? distanceM(me, kiosk) : null;

  function locate() {
    if (!navigator.geolocation) {
      setLocError("Your browser can't share its location.");
      return;
    }
    setLocating(true);
    setLocError("");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        setMe(pos);
        setLocating(false);
        map.current?.showUser(pos);
      },
      (e) => {
        setLocating(false);
        setLocError(e.code === e.PERMISSION_DENIED ? "Location permission was denied." : "Couldn't get your location.");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  return (
    <main className="finder">
      <header className="finder-head">
        <Link href="/" className="brand"><span className="kanji">宝箱</span> Takarabako</Link>
        <Link href="/" className="btn btn-ghost small">Open the app</Link>
      </header>

      <section className="finder-hero">
        <p className="label" style={{ margin: 0 }}>Find a kiosk near me</p>
        <h1>Cash in at the box</h1>
        <p className="muted">Insert banknotes, watch them land in your treasure box. {kiosks.length === 1 ? "One kiosk is live right now." : `${kiosks.length} kiosks are live.`}</p>
      </section>

      <div className="finder-map-wrap">
        <KioskMap ref={map} kiosk={kiosk} />
        <div className="finder-map-actions">
          <button className="btn btn-gold small" onClick={locate} disabled={locating}>
            {locating ? "Finding you…" : me ? "Update my location" : "◎ Use my location"}
          </button>
          <button className="btn small" onClick={() => map.current?.replay()}>↻ Fly in again</button>
        </div>
      </div>

      <section className="finder-card">
        <div className="spread">
          <div>
            <h2>{kiosk.name}</h2>
            <p className="mono small muted" style={{ margin: 0 }}>{kiosk.ens}</p>
          </div>
          <span className={`pill ${kiosk.status === "open" ? "ok" : kiosk.status === "paused" ? "warn" : ""}`}>
            {kiosk.status === "open" ? "In service" : kiosk.status === "paused" ? "Paused" : "Status unknown"}
          </span>
        </div>

        <div className="finder-facts">
          <div><span className="label">Where</span><b>{kiosk.venue}</b><span className="muted small">Floor {kiosk.floor} · {kiosk.spot}</span></div>
          <div><span className="label">Hours</span><b>{kiosk.hours}</b></div>
          <div><span className="label">Accepts</span><b>{kiosk.accepts}</b></div>
          <div>
            <span className="label">From you</span>
            {distance !== null ? (
              <>
                <b>{fmtDistance(distance)}</b>
                <span className="muted small">{distance < 60 ? "You're here! Head up to 5F." : fmtWalk(distance)}</span>
              </>
            ) : (
              <span className="muted small">{locError || "Tap “Use my location”."}</span>
            )}
          </div>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <a className="btn btn-gold" href={directionsUrl(kiosk)} target="_blank" rel="noreferrer">Directions ↗</a>
          <Link className="btn" href="/qr">Get my deposit QR</Link>
        </div>
      </section>

      <section className="finder-card">
        <h2>Inside the venue</h2>
        <p className="muted small">The kiosk is on 5F, the hackathon floor. Follow the gold line.</p>
        <FloorPlan kioskId={kiosk.id} />
      </section>
    </main>
  );
}
