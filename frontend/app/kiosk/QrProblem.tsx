"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export type QrProblemKind = "unregistered" | "invalid";

// An unattended pop-up must not block the next customer.
const IDLE_CLOSE_MS = 60_000;

const COPY: Record<QrProblemKind, { title: string; body: string }> = {
  unregistered: {
    title: "We don’t know this QR yet",
    body: "It isn’t linked to a Takarabako account. Scan a different QR, or sign up first — it only takes an email.",
  },
  invalid: {
    title: "That’s not a Takarabako QR",
    body: "Open My QR in the Takarabako app (or the QR from your welcome email) and try again, or sign up first.",
  },
};

/// Shown when a scanned QR can't log anyone in: scan again, or sign up.
/// Closing it (×, tapping outside, Esc, or a minute idle) goes back to the
/// start screen.
/// On /kiosk, signing up is the email box on this screen (onSignUpHere). On
/// the deposit terminal there is no email box, so it shows a QR that opens
/// sign-up on the customer's own phone.
export function QrProblem({
  kind,
  depositOnly,
  onRescan,
  onSignUpHere,
  onDismiss,
}: {
  kind: QrProblemKind;
  depositOnly: boolean;
  onRescan: () => void;
  onSignUpHere: () => void;
  onDismiss: () => void;
}) {
  const [view, setView] = useState<"choose" | "signup">("choose");
  const [signupQr, setSignupQr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(onDismiss, IDLE_CLOSE_MS);
    return () => clearTimeout(t);
  }, [view, onDismiss]);

  // Esc closes it too (the laptop next to the box has a keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  async function onSignUp() {
    if (!depositOnly) {
      onSignUpHere();
      return;
    }
    setView("signup");
    if (!signupQr) {
      const url = `${window.location.origin}/login`;
      setSignupQr(await QRCode.toDataURL(url, { width: 480, margin: 2 }));
    }
  }

  const copy = COPY[kind];
  return (
    // Tapping the dimmed area outside the card closes it.
    <div
      className="qr-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="qr-modal-card">
        <button className="qr-modal-close" onClick={onDismiss} aria-label="Close">
          ×
        </button>
        {view === "choose" ? (
          <>
            <div className="qr-modal-icon" aria-hidden="true">?</div>
            <h2 id="qr-modal-title">{copy.title}</h2>
            <p className="muted">{copy.body}</p>
            <div className="qr-modal-actions">
              <button className="btn btn-gold btn-block" onClick={onRescan} autoFocus>
                Scan a new QR
              </button>
              <button className="btn btn-block" onClick={onSignUp}>
                Sign up
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="qr-modal-title">Sign up on your phone</h2>
            <p className="muted">Point your phone camera here, sign up with your email, then open <b>My QR</b> and scan it at this box.</p>
            <div className="qr-frame qr-modal-qr">
              {signupQr ? (
                // eslint-disable-next-line @next/next/no-img-element -- generated data URL
                <img src={signupQr} alt="QR code that opens Takarabako sign-up" width={480} height={480} />
              ) : (
                <div className="qr-modal-qr-loading" />
              )}
            </div>
            <div className="qr-modal-actions">
              <button className="btn btn-gold btn-block" onClick={onRescan} autoFocus>
                I’ve signed up — scan my QR
              </button>
              <button className="btn btn-ghost btn-block" onClick={() => setView("choose")}>
                ← Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
