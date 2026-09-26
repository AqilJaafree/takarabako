import type { Metadata } from "next";
import type { Pool } from "@/lib/types";
import { loadPublic } from "@/lib/serverData";
import { KioskApp } from "./KioskApp";

export const metadata: Metadata = { title: "Takarabako Kiosk" };

/// The box's own screen. The old device-agent/public page stays on the Pi's
/// :8080 as a fallback.
export default async function KioskPage() {
  const pools = await loadPublic<{ pools: Pool[] }>("/agent/pools")
    .then((r) => r.pools)
    .catch(() => []);
  return <KioskApp pools={pools} testDeposit={process.env.KIOSK_TEST_DEPOSIT === "1"} />;
}
