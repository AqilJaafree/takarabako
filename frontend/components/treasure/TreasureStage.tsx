"use client";

import dynamic from "next/dynamic";
import { useRef, useSyncExternalStore } from "react";
import type { StageProps } from "./types";

// WebGL can't render on the server: the scene loads in the browser only.
const Scene = dynamic(() => import("./Scene"), {
  ssr: false,
  loading: () => <div className="stage-loading" />,
});

let can3d: boolean | null = null;
function detect(): boolean {
  if (can3d !== null) return can3d;
  try {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const flat = new URLSearchParams(window.location.search).has("flat");
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    can3d = !reduced && !flat && !!gl;
  } catch {
    can3d = false;
  }
  return can3d;
}
const noop = () => () => {};

/// The living treasure box. Without WebGL, with reduced motion requested, or
/// with ?flat in the URL it renders nothing and the page keeps its plain
/// (phase 2) layout.
export function TreasureStage(props: StageProps) {
  const enabled = useSyncExternalStore(noop, detect, () => false);
  const bubbleEl = useRef<HTMLDivElement>(null);
  const etchEl = useRef<HTMLDivElement>(null);
  if (!enabled) return null;
  return (
    <div className="stage" style={{ height: props.height ?? 340 }}>
      <Scene {...props} bubbleEl={bubbleEl} etchEl={etchEl} />
      {/* DOM overlays, moved each frame by the scene's anchors */}
      <div ref={bubbleEl} className="stage-anchor">
        {props.line && (
          <div key={props.line} className={`cat-bubble mood-${props.mood}`} role="status">
            {props.line}
          </div>
        )}
      </div>
      <div ref={etchEl} className="stage-anchor">
        {props.etch && <div className="etch">{props.etch}</div>}
      </div>
    </div>
  );
}
