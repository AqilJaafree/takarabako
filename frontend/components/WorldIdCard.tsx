"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IDKitRequestWidget, deviceLegacy, type IDKitResult, type RpContext } from "@worldcoin/idkit";

interface WorldRequest {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  signal: string;
  rp_context: RpContext;
}

/// "Verify you're human" with World ID. The backend signs the request (its
/// signing key never reaches the browser) and binds it to the customer's
/// wallet; World App returns a proof, which the backend verifies with World
/// before this card turns green. One human, one Takarabako account.
export function WorldIdCard({ verified, reason }: { verified: boolean; reason?: string }) {
  const router = useRouter();
  const [request, setRequest] = useState<WorldRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(verified);

  async function start() {
    setBusy(true);
    setError("");
    try {
      // A fresh signed request each time (they expire after a few minutes).
      const res = await fetch("/api/worldid/request");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "couldn't start World ID");
      setRequest(body);
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't start World ID");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="card world-card is-verified">
        <div className="spread">
          <b>✓ Verified human</b>
          <span className="pill ok">World ID</span>
        </div>
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          Your account is proven to belong to one real person. Sending by name and tkCASH transfers are unlocked, and your ENS
          name says so.
        </p>
      </section>
    );
  }

  return (
    <section className="card world-card">
      <div className="spread">
        <b>Verify you&apos;re human</b>
        <span className="pill warn">Not verified</span>
      </div>
      <p className="muted small" style={{ margin: "6px 0 12px" }}>
        {reason ?? "Prove with World ID that this account belongs to one real person. It unlocks sending by name and moving tkCASH."}{" "}
        World ID never tells us who you are — only that you&apos;re unique.
      </p>
      {error && <div className="notice error">{error}</div>}
      <button className="btn btn-gold btn-block world-btn" onClick={start} disabled={busy}>
        <WorldMark /> {busy ? "Preparing…" : "Verify with World ID"}
      </button>
      {request && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={request.app_id}
          action={request.action}
          rp_context={request.rp_context}
          environment={request.environment}
          allow_legacy_proofs={true}
          preset={deviceLegacy({ signal: request.signal })}
          handleVerify={async (result: IDKitResult) => {
            const res = await fetch("/api/me/worldid", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(result),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              setError(body.error ?? "World ID verification failed");
              throw new Error(body.error ?? "verification failed");
            }
          }}
          onSuccess={() => {
            setDone(true);
            router.refresh();
          }}
          onError={(code) => setError(`World ID didn't finish (${code}). Try again.`)}
        />
      )}
    </section>
  );
}

function WorldMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style={{ verticalAlign: "-3px" }}>
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M2.5 12h19M12 2.5c3 3.2 3 15.8 0 19" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
