import { BRAND_GLYPH } from "@/lib/theme";

/// The venue, indoors: a schematic of the ETHGlobal Mumbai hall at Jio World
/// Convention Centre (after the event's venue map), with the walking route
/// from the Pavilion 2 entry to the kiosk at the Main Stage.

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  kind?: "target" | "stage" | "service" | "seating";
}

const ROOMS: Room[] = [
  // along the top wall
  { x: 35, y: 121, w: 175, h: 92, label: "Meal Catering", kind: "service" },
  { x: 110, y: 219, w: 100, h: 17, label: "Snacks", kind: "service" },
  { x: 230, y: 125, w: 45, h: 84, label: "Bags", kind: "service" },
  { x: 283, y: 125, w: 45, h: 84, label: "Chill", kind: "service" },
  { x: 335, y: 125, w: 45, h: 84, label: "WS 1", kind: "service" },
  { x: 388, y: 125, w: 45, h: 84, label: "WS 2", kind: "service" },
  { x: 452, y: 121, w: 303, h: 92, label: "Hacking Space" },
  // the middle of the hall
  { x: 35, y: 317, w: 40, h: 106, label: "", kind: "seating" },
  { x: 134, y: 243, w: 200, h: 102, label: "Hacking Space" },
  { x: 196, y: 354, w: 82, h: 28, label: "Activities", kind: "service" },
  { x: 189, y: 391, w: 144, h: 69, label: "Hacking Space" },
  { x: 400, y: 243, w: 180, h: 198, label: "Hacking Space" },
  { x: 606, y: 255, w: 18, h: 147, label: "", kind: "service" },
  { x: 640, y: 240, w: 99, h: 178, label: "Main Stage", kind: "target" },
  // the bottom row
  { x: 35, y: 437, w: 60, h: 82, label: "Registration", kind: "service" },
  { x: 148, y: 437, w: 26, h: 82, label: "", kind: "service" },
  { x: 189, y: 484, w: 144, h: 16, label: "Spotlight · Snacks", kind: "stage" },
  { x: 189, y: 517, w: 144, h: 22, label: "", kind: "seating" },
  { x: 397, y: 474, w: 42, h: 17, label: "Mentors", kind: "service" },
  { x: 447, y: 474, w: 83, h: 17, label: "Partners", kind: "service" },
  { x: 379, y: 507, w: 155, h: 32, label: "", kind: "seating" },
  { x: 556, y: 446, w: 183, h: 93, label: "Judging Rooms", sub: "Pragma (Fri)", kind: "stage" },
  // the restrooms, down the corridor
  { x: 189, y: 572, w: 31, h: 42, label: "WC", kind: "service" },
  { x: 256, y: 572, w: 147, h: 76, label: "Restrooms", kind: "service" },
];

const OUTLINE = "27,112 763,112 763,564 411,564 411,655 247,655 247,564 27,564";

// Walking route (SVG path in the same coordinates): in at Pavilion 2, along the aisle
// past the Spotlight stands, below the big Hacking Space, up beside the Partners wall.
const ROUTE = "M 52 600 L 52 530 L 124 530 L 124 467 L 368 467 L 368 456 L 592 456 L 592 428 L 652 428";
const KIOSK = { x: 652, y: 428 };

export function FloorPlan({ kioskId }: { kioskId: string }) {
  return (
    <div className="floorplan">
      <svg
        className="floor-svg"
        viewBox="10 96 770 572"
        role="img"
        aria-label={`The hall: walk in at the Pavilion 2 entry, past the Spotlight stands and below the big Hacking Space, then up beside the Partners wall. Kiosk ${kioskId} is at the front corner of the Main Stage.`}
      >
        <polygon points={OUTLINE} className="fp-outline" />
        {ROOMS.map((r, i) => (
          <g key={i} className={`fp-room ${r.kind ?? ""}`}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={5} />
            {r.label && (
              <text x={r.x + r.w / 2} y={r.y + r.h / 2 + (r.sub ? -4 : 5)} textAnchor="middle" className={r.h < 30 || r.w < 70 ? "fp-label small" : "fp-label"}>
                {r.label}
              </text>
            )}
            {r.sub && (
              <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 16} textAnchor="middle" className="fp-sub">
                {r.sub}
              </text>
            )}
          </g>
        ))}
        <text x={615} y={330} textAnchor="middle" className="fp-sub" transform="rotate(90 615 330)">Partners</text>

        <path d={ROUTE} className="fp-route-glow" />
        <path d={ROUTE} className="fp-route" pathLength={1} />
        <path d={ROUTE} className="fp-route-march" />
        <g className="fp-start" transform="translate(52 600)">
          <circle r="9" />
          <text x="16" y="5" className="fp-sub">Entry · Pavilion 2</text>
        </g>
        <g className="fp-kiosk" transform={`translate(${KIOSK.x} ${KIOSK.y})`}>
          <circle className="ring" r="14" />
          <circle className="ring r2" r="14" />
          <circle className="head" r="15" />
          <text y="6" textAnchor="middle" className="glyph">{BRAND_GLYPH}</text>
          <text x="38" y="-26" textAnchor="middle" className="fp-kiosk-label">{kioskId} ▾</text>
        </g>
      </svg>

      <ol className="floor-steps">
        <li>Walk in at the <b>Pavilion 2</b> entry, by Registration.</li>
        <li>Follow the aisle past the <b>Spotlight</b> stands and the <b>Mentor Station</b>.</li>
        <li>Turn up beside the <b>Partners</b> wall: the kiosk is at the front corner of the <b>Main Stage</b>.</li>
      </ol>
    </div>
  );
}
