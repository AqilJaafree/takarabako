"use client";

import { useEffect, useRef } from "react";

/// The Deepavali page background (in place of the currency drum): a night sky
/// with sky lanterns drifting up, a faint rangoli turning low behind the page,
/// and now and then a firework bursting near the top. Pure decoration: hidden
/// from assistive tech, no pointer events, static for reduced motion, paused
/// while the tab is hidden, drawn at 30 fps.

const FRAME_MS = 1000 / 30;
const LANTERNS = 34;
const GOLD = [255, 196, 92];
const COLOURS = [
  [255, 196, 92], // gold
  [255, 120, 190], // pink
  [190, 130, 255], // violet
  [120, 220, 255], // sky
  [255, 150, 80], // marigold
];

interface Lantern {
  x: number;
  y: number;
  size: number;
  speed: number;
  sway: number;
  phase: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  colour: number[];
}

/// A soft glowing lantern, drawn once and stamped each frame.
function lanternSprite(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, `rgba(${GOLD.join(",")}, 0.9)`);
  glow.addColorStop(0.25, `rgba(${GOLD.join(",")}, 0.45)`);
  glow.addColorStop(1, "rgba(255, 140, 60, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, 64, 64);
  // the lantern's paper body
  g.fillStyle = "rgba(255, 214, 140, 0.95)";
  g.beginPath();
  g.moveTo(26, 24);
  g.lineTo(38, 24);
  g.lineTo(36, 40);
  g.lineTo(28, 40);
  g.closePath();
  g.fill();
  g.fillStyle = "rgba(255, 250, 220, 1)";
  g.fillRect(29.5, 36, 5, 3);
  return c;
}

/// An eight-petal rangoli, drawn once.
function rangoliSprite(size: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  const r = size / 2;
  g.translate(r, r);
  const ring = (radius: number, petals: number, len: number, colour: string, width: number) => {
    g.strokeStyle = colour;
    g.lineWidth = width;
    for (let i = 0; i < petals; i++) {
      g.save();
      g.rotate((i / petals) * Math.PI * 2);
      g.beginPath();
      g.moveTo(0, radius);
      g.quadraticCurveTo(len * 0.45, radius + len * 0.5, 0, radius + len);
      g.quadraticCurveTo(-len * 0.45, radius + len * 0.5, 0, radius);
      g.stroke();
      g.restore();
    }
  };
  ring(r * 0.08, 8, r * 0.22, "rgba(255, 196, 92, 0.9)", 2);
  ring(r * 0.32, 16, r * 0.2, "rgba(255, 120, 190, 0.7)", 2);
  ring(r * 0.55, 24, r * 0.18, "rgba(190, 130, 255, 0.7)", 2);
  ring(r * 0.75, 32, r * 0.14, "rgba(255, 196, 92, 0.6)", 1.5);
  g.strokeStyle = "rgba(255, 196, 92, 0.5)";
  g.lineWidth = 1.5;
  for (const k of [0.3, 0.53, 0.73, 0.92]) {
    g.beginPath();
    g.arc(0, 0, r * k, 0, Math.PI * 2);
    g.setLineDash([2, 6]);
    g.stroke();
  }
  return c;
}

export function FestivalSky() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lantern = lanternSprite();
    const rangoli = rangoliSprite(900);
    let width = 0;
    let height = 0;
    let lanterns: Lantern[] = [];
    let sparks: Spark[] = [];
    let nextBurst = 1.5;
    let t = 0;

    // Per-lantern variety from its index, so a respawned lantern differs from the last.
    const seeded = (i: number, k: number) => {
      const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
      return v - Math.floor(v);
    };
    const spawn = (i: number, anywhere: boolean): Lantern => ({
      x: seeded(i, 1) * width,
      y: anywhere ? seeded(i, 2) * height : height + 40,
      size: 14 + seeded(i, 3) * 26,
      speed: 8 + seeded(i, 4) * 16,
      sway: 6 + seeded(i, 5) * 16,
      phase: seeded(i, 6) * Math.PI * 2,
    });

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
      lanterns = Array.from({ length: LANTERNS }, (_, i) => spawn(i, true));
      draw();
    };

    const burst = () => {
      const x = width * (0.12 + Math.random() * 0.76);
      const y = height * (0.08 + Math.random() * 0.22);
      const colour = COLOURS[Math.floor(Math.random() * COLOURS.length)];
      const n = 46;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const v = 60 + Math.random() * 50;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, colour });
      }
    };

    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // the rangoli, low and slowly turning
      const rs = Math.min(width * 1.1, 900);
      ctx.save();
      ctx.globalAlpha = 0.13;
      ctx.translate(width / 2, height * 1.02);
      ctx.rotate(t * 0.02);
      ctx.drawImage(rangoli, -rs / 2, -rs / 2, rs, rs);
      ctx.restore();

      // lanterns
      for (const l of lanterns) {
        const x = l.x + Math.sin(t * 0.4 + l.phase) * l.sway;
        const flicker = 0.75 + 0.25 * Math.sin(t * 3 + l.phase * 3);
        ctx.globalAlpha = Math.min(1, 0.25 + (l.size / 40) * 0.6) * flicker * Math.min(1, l.y / (height * 0.25));
        ctx.drawImage(lantern, x - l.size, l.y - l.size, l.size * 2, l.size * 2);
      }

      // fireworks
      ctx.globalCompositeOperation = "lighter";
      for (const s of sparks) {
        ctx.globalAlpha = Math.max(0, s.life) * 0.9;
        ctx.fillStyle = `rgb(${s.colour.join(",")})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 1.6 + s.life * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    };

    const step = (dt: number) => {
      t += dt;
      lanterns.forEach((l, i) => {
        l.y -= l.speed * dt;
        if (l.y < -60) lanterns[i] = spawn(i + Math.floor(t * 10), false);
      });
      nextBurst -= dt;
      if (nextBurst <= 0) {
        burst();
        nextBurst = 2.5 + Math.random() * 3.5;
      }
      for (const s of sparks) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vx *= 0.97;
        s.vy = s.vy * 0.97 + 30 * dt; // gravity
        s.life -= dt * 0.7;
      }
      sparks = sparks.filter((s) => s.life > 0);
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
      step(dt);
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
    <div className="festival-sky" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
