"use client";

import { useEffect, useState } from "react";

/// The kiosk's identity: its ENS name and whether that name really resolves,
/// through the official ENS v2 resolver, to the device key that signs every
/// note this machine takes.
export function MachineBadge() {
  const [state, setState] = useState<{ name: string | null; verified: boolean | null }>({ name: null, verified: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const device = await fetch("/api/kiosk/device").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!device?.kiosk || !device.address) return;
      const ens = await fetch(`/api/ens/resolve?name=${encodeURIComponent(device.kiosk)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const verified = Boolean(ens && ens.kind === "kiosk" && ens.address?.toLowerCase() === device.address.toLowerCase());
      if (!cancelled) setState({ name: device.kiosk, verified });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state.name) return null;
  return (
    <span
      className={`machine-id ${state.verified ? "is-ok" : "is-bad"}`}
      title={state.verified ? "This machine signs every note; its key is published on ENS" : "This machine's key doesn't match its ENS name"}
    >
      {state.verified ? "✓" : "!"} <span className="mono">{state.name}</span>
      <span className="machine-id-note">{state.verified ? "verified machine" : "unverified"}</span>
    </span>
  );
}
