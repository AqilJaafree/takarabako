/// Where the Takarabako kiosks are. One for now: the box at ETHGlobal Mumbai,
/// Jio World Convention Centre. `id` matches the backend's KIOSK_ID and the id the kiosk is registered under;
/// `chain` is the chain its notes are credited on.

export interface KioskLocation {
  id: string;
  chain: "sepolia" | "arc-testnet" | "hedera-testnet";
  name: string;
  lat: number;
  lng: number;
  venue: string;
  /// The hall it stands in (where to walk in).
  hall: string;
  spot: string;
  hours: string;
  accepts: string;
}

export const KIOSKS: KioskLocation[] = [
  {
    id: "mumbai-01",
    chain: "sepolia",
    name: "Takarabako · ETHGlobal Mumbai",
    lat: 19.0641916,
    lng: 72.8674424,
    venue: "Jio World Convention Centre (JWCC), BKC",
    hall: "Pavilion 2",
    spot: "Main Stage, by the Partners wall",
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
