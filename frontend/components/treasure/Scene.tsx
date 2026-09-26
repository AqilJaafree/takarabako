"use client";

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { StageProps } from "./types";
import { BOX, TreasureBox } from "./TreasureBox";
import { FallingNote } from "./FallingNote";
import { Gems } from "./Gems";
import { CoinBurst } from "./CoinBurst";
import { ManekiNeko } from "./ManekiNeko";

/// The box on a slowly swaying plinth. The cat stays put so it always faces
/// the viewer.
function Plinth({ children }: { children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (group.current) group.current.rotation.y = -0.25 + Math.sin(clock.elapsedTime * 0.25) * 0.3;
  });
  return (
    <group ref={group}>
      <mesh position={[0, -0.12, 0]}>
        <cylinderGeometry args={[1.75, 1.9, 0.24, 64]} />
        <meshStandardMaterial color="#1f110e" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.66, 1.75, 64]} />
        <meshStandardMaterial color="#e3b36a" metalness={0.8} roughness={0.3} />
      </mesh>
      {children}
    </group>
  );
}

const TARGET = new THREE.Vector3(0.45, 0.55, 0);
const CAMERA_DIR = new THREE.Vector3(0.9, 3.85, 5.9).sub(TARGET);

/// Keeps the whole scene in frame: pulls the camera back on narrow (portrait)
/// canvases, where the default framing would crop the cat.
function Framing() {
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const pullBack = Math.max(1, 1.5 / aspect);
    camera.position.copy(TARGET).addScaledVector(CAMERA_DIR, pullBack);
    camera.lookAt(TARGET);
  }, [camera, size.width, size.height]);
  return null;
}

/// Pins a DOM element to a point in the scene each frame (the speech bubble
/// and the etched tx hash are plain DOM, positioned here).
function Anchor({ target, el }: { target: React.RefObject<THREE.Group | null>; el: React.RefObject<HTMLDivElement | null> }) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (!target.current || !el.current) return;
    target.current.getWorldPosition(v).project(camera);
    const x = ((v.x + 1) / 2) * size.width;
    const y = ((1 - v.y) / 2) * size.height;
    el.current.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  });
  return null;
}

export default function Scene(
  props: StageProps & {
    bubbleEl: React.RefObject<HTMLDivElement | null>;
    etchEl: React.RefObject<HTMLDivElement | null>;
  },
) {
  const { balance, notes, gems, mood, hop, burst, onNoteDone, bubbleEl, etchEl } = props;
  const bubbleAnchor = useRef<THREE.Group>(null);
  const etchAnchor = useRef<THREE.Group>(null);
  const lidOpen = burst > 0 || notes.some((n) => n.status === "pending") ? 2.1 : 1.8;
  const glow = notes.filter((n) => n.status === "confirmed").length;

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: TARGET.clone().add(CAMERA_DIR).toArray(), fov: 38 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      style={{ height: props.height ?? 340 }}
      aria-label="Your treasure box"
    >
      <Framing />
      <Anchor target={bubbleAnchor} el={bubbleEl} />
      <Anchor target={etchAnchor} el={etchEl} />

      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 6, 4]} intensity={1.6} color="#fff1dd" />
      <directionalLight position={[-4, 2, -3]} intensity={0.5} color="#ff9a7a" />

      <group position={[-0.45, 0, 0]}>
        <Plinth>
          <TreasureBox balance={balance} lidOpen={lidOpen} glow={glow} etchAnchor={etchAnchor} />
          {notes.map((n) => (
            <FallingNote key={n.id} note={n} onDone={onNoteDone} />
          ))}
          <CoinBurst burst={burst} />
        </Plinth>
        <Gems gems={gems} />
      </group>

      <group position={[2.2, 0, 0.45]} rotation={[0, -0.45, 0]} scale={0.95}>
        <ManekiNeko mood={mood} hop={hop} bubbleAnchor={bubbleAnchor} />
      </group>

      {/* soft contact shadow under the plinth */}
      <mesh position={[-0.45, -0.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[BOX.w * 1.1, 48]} />
        <meshBasicMaterial color="#000" transparent opacity={0.35} />
      </mesh>
    </Canvas>
  );
}
