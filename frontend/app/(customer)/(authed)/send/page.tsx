import type { Metadata } from "next";
import type { Me, MyWallet } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import Link from "next/link";
import { usd } from "@/lib/format";
import { SendForm } from "./SendForm";

export const metadata: Metadata = { title: "Send · Takarabako" };

export default async function SendPage() {
  const [me, wallet] = await Promise.all([loadForPage<Me>("/me"), loadForPage<MyWallet>("/me/wallet")]);
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Send</h1>
      <p className="muted">
        Type another account&apos;s label, like <span className="mono">alice-1a2b</span>, or a wallet address. Sends stay on the chain you pick;
        to move your own money between chains use <Link href="/bridge">Bridge</Link>.
      </p>
      {wallet.limit?.limited && wallet.limit.leftUsd !== null && (
        <div className="notice pending">
          Every account can move {usd(wallet.limit.limitUsd, 0)} a day. <b>{usd(wallet.limit.leftUsd)} left today.</b>
        </div>
      )}
      <SendForm me={me} wallet={wallet} />
    </>
  );
}
