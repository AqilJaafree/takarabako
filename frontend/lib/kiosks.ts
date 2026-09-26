/// Where the Takarabako kiosks are. One for now: the box at the ETHTokyo
/// hackathon venue. `id` matches the backend's KIOSK_ID (and its ENS name).

export interface KioskLocation {
  id: string;
  ens: string;
  name: string;
  lat: number;
  lng: number;
  venue: string;
  floor: "5F";
  spot: string;
  hours: string;
  accepts: string;
}

export const KIOSKS: KioskLocation[] = [
  {
    id: "tokyo-01",
    ens: "tokyo-01.takarabako.eth",
    name: "Takarabako · ETHTokyo",
    lat: 35.66700139908581,
    lng: 139.7491968121778,
    venue: "ETHTokyo hackathon venue",
    floor: "5F",
    spot: "Hacking Space (north side), by the windows",
    hours: "Open during the hackathon",
    accepts: "Malaysian ringgit notes (RM1–RM100)",
  },
];

/// Great-circle distance in metres.
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const directionsUrl = (k: KioskLocation) =>
  `https://www.google.com/maps/dir/?api=1&destination=${k.lat},${k.lng}&travelmode=walking`;
