"use client";

import { useEffect, useRef, useState } from "react";
import { useWorldProof, type WorldRequest } from "@/lib/useWorldProof";

/// The World ID selfie, taken right after the customer creates their wallet.
/// The backend signs the request and binds it to that wallet's address (the
/// signal), so the proof can only ever verify this account. On a phone the
/// button opens World App directly; on a computer, scan the code with it.
/// Until they verify, the account can move $1,000 a day.
export function WorldSelfie({ onVerified }: { onVerified: () => void }) {
  const [request, setRequest] = useState<WorldRequest | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function start() {
    setLoading(true);
    setError("");
    try {
      // A fresh signed request each time (they expire after a few minutes).
      const res = await fetch("/api/worldid/request");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "couldn't start World ID");
      setRequest(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't start World ID");
    } finally {
      setLoading(false);
    }
  }

  if (!request) {
    return (
      <>
        {error && <div className="notice error">{error}</div>}
        <button className="btn btn-gold btn-block" onClick={start} disabled={loading}>
          {loading ? "Preparing…" : "Take my World ID selfie"}
        </button>
      </>
    );
  }
  return <SelfieFlow request={request} onVerified={onVerified} onRestart={() => setRequest(null)} />;
}

function SelfieFlow({ request, onVerified, onRestart }: { request: WorldRequest; onVerified: () => void; onRestart: () => void }) {
  const proof = useWorldProof(request);
  const [status, setStatus] = useState<"waiting" | "checking" | "done" | "error">("waiting");
  const [error, setError] = useState("");
  const submitted = useRef(false);

  useEffect(() => {
    // The proof is sent once.
    if (proof.status !== "success" || !proof.result || submitted.current) return;
    submitted.current = true;
    setStatus("checking");
    fetch("/api/me/worldid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proof.result) })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "verification failed");
        setStatus("done");
        setTimeout(onVerified, 1200);
      })
      .catch((e) => {
        setStatus("error");
        setError(e instanceof Error ? e.message : "verification failed");
      });
  }, [proof.status, proof.result, onVerified]);

  if (status === "done") return <p className="world-done">✓ Verified — no daily limit on your box.</p>;

  const failure = status === "error" ? error || "verification failed" : proof.status === "error" ? `World ID didn't finish (${proof.errorCode ?? "error"}).` : "";
  if (failure) {
    return (
      <>
        <div className="notice error">{failure}</div>
        <button className="btn btn-block" onClick={onRestart}>Try again</button>
      </>
    );
  }

  return (
    <div className="world-flow">
      {status === "waiting" && proof.status === "open" && (
        <>
          <a className={`btn btn-gold btn-block${proof.connectorURI ? "" : " is-disabled"}`} href={proof.connectorURI ?? undefined}>
            Open World App
          </a>
          <details className="world-qr-alt">
            <summary className="muted small">On a computer? Scan with your phone instead</summary>
            <div className="world-code">
              {/* A generated data URL — next/image adds nothing here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {proof.qr ? <img src={proof.qr} alt="World ID QR code — scan with World App" width={220} height={220} /> : <span className="muted small">Preparing the code…</span>}
            </div>
          </details>
        </>
      )}
      <p className="small" style={{ textAlign: "center", margin: "10px 0 0" }}>
        {status === "checking" ? "Checking your proof with World…" : proof.status === "approve" ? "Take the selfie and approve in World App…" : "World App asks for a quick selfie, then comes back here."}
      </p>
    </div>
  );
}
