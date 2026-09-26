"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { StageGem } from "./types";

const TIER_COLOUR = { low: "#5fd1bd", medium: "#f0b85a", high: "#ff5a4a" } as const;

/// One gem per open Uniswap position, orbiting the box. Colour = risk tier,
/// pulse speed = APY.
export function Gems({ gems }: { gems: StageGem[] }) {
  const group = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    group.current?.children.forEach((child, i) => {
      const gem = gems[i];
      if (!gem) return;
      const a = t * 0.45 + (i / Math.max(1, gems.length)) * Math.PI * 2;
      child.position.set(Math.cos(a) * 1.9, 1.75 + Math.sin(t * 1.3 + i) * 0.12, Math.sin(a) * 1.2);
      child.rotation.y = t * 1.2;
      const mesh = child as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const speed = 1 + gem.apyBps / 300;
      mat.emissiveIntensity = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * speed * 2));
    });
  });

  return (
    <group ref={group}>
      {gems.map((g) => (
        <mesh key={g.id}>
          <octahedronGeometry args={[0.16, 0]} />
          <meshStandardMaterial color={TIER_COLOUR[g.riskTier]} emissive={TIER_COLOUR[g.riskTier]} metalness={0.2} roughness={0.15} flatShading />
        </mesh>
      ))}
    </group>
  );
}
