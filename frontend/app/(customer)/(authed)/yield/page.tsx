import type { Metadata } from "next";
import type { Market, Me, PositionView } from "@/lib/types";
import type { NetworksResponse } from "@/lib/networks";
import { loadForPage, loadPublic } from "@/lib/serverData";
import { YieldHub } from "./YieldHub";
import { aquaBalance } from "@/lib/boxes";

export const metadata: Metadata = { title: "Yield · Takarabako" };

export default async function YieldPage() {
  const [me, market, networks, { positions }] = await Promise.all([
    loadForPage<Me>("/me"),
    loadPublic<Market>("/yield/market"),
    loadPublic<NetworksResponse>("/networks"),
    loadForPage<{ positions: PositionView[] }>("/yield/positions"),
  ]);
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Grow your box</h1>
      <YieldHub networks={networks} balance={aquaBalance(me.balances, market.network?.key)} market={market} positions={positions} />
    </>
  );
}
