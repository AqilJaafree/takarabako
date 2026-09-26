import type { Metadata } from "next";
import { backendFetch } from "@/lib/backend";
import { KIOSKS } from "@/lib/kiosks";
import { KioskFinder } from "./KioskFinder";

export const metadata: Metadata = { title: "Find a kiosk · Takarabako" };
export const dynamic = "force-dynamic";

interface SummaryKiosk {
  kioskId: string;
  frozen: boolean;
}

/// Find a kiosk: public (no login), so anyone can find the box.
export default async function KiosksPage() {
  // Live status: a kiosk is "paused" only when its minting is frozen.
  const summary = await backendFetch<{ reserve?: { data?: { kiosks?: SummaryKiosk[] } } }>("/dashboard/summary").catch(() => null);
  const frozen = Object.fromEntries((summary?.reserve?.data?.kiosks ?? []).map((k) => [k.kioskId, k.frozen]));
  const kiosks = KIOSKS.map((k) => ({ ...k, status: summary ? (frozen[k.id] ? "paused" : "open") : "unknown" }) as const);
  return <KioskFinder kiosks={kiosks} />;
}
