"use client";

import { useEffect, useRef, useState } from "react";

/// Shown on a real-money network (see backend networks.ts `real`): a standing
/// notice at the top of the yield page, and a confirmation before any position
/// is opened. The wording sticks to what is true of these strategies.

export function RealMoneyNotice({ network }: { network: string }) {
  return (
    <div className="real-notice" role="note">
      <b>Real money on {network}.</b> Strategies can lose value and nothing here is guaranteed. Earnings are trading fees from other people&apos;s trades.
    </div>
  );
}

const RISKS = [
  "The value can go down as well as up. When ETH leaves your range the position turns into one token and stops earning, and it can be worth less than you put in.",
  "Earnings are trading fees, which depend on how much people trade. None is promised, and this is not insured or guaranteed.",
  "Strategies run on 1inch Aqua smart contracts, which carry smart-contract risk. The tokens stay in the Takarabako treasury wallet while Aqua tracks each strategy's share.",
  "Closing returns the position's value at that moment's ETH price, which may differ from when you opened it.",
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
