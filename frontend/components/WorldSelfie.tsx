"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { deviceLegacy, selfieCheck, selfieCheckLegacy, useIDKitRequest, type RpContext } from "@worldcoin/idkit";

interface WorldRequest {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  preset?: "device" | "selfie" | "selfie-v4";
  signal: string;
  rp_context: RpContext;
}

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

/// The credential the backend asked for (WORLD_PRESET).
function presetFor({ preset, signal }: WorldRequest) {
  if (preset === "selfie-v4") return { allow_legacy_proofs: false, preset: selfieCheck({ signal }) };
  if (preset === "device") return { allow_legacy_proofs: true, preset: deviceLegacy({ signal }) };
  return { allow_legacy_proofs: true, preset: selfieCheckLegacy({ signal }) };
}

function SelfieFlow({ request, onVerified, onRestart }: { request: WorldRequest; onVerified: () => void; onRestart: () => void }) {
  const flow = useIDKitRequest({
    app_id: request.app_id,
    action: request.action,
    rp_context: request.rp_context,
    environment: request.environment,
    ...presetFor(request),
  });
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<"open" | "approve" | "checking" | "done" | "error">("open");
  const [error, setError] = useState("");
  const opened = useRef(false);
  const submitted = useRef(false);

  // Start the request once; IDKit then waits for World App.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    flow.open();
  }, [flow]);

  useEffect(() => {
    if (!flow.connectorURI) return;
    let cancelled = false;
    QRCode.toDataURL(flow.connectorURI, { width: 320, margin: 1, color: { dark: "#120807", light: "#f4e9da" } })
      .then((url) => !cancelled && setQr(url))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [flow.connectorURI]);

  useEffect(() => {
    // Derived from IDKit's state machine; the proof is sent once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (flow.isAwaitingUserConfirmation && status === "open") setStatus("approve");
    if (flow.isError && status !== "error") {
      setStatus("error");
      setError(`World ID didn't finish (${flow.errorCode ?? "error"}).`);
    }
    if (flow.isSuccess && flow.result && !submitted.current) {
      submitted.current = true;
      setStatus("checking");
      fetch("/api/me/worldid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(flow.result) })
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
    }
  }, [flow.isAwaitingUserConfirmation, flow.isError, flow.isSuccess, flow.result, flow.errorCode, status, onVerified]);

  if (status === "done") return <p className="world-done">✓ Verified — no daily limit on your box.</p>;

  if (status === "error") {
    return (
      <>
        <div className="notice error">{error}</div>
        <button className="btn btn-block" onClick={onRestart}>Try again</button>
      </>
    );
  }

  return (
    <div className="world-flow">
      {status === "open" && (
        <>
          <a className={`btn btn-gold btn-block${flow.connectorURI ? "" : " is-disabled"}`} href={flow.connectorURI ?? undefined}>
            Open World App
          </a>
          <details className="world-qr-alt">
            <summary className="muted small">On a computer? Scan with your phone instead</summary>
            <div className="world-code">
              {/* A generated data URL — next/image adds nothing here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qr ? <img src={qr} alt="World ID QR code — scan with World App" width={220} height={220} /> : <span className="muted small">Preparing the code…</span>}
            </div>
          </details>
        </>
      )}
      <p className="small" style={{ textAlign: "center", margin: "10px 0 0" }}>
        {status === "open" && "World App asks for a quick selfie, then comes back here."}
        {status === "approve" && "Take the selfie and approve in World App…"}
        {status === "checking" && "Checking your proof with World…"}
      </p>
    </div>
  );
}
