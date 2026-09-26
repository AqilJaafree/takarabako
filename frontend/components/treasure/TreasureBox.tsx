"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import gsap from "gsap";
import { createGold, createLacquer } from "./materials";

// Box dimensions (world units). The top is open; the lid hinges at the back.
export const BOX = { w: 2.4, h: 0.85, d: 1.5, wall: 0.08 };
const MAX_COINS = 90;

/// Coins shown for a balance: logarithmic, so $2 and $2,000 both read.
export function coinCount(balance: number): number {
  if (!(balance > 0)) return 0;
  return Math.min(MAX_COINS, Math.round(6 + Math.log10(balance + 1) * 22));
}

/// Height of the gold mound inside the box: also logarithmic, full at ~$10k.
function moundHeight(balance: number): number {
  if (!(balance > 0)) return 0;
  return 0.3 + Math.min(1, Math.log10(balance + 1) / 4) * 0.45;
}

const RX = 0.95;
const RZ = 0.58;

// Coin i sits on a golden-angle spiral over the mound, so the pile spreads
// outward as coins are added and earlier coins never move.
function coinTransform(i: number, height: number, out: THREE.Object3D) {
  const r = Math.sqrt((i + 0.5) / MAX_COINS) * 0.92;
  const a = i * 2.39996;
  const x = Math.cos(a) * r * RX;
  const z = Math.sin(a) * r * RZ;
  const surface = Math.sqrt(Math.max(0, 1 - r * r));
  out.position.set(x, BOX.wall + height * surface + 0.02, z);
  // Tilt with the mound's slope, plus a little scatter.
  out.rotation.set(Math.sin(a) * r * 0.9 + Math.sin(i * 12.9898) * 0.2, a, -Math.cos(a) * r * 0.9 + Math.cos(i * 78.233) * 0.2);
}

function easeOutBack(x: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function Coins({ balance, gold }: { balance: number; gold: THREE.ShaderMaterial }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const mound = useRef<THREE.Mesh>(null);
  const born = useRef<number[]>([]);
  const shown = useRef(0);
  const height = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const geometry = useMemo(() => new THREE.CylinderGeometry(0.15, 0.15, 0.045, 20), []);
  const count = coinCount(balance);
  const targetHeight = moundHeight(balance);

  useFrame(({ clock }, delta) => {
    const m = mesh.current;
    if (!m) return;
    const t = clock.elapsedTime;
    // The mound eases toward its new height; new coins pop in one by one.
    height.current += (targetHeight - height.current) * Math.min(1, delta * 2.5);
    if (mound.current) {
      mound.current.visible = height.current > 0.01;
      mound.current.scale.set(RX, Math.max(0.001, height.current), RZ);
    }
    const first = shown.current;
    while (shown.current < count) {
      born.current[shown.current] = t + (shown.current - first) * 0.035;
      shown.current++;
    }
    if (shown.current > count) shown.current = count;
    m.count = shown.current;
    for (let i = 0; i < shown.current; i++) {
      const p = Math.min(1, Math.max(0, (t - born.current[i]) / 0.45));
      coinTransform(i, height.current, dummy);
      dummy.position.y += (1 - p) * 0.6;
      dummy.scale.setScalar(Math.max(0.001, easeOutBack(p)));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <mesh ref={mound} position={[0, BOX.wall, 0]} material={gold} visible={false}>
        <sphereGeometry args={[1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      <instancedMesh ref={mesh} args={[geometry, gold, MAX_COINS]} frustumCulled={false} />
    </>
  );
}

function Panel({ args, position, material }: { args: [number, number, number]; position: [number, number, number]; material: THREE.Material }) {
  return (
    <mesh position={position} material={material}>
      <boxGeometry args={args} />
    </mesh>
  );
}

export function TreasureBox({
  balance,
  lidOpen,
  glow,
  etchAnchor,
}: {
  balance: number;
  lidOpen: number;
  glow: number;
  /** Where the etched tx hash label is pinned (see Anchor in Scene). */
  etchAnchor: React.RefObject<THREE.Group | null>;
}) {
  const lacquer = useMemo(() => createLacquer(), []);
  const gold = useMemo(() => createGold(), []);
  const lid = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);

  useEffect(() => () => { lacquer.dispose(); gold.dispose(); }, [lacquer, gold]);

  useEffect(() => {
    if (lid.current) gsap.to(lid.current.rotation, { x: -lidOpen, duration: 0.9, ease: "power3.out" });
  }, [lidOpen]);

  useEffect(() => {
    gsap.to(gold.uniforms.uGlow, { value: glow, duration: 0.4, yoyo: glow > 0, repeat: glow > 0 ? 1 : 0 });
  }, [glow, gold]);

  useFrame(({ clock }) => {
    lacquer.uniforms.uTime.value = clock.elapsedTime;
    gold.uniforms.uTime.value = clock.elapsedTime;
    if (light.current) light.current.intensity = balance > 0 ? 2.2 + Math.sin(clock.elapsedTime * 1.7) * 0.4 : 0;
  });

  const { w, h, d, wall } = BOX;
  const trim = 0.05;
  return (
    <group>
      {/* body: floor + four walls, open top */}
      <Panel args={[w, wall, d]} position={[0, wall / 2, 0]} material={lacquer} />
      <Panel args={[w, h, wall]} position={[0, h / 2, d / 2 - wall / 2]} material={lacquer} />
      <Panel args={[w, h, wall]} position={[0, h / 2, -d / 2 + wall / 2]} material={lacquer} />
      <Panel args={[wall, h, d]} position={[w / 2 - wall / 2, h / 2, 0]} material={lacquer} />
      <Panel args={[wall, h, d]} position={[-w / 2 + wall / 2, h / 2, 0]} material={lacquer} />
      {/* gold trim: rim and base bands, front clasp */}
      <Panel args={[w + trim, trim, trim]} position={[0, h, d / 2]} material={gold} />
      <Panel args={[w + trim, trim, trim]} position={[0, h, -d / 2]} material={gold} />
      <Panel args={[trim, trim, d + trim]} position={[w / 2, h, 0]} material={gold} />
      <Panel args={[trim, trim, d + trim]} position={[-w / 2, h, 0]} material={gold} />
      <Panel args={[w + trim, trim * 1.4, d + trim]} position={[0, trim * 0.7, 0]} material={gold} />
      <Panel args={[0.32, 0.26, 0.04]} position={[0, h - 0.2, d / 2 + 0.01]} material={gold} />
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <Panel key={`${sx}${sz}`} args={[trim * 1.6, h, trim * 1.6]} position={[(sx * w) / 2, h / 2, (sz * d) / 2]} material={gold} />
        )),
      )}

      <Coins balance={balance} gold={gold} />
      <group ref={etchAnchor} position={[0, h + 0.25, 0.2]} />
      <pointLight ref={light} position={[0, h * 0.9, 0]} color="#ffc56b" distance={3.2} />

      {/* lid, hinged along the back top edge */}
      <group ref={lid} position={[0, h, -d / 2]} rotation={[-lidOpen, 0, 0]}>
        <Panel args={[w + 0.08, 0.1, d + 0.06]} position={[0, 0.05, d / 2]} material={lacquer} />
        <Panel args={[w + 0.1, 0.1, trim]} position={[0, 0.05, d + 0.03]} material={gold} />
        <mesh position={[0, 0.105, d / 2]} rotation={[-Math.PI / 2, 0, 0]} material={gold}>
          <ringGeometry args={[0.26, 0.31, 40]} />
        </mesh>
      </group>
    </group>
  );
}
