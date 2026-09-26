import type { Metadata } from "next";
import type { Me, Pool } from "@/lib/types";
import { loadForPage, loadPublic } from "@/lib/serverData";
import { YieldPicker } from "./YieldPicker";

export const metadata: Metadata = { title: "Yield · Takarabako" };

export default async function YieldPage() {
  const [me, { pools }] = await Promise.all([loadForPage<Me>("/me"), loadPublic<{ pools: Pool[] }>("/agent/pools")]);
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Grow your box</h1>
      <p className="muted">
        Pick a risk level. The Takarabako agent puts your balance into a real Uniswap v3 pool on Sepolia and tells
        you why.
      </p>
      <YieldPicker balance={me.balance} pools={pools} positions={me.positions} />
    </>
  );
}
