"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

const CHART_HEIGHT = 356;

/// A minimizable section holding a liquidity chart. The chart's dates and coordinates can differ between
/// the server and the browser, so it is only drawn in the browser, and only while the section is open.
export function LiquidityPanel({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const inBrowser = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  return (
    <details className="liq-panel" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{title}</summary>
      {open && (inBrowser ? children : <div style={{ height: CHART_HEIGHT }} aria-hidden="true" />)}
    </details>
  );
}
