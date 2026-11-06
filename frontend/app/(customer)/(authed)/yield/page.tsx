import type { Metadata } from "next";
import type { Market, Me, PositionView } from "@/lib/types";
import type { NetworksResponse } from "@/lib/networks";
import { loadForPage, loadPublic } from "@/lib/serverData";
import { YieldHub } from "./YieldHub";

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
      <p className="muted">
        Earn trading fees on your balance with 1inch Aqua.
      </p>
      <YieldHub networks={networks} balance={me.balance} market={market} positions={positions} />
    </>
  );
}
