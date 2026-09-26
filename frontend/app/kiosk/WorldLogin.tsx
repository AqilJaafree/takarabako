"use client";

import { useEffect, useRef, useState } from "react";
import type { KioskLogin } from "@/lib/types";
import { useWorldProof, type WorldRequest } from "@/lib/useWorldProof";

type LoginRequest = WorldRequest & { nonce: string };

/// World ID login at the deposit terminal: the customer scans this code with
/// World App on their phone. Only works for accounts verified with World ID;
/// everyone else is sent back to their wallet QR.
export function WorldLogin({ onLogin, onUseQr }: { onLogin: (login: KioskLogin) => void; onUseQr: () => void }) {
  const [request, setRequest] = useState<LoginRequest | null>(null);
  const [error, setError] = useState("");

  function load() {
    fetch("/api/kiosk/login-world/request")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "World ID login isn't available");
        setRequest(body);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "World ID login isn't available"));
  }

  useEffect(() => {
    load(); // one request per mount; retry() asks for the next
  }, []);

  function retry() {
    setRequest(null);
    setError("");
    load();
  }

  return (
    <section className="card">
      <p className="label" style={{ textAlign: "center" }}>Log in with World ID</p>
      {error ? (
        <>
          <div className="notice error">{error}</div>
          <button className="btn btn-gold btn-block" onClick={retry}>Try again</button>
        </>
      ) : request ? (
        <WorldLoginFlow key={request.nonce} request={request} onLogin={onLogin} onError={setError} />
      ) : (
        <p className="muted small" style={{ textAlign: "center" }}>Preparing the code…</p>
      )}
      <button className="btn btn-block" onClick={onUseQr}>Scan my QR instead</button>
    </section>
  );
}

function WorldLoginFlow({
  request,
  onLogin,
  onError,
}: {
  request: LoginRequest;
  onLogin: (login: KioskLogin) => void;
  onError: (message: string) => void;
}) {
  const proof = useWorldProof(request);
  const [checking, setChecking] = useState(false);
  const submitted = useRef(false);

  useEffect(() => {
    if (proof.status === "error") {
      onError(`World ID didn't finish (${proof.errorCode ?? "error"}).`);
      return;
    }
    // The proof is sent once.
    if (proof.status !== "success" || !proof.result || submitted.current) return;
    submitted.current = true;
    setChecking(true);
    fetch("/api/kiosk/login-world", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: request.nonce, result: proof.result }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "World ID login failed");
        onLogin(body as KioskLogin);
      })
      .catch((e) => onError(e instanceof Error ? e.message : "World ID login failed"));
  }, [proof.status, proof.result, proof.errorCode, request.nonce, onLogin, onError]);

  return (
    <>
      <p className="muted small" style={{ textAlign: "center" }}>Scan this code with World App on your phone, then take a quick selfie.</p>
      <div className="world-code">
        {/* A generated data URL — next/image adds nothing here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {proof.qr ? <img src={proof.qr} alt="World ID QR code — scan with World App" width={260} height={260} /> : <span className="muted small">Preparing the code…</span>}
      </div>
      <p className="muted small" style={{ textAlign: "center" }}>
        {checking ? "Checking with World…" : proof.status === "approve" ? "Take the selfie in World App…" : "For accounts verified with World ID."}
      </p>
    </>
  );
}
