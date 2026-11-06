import type { Metadata, Viewport } from "next";
import { Inter, Shippori_Mincho, Yatra_One } from "next/font/google";
import { CurrencyTunnel } from "@/components/CurrencyTunnel";
import { FestivalSky } from "@/components/FestivalSky";
import { FESTIVE, BRAND_MARK, THEME } from "@/lib/theme";
import "./globals.css";
import "./theme-deepavali.css";
import "./theme-deepavali-extra.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const mincho = Shippori_Mincho({ variable: "--font-mincho", subsets: ["latin"], weight: ["500", "700"] });
// Only the Deepavali theme uses it, so it isn't preloaded (and never downloads otherwise).
const devanagari = Yatra_One({ variable: "--font-devanagari", subsets: ["devanagari", "latin"], weight: "400", preload: false });

export const metadata: Metadata = {
  title: `Takarabako ${BRAND_MARK}`,
  description: "Cash in at the box, watch it grow on-chain.",
};

export const viewport: Viewport = {
  themeColor: FESTIVE ? "#0f0712" : "#120807",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme={THEME} className={`${inter.variable} ${mincho.variable} ${devanagari.variable}`}>
      <body>
        {FESTIVE ? <FestivalSky /> : <CurrencyTunnel />}
        {children}
      </body>
    </html>
  );
}
