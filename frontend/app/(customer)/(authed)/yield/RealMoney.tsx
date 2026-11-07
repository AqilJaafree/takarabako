"use client";

import { useEffect, useRef, useState } from "react";

/// Shown on a real-money network (see backend networks.ts `real`): a confirmation
/// before any position is opened. The wording sticks to what is true of these strategies.

const RISKS = [
  "Value can fall below what you put in. Outside your range it stops earning and holds one token.",
  "Earnings are trading fees. None is promised or insured.",
  "Runs on 1inch Aqua smart contracts (smart-contract risk). Tokens stay in the Takarabako treasury.",
  "Closing pays out at that moment's ETH price.",
];

export function ConfirmRealMoney({
  summary,
  network,
  onResult,
  risks = RISKS,
  title = "Put real money into a strategy?",
  confirmLabel = "Confirm and open",
}: {
  summary: string;
  network: string;
  onResult: (confirmed: boolean) => void;
  /// The risks to list: the default describes the treasury-managed positions.
  risks?: string[];
  title?: string;
  confirmLabel?: string;
}) {
  const [understood, setUnderstood] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);

  // Cancel is focused first (the safe choice), and Escape cancels.
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onResult(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResult]);

  return (
    <div className="confirm-overlay" onClick={() => onResult(false)}>
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{title}</h2>
        <p className="confirm-summary">
          {summary} on {network}.
        </p>
        <ul className="confirm-risks">
          {risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <label className="confirm-check">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>I understand I can lose money.</span>
        </label>
        <div className="row confirm-actions">
          <button ref={cancel} type="button" className="btn btn-ghost" onClick={() => onResult(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-gold" disabled={!understood} onClick={() => onResult(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
