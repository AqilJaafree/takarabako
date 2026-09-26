"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";

export function LogoutButton() {
  const router = useRouter();
  const { logout } = usePrivy();
  const [busy, setBusy] = useState(false);

  async function onLogout() {
    setBusy(true);
    await fetch("/api/session", { method: "DELETE" }).catch(() => {});
    await logout().catch(() => {});
    router.replace("/login");
    router.refresh();
  }

  return (
    <button className="btn btn-ghost small" onClick={onLogout} disabled={busy}>
      {busy ? "…" : "Log out"}
    </button>
  );
}
