"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import gsap from "gsap";
import type { StageNote } from "./types";
import { BOX } from "./TreasureBox";

// Stylised note colours per ringgit denomination (not a replica of the real notes).
const NOTE_COLOURS: Record<string, string> = {
  "MYR:1": "#2f64b5",
  "MYR:5": "#3f9a5b",
  "MYR:10": "#c2342b",
  "MYR:20": "#d9822b",
  "MYR:50": "#2b8f8f",
  "MYR:100": "#7b3fa0",
};

function noteTexture(note: StageNote): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  const base = NOTE_COLOURS[`${note.currency}:${note.amount}`] ?? "#4c8a4f";
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 6;
  g.strokeRect(8, 8, 240, 112);
  g.fillStyle = "rgba(255,255,255,0.18)";
  g.beginPath();
  g.arc(196, 64, 38, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 50px Georgia, serif";
  g.textBaseline = "middle";
  g.fillText(note.currency === "MYR" ? `RM${note.amount}` : `$${note.amount}`, 22, 66);
  g.font = "28px serif";
  g.fillText("宝", 182, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/// One deposit's note: drops in an arc into the box, hovers while the
/// transaction is pending, then melts into gold (confirmed) or greys and
/// sinks away (failed). Calls onDone when its exit animation finishes.
export function FallingNote({ note, onDone }: { note: StageNote; onDone: (id: string) => void }) {
  const group = useRef<THREE.Group>(null);
  const landed = useRef(false);
  const texture = useMemo(() => noteTexture(note), [note]);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.6, emissive: new THREE.Color("#000"), transparent: true }),
    [texture],
  );
  useEffect(() => () => { texture.dispose(); material.dispose(); }, [texture, material]);

  // Entrance.
  useEffect(() => {
    const g = group.current!;
    g.position.set(-0.6, 4.2, 0.9);
    g.rotation.set(0.6, 0.4, -0.5);
    const tl = gsap.timeline({ onComplete: () => { landed.current = true; } });
    tl.to(g.position, { x: 0.1, y: 2.2, z: 0.4, duration: 0.55, ease: "power1.in" })
      .to(g.position, { x: 0, y: BOX.h * 0.75, z: 0, duration: 0.45, ease: "bounce.out" })
      .to(g.rotation, { x: -Math.PI / 2 + 0.25, y: 0, z: 0.15, duration: 1.0, ease: "power2.out" }, 0);
    return () => { tl.kill(); };
  }, []);

  // Exit, once the deposit settles.
  useEffect(() => {
    const g = group.current;
    if (!g || note.status === "pending") return;
    const tl = gsap.timeline({ delay: landed.current ? 0 : 1.0, onComplete: () => onDone(note.id) });
    if (note.status === "confirmed") {
      tl.to(material.color, { r: 1, g: 0.78, b: 0.35, duration: 0.35 })
        .to(material.emissive, { r: 0.9, g: 0.6, b: 0.15, duration: 0.35 }, 0)
        .to(g.scale, { x: 0.05, y: 0.05, z: 0.05, duration: 0.6, ease: "back.in(2)" }, 0.3)
        .to(g.position, { y: BOX.wall + 0.2, duration: 0.6, ease: "power2.in" }, 0.3);
    } else {
      tl.to(material.color, { r: 0.45, g: 0.45, b: 0.45, duration: 0.5 })
        .to(g.position, { y: BOX.h + 0.3, duration: 0.8, ease: "power1.out" })
        .to(material, { opacity: 0, duration: 1.2, delay: 1.5 });
    }
    return () => { tl.kill(); };
  }, [note.status, note.id, material, onDone]);

  // Gentle bob while waiting for the chain.
  useFrame(({ clock }) => {
    if (!group.current || !landed.current || note.status !== "pending") return;
    group.current.position.y = BOX.h * 0.75 + Math.sin(clock.elapsedTime * 3) * 0.05;
  });

  return (
    <group ref={group}>
      <mesh material={material}>
        <planeGeometry args={[0.95, 0.47]} />
      </mesh>
    </group>
  );
}
