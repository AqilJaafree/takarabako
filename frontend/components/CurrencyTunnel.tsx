"use client";

import { useEffect, useRef } from "react";

/// The page background: rings of currency codes around the viewer, as if
/// standing inside a turning drum. Rings above eye level curve up at the
/// edges and rings below curve down; the far wall is small and dim, the near
/// sides large and glowing gold. Each ring turns at its own speed.
/// Pure decoration: hidden from assistive tech, no pointer events, static for
/// reduced motion, paused while the tab is hidden.
///
/// Performance: each code is rendered once into a small sprite (the gold glow
/// baked in), so a frame is just ~300 cheap drawImage stamps with one
/// setTransform each — no text shaping and no live blur — at 30 fps, 1×.

const CODES = ["USD", "EUR", "GBP", "JPY", "SGD", "MYR", "THB", "IDR", "PHP", "VND", "KRW", "AUD", "CAD", "CHF", "HKD", "NZD", "AED", "CNY"];

interface Ring {
  height: number; // world y of the ring (eye level = 0, positive = below)
  speed: number; // radians per second (sign = direction)
  offset: number; // current rotation
  bright: number; // 0.35–1: how much this ring glows
  tokens: string[];
}

// The drum, seen from its centre: a wall point at angle a (0 = straight
// ahead) is at depth R·cos(a), so it projects to x = f·tan(a) and grows as
// 1/cos(a) towards the sides — far wall small and dim, near sides big.
const RADIUS = 10;
const TEXT_HEIGHT = 0.72; // world height of a code
const EDGE_ANGLE = (72 * Math.PI) / 180; // the drum angle that lands on the screen edge
const MAX_ANGLE = (80 * Math.PI) / 180; // draw a little past the edge
const TOKEN_ANGLE = 0.23; // angular spacing between codes
const RING_GAP = 1.55; // world spacing between rings
const OPACITY = 1; // overall strength — it's a background
const FRAME_MS = 1000 / 30; // a slow drift doesn't need 60 fps
const SPRITE_PX = 64; // font size the sprites are drawn at

interface Sprite {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

/// One pre-rendered image per code and style: "CODE ·" in bronze, or in gold
/// with its glow already applied.
function makeSprites(serif: string) {
  const make = (code: string, gold: boolean): Sprite => {
    const pad = gold ? 28 : 6;
    const probe = document.createElement("canvas").getContext("2d")!;
    probe.font = `700 ${SPRITE_PX}px ${serif}, Georgia, serif`;
    const textW = probe.measureText(code).width;
    const dotGap = SPRITE_PX * 0.55;
    const w = Math.ceil(textW + dotGap + SPRITE_PX * 0.2 + pad * 2);
    const h = Math.ceil(SPRITE_PX * 1.3 + pad * 2);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d")!;
    c.font = probe.font;
    c.textBaseline = "middle";
    c.fillStyle = gold ? "rgb(240, 170, 95)" : "rgb(200, 132, 72)";
    if (gold) {
      c.shadowColor = "rgba(245, 160, 70, 0.75)";
      c.shadowBlur = SPRITE_PX * 0.35;
    }
    c.fillText(code, pad, h / 2);
    c.beginPath();
    c.arc(pad + textW + dotGap, h / 2, SPRITE_PX * 0.08, 0, Math.PI * 2);
    c.fill();
    return { canvas, w, h };
  };
  const sprites = new Map<string, Sprite>();
  for (const code of CODES) {
    sprites.set(code, make(code, false));
    sprites.set(`${code}*`, make(code, true));
  }
  return sprites;
}

function makeRings(): Ring[] {
  const rings: Ring[] = [];
  const perRing = Math.ceil((Math.PI * 2) / TOKEN_ANGLE);
  let i = 0;
  for (let h = -RING_GAP * 13; h <= RING_GAP * 13 + 0.01; h += RING_GAP, i++) {
    const start = (i * 5) % CODES.length;
    rings.push({
      height: h + 0.4, // eye level sits just between two rings
      speed: (i % 2 === 0 ? 1 : -1) * (0.035 + (i % 3) * 0.018),
      offset: i * 0.37,
      // One ring in four glows gold; the rest stay a quiet bronze.
      bright: i % 4 === 1 ? 1 : 0.3 + ((i * 37) % 30) / 100,
      tokens: Array.from({ length: perRing }, (_, k) => CODES[(start + k * 7) % CODES.length]),
    });
  }
  return rings;
}

export function CurrencyTunnel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const rings = makeRings();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const serif = getComputedStyle(document.documentElement).getPropertyValue("--font-mincho").trim() || "Georgia";

    const sprites = makeSprites(serif);

    let width = 0;
    let height = 0;
    let focal = 0;
    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      // 1× is plenty for a soft background, and 2.25× fewer pixels than 1.5×.
      canvas.width = width;
      canvas.height = height;
      focal = width / 2 / Math.tan(EDGE_ANGLE); // ±72° of drum fills the width
      draw();
    };

    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height * 0.45;
      for (const ring of rings) {
        for (let k = 0; k < ring.tokens.length; k++) {
          // Wrap into (-π, π] so codes flow round the drum.
          let a = ring.offset + k * TOKEN_ANGLE;
          a = ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
          if (Math.abs(a) > MAX_ANGLE) continue;

          const cos = Math.cos(a);
          const z = RADIUS * cos;
          const y = cy + (focal * ring.height) / z;
          const size = (focal * TEXT_HEIGHT) / z;
          if (y < -size * 2 || y > height + size * 2 || size > 140) continue;
          const x = cx + focal * Math.tan(a);

          const near = 1 - cos; // 0 at the far wall, → 1 at the sides
          const alpha = Math.min(0.9, (0.08 + 0.55 * near) * ring.bright) * OPACITY;
          if (alpha < 0.012) continue;
          const gold = ring.bright > 0.8 && near > 0.45;
          const sprite = sprites.get(gold ? `${ring.tokens[k]}*` : ring.tokens[k])!;

          // translate(x,y) · rotate(r) · scale(sx, s) in one matrix.
          const r = Math.atan((ring.height * Math.sin(a)) / RADIUS); // follow the ring's curve
          const s = size / SPRITE_PX;
          const sx = s * Math.min(1 / cos, 2.2) * 0.62; // the wall recedes: codes widen towards the sides
          const cr = Math.cos(r);
          const sr = Math.sin(r);
          ctx.globalAlpha = alpha;
          ctx.setTransform(cr * sx, sr * sx, -sr * s, cr * s, x, y);
          ctx.drawImage(sprite.canvas, -sprite.w / 2, -sprite.h / 2);
        }
      }
      ctx.globalAlpha = 1;
    };

    window.addEventListener("resize", resize);
    resize();

    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastDraw < FRAME_MS) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      lastDraw = now;
      for (const ring of rings) ring.offset += ring.speed * dt;
      draw();
    };

    const start = () => {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) start();
    };

    if (reduced) draw();
    else start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="currency-tunnel" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
