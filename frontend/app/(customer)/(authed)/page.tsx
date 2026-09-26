import type { CashReceipts, Deposit, Me } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { Dashboard } from "./Dashboard";

/// My box — rendered on the server with real numbers, then kept live by the
/// deposit stream (Dashboard).
export default async function HomePage() {
  const [me, { deposits }, receipts] = await Promise.all([
    loadForPage<Me>("/me"),
    loadForPage<{ deposits: Deposit[] }>("/deposits?limit=20"),
    // tkCASH is extra: if MultiBaas is down, My box still loads without it.
    loadForPage<CashReceipts>("/me/cash-receipts").catch(() => null),
  ]);
  return <Dashboard me={me} deposits={deposits} receipts={receipts} />;
}
