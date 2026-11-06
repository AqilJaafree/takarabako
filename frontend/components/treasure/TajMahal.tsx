"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { createGilt, createGold, createLacquer } from "./materials";

/// The Deepavali stage (in place of the treasure box): a gilded Taj Mahal on a
/// royal-blue lacquer plinth, a row of diya lamps along the front that light up as the balance
/// grows, and fireworks over the dome whenever a deposit confirms or money
/// leaves. Modelled in its own units; Scene scales it to the frame.

/// The onion dome's outline, from the drum up to the tip (radius, height).
const DOME: Array<[number, number]> = [
  [0.55, 0], [0.64, 0.12], [0.7, 0.32], [0.68, 0.52], [0.58, 0.74], [0.42, 0.92], [0.24, 1.07], [0.1, 1.19], [0.03, 1.27], [0, 1.3],
];
const PLATFORM = { w: 4.4, d: 3.2, h: 0.22 };
/// The lower tier of the plinth, under y = 0.
const BASE = { w: 4.9, d: 3.7, h: 0.14 };
const HALL = { r: 1.0, h: 1.15 };
const APOTHEM = HALL.r * Math.cos(Math.PI / 8);
export const DIYA_COUNT = 11;
const ARCH = new THREE.Color("#111a5c");
const DOME_SCALE = 1.08;
const GLINTS = 36;

/// How many diyas burn for a balance: logarithmic, so $1 and $1,000 both read.
export function litDiyas(balance: number): number {
  if (!(balance > 0)) return 0;
  return Math.min(DIYA_COUNT, 2 + Math.round(Math.log10(balance + 1) * 3));
}

function domeGeometry(scale = 1) {
  return new THREE.LatheGeometry(DOME.map(([r, h]) => new THREE.Vector2(r * scale, h * scale)), 40);
}

/// A pointed (Mughal) arch, as a flat shape with its base at y = 0.
function archShape(w: number, h: number) {
  const s = new THREE.Shape();
  const spring = h - w * 0.75; // where the curve starts
  s.moveTo(-w / 2, 0);
  s.lineTo(-w / 2, spring);
  s.quadraticCurveTo(-w / 2, h - w * 0.2, 0, h);
  s.quadraticCurveTo(w / 2, h - w * 0.2, w / 2, spring);
  s.lineTo(w / 2, 0);
  s.closePath();
  return new THREE.ShapeGeometry(s, 12);
}

/// A soft round glow, for the diya flames and the fireworks.
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function Minaret({ x, z, gilt, gold, dome }: { x: number; z: number; gilt: THREE.Material; gold: THREE.Material; dome: THREE.BufferGeometry }) {
  const h = 2.35;
  return (
    <group position={[x, PLATFORM.h, z]}>
      <mesh position={[0, h / 2, 0]} material={gilt}>
        <cylinderGeometry args={[0.1, 0.14, h, 16]} />
      </mesh>
      {[0.78, 1.52, 2.2].map((y) => (
        <mesh key={y} position={[0, y, 0]} material={gold}>
          <cylinderGeometry args={[0.18, 0.15, 0.05, 16]} />
        </mesh>
      ))}
      {/* an open lantern of four posts under the cupola */}
      {[0, 1, 2, 3].map((k) => (
        <mesh key={k} position={[Math.sin((k * Math.PI) / 2 + Math.PI / 4) * 0.09, h + 0.09, Math.cos((k * Math.PI) / 2 + Math.PI / 4) * 0.09]} material={gold}>
          <cylinderGeometry args={[0.012, 0.012, 0.18, 6]} />
        </mesh>
      ))}
      <mesh position={[0, h + 0.19, 0]} material={gold}>
        <cylinderGeometry args={[0.15, 0.13, 0.03, 12]} />
      </mesh>
      <mesh position={[0, h + 0.2, 0]} geometry={dome} material={gilt} />
      <mesh position={[0, h + 0.2 + 0.3, 0]} material={gold}>
        <cylinderGeometry args={[0.008, 0.016, 0.16, 6]} />
      </mesh>
    </group>
  );
}

/// Points on the front of the dome where the gold catches the light.
function glintPositions(domeBase: number) {
  const out = new Float32Array(GLINTS * 3);
  for (let i = 0; i < GLINTS; i++) {
    const k = 1 + Math.floor(((i * 7) % 17) / 17 * (DOME.length - 3));
    const [r, h] = DOME[k];
    const a = -1.3 + ((i * 0.618) % 1) * 2.6; // the front half, facing the camera
    out.set([Math.sin(a) * r * DOME_SCALE * 1.02, domeBase + h * DOME_SCALE, Math.cos(a) * r * DOME_SCALE * 1.02], i * 3);
  }
  return out;
}

/// Little stars of light winking on the gold.
function Glints({ domeBase, flame }: { domeBase: number; flame: THREE.Texture }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(glintPositions(domeBase), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(GLINTS * 3), 3));
    return g;
  }, [domeBase]);
  const material = useMemo(
    () => new THREE.PointsMaterial({ size: 0.22, map: flame, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    [flame],
  );
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const col = geometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < GLINTS; i++) {
      const k = Math.pow(Math.max(0, Math.sin(t * (0.9 + (i % 5) * 0.23) + i * 2.1)), 24) * 1.4;
      col.setXYZ(i, k, k * 0.9, k * 0.65);
    }
    col.needsUpdate = true;
  });
  return <points geometry={geometry} material={material} />;
}

function Diyas({ balance, flame }: { balance: number; flame: THREE.Texture }) {
  const lit = litDiyas(balance);
  const flames = useRef<Array<THREE.Sprite | null>>([]);
  const litAt = useRef<number[]>(Array(DIYA_COUNT).fill(-1));
  const light = useRef<THREE.PointLight>(null);
  const clay = useMemo(() => new THREE.MeshStandardMaterial({ color: "#b5562b", roughness: 0.7 }), []);
  const materials = useMemo(
    () => Array.from({ length: DIYA_COUNT }, () => new THREE.SpriteMaterial({ map: flame, color: "#ffb04a", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })),
    [flame],
  );
  useEffect(() => () => { clay.dispose(); materials.forEach((m) => m.dispose()); }, [clay, materials]);

  // Light them from the middle outwards, so a few lamps sit under the arch.
  const order = useMemo(() => {
    const mid = (DIYA_COUNT - 1) / 2;
    return Array.from({ length: DIYA_COUNT }, (_, i) => i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  }, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    order.forEach((i, rank) => {
      const on = rank < lit;
      if (on && litAt.current[i] < 0) litAt.current[i] = t + rank * 0.12;
      if (!on) litAt.current[i] = -1;
      const s = flames.current[i];
      if (!s) return;
      const grow = on ? Math.min(1, Math.max(0, (t - litAt.current[i]) / 0.5)) : 0;
      const flicker = 1 + Math.sin(t * 9 + i * 1.7) * 0.08 + Math.sin(t * 17 + i) * 0.05;
      s.scale.set(0.18 * grow, 0.3 * grow * flicker, 1);
      s.visible = grow > 0.01;
    });
    if (light.current) light.current.intensity = lit > 0 ? 0.9 + lit * 0.18 + Math.sin(t * 7) * 0.08 : 0;
  });

  const span = PLATFORM.w - 1.1; // clear of the front minarets
  return (
    <group position={[0, PLATFORM.h, PLATFORM.d / 2 - 0.18]}>
      {Array.from({ length: DIYA_COUNT }, (_, i) => {
        const x = -span / 2 + (span * i) / (DIYA_COUNT - 1);
        return (
          <group key={i} position={[x, 0, 0]}>
            <mesh material={clay} scale={[1, 0.5, 1]}>
              <sphereGeometry args={[0.08, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
            </mesh>
            <sprite ref={(el) => { flames.current[i] = el; }} position={[0, 0.1, 0]} material={materials[i]} />
          </group>
        );
      })}
      <pointLight ref={light} position={[0, 0.35, 0.2]} color="#ffad55" distance={4.5} />
    </group>
  );
}

const SPARKS = 120; // per firework
const MAX_SHELLS = 3;
const PALETTE = ["#ffcf6a", "#ff78be", "#c08cff", "#7fe0ff", "#ff9a52"].map((c) => new THREE.Color(c));

interface Shell {
  start: number;
  x: number;
  z: number;
  top: number;
  colour: THREE.Color;
  dirs: Float32Array;
}

/// Fireworks over the dome: each bump of `trigger` launches a couple of shells
/// that rise, burst into a sphere of sparks, droop and fade. World units.
export function Fireworks({ trigger, flame }: { trigger: number; flame: THREE.Texture }) {
  const points = useRef<THREE.Points>(null);
  const shells = useRef<Shell[]>([]);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARKS * MAX_SHELLS * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(SPARKS * MAX_SHELLS * 3), 3));
    return g;
  }, []);
  const material = useMemo(
    () => new THREE.PointsMaterial({ size: 0.5, map: flame, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    [flame],
  );
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);

  const fired = useRef(trigger);
  const pending = useRef(0);
  useEffect(() => {
    if (trigger > fired.current) pending.current += 2;
    fired.current = trigger;
  }, [trigger]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    while (pending.current > 0) {
      pending.current--;
      const dirs = new Float32Array(SPARKS * 3);
      for (let i = 0; i < SPARKS; i++) {
        // even directions on a sphere (golden spiral), with a little spread in speed
        const y = 1 - (2 * (i + 0.5)) / SPARKS;
        const r = Math.sqrt(1 - y * y);
        const a = i * 2.39996;
        const v = 0.85 + ((i * 37) % 10) / 40;
        dirs.set([Math.cos(a) * r * v, y * v, Math.sin(a) * r * v], i * 3);
      }
      shells.current.push({
        start: t + pending.current * 0.35,
        x: (Math.random() - 0.5) * 2.6,
        z: -0.4 + Math.random() * 0.6,
        top: 1.75 + Math.random() * 0.4,
        colour: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        dirs,
      });
      if (shells.current.length > MAX_SHELLS) shells.current.shift();
    }
    shells.current = shells.current.filter((s) => t - s.start < 2.8);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const col = geometry.attributes.color as THREE.BufferAttribute;
    (pos.array as Float32Array).fill(0);
    (col.array as Float32Array).fill(0);
    shells.current.forEach((s, k) => {
      const e = t - s.start;
      if (e < 0) return;
      const base = k * SPARKS;
      if (e < 0.6) {
        // the rocket climbing: one bright spark with a short trail
        const p = e / 0.6;
        for (let i = 0; i < 6; i++) {
          const q = Math.max(0, p - i * 0.04);
          pos.setXYZ(base + i, s.x, 0.2 + (s.top - 0.2) * (1 - (1 - q) * (1 - q)), s.z);
          col.setXYZ(base + i, 1 - i * 0.15, 0.85 - i * 0.12, 0.5 - i * 0.08);
        }
        return;
      }
      const b = e - 0.6;
      const fade = Math.max(0, 1 - b / 2.0);
      const spread = 0.85 * (1 - Math.exp(-b * 2.6));
      for (let i = 0; i < SPARKS; i++) {
        pos.setXYZ(base + i, s.x + s.dirs[i * 3] * spread, s.top + s.dirs[i * 3 + 1] * spread - b * b * 0.35, s.z + s.dirs[i * 3 + 2] * spread);
        const twinkle = 0.75 + 0.25 * Math.sin(t * 30 + i);
        const k = fade * twinkle * 1.6; // additive: brighter than 1 reads as a hot spark
        col.setXYZ(base + i, s.colour.r * k, s.colour.g * k, s.colour.b * k);
      }
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
    if (points.current) points.current.visible = shells.current.length > 0;
  });

  return <points ref={points} geometry={geometry} material={material} frustumCulled={false} visible={false} />;
}

export function useGlowTexture() {
  const tex = useMemo(() => glowTexture(), []);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

export function TajMahal({
  balance,
  glow,
  etchAnchor,
  flame,
}: {
  balance: number;
  /** Confirmed deposits so far: each one flashes the gold. */
  glow: number;
  etchAnchor: React.RefObject<THREE.Group | null>;
  flame: THREE.Texture;
}) {
  const gilt = useMemo(() => createGilt(), []);
  const gold = useMemo(() => createGold(), []);
  const lacquer = useMemo(() => createLacquer("#070b33", "#1f30a8"), []);
  const dome = useMemo(() => domeGeometry(DOME_SCALE), []);
  const smallDome = useMemo(() => domeGeometry(0.26), []);
  const tinyDome = useMemo(() => domeGeometry(0.22), []);
  const bigArch = useMemo(() => archShape(0.52, 0.98), []);
  const smallArch = useMemo(() => archShape(0.26, 0.4), []);
  const archMat = useMemo(() => new THREE.MeshBasicMaterial({ color: ARCH.clone(), side: THREE.DoubleSide }), []);
  const inlay = useMemo(() => new THREE.MeshBasicMaterial({ color: "#2b40d0" }), []);
  const halo = useMemo(
    () => new THREE.SpriteMaterial({ map: flame, color: "#ffc760", transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending }),
    [flame],
  );
  useEffect(
    () => () => {
      [gilt, gold, lacquer, archMat, inlay, halo].forEach((m) => m.dispose());
      [dome, smallDome, tinyDome, bigArch, smallArch].forEach((g) => g.dispose());
    },
    [gilt, gold, lacquer, archMat, inlay, halo, dome, smallDome, tinyDome, bigArch, smallArch],
  );

  const lit = litDiyas(balance) / DIYA_COUNT;
  // A newly confirmed deposit lights the gold and the arches up for a moment.
  const flash = useRef(0);
  const seen = useRef(glow);
  useEffect(() => {
    if (glow > seen.current) flash.current = 1;
    seen.current = glow;
  }, [glow]);

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const u = gilt.uniforms;
    u.uTime.value = t;
    gold.uniforms.uTime.value = t;
    lacquer.uniforms.uTime.value = t;
    u.uLit.value += (lit - u.uLit.value) * Math.min(1, delta * 1.5);
    flash.current = Math.max(0, flash.current - delta * 0.7);
    const f = flash.current * flash.current;
    u.uGlow.value = f;
    gold.uniforms.uGlow.value = f * 0.5;
    archMat.color.setRGB(ARCH.r + (1 - ARCH.r) * f, ARCH.g + (0.75 - ARCH.g) * f, ARCH.b + (0.35 - ARCH.b) * f);
    halo.opacity = 0.24 + 0.05 * Math.sin(t * 0.8) + 0.4 * f;
  });

  const roof = PLATFORM.h + HALL.h;
  const domeBase = roof + 0.05 + 0.3;
  const domeTop = domeBase + 1.3 * DOME_SCALE;
  const pishtaq = { w: 0.8, h: HALL.h + 0.24, d: 0.08 };
  return (
    <group>
      {/* the plinth: two tiers of royal-blue lacquer edged in gold */}
      <mesh position={[0, -BASE.h / 2, 0]} material={lacquer}>
        <boxGeometry args={[BASE.w, BASE.h, BASE.d]} />
      </mesh>
      <mesh position={[0, PLATFORM.h / 2, 0]} material={lacquer}>
        <boxGeometry args={[PLATFORM.w, PLATFORM.h, PLATFORM.d]} />
      </mesh>
      {[
        [0, PLATFORM.h, PLATFORM.d / 2, PLATFORM.w, 0],
        [0, PLATFORM.h, -PLATFORM.d / 2, PLATFORM.w, 0],
        [PLATFORM.w / 2, PLATFORM.h, 0, PLATFORM.d, Math.PI / 2],
        [-PLATFORM.w / 2, PLATFORM.h, 0, PLATFORM.d, Math.PI / 2],
        [0, 0, BASE.d / 2, BASE.w, 0],
        [BASE.w / 2, 0, 0, BASE.d, Math.PI / 2],
        [-BASE.w / 2, 0, 0, BASE.d, Math.PI / 2],
      ].map(([x, y, z, len, ry], k) => (
        <mesh key={k} position={[x, y, z]} rotation={[0, ry, 0]} material={gold}>
          <boxGeometry args={[len + 0.03, 0.03, 0.03]} />
        </mesh>
      ))}

      {/* the octagonal hall, a flat face to the front */}
      <mesh position={[0, PLATFORM.h + HALL.h / 2, 0]} rotation={[0, Math.PI / 8, 0]} material={gilt}>
        <cylinderGeometry args={[HALL.r, HALL.r, HALL.h, 8]} />
      </mesh>
      <mesh position={[0, roof + 0.025, 0]} rotation={[0, Math.PI / 8, 0]} material={gold}>
        <cylinderGeometry args={[HALL.r + 0.04, HALL.r + 0.04, 0.05, 8]} />
      </mesh>

      {/* the four great gateways (pishtaqs) rise above the roof; two small arches on each corner */}
      {Array.from({ length: 8 }, (_, k) => {
        const a = (k * Math.PI) / 4;
        const main = k % 2 === 0;
        return (
          <group key={k} rotation={[0, a, 0]}>
            {main ? (
              <group position={[0, PLATFORM.h, APOTHEM]}>
                <mesh position={[0, pishtaq.h / 2, pishtaq.d / 2]} material={gilt}>
                  <boxGeometry args={[pishtaq.w, pishtaq.h, pishtaq.d]} />
                </mesh>
                <mesh position={[0, 0.06, pishtaq.d + 0.003]} geometry={bigArch} material={archMat} />
                {/* lapis inlay framing the arch */}
                <mesh position={[0, 1.13, pishtaq.d + 0.004]} material={inlay}><boxGeometry args={[0.66, 0.025, 0.004]} /></mesh>
                <mesh position={[-0.33, 0.58, pishtaq.d + 0.004]} material={inlay}><boxGeometry args={[0.025, 1.1, 0.004]} /></mesh>
                <mesh position={[0.33, 0.58, pishtaq.d + 0.004]} material={inlay}><boxGeometry args={[0.025, 1.1, 0.004]} /></mesh>
                {/* a crest of little finials along the top */}
                {[-0.3, -0.15, 0, 0.15, 0.3].map((x) => (
                  <mesh key={x} position={[x, pishtaq.h + 0.04, pishtaq.d / 2]} material={gold}>
                    <coneGeometry args={[0.035, 0.09, 8]} />
                  </mesh>
                ))}
              </group>
            ) : (
              <group position={[0, PLATFORM.h, APOTHEM + 0.003]}>
                <mesh position={[0, 0.08, 0]} geometry={smallArch} material={archMat} />
                <mesh position={[0, 0.6, 0]} geometry={smallArch} material={archMat} />
              </group>
            )}
          </group>
        );
      })}
      <group ref={etchAnchor} position={[0, PLATFORM.h + 1.25, APOTHEM + 0.3]} />

      {/* a halo of warm light behind the dome */}
      <sprite position={[0, domeBase + 0.7, -0.5]} scale={[4.2, 4.2, 1]} material={halo} />

      {/* the drum, banded in gold, the great dome and its crowned finial */}
      <mesh position={[0, roof + 0.05 + 0.15, 0]} material={gilt}>
        <cylinderGeometry args={[0.6, 0.62, 0.3, 32]} />
      </mesh>
      {[roof + 0.07, domeBase - 0.01].map((y) => (
        <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={gold}>
          <torusGeometry args={[0.615, 0.025, 8, 40]} />
        </mesh>
      ))}
      <mesh position={[0, domeBase, 0]} geometry={dome} material={gilt} />
      {[0.075, 0.055, 0.04].map((r, k) => (
        <mesh key={r} position={[0, domeTop + 0.05 + k * 0.12, 0]} material={gold}>
          <sphereGeometry args={[r, 14, 10]} />
        </mesh>
      ))}
      <mesh position={[0, domeTop + 0.5, 0]} material={gold}>
        <coneGeometry args={[0.025, 0.28, 8]} />
      </mesh>
      <Glints domeBase={domeBase} flame={flame} />

      {/* chhatris on the four corners of the roof */}
      {Array.from({ length: 4 }, (_, k) => {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        const x = Math.sin(a) * 0.74;
        const z = Math.cos(a) * 0.74;
        return (
          <group key={k} position={[x, roof + 0.05, z]}>
            <mesh position={[0, 0.1, 0]} material={gilt}>
              <cylinderGeometry args={[0.15, 0.15, 0.2, 8]} />
            </mesh>
            <mesh position={[0, 0.2, 0]} geometry={smallDome} material={gold} />
            <mesh position={[0, 0.2 + 0.26 * 1.3 + 0.05, 0]} material={gold}>
              <coneGeometry args={[0.012, 0.1, 6]} />
            </mesh>
          </group>
        );
      })}

      {/* the four minarets */}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <Minaret key={`${sx}${sz}`} x={sx * (PLATFORM.w / 2 - 0.22)} z={sz * (PLATFORM.d / 2 - 0.22)} gilt={gilt} gold={gold} dome={tinyDome} />
        )),
      )}

      <Diyas balance={balance} flame={flame} />
    </group>
  );
}
