import Link from "next/link";
import { Nav } from "@/components/Nav";
import { LogoutButton } from "@/components/LogoutButton";
import { ChatProvider } from "@/components/chat/ChatProvider";

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <ChatProvider>
    <main className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="kanji">宝箱</span> Takarabako
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
