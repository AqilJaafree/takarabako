import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";
import { BRAND_MARK, FESTIVE } from "@/lib/theme";

export const metadata: Metadata = { title: "Log in · Takarabako" };

export default function LoginPage() {
  return (
    <main className="shell login-shell">
      {FESTIVE ? <TajCrest /> : <BoxCrest />}
      <h1 className="login-title">
        <span className="kanji">{BRAND_MARK}</span> Takarabako
      </h1>
      <p className="login-tagline">
        {FESTIVE ? "Shubh Deepavali! Cash in at the kiosk, watch it glow here." : "Your treasure box. Cash in at the kiosk, watch it grow here."}
      </p>
      <LoginForm />
      <ul className="login-perks">
        <li><span aria-hidden="true">💴</span>Cash in at the kiosk</li>
        <li><span aria-hidden="true">🌱</span>Grows with yield</li>
        <li><span aria-hidden="true">🏧</span>Out as cash or crypto</li>
      </ul>
      <p className="login-ops">
        <a href="/ops">Treasury dashboard for operators →</a>
      </p>
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


/// The Deepavali crest: the Taj Mahal in gold, with light rays behind it.
function TajCrest() {
  return (
    <div className="login-crest" aria-hidden="true">
      <div className="crest-rays" />
      <svg viewBox="0 0 160 130" className="crest-box">
        <defs>
          <linearGradient id="taj-gold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff1c8" />
            <stop offset="0.55" stopColor="#e3b36a" />
            <stop offset="1" stopColor="#a8752f" />
          </linearGradient>
        </defs>
        <g fill="url(#taj-gold)">
          {/* minarets */}
          {[18, 142].map((x) => (
            <g key={x}>
              <rect x={x - 2.5} y={52} width={5} height={60} rx={1} />
              <rect x={x - 4} y={70} width={8} height={2} />
              <rect x={x - 4} y={88} width={8} height={2} />
              <path d={`M${x - 4} 52 Q${x} 42 ${x + 4} 52 Z`} />
              <rect x={x - 0.5} y={40} width={1} height={4} />
            </g>
          ))}
          {/* the hall, with chamfered corners */}
          <path d="M38 112 V78 L45 72 H115 L122 78 V112 Z" />
          {/* side domes (chhatris) */}
          {[50, 110].map((x) => (
            <g key={x}>
              <rect x={x - 6} y={64} width={12} height={8} />
              <path d={`M${x - 7} 65 Q${x} 50 ${x + 7} 65 Z`} />
              <rect x={x - 0.5} y={52} width={1} height={4} />
            </g>
          ))}
          {/* the drum and the great onion dome */}
          <rect x={62} y={60} width={36} height={13} />
          <path d="M59 62 C51 44 66 33 80 20 C94 33 109 44 101 62 Z" />
          <rect x={79.3} y={8} width={1.4} height={13} />
          <circle cx={80} cy={8} r={2} />
        </g>
        {/* arches */}
        <g fill="#2a0d38">
          <path d="M70 112 V93 Q70 83 80 78 Q90 83 90 93 V112 Z" />
          {[48, 104].map((x) => (
            <path key={x} d={`M${x} 112 V100 Q${x} 94 ${x + 4} 92 Q${x + 8} 94 ${x + 8} 100 V112 Z`} />
          ))}
          {[48, 104].map((x) => (
            <path key={`u${x}`} d={`M${x} 88 V82 Q${x} 78 ${x + 4} 77 Q${x + 8} 78 ${x + 8} 82 V88 Z`} />
          ))}
        </g>
        {/* the platform, with a row of diyas */}
        <rect x={6} y={112} width={148} height={6} rx={1.5} fill="url(#taj-gold)" />
        {[22, 42, 62, 80, 98, 118, 138].map((x) => (
          <g key={x}>
            <ellipse cx={x} cy={124} rx={4} ry={1.8} fill="#e3b36a" />
            <path d={`M${x} 116.5 Q${x + 1.6} 119.5 ${x} 122 Q${x - 1.6} 119.5 ${x} 116.5 Z`} fill="#ffcf6a" className="crest-flame" />
          </g>
        ))}
      </svg>
      <span className="crest-glint g1" />
      <span className="crest-glint g2" />
      <span className="crest-glint g3" />
    </div>
  );
}
