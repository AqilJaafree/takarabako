"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { deviceLegacy, selfieCheck, selfieCheckLegacy, useIDKitRequest, type RpContext } from "@worldcoin/idkit";

/// A signed World ID request from the backend (worldId.ts requestContext).
export interface WorldRequest {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  preset?: "device" | "selfie" | "selfie-v4";
  signal: string;
  rp_context: RpContext;
}

/// The credential the backend asked for (WORLD_PRESET).
function presetFor({ preset, signal }: WorldRequest) {
  if (preset === "selfie-v4") return { allow_legacy_proofs: false, preset: selfieCheck({ signal }) };
  if (preset === "device") return { allow_legacy_proofs: true, preset: deviceLegacy({ signal }) };
  return { allow_legacy_proofs: true, preset: selfieCheckLegacy({ signal }) };
}

export type WorldProofStatus = "open" | "approve" | "success" | "error";

/// Runs one World ID request: opens it once, draws the World App QR, and
/// reports where it is. The caller sends `result` to the backend on success.
/// Mount once per request (e.g. `key={request.nonce}`); a new request needs a remount.
export function useWorldProof(request: WorldRequest) {
  const flow = useIDKitRequest({
    app_id: request.app_id,
    action: request.action,
    rp_context: request.rp_context,
    environment: request.environment,
    ...presetFor(request),
  });
  const [qr, setQr] = useState<string | null>(null);
  const opened = useRef(false);

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

  const status: WorldProofStatus =
    flow.isSuccess && flow.result ? "success" : flow.isError ? "error" : flow.isAwaitingUserConfirmation ? "approve" : "open";
  return {
    status,
    qr,
    connectorURI: flow.connectorURI ?? null,
    result: flow.isSuccess ? flow.result : null,
    errorCode: flow.errorCode ?? null,
  };
}
