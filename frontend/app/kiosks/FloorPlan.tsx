"use client";

import { useState } from "react";

/// The venue, indoors: a schematic of floors 5F and 4F (after the event's
/// floor plan). 5F draws the walking route from the elevators and stairs to
/// the kiosk in the south Hacking Space; 4F (main stage and judging) points
/// back up to 5F.

type Floor = "5F" | "4F";

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  kind?: "target" | "stage" | "service" | "seating" | "stairs";
}

const FLOOR_5F: Room[] = [
  { x: 228, y: 140, w: 46, h: 66, label: "Snacks", kind: "service" },
  { x: 290, y: 140, w: 46, h: 66, label: "Photo", kind: "service" },
  { x: 352, y: 72, w: 142, h: 158, label: "Catering" },
  { x: 502, y: 72, w: 210, h: 158, label: "Hacking Space", sub: "North" },
  { x: 722, y: 92, w: 44, h: 138, label: "", kind: "seating" },
  { x: 800, y: 72, w: 104, h: 158, label: "Restrooms", kind: "service" },
  { x: 150, y: 238, w: 72, h: 48, label: "Registration", kind: "service" },
  { x: 300, y: 282, w: 32, h: 156, label: "", kind: "stairs" },
  { x: 410, y: 282, w: 290, h: 156, label: "Seating", kind: "seating" },
  { x: 846, y: 342, w: 96, h: 56, label: "Workshop", kind: "service" },
  { x: 846, y: 410, w: 86, h: 56, label: "Chill space", kind: "service" },
  { x: 300, y: 492, w: 156, h: 26, label: "Spotlight", kind: "stage" },
  { x: 300, y: 528, w: 432, h: 110, label: "Hacking Space", sub: "South", kind: "target" },
  { x: 262, y: 652, w: 148, h: 22, label: "Partners", kind: "service" },
  { x: 420, y: 652, w: 108, h: 22, label: "Mentors", kind: "service" },
  { x: 538, y: 652, w: 168, h: 22, label: "Partners", kind: "service" },
];

const FLOOR_4F: Room[] = [
  { x: 220, y: 74, w: 256, h: 168, label: "Judging Rooms", sub: "Finalists · Sun 9:30–12:00", kind: "stage" },
  { x: 488, y: 62, w: 180, h: 180, label: "Main Stage", kind: "stage" },
  { x: 676, y: 96, w: 46, h: 146, label: "", kind: "stage" },
  { x: 760, y: 92, w: 96, h: 150, label: "Restrooms", kind: "service" },
  { x: 414, y: 226, w: 44, h: 28, label: "Water", kind: "service" },
  { x: 400, y: 286, w: 32, h: 72, label: "", kind: "stairs" },
  { x: 270, y: 262, w: 30, h: 92, label: "", kind: "stairs" },
];

const OUTLINE_5F = "190,62 880,62 960,420 880,690 190,690 104,560 104,316";
const OUTLINE_4F = "150,210 220,70 480,40 700,60 900,80 910,380 150,380";

// Walking routes (SVG path in the same coordinates).
const ROUTE_5F = "M 350 372 L 370 372 L 370 474 L 472 474 L 472 594";
const ROUTE_4F = "M 578 244 L 578 300 L 300 300 L 285 262";

export function FloorPlan({ kioskId }: { kioskId: string }) {
  const [floor, setFloor] = useState<Floor>("5F");
  const rooms = floor === "5F" ? FLOOR_5F : FLOOR_4F;

  return (
    <div className="floorplan">
      <div className="floor-tabs" role="tablist" aria-label="Floor">
        {(["5F", "4F"] as Floor[]).map((f) => (
          <button key={f} role="tab" aria-selected={floor === f} className={floor === f ? "is-on" : ""} onClick={() => setFloor(f)}>
            {f}
            <span className="muted small">{f === "5F" ? "Hackathon · kiosk here" : "Main stage · judging"}</span>
          </button>
        ))}
      </div>

      <svg
        key={floor}
        className="floor-svg"
        viewBox={floor === "5F" ? "80 30 900 670" : "120 26 820 380"}
        role="img"
        aria-label={
          floor === "5F"
            ? `Floor 5F: from the elevators, walk down past the Spotlight stage into the south Hacking Space. Kiosk ${kioskId} is by the Partners and Mentor Station.`
            : "Floor 4F: main stage and judging rooms. The kiosk is one floor up on 5F — take the stairs or elevator up."
        }
      >
        <polygon points={floor === "5F" ? OUTLINE_5F : OUTLINE_4F} className="fp-outline" />
        {rooms.map((r, i) => (
          <g key={i} className={`fp-room ${r.kind ?? ""}`}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={6} />
            {r.kind === "stairs" && (
              <g className="fp-steps">
                {Array.from({ length: Math.floor(r.h / 12) }, (_, k) => (
                  <line key={k} x1={r.x + 4} x2={r.x + r.w - 4} y1={r.y + 8 + k * 12} y2={r.y + 8 + k * 12} />
                ))}
              </g>
            )}
            {r.label && (
              <text
                x={r.kind === "target" ? r.x + r.w * 0.64 : r.x + r.w / 2}
                y={r.y + r.h / 2 + (r.sub ? -4 : 5)}
                textAnchor="middle"
                className={r.h < 30 || r.w < 60 ? "fp-label small" : "fp-label"}
              >
                {r.label}
              </text>
            )}
            {r.sub && (
              <text x={r.kind === "target" ? r.x + r.w * 0.64 : r.x + r.w / 2} y={r.y + r.h / 2 + 16} textAnchor="middle" className="fp-sub">
                {r.sub}
              </text>
            )}
          </g>
        ))}

        {floor === "5F" ? (
          <>
            <text x={316} y={458} textAnchor="middle" className="fp-sub">Elevators</text>
            <path d={ROUTE_5F} className="fp-route-glow" />
            <path d={ROUTE_5F} className="fp-route" pathLength={1} />
            <path d={ROUTE_5F} className="fp-route-march" />
            <g className="fp-start" transform="translate(350 372)">
              <circle r="9" />
              <text x="-60" y="5" textAnchor="end" className="fp-sub">You arrive here</text>
            </g>
            <g className="fp-kiosk" transform="translate(472 610)">
              <circle className="ring" r="14" />
              <circle className="ring r2" r="14" />
              <circle className="head" r="15" />
              <text y="6" textAnchor="middle" className="glyph">宝</text>
              <text x="-26" y="5" textAnchor="end" className="fp-kiosk-label">{kioskId} kiosk ▸</text>
            </g>
          </>
        ) : (
          <>
            <text x={416} y={378} textAnchor="middle" className="fp-sub">Elevators</text>
            <path d={ROUTE_4F} className="fp-route-glow" />
            <path d={ROUTE_4F} className="fp-route" pathLength={1} />
            <path d={ROUTE_4F} className="fp-route-march" />
            <g className="fp-up" transform="translate(285 240)">
              <path d="M -12 8 L 0 -8 L 12 8" />
              <text x="0" y="-18" textAnchor="middle" className="fp-kiosk-label">Up to 5F — kiosk upstairs</text>
            </g>
          </>
        )}
      </svg>

      <ol className="floor-steps">
        {floor === "5F" ? (
          <>
            <li>Take the elevator or stairs to <b>5F</b> (the hackathon floor).</li>
            <li>From the elevators, walk down past the <b>Spotlight</b> stage.</li>
            <li>Enter the <b>south Hacking Space</b>: the kiosk is near the <b>Partners</b> and <b>Mentor Station</b>.</li>
          </>
        ) : (
          <>
            <li>You&apos;re on <b>4F</b>: main stage and judging (daytime only).</li>
            <li>Head to the stairs by the exit, or the elevators, and go <b>up one floor</b>.</li>
            <li>On 5F, follow the route to the south Hacking Space.</li>
          </>
        )}
      </ol>
    </div>
  );
}
