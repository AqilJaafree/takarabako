import type { Metadata } from "next";
import type { Market, Me, PositionView } from "@/lib/types";
import { loadForPage, loadPublic } from "@/lib/serverData";
import { YieldHub } from "./YieldHub";

export const metadata: Metadata = { title: "Yield · Takarabako" };

export default async function YieldPage() {
  const [me, market, { positions }] = await Promise.all([
    loadForPage<Me>("/me"),
    loadPublic<Market>("/yield/market"),
    loadForPage<{ positions: PositionView[] }>("/yield/positions"),
  ]);
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Grow your box</h1>
      <p className="muted">
        Put your balance to work as ETH/USDC liquidity on 1inch Aqua. Start simple, or draw your own price range.
      </p>
      <YieldHub balance={me.balance} market={market} positions={positions} />
    </>
  );
}
