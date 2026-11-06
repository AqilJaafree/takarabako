"use client";

import { useEffect, useState } from "react";

/// The kiosk's identity: its id, and whether the device key this machine signs
/// with is the one an operator registered for that id.
export function MachineBadge() {
  const [state, setState] = useState<{ name: string | null; verified: boolean | null }>({ name: null, verified: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const device = await fetch("/api/kiosk/device").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!device?.kiosk || !device.address) return;
      const registered = await fetch("/api/kiosk/registered").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const kiosk = (registered?.kiosks as Array<{ id: string; signer: string; active: boolean }> | undefined)?.find((k) => k.id === device.kiosk);
      const verified = Boolean(kiosk && kiosk.active && kiosk.signer.toLowerCase() === String(device.address).toLowerCase());
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
      title={state.verified ? "This machine signs every note with the key an operator registered for it" : "This machine's key isn't registered for its id"}
    >
      {state.verified ? "✓" : "!"} <span className="mono">{state.name}</span>
      <span className="machine-id-note">{state.verified ? "verified machine" : "unverified"}</span>
    </span>
  );
}
