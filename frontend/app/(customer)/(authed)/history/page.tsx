import type { Metadata } from "next";
import type { HistoryItem } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { HistoryList } from "./HistoryList";

export const metadata: Metadata = { title: "History · Takarabako" };

/// Everything that happened to the box: deposit receipts, withdrawals, yield
/// actions and notes the cash slot handed back. Newest first.
export default async function HistoryPage() {
  const { items } = await loadForPage<{ items: HistoryItem[] }>("/history?limit=100");
  return (
    <>
      <h1 style={{ fontSize: 26 }}>History</h1>
      <p className="muted">Every deposit, withdrawal and yield move — with the transaction behind it.</p>
      <HistoryList items={items} />
    </>
  );
}
