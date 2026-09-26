"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { createGold } from "./materials";
import { BOX } from "./TreasureBox";

const COUNT = 36;
const DURATION = 2.2;

/// Withdraw: coins stream up out of the box and off toward the wallet
/// (top-right of the frame). Replays whenever `burst` changes.
export function CoinBurst({ burst }: { burst: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const started = useRef<number | null>(null);
  const gold = useMemo(() => createGold(), []);
  const geometry = useMemo(() => new THREE.CylinderGeometry(0.12, 0.12, 0.04, 16), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  // Per-coin launch offsets, fixed for the component's life.
  const seeds = useMemo(() => Array.from({ length: COUNT }, (_, i) => ({ delay: i * 0.035, spin: 4 + (i % 5), dx: ((i * 37) % 11) / 11 - 0.5 })), []);

  useEffect(() => () => { gold.dispose(); geometry.dispose(); }, [gold, geometry]);
  useEffect(() => {
    if (burst > 0) started.current = null; // start on the next frame
  }, [burst]);

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m || burst === 0) return;
    const t = clock.elapsedTime;
    if (started.current === null) started.current = t;
    const e = t - started.current;
    gold.uniforms.uTime.value = t;
    m.visible = e < DURATION + COUNT * 0.035;
    seeds.forEach((s, i) => {
      const p = Math.min(1, Math.max(0, (e - s.delay) / DURATION));
      // Rise out of the box, then arc away to the upper right.
      dummy.position.set(s.dx * 0.8 + p * p * 4.5, BOX.h * 0.6 + Math.sin(p * Math.PI * 0.8) * 2.6 + p * 1.2, p * 1.5);
      dummy.rotation.set(e * s.spin, e * 2, 0);
      dummy.scale.setScalar(p > 0 && p < 1 ? 1 - p * 0.5 : 0.001);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, gold, COUNT]} frustumCulled={false} visible={false} />;
}
