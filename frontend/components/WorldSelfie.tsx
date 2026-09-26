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

/// World ID at the deposit terminal. The kiosk shows World ID's QR code on
/// its own screen; the customer scans it with World App on their phone and
/// approves. The request is signed by the backend and bound to the customer's
/// wallet; the proof goes back to the backend to verify with World.
/// One human, one Takarabako account.
export function KioskWorldId({ onVerified }: { onVerified: () => void }) {
  const [request, setRequest] = useState<WorldRequest | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function start() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/kiosk/worldid/request");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "couldn't start World ID");
      setRequest(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't start World ID");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card kiosk-world">
      <div className="spread">
        <b>Verify you&apos;re human</b>
        <span className="pill warn">Optional</span>
      </div>
      {!request ? (
        <>
          <p className="muted small" style={{ margin: "6px 0 12px" }}>
            Scan with World App on your phone to prove you&apos;re one real person. It unlocks sending by name and moving tkCASH.
            World ID never tells us who you are.
          </p>
          {error && <div className="notice error">{error}</div>}
          <button className="btn btn-block" onClick={start} disabled={loading}>
            {loading ? "Preparing…" : "Verify with World ID"}
          </button>
        </>
      ) : (
        <WorldQr request={request} onVerified={onVerified} onRestart={() => setRequest(null)} />
      )}
    </section>
  );
}

/// The credential the backend asked for (WORLD_PRESET).
function presetFor({ preset, signal }: WorldRequest) {
  if (preset === "selfie-v4") return { allow_legacy_proofs: false, preset: selfieCheck({ signal }) };
  if (preset === "selfie") return { allow_legacy_proofs: true, preset: selfieCheckLegacy({ signal }) };
  return { allow_legacy_proofs: true, preset: deviceLegacy({ signal }) };
}

function WorldQr({ request, onVerified, onRestart }: { request: WorldRequest; onVerified: () => void; onRestart: () => void }) {
  const flow = useIDKitRequest({
    app_id: request.app_id,
    action: request.action,
    rp_context: request.rp_context,
    environment: request.environment,
    ...presetFor(request),
  });
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<"scan" | "approve" | "checking" | "done" | "error">("scan");
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
    if (flow.isAwaitingUserConfirmation && status === "scan") setStatus("approve");
    if (flow.isError && status !== "error") {
      setStatus("error");
      setError(`World ID didn't finish (${flow.errorCode ?? "error"}).`);
    }
    if (flow.isSuccess && flow.result && !submitted.current) {
      submitted.current = true;
      setStatus("checking");
      fetch("/api/kiosk/worldid/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(flow.result) })
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

  if (status === "done") {
    return <p className="kiosk-world-done">✓ Verified — you&apos;re a unique human.</p>;
  }

  return (
    <div className="kiosk-world-qr">
      {status === "error" ? (
        <>
          <div className="notice error">{error}</div>
          <button className="btn btn-block" onClick={onRestart}>Try again</button>
        </>
      ) : (
        <>
          <div className="kiosk-world-code">
            {/* A generated data URL — next/image adds nothing here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr ? <img src={qr} alt="World ID QR code — scan with World App" width={240} height={240} /> : <span className="muted small">Preparing the code…</span>}
          </div>
          <p className="small" style={{ textAlign: "center", margin: "10px 0 0" }}>
            {status === "scan" && "Open World App on your phone and scan this code."}
            {status === "approve" && "Approve the request in World App…"}
            {status === "checking" && "Checking your proof with World…"}
          </p>
        </>
      )}
    </div>
  );
}
