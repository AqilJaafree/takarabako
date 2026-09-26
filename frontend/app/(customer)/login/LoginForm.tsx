"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLoginWithEmail, usePrivy } from "@privy-io/react-auth";

type Step = "email" | "code";

/// Privy email one-time code → Privy access token → POST /api/session, which
/// has the backend verify the token and sets the httpOnly session cookie.
export function LoginForm() {
  const router = useRouter();
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const exchanging = useRef(false);

  async function exchange() {
    if (exchanging.current) return;
    exchanging.current = true;
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Privy didn't return a login token — try again");
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "login failed");
      router.replace("/");
      router.refresh();
    } catch (e) {
      exchanging.current = false;
      setError(e instanceof Error ? e.message : "login failed");
      // Start over cleanly: a Privy session the backend refused is no use.
      setStep("email");
      await logout().catch(() => {});
    }
  }

  // Already logged in with Privy (e.g. the cookie expired): swap the token
  // for a fresh backend session without asking for another code.
  // exchange() only sets state after awaiting Privy and the backend.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready && authenticated) void exchange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  async function onSendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await sendCode({ email: email.trim() });
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the code");
    } finally {
      setBusy(false);
    }
  }

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await loginWithCode({ code: code.trim() });
      // `authenticated` flips to true and the effect above finishes the login.
    } catch {
      setError("That code is wrong or has expired. Check it, or send a new one.");
      setBusy(false);
    }
  }

  // Privy is logged in: the effect above is swapping its token for a session.
  if (!ready || authenticated) {
    return (
      <div className="card" style={{ textAlign: "center" }}>
        <p className="muted" style={{ margin: 0 }}>{authenticated ? "Opening your box…" : "Loading…"}</p>
      </div>
    );
  }

  return (
    <div className="card">
      {error && <div className="notice error">{error}</div>}
      {step === "email" ? (
        <form onSubmit={onSendCode}>
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ marginTop: 6 }}
          />
          <button className="btn btn-gold btn-block" disabled={busy || !email}>
            {busy ? "Sending…" : "Email me a code"}
          </button>
          <p className="muted small" style={{ marginTop: 14, marginBottom: 0 }}>
            Use the same email as at the kiosk to see the same box.
          </p>
        </form>
      ) : (
        <form onSubmit={onLogin}>
          <label className="label" htmlFor="code">Code sent to {email}</label>
          <input
            id="code"
            className="input code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={6}
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            style={{ marginTop: 6 }}
            autoFocus
          />
          <button className="btn btn-gold btn-block" disabled={busy || code.length < 6}>
            {busy ? "Checking…" : "Log in"}
          </button>
          <div className="spread" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-ghost small" onClick={() => { setStep("email"); setCode(""); }}>
              ← Different email
            </button>
            <button type="button" className="btn btn-ghost small" disabled={busy} onClick={onSendCode}>
              Send a new code
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
