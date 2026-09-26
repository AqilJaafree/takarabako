import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Log in · Takarabako" };

export default function LoginPage() {
  return (
    <main className="shell" style={{ maxWidth: 440, paddingTop: "12vh" }}>
      <div className="brand" style={{ justifyContent: "center", fontSize: 30, marginBottom: 8 }}>
        <span className="kanji">宝箱</span> Takarabako
      </div>
      <p className="muted" style={{ textAlign: "center", marginBottom: 28 }}>
        Your treasure box. Cash in at the kiosk, watch it grow here.
      </p>
      <LoginForm />
    </main>
  );
}
