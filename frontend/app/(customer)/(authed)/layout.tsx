import Link from "next/link";
import { Nav } from "@/components/Nav";
import { LogoutButton } from "@/components/LogoutButton";
import { ChatProvider } from "@/components/chat/ChatProvider";
import { BRAND_MARK } from "@/lib/theme";

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <ChatProvider>
    <main className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="kanji">{BRAND_MARK}</span> Takarabako
        </Link>
        <LogoutButton />
      </header>
      <Nav />
      {children}
      <footer className="app-foot">
        <a href="/ops">Treasury dashboard</a> · proof of reserve for every tkCASH
      </footer>
    </main>
    </ChatProvider>
  );
}
