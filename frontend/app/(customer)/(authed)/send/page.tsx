import type { Metadata } from "next";
import type { Me, MyWallet } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { SendForm } from "./SendForm";
import { WorldIdCard } from "@/components/WorldIdCard";

export const metadata: Metadata = { title: "Send · Takarabako" };

export default async function SendPage() {
  const [me, wallet] = await Promise.all([loadForPage<Me>("/me"), loadForPage<MyWallet>("/me/wallet")]);
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Send by name</h1>
      <p className="muted">
        Type someone&apos;s ENS name — like <span className="mono">alice-1a2b.takarabako.eth</span>. It&apos;s looked up on ENS, so
        what you see is exactly where it goes.
      </p>
      {wallet.worldId && !wallet.worldId.verified && (
        <WorldIdCard verified={false} reason="Sending by name needs a verified human behind the account — it keeps limits per person and stops throwaway accounts." />
      )}
      <SendForm balance={me.balance} wallet={wallet} />
    </>
  );
}
