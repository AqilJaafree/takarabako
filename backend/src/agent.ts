import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { TIERS, type Tier } from "./aquaMath.js";
import { complete, llmReady } from "./llm.js";

/// The yield agent for the beginner tiers. The customer picks a risk tier;
/// Claude confirms the matching 1inch Aqua strategy against today's ETH price
/// and explains it in one honest sentence. It never overrides the customer's
/// choice, holds no keys, and a missing key or API failure falls back to a
/// plain rationale — the call is additive, never a hard dependency.

export interface TierInfo {
  riskTier: Tier;
  label: string;
  description: string;
  pair: string;
  apyBps: number; // estimate
  feeBps: number;
  fullRange: boolean;
  rangePct: number | null;
  priceLowUsd: number | null; // at today's price
  priceHighUsd: number | null;
}

/// The three beginner tiers, with ranges placed around today's ETH price.
export function getTiersInfo(spot: number | null): TierInfo[] {
  return (Object.values(TIERS)).map((t) => ({
    riskTier: t.tier,
    label: t.label,
    description: t.description,
    pair: "ETH/USDC",
    apyBps: t.apyEstBps,
    feeBps: t.feeBps,
    fullRange: t.rangePct === null,
    rangePct: t.rangePct,
    priceLowUsd: spot && t.rangePct !== null ? spot * (1 - t.rangePct / 100) : null,
    priceHighUsd: spot && t.rangePct !== null ? spot * (1 + t.rangePct / 100) : null,
  }));
}

const anthropic = !llmReady && config.agent.apiKey ? new Anthropic({ apiKey: config.agent.apiKey }) : null;

const RATIONALE_SYSTEM =
  "You are the yield agent for Takarabako, a cash-in kiosk that puts savings into 1inch Aqua " +
  "liquidity strategies on ETH/USDC. The customer already picked a risk tier; you never change it. " +
  "Write ONE short, honest sentence for a DeFi beginner explaining why the given strategy fits that " +
  "tier, mentioning the price range in dollars when there is one. APY figures are rough estimates from " +
  "the range width, not promises: if you mention one, say \"about\" or \"estimated\". Plain text only, no preamble.";

const DEFAULT_RATIONALE: Record<Tier, string> = {
  low: "Full-range ETH/USDC liquidity: it earns on every trade and swings the least, which suits a low-risk choice.",
  medium: "A ±25% range around today's ETH price earns more per dollar while ETH stays in that band, without being twitchy.",
  high: "A tight ±8% range earns the most while ETH holds steady, and pauses earning if the price moves past it.",
};

export async function tierRationale(tier: Tier, amount: number, spot: number): Promise<string> {
  const prompt = `Tier: ${tier}. Amount: $${amount}. ETH price now: $${spot.toFixed(0)}. Strategies:\n${JSON.stringify(getTiersInfo(spot), null, 2)}`;
  if (llmReady) {
    try {
      return (await complete(RATIONALE_SYSTEM, prompt, 1200)) || DEFAULT_RATIONALE[tier];
    } catch (err) {
      console.error("[agent] rationale failed, using the default:", err instanceof Error ? err.message : err);
      return DEFAULT_RATIONALE[tier];
    }
  }
  if (!anthropic) return DEFAULT_RATIONALE[tier];
  try {
    const response = await anthropic.messages.create({
      model: config.agent.model,
      max_tokens: 300,
      system: RATIONALE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text.trim();
    return text || DEFAULT_RATIONALE[tier];
  } catch (err) {
    console.error("[agent] rationale failed, using the default:", err instanceof Error ? err.message : err);
    return DEFAULT_RATIONALE[tier];
  }
}
