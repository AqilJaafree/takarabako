/// The site's look, chosen at build time with NEXT_PUBLIC_THEME:
/// - "mumbai" (default): the red-lacquer treasure box (宝箱) and the currency drum.
/// - "deepavali": purple and gold for Deepavali in Mumbai, with the Taj Mahal,
///   diya lamps and fireworks in place of the box.
/// The colours come from app/theme-deepavali.css (generated from globals.css by
/// scripts/gen-deepavali-css.mjs), switched on by data-theme on <html>.

export type Theme = "mumbai" | "deepavali";

export const THEME: Theme = process.env.NEXT_PUBLIC_THEME === "deepavali" ? "deepavali" : "mumbai";
export const FESTIVE = THEME === "deepavali";

/// The mark beside "Takarabako": 宝箱 (treasure box), or दीप (lamp) for Deepavali.
export const BRAND_MARK = FESTIVE ? "दीप" : "宝箱";
/// One glyph for small badges (the kiosk pin, the transition clasp).
export const BRAND_GLYPH = FESTIVE ? "✦" : "宝";
/// The cat's hello and goodbye.
export const GREETING = FESTIVE ? "Namaste!" : "いらっしゃいませ!";
export const FAREWELL = FESTIVE ? "Shubh Deepavali! 🪔" : "お疲れさま";
