/// Chat with Maneki (backend customerChat.ts).

export type Card =
  | { type: "qr"; qr: string; dataUrl: string; expiresAt: string }
  | { type: "confirm_yield"; riskTier: "low" | "medium" | "high"; label: string; amountUsd: number; apyBps: number; range: string; reason: string }
  | { type: "confirm_withdraw"; amountUsd: number; wallet: string; reason: string }
  | { type: "link"; href: string; label: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: Array<{ name: string; type: string }>;
  cards: Card[];
  createdAt: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
