import Link from "next/link";
import { cookies } from "next/headers";
import { Nav } from "@/components/Nav";
import { LogoutButton } from "@/components/LogoutButton";
import { NetworkProvider, NetworkSelect } from "@/components/NetworkProvider";
import { ChatProvider } from "@/components/chat/ChatProvider";
import { BRAND_MARK } from "@/lib/theme";
import { NETWORK_COOKIE, type DepositChainInfo, type NetworkKey, type NetworksResponse } from "@/lib/networks";
import { loadPublic } from "@/lib/serverData";
import { backendFetch, sessionToken } from "@/lib/backend";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  // Every signed-in page has this layout, so a backend hiccup here only hides the network switch.
  const networks = await loadPublic<NetworksResponse>("/networks").catch(() => null);
  const token = await sessionToken("web");
  const deposit = token ? await backendFetch<DepositChainInfo>("/me/deposit-chain", { token }).catch(() => null) : null;
  // This browser's last choice, else the network the account mints on (a new device), else the default.
  const saved = (await cookies()).get(NETWORK_COOKIE)?.value ?? deposit?.chosen;
  const initial: NetworkKey | null = networks?.networks.find((n) => n.key === saved)?.key ?? networks?.active ?? null;
  return (
    <ChatProvider>
    <NetworkProvider networks={networks} initial={initial} deposit={deposit}>
    <main className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="kanji">{BRAND_MARK}</span> Takarabako
        </Link>
        <div className="topbar-actions">
          <NetworkSelect />
          <LogoutButton />
        </div>
      </header>
      <Nav />
      {children}
      <footer className="app-foot">
        <a href="/ops">Treasury dashboard</a> · proof of reserve for every tkCASH
      </footer>
    </main>
    </NetworkProvider>
    </ChatProvider>
  );
}
