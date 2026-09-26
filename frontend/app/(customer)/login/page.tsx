import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Log in · Takarabako" };

export default function LoginPage() {
  return (
    <main className="shell login-shell">
      <BoxCrest />
      <h1 className="login-title">
        <span className="kanji">宝箱</span> Takarabako
      </h1>
      <p className="login-tagline">Your treasure box. Cash in at the kiosk, watch it grow here.</p>
      <LoginForm />
      <ul className="login-perks">
        <li><span aria-hidden="true">💴</span>Cash in at the kiosk</li>
        <li><span aria-hidden="true">🌱</span>Grows with yield</li>
        <li><span aria-hidden="true">🏧</span>Out as cash or crypto</li>
      </ul>
    </main>
  );
}

/// A closed lacquered box with light rays and glints behind it.
function BoxCrest() {
  return (
    <div className="login-crest" aria-hidden="true">
      <div className="crest-rays" />
      <svg viewBox="0 0 160 130" className="crest-box">
        <defs>
          <linearGradient id="lq-lid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#d4382c" />
            <stop offset="0.6" stopColor="#b3261e" />
            <stop offset="1" stopColor="#7d1812" />
          </linearGradient>
          <linearGradient id="lq-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9c2018" />
            <stop offset="1" stopColor="#4f0e0a" />
          </linearGradient>
          <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fbe3a8" />
            <stop offset="0.5" stopColor="#e3b36a" />
            <stop offset="1" stopColor="#a8752f" />
          </linearGradient>
        </defs>
        {/* body */}
        <rect x="18" y="58" width="124" height="62" rx="6" fill="url(#lq-body)" />
        <rect x="18" y="58" width="124" height="62" rx="6" fill="none" stroke="url(#gold)" strokeWidth="2.5" />
        <path d="M18 72 H142" stroke="url(#gold)" strokeWidth="1.2" opacity="0.6" />
        {/* lid */}
        <path d="M12 58 V38 Q12 18 32 18 H128 Q148 18 148 38 V58 Z" fill="url(#lq-lid)" />
        <path d="M12 58 V38 Q12 18 32 18 H128 Q148 18 148 38 V58 Z" fill="none" stroke="url(#gold)" strokeWidth="2.5" />
        <path d="M24 30 Q30 24 42 24 H70" stroke="#fff" strokeOpacity="0.28" strokeWidth="3" strokeLinecap="round" fill="none" />
        <rect x="10" y="55" width="140" height="6" rx="2" fill="url(#gold)" />
        {/* corner fittings */}
        <path d="M12 42 V30 Q12 20 22 20 H34" stroke="url(#gold)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d="M148 42 V30 Q148 20 138 20 H126" stroke="url(#gold)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d="M18 106 V116 Q18 120 24 120 H34" stroke="url(#gold)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d="M142 106 V116 Q142 120 136 120 H126" stroke="url(#gold)" strokeWidth="5" fill="none" strokeLinecap="round" />
        {/* clasp */}
        <circle cx="80" cy="60" r="15" fill="url(#gold)" stroke="#8a5f2a" strokeWidth="1.5" />
        <circle cx="80" cy="60" r="10.5" fill="none" stroke="#8a5f2a" strokeWidth="1" opacity="0.7" />
        <text x="80" y="65" textAnchor="middle" fontSize="13" fontWeight="700" fill="#5a1410" fontFamily="serif">宝</text>
      </svg>
      <span className="crest-glint g1" />
      <span className="crest-glint g2" />
      <span className="crest-glint g3" />
    </div>
  );
}
