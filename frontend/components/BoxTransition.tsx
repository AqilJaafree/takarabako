"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

/// The page as the lid of a lacquered box. Logging in, the two halves slide
/// shut over the login page, the clasp turns, light leaks from the seam and
/// the lid lifts off onto the customer's box. Logging out, the lid shuts and
/// locks over their box, then the closed box sinks away onto the login page.
/// It lives in the (customer) layout, so it stays on screen across the route
/// change underneath.

type Phase = "idle" | "closing" | "closed" | "opening" | "leaving";

interface BoxTransition {
  /// Close over the current page, go to `href`, open onto it.
  openInto: (href: string) => Promise<void>;
  /// Close and lock over the current page, run `work` (e.g. end the
  /// session), go to `href`, and sink away onto it.
  closeTo: (href: string, work?: () => Promise<unknown>) => Promise<void>;
}

const Ctx = createContext<BoxTransition | null>(null);

const CLOSE_MS = 700; // halves meet + the clasp drops in
const OPEN_MS = 1400; // clasp turns, seam glows, lid lifts
const LEAVE_MS = 750;
const ROUTE_TIMEOUT_MS = 6000; // never leave the box shut if a page is slow

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const twoFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function BoxTransitionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("idle");
  const running = useRef(false);
  const arrival = useRef<{ href: string; resolve: () => void } | null>(null);

  // Resolve a pending navigation once its page has rendered.
  useEffect(() => {
    if (arrival.current && arrival.current.href === pathname) {
      arrival.current.resolve();
      arrival.current = null;
    }
  }, [pathname]);

  const go = useCallback(
    async (href: string) => {
      const arrived = new Promise<void>((resolve) => {
        arrival.current = { href, resolve };
      });
      router.replace(href);
      router.refresh();
      await Promise.race([arrived, wait(ROUTE_TIMEOUT_MS)]);
      arrival.current = null;
      await twoFrames(); // let the new page paint under the lid
    },
    [router],
  );

  const openInto = useCallback(
    async (href: string) => {
      if (running.current) return;
      if (reducedMotion()) return go(href);
      running.current = true;
      try {
        setPhase("closing");
        await wait(CLOSE_MS);
        setPhase("closed");
        await go(href);
        setPhase("opening");
        await wait(OPEN_MS);
      } finally {
        setPhase("idle");
        running.current = false;
      }
    },
    [go],
  );

  const closeTo = useCallback(
    async (href: string, work?: () => Promise<unknown>) => {
      if (running.current) return;
      if (reducedMotion()) {
        await work?.().catch(() => {});
        return go(href);
      }
      running.current = true;
      try {
        setPhase("closing");
        await Promise.all([wait(CLOSE_MS + 250), work?.().catch(() => {})]);
        setPhase("closed");
        await go(href);
        setPhase("leaving");
        await wait(LEAVE_MS);
      } finally {
        setPhase("idle");
        running.current = false;
      }
    },
    [go],
  );

  return (
    <Ctx.Provider value={{ openInto, closeTo }}>
      {children}
      {phase !== "idle" && <BoxLid phase={phase} />}
    </Ctx.Provider>
  );
}

export function useBoxTransition() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBoxTransition must be used inside BoxTransitionProvider");
  return ctx;
}

function BoxLid({ phase }: { phase: Exclude<Phase, "idle"> }) {
  return (
    <div className="box-tx" data-phase={phase} aria-hidden="true">
      <div className="box-tx-glow" />
      <div className="box-tx-half box-tx-lid">
        <span className="box-tx-fit tl" />
        <span className="box-tx-fit tr" />
        <span className="box-tx-mon">宝箱</span>
      </div>
      <div className="box-tx-half box-tx-body">
        <span className="box-tx-fit bl" />
        <span className="box-tx-fit br" />
      </div>
      <div className="box-tx-seam" />
      <div className="box-tx-clasp">
        <span>宝</span>
      </div>
    </div>
  );
}
