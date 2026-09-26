import type { Metadata, Viewport } from "next";
import { Inter, Shippori_Mincho } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const mincho = Shippori_Mincho({ variable: "--font-mincho", subsets: ["latin"], weight: ["500", "700"] });

export const metadata: Metadata = {
  title: "Takarabako 宝箱",
  description: "Cash in at the box, watch it grow on-chain.",
};

export const viewport: Viewport = {
  themeColor: "#120807",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mincho.variable}`}>
      <body>{children}</body>
    </html>
  );
}
