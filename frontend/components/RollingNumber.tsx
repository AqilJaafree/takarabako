"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { usd } from "@/lib/format";

/// A USD amount that rolls up (or down) to its new value instead of jumping.
/// Server-rendered with the real value, so it reads correctly before JS loads.
export function RollingNumber({ value, className }: { value: number; className?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const shown = useRef({ v: value });

  useEffect(() => {
    const tween = gsap.to(shown.current, {
      v: value,
      duration: Math.abs(value - shown.current.v) > 0 ? 1.2 : 0,
      ease: "power2.out",
      onUpdate: () => {
        if (el.current) el.current.textContent = usd(shown.current.v);
      },
    });
    return () => { tween.kill(); };
  }, [value]);

  return (
    <div ref={el} className={className}>
      {usd(value)}
    </div>
  );
}
