import type { Metadata } from "next";
import type { BridgeTransfer, Me } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { BridgeForm } from "./BridgeForm";

export const metadata: Metadata = { title: "Bridge · Takarabako" };

export default async function BridgePage() {
  const [me, { transfers }] = await Promise.all([loadForPage<Me>("/me"), loadForPage<{ transfers: BridgeTransfer[] }>("/bridge")]);
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Bridge</h1>
      <p className="muted">
        Move USDC from your box on one chain to your box on the other, using Circle&apos;s CCTP. Your tkCASH stays where the cash is, so only USDC moves.
      </p>
      <BridgeForm me={me} initial={transfers} />
    </>
  );
}
