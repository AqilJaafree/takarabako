import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { Me } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { usd } from "@/lib/format";
import { VerifyStep } from "./VerifyStep";

export const metadata: Metadata = { title: "Verify · Takarabako" };

/// Straight after a customer creates their wallet: a World ID selfie, bound
/// to that wallet's address. Skippable — unverified accounts can still move
/// a limited amount a day.
export default async function VerifyPage() {
  const me = await loadForPage<Me>("/me");
  if (!me.worldId || me.worldId.verified) redirect("/");
  const limit = usd(me.limit?.limitUsd ?? 1000, 0);
  return (
    <section>
      <h1 style={{ fontSize: 26 }}>One selfie, and your box is fully open</h1>
      <p className="muted">
        Your wallet is ready. Take a quick selfie with <b>World ID</b> to prove it belongs to one real person. The proof is tied to
        your wallet <span className="mono">{me.ensName}</span>, and World ID never tells us who you are.
      </p>
      <div className="notice pending">
        Until you verify, everything you move — cash in, withdrawals, yield and sends — is limited to <b>{limit} a day</b>.
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <VerifyStep />
      </div>
    </section>
  );
}
