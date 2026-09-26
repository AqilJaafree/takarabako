"use client";

import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useBoxTransition } from "./BoxTransition";

export function LogoutButton() {
  const { logout } = usePrivy();
  const box = useBoxTransition();
  const [busy, setBusy] = useState(false);

  async function onLogout() {
    setBusy(true);
    // The box shuts over the page while the session ends behind it.
    await box.closeTo("/login", async () => {
      await fetch("/api/session", { method: "DELETE" }).catch(() => {});
      await logout().catch(() => {});
    });
  }

  return (
    <button className="btn btn-ghost small" onClick={onLogout} disabled={busy}>
      {busy ? "…" : "Log out"}
    </button>
  );
}
