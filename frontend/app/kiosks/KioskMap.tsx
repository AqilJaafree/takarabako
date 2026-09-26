"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { LngLatBounds, Map as MapLibre, Marker, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { KioskLocation } from "@/lib/kiosks";

/// The city map: opens on Japan as a globe, flies down to the kiosk with
/// 3D buildings and a slow orbit, and — once the visitor shares their
/// location — draws an animated walking line from them to the box.
/// OpenFreeMap's dark style: free, no API key.

const STYLE = "https://tiles.openfreemap.org/styles/dark";
// Same-origin copy of MapLibre's worker (scripts/copy-maplibre-worker.mjs).
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

export interface KioskMapHandle {
  replay: () => void;
  showUser: (pos: { lat: number; lng: number }) => void;
}

function pinElement(label: string) {
  const el = document.createElement("div");
  el.className = "kiosk-pin";
  el.innerHTML = `<span class="kiosk-pin-ring"></span><span class="kiosk-pin-ring r2"></span><span class="kiosk-pin-head"><i>宝</i></span><span class="kiosk-pin-label">${label}</span>`;
  return el;
}

export default function KioskMap({ kiosk, onReady, ref }: { kiosk: KioskLocation; onReady?: () => void; ref?: Ref<KioskMapHandle> }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const orbit = useRef<number | null>(null);
  const dash = useRef<number | null>(null);
  const userMarker = useRef<Marker | null>(null);

  const stopOrbit = () => {
    if (orbit.current) cancelAnimationFrame(orbit.current);
    orbit.current = null;
  };

  const startOrbit = () => {
    const m = map.current;
    if (!m || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    stopOrbit();
    const spin = () => {
      m.setBearing(m.getBearing() + 0.04);
      orbit.current = requestAnimationFrame(spin);
    };
    orbit.current = requestAnimationFrame(spin);
  };

  const flyIn = () => {
    const m = map.current;
    if (!m) return;
    stopOrbit();
    m.jumpTo({ center: [138.4, 36.2], zoom: 3.6, pitch: 0, bearing: 0 });
    // Narrow screens need a little more context around the building.
    const zoom = m.getContainer().clientWidth < 600 ? 16.2 : 17.2;
    // Hold on Japan for a beat, then fly down to the box.
    window.setTimeout(() => {
      m.flyTo({ center: [kiosk.lng, kiosk.lat], zoom, pitch: 62, bearing: -28, duration: 6500, curve: 1.7, essential: true });
      m.once("moveend", startOrbit);
    }, 1200);
  };

  useImperativeHandle(ref, () => ({
    replay: flyIn,
    showUser: (pos) => {
      const m = map.current;
      if (!m) return;
      stopOrbit();
      if (!userMarker.current) {
        const el = document.createElement("div");
        el.className = "user-dot";
        userMarker.current = new Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(m);
      } else {
        userMarker.current.setLngLat([pos.lng, pos.lat]);
      }
      const line = { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[pos.lng, pos.lat], [kiosk.lng, kiosk.lat]] } };
      const src = m.getSource("walk") as GeoJSONSource | undefined;
      if (src) src.setData(line);
      else {
        m.addSource("walk", { type: "geojson", data: line });
        m.addLayer({ id: "walk-glow", type: "line", source: "walk", paint: { "line-color": "#e3b36a", "line-width": 10, "line-opacity": 0.18, "line-blur": 6 } });
        m.addLayer({ id: "walk", type: "line", source: "walk", layout: { "line-cap": "round" }, paint: { "line-color": "#e3b36a", "line-width": 3, "line-dasharray": [0, 2, 2] } });
        // March the dashes toward the kiosk.
        const steps = [[0, 2, 2], [0.5, 2, 1.5], [1, 2, 1], [1.5, 2, 0.5], [2, 2, 0], [0, 0.5, 2, 1.5], [0, 1, 2, 1], [0, 1.5, 2, 0.5]];
        let i = 0;
        const tick = () => {
          i = (i + 1) % steps.length;
          if (m.getLayer("walk")) m.setPaintProperty("walk", "line-dasharray", steps[i]);
          dash.current = window.setTimeout(() => requestAnimationFrame(tick), 70);
        };
        tick();
      }
      const bounds = new LngLatBounds([pos.lng, pos.lat], [pos.lng, pos.lat]).extend([kiosk.lng, kiosk.lat]);
      m.fitBounds(bounds, { padding: 90, pitch: 45, bearing: -20, maxZoom: 17, duration: 2500 });
    },
  }));

  useEffect(() => {
    if (!box.current) return;
    const m = new MapLibre({
      container: box.current,
      style: STYLE,
      center: [138.4, 36.2],
      zoom: 3.6,
      attributionControl: { compact: true },
      maxPitch: 70,
    });
    map.current = m;
    const stopOnTouch = () => stopOrbit();
    m.on("mousedown", stopOnTouch);
    m.on("touchstart", stopOnTouch);
    m.on("wheel", stopOnTouch);

    m.on("load", () => {
      m.setProjection({ type: "globe" });
      // Warm the base map into the app's lacquer tones: in this style land is
      // darker than water, which hides Japan's coastline from far out.
      if (m.getLayer("background")) m.setPaintProperty("background", "background-color", "#2a1915");
      if (m.getLayer("water")) m.setPaintProperty("water", "fill-color", "#080404");
      if (m.getLayer("waterway")) m.setPaintProperty("waterway", "line-color", "#080404");
      // 3D buildings in warm lacquer tones.
      if (m.getSource("openmaptiles")) {
        m.addLayer({
          id: "buildings-3d",
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 10], 0, "#2a1814", 120, "#4a2a20"],
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 10],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.88,
          },
        });
      }
      new Marker({ element: pinElement(`${kiosk.id} · ${kiosk.floor}`), anchor: "bottom" }).setLngLat([kiosk.lng, kiosk.lat]).addTo(m);
      onReady?.();
      flyIn();
    });

    return () => {
      stopOrbit();
      if (dash.current) clearTimeout(dash.current);
      m.remove();
      map.current = null;
    };
    // The map is created once per kiosk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiosk.id]);

  return <div ref={box} className="kiosk-map" role="region" aria-label={`Map showing ${kiosk.name}`} />;
}
