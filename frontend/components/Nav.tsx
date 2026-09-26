"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "My box" },
  { href: "/qr", label: "My QR" },
  { href: "/yield", label: "Yield" },
  { href: "/withdraw", label: "Withdraw" },
  { href: "/history", label: "History" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
