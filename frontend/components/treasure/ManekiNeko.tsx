"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import gsap from "gsap";
import type { CatMood } from "./types";

const WHITE = "#fbf5ec";
const PINK = "#f3a6a0";
const RED = "#b3261e";
const GOLD = "#e3b36a";
const INK = "#241512";

/// The Takarabako agent's face: a procedural maneki-neko. Waves its raised
/// paw (faster when happy), blinks, hops on deposits and droops when
/// worried. Its speech bubble is a DOM overlay pinned to `bubbleAnchor`.
export function ManekiNeko({
  mood,
  hop,
  bubbleAnchor,
}: {
  mood: CatMood;
  hop: number;
  /** Where the speech bubble is pinned (see Anchor in Scene). */
  bubbleAnchor: React.RefObject<THREE.Group | null>;
}) {
  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const paw = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Group>(null);
  const earL = useRef<THREE.Mesh>(null);
  const earR = useRef<THREE.Mesh>(null);
  const tail = useRef<THREE.Group>(null);
  const nextBlink = useRef(2);

  useEffect(() => {
    if (!hop || !root.current) return;
    const tl = gsap.timeline();
    tl.to(root.current.position, { y: 0.45, duration: 0.18, ease: "power2.out" })
      .to(root.current.position, { y: 0, duration: 0.32, ease: "bounce.out" });
    return () => { tl.kill(); };
  }, [hop]);

  useEffect(() => {
    const droop = mood === "worried" ? 0.55 : 0;
    if (earL.current) gsap.to(earL.current.rotation, { z: 0.25 + droop, duration: 0.4 });
    if (earR.current) gsap.to(earR.current.rotation, { z: -0.25 - droop, duration: 0.4 });
    if (head.current) gsap.to(head.current.rotation, { z: mood === "thinking" ? 0.22 : mood === "worried" ? -0.12 : 0, duration: 0.5 });
  }, [mood]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (paw.current) {
      const speed = mood === "happy" ? 9 : mood === "worried" ? 0 : 3;
      paw.current.rotation.z = 0.35 + Math.sin(t * speed) * (speed ? 0.35 : 0);
    }
    if (tail.current) tail.current.rotation.z = Math.sin(t * 2) * 0.2;
    if (eyes.current) {
      if (t > nextBlink.current) nextBlink.current = t + 2.5 + Math.random() * 2.5;
      const closing = nextBlink.current - t > 2.35 && mood !== "worried";
      const target = mood === "worried" ? 0.45 : mood === "happy" ? 0.7 : 1;
      eyes.current.scale.y = closing ? 0.1 : target;
    }
    if (head.current) head.current.position.y = 1.02 + Math.sin(t * 1.6) * 0.015;
  });

  return (
    <group ref={root}>
      {/* body and belly */}
      <mesh position={[0, 0.42, 0]} scale={[0.62, 0.72, 0.55]}>
        <sphereGeometry args={[0.62, 32, 24]} />
        <meshStandardMaterial color={WHITE} roughness={0.55} />
      </mesh>
      {/* resting paw holding a gold koban */}
      <mesh position={[-0.2, 0.42, 0.33]} scale={[0.14, 0.12, 0.14]}>
        <sphereGeometry args={[1, 20, 16]} />
        <meshStandardMaterial color={WHITE} roughness={0.55} />
      </mesh>
      <mesh position={[0.02, 0.42, 0.36]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.6]}>
        <cylinderGeometry args={[0.15, 0.15, 0.04, 24]} />
        <meshStandardMaterial color={GOLD} metalness={0.9} roughness={0.25} />
      </mesh>
      {/* collar and bell */}
      <mesh position={[0, 0.78, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.3, 0.045, 12, 32]} />
        <meshStandardMaterial color={RED} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.72, 0.31]}>
        <sphereGeometry args={[0.07, 16, 12]} />
        <meshStandardMaterial color={GOLD} metalness={0.9} roughness={0.2} />
      </mesh>

      {/* raised, beckoning paw */}
      <group ref={paw} position={[0.34, 0.72, 0.1]}>
        <mesh position={[0.05, 0.22, 0]} scale={[0.12, 0.26, 0.12]}>
          <sphereGeometry args={[1, 20, 16]} />
          <meshStandardMaterial color={WHITE} roughness={0.55} />
        </mesh>
        <mesh position={[0.07, 0.44, 0.08]} scale={[0.06, 0.05, 0.03]}>
          <sphereGeometry args={[1, 12, 10]} />
          <meshStandardMaterial color={PINK} />
        </mesh>
      </group>

      {/* tail */}
      <group ref={tail} position={[-0.3, 0.2, -0.3]}>
        <mesh position={[-0.12, 0.12, 0]} rotation={[0, 0, 0.9]}>
          <capsuleGeometry args={[0.06, 0.3, 6, 12]} />
          <meshStandardMaterial color={WHITE} roughness={0.55} />
        </mesh>
      </group>

      {/* head */}
      <group ref={head} position={[0, 1.02, 0]}>
        <mesh scale={[1, 0.88, 0.9]}>
          <sphereGeometry args={[0.36, 32, 24]} />
          <meshStandardMaterial color={WHITE} roughness={0.55} />
        </mesh>
        <mesh ref={earL} position={[-0.2, 0.27, 0]} rotation={[0, 0, 0.25]}>
          <coneGeometry args={[0.11, 0.2, 16]} />
          <meshStandardMaterial color={WHITE} roughness={0.55} />
        </mesh>
        <mesh ref={earR} position={[0.2, 0.27, 0]} rotation={[0, 0, -0.25]}>
          <coneGeometry args={[0.11, 0.2, 16]} />
          <meshStandardMaterial color={WHITE} roughness={0.55} />
        </mesh>
        <mesh position={[-0.2, 0.26, 0.04]} rotation={[0, 0, 0.25]} scale={0.6}>
          <coneGeometry args={[0.11, 0.2, 16]} />
          <meshStandardMaterial color={PINK} />
        </mesh>
        <mesh position={[0.2, 0.26, 0.04]} rotation={[0, 0, -0.25]} scale={0.6}>
          <coneGeometry args={[0.11, 0.2, 16]} />
          <meshStandardMaterial color={PINK} />
        </mesh>
        <group ref={eyes} position={[0, 0.03, 0.29]}>
          <mesh position={[-0.12, 0, 0]} scale={[0.045, 0.06, 0.03]}>
            <sphereGeometry args={[1, 12, 10]} />
            <meshStandardMaterial color={INK} />
          </mesh>
          <mesh position={[0.12, 0, 0]} scale={[0.045, 0.06, 0.03]}>
            <sphereGeometry args={[1, 12, 10]} />
            <meshStandardMaterial color={INK} />
          </mesh>
        </group>
        <mesh position={[0, -0.06, 0.32]} scale={[0.035, 0.025, 0.02]}>
          <sphereGeometry args={[1, 12, 10]} />
          <meshStandardMaterial color={PINK} />
        </mesh>
        {/* cheeks */}
        <mesh position={[-0.2, -0.08, 0.24]} scale={[0.06, 0.035, 0.02]}>
          <sphereGeometry args={[1, 12, 10]} />
          <meshStandardMaterial color={PINK} transparent opacity={0.7} />
        </mesh>
        <mesh position={[0.2, -0.08, 0.24]} scale={[0.06, 0.035, 0.02]}>
          <sphereGeometry args={[1, 12, 10]} />
          <meshStandardMaterial color={PINK} transparent opacity={0.7} />
        </mesh>
      </group>

      <group ref={bubbleAnchor} position={[0, 1.5, 0]} />
    </group>
  );
}
