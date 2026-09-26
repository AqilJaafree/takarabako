"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface DepositQrCode {
  qr: string;
  dataUrl: string;
  ttlSeconds: number;
}

// Swap in a new QR a few seconds early, so the one on screen never expires
// while someone is holding it up to the camera.
const REFRESH_EARLY_MS = 5_000;

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/// The Deposit tab's QR: valid for 5 minutes, and replaced automatically
/// while it's on screen. Coming back to the tab after it expired also gets a
/// new one. Each new QR kills the previous one on the backend.
export function DepositQr({ initial }: { initial: DepositQrCode }) {
  const router = useRouter();
  const [code, setCode] = useState(initial);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  // The deadline the timers act on; `deadline` state mirrors it for display.
  const deadlineRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const res = await fetch("/api/me/qr", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "couldn't make a new QR");
      setCode(body);
      deadlineRef.current = Date.now() + body.ttlSeconds * 1000;
      setDeadline(deadlineRef.current);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't make a new QR");
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [router]);

  // Tick every second: count down, and swap the QR just before it expires.
  useEffect(() => {
    if (deadlineRef.current === null) deadlineRef.current = Date.now() + initial.ttlSeconds * 1000;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      setDeadline(deadlineRef.current);
      if (deadlineRef.current !== null && deadlineRef.current - n <= REFRESH_EARLY_MS) void refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [initial.ttlSeconds, refresh]);

  // Back on the tab (phone unlocked, app switched): a new QR if it has run out.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const d = deadlineRef.current;
      if (d !== null && d - Date.now() <= REFRESH_EARLY_MS) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const left = deadline !== null && now !== null ? deadline - now : code.ttlSeconds * 1000;
  const fraction = Math.min(1, Math.max(0, left / (code.ttlSeconds * 1000)));

  return (
    <>
      <div className={`qr-frame deposit-qr${refreshing ? " is-refreshing" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the backend */}
        <img key={code.qr} src={code.dataUrl} alt="Your deposit QR code" width={480} height={480} />
      </div>
      <div className="qr-timer" aria-live="polite">
        <div className="qr-timer-bar" aria-hidden="true">
          <span style={{ transform: `scaleX(${fraction})` }} />
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {refreshing ? "Making a new QR…" : <>New QR in <b className="mono">{clock(left - REFRESH_EARLY_MS)}</b></>}
        </p>
      </div>
      {error && <div className="notice error">{error} — retrying…</div>}
      <button className="btn btn-ghost small" onClick={() => void refresh()} disabled={refreshing}>
        ↻ New QR now
      </button>
    </>
  );
}
