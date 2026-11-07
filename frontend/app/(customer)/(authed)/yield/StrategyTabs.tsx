"use client";

import { useState, type ReactNode } from "react";

/// The Quick start and Advanced tabs, the same whichever funds a position.
export function StrategyTabs({ quick, advanced }: { quick: ReactNode; advanced: ReactNode }) {
  const [tab, setTab] = useState<"quick" | "advanced">("quick");
  return (
    <>
      <div className="yield-tabs" role="tablist" aria-label="Yield mode">
        <button role="tab" aria-selected={tab === "quick"} className={tab === "quick" ? "is-on" : ""} onClick={() => setTab("quick")}>
          Quick start
        </button>
        <button role="tab" aria-selected={tab === "advanced"} className={tab === "advanced" ? "is-on" : ""} onClick={() => setTab("advanced")}>
          Advanced
        </button>
      </div>
      {tab === "quick" ? quick : advanced}
    </>
  );
}
