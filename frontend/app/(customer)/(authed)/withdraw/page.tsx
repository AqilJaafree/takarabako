import type { Metadata } from "next";
import type { Me } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { WithdrawForm } from "./WithdrawForm";

export const metadata: Metadata = { title: "Withdraw · Takarabako" };

export default async function WithdrawPage() {
  const me = await loadForPage<Me>("/me");
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Withdraw</h1>
      <p className="muted">
        Send everything in your box — vault balance and any yield positions — to your own wallet as USDC. No fee.
        For cash, withdraw at a kiosk.
      </p>
      <WithdrawForm balance={me.balance} positions={me.positions.length} wallet={me.privyWallet} />
    </>
  );
}
