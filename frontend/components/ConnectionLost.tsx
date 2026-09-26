"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/// "The box lost its connection" — shown when the backend can't be reached.
/// Retries on its own with growing gaps (and at once when the tab regains
/// focus or the network returns). When the backend answers, the lid reopens
/// ("Back!") and `onRecovered` runs, so the caller can transition back to
/// whatever the customer was doing.

const BACKOFF_S = [2, 4, 8, 15]; // then every 15 s
const REOPEN_MS = 900; // let the lid open before handing back

type Phase = "down" | "checking" | "back";

async function backendUp(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export function ConnectionLost({
  onRecovered,
  title = "The box lost its connection",
  detail = "We'll keep trying — nothing in your box is lost.",
}: {
  onRecovered: () => void;
  title?: string;
  detail?: string;
}) {
  const [phase, setPhase] = useState<Phase>("down");
  const [attempt, setAttempt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(BACKOFF_S[0]);
  const recovered = useRef(false);
  const attemptRef = useRef(0);
  const onRecoveredRef = useRef(onRecovered);
  useEffect(() => {
    onRecoveredRef.current = onRecovered;
  });

  const check = useCallback(async () => {
    if (recovered.current) return;
    setPhase("checking");
    if (await backendUp()) {
      recovered.current = true;
      setPhase("back");
      setTimeout(() => onRecoveredRef.current(), REOPEN_MS);
      return;
    }
    attemptRef.current += 1;
    setAttempt(attemptRef.current);
    setSecondsLeft(BACKOFF_S[Math.min(attemptRef.current, BACKOFF_S.length - 1)]);
    setPhase("down");
  }, []);

  // Countdown to the next automatic try.
  useEffect(() => {
    if (phase !== "down") return;
    if (secondsLeft <= 0) {
      const t = setTimeout(check, 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, secondsLeft, check]);

  // Back on the network, or back in the tab: try straight away.
  useEffect(() => {
    const now = () => void check();
    window.addEventListener("online", now);
    window.addEventListener("focus", now);
    return () => {
      window.removeEventListener("online", now);
      window.removeEventListener("focus", now);
    };
  }, [check]);

  const status =
    phase === "back"
      ? "Back! Opening your box…"
      : phase === "checking"
        ? "Checking…"
        : `Trying again in ${secondsLeft}s${attempt > 2 ? ` · attempt ${attempt + 1}` : ""}`;

  return (
    <div className={`conn-lost ${phase === "back" ? "is-back" : ""}`} role="alert" aria-live="assertive">
      <div className="conn-scene" aria-hidden="true">
        <span className="conn-lantern">
          <span className="conn-lantern-glow" />
        </span>
        <span className="conn-box">
          <span className="conn-lid" />
          <span className="conn-body" />
        </span>
      </div>
      <h2 className="conn-title">{phase === "back" ? "Reconnected" : title}</h2>
      <p className="muted conn-detail">{phase === "back" ? "Taking you back where you were." : detail}</p>
      <p className="conn-status" aria-live="polite">
        {status}
      </p>
      {phase !== "back" && (
        <button className="btn btn-gold" onClick={() => void check()} disabled={phase === "checking"}>
          Try now
        </button>
      )}
    </div>
  );
}

/// Polls the backend's health; `down` flips true after two failed checks in a
/// row (one blip isn't worth interrupting a customer for).
export function useBackendDown(intervalMs = 5000): [boolean, () => void] {
  const [down, setDown] = useState(false);
  const failures = useRef(0);

  useEffect(() => {
    if (down) return; // ConnectionLost takes over the retrying
    let stopped = false;
    const tick = async () => {
      const ok = await backendUp();
      if (stopped) return;
      failures.current = ok ? 0 : failures.current + 1;
      if (failures.current >= 2) setDown(true);
    };
    const t = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [down, intervalMs]);

  const recovered = useCallback(() => {
    failures.current = 0;
    setDown(false);
  }, []);
  return [down, recovered];
}
