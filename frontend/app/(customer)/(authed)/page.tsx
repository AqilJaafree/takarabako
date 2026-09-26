import type { Deposit, Me } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { Dashboard } from "./Dashboard";

/// My box — rendered on the server with real numbers, then kept live by the
/// deposit stream (Dashboard).
export default async function HomePage() {
  const [me, { deposits }] = await Promise.all([
    loadForPage<Me>("/me"),
    loadForPage<{ deposits: Deposit[] }>("/deposits?limit=20"),
  ]);
  return <Dashboard me={me} deposits={deposits} />;
}
