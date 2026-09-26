import type { Address } from "viem";
import QRCode from "qrcode";
import { pool } from "./db.js";
import { config } from "./config.js";
import { findByPrivyUserId, type Account } from "./accounts.js";
import { listHistory } from "./history.js";
import { allowanceJson, dailyAllowance } from "./limits.js";
import { positionSummaries } from "./yieldPositions.js";
import { getTiersInfo } from "./agent.js";
import { ethUsd } from "./aqua.js";
import { chainReady, previewValueOnChain } from "./chain.js";
import { issueDepositCode } from "./depositCode.js";
import { chat, llmReady, type ChatMessage, type ContentPart, type ToolDef } from "./llm.js";

/// Chat with Maneki, the maneki-neko on every customer page. Its tools read
/// only the logged-in customer's own account. It never moves money: an
/// action (open a yield position, withdraw) comes back as a confirm card the
/// customer taps, which calls the same endpoints the app's buttons use.
/// Uploaded images and PDFs are read by the model and not stored.

export const chatReady = llmReady;

export type Card =
  | { type: "qr"; qr: string; dataUrl: string; expiresAt: string }
  | { type: "confirm_yield"; riskTier: "low" | "medium" | "high"; label: string; amountUsd: number; apyBps: number; range: string; reason: string }
  | { type: "confirm_withdraw"; amountUsd: number; wallet: string; reason: string }
  | { type: "link"; href: string; label: string };

export interface UploadedFile {
  name: string;
  type: string;
  dataUrl: string;
}

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: Array<{ name: string; type: string }>;
  cards: Card[];
  createdAt: Date;
}

const MAX_TURNS = 6;
const HISTORY_MESSAGES = 16; // earlier turns sent back as context

const SYSTEM = `You are Maneki, the lucky-cat assistant of Takarabako — a kiosk where people insert banknotes (Malaysian ringgit) that become savings on Ethereum: a yield vault (USDC), plus optional ETH/USDC liquidity strategies on 1inch Aqua (Steady, Balanced, Bold).
You talk with one logged-in customer. Be warm, brief and concrete: 1–4 short paragraphs or a short list, plain language, a light cat touch at most (an occasional "nya" is fine, never more).
Format numbers for people: money as $2.70 (two decimals), ringgit as RM10, dates and times as "27 Sep, 8:45 AM" — never raw timestamps, long decimals or field names.

Use tools for anything about this customer — balance, deposits, receipts, withdrawals, yield positions, daily limit, World ID — and only state numbers you got from a tool in this conversation. You only ever see this customer's own data.

You cannot move money. To help with an action, call propose_yield or propose_withdraw: the app shows the customer a confirm card and nothing happens until they tap Confirm. Say "I've prepared it — tap Confirm if it looks right", never "done". If the tool returns prepared:false, no card was made: say why (e.g. the box is empty) and don't mention Confirm.
- To show their deposit QR, call show_deposit_qr (it lasts 5 minutes; they show it to the kiosk camera).
- Yield advice: explain the trade-off (narrower range = higher estimated fees while ETH stays inside, pauses outside). APYs are estimates, not promises. It's a testnet (Sepolia) demo — no real money.
- A note marked "not credited" means the cash reached the box but the deposit didn't go through; tell them staff can re-credit it from the recorded note.
- If they upload a document or photo, read it carefully and give practical feedback; if it's unrelated to Takarabako, still help briefly.
Never ask for passwords, seed phrases or codes.`;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS: ToolDef[] = [
  { name: "get_my_account", description: "The customer's box: ENS name, balance (USD), wallet, vault APY, World ID status and today's deposit allowance.", parameters: obj({}) },
  {
    name: "get_my_history",
    description: "The customer's recent activity, newest first: deposit sessions with each note and its status, withdrawals, yield actions, refused notes.",
    parameters: obj({ limit: { type: "integer", description: "1 to 30" } }, ["limit"]),
  },
  { name: "get_my_yield_positions", description: "The customer's open yield strategies: value, APY estimate, price range, whether in range.", parameters: obj({}) },
  { name: "get_market", description: "Today's ETH price and the three beginner strategies (Steady/Balanced/Bold) with estimated APY and price range.", parameters: obj({}) },
  { name: "find_kiosk", description: "Where the Takarabako kiosk is and how to get there.", parameters: obj({}) },
  { name: "show_deposit_qr", description: "Makes a fresh 5-minute deposit QR and shows it in the chat for the kiosk camera.", parameters: obj({}) },
  {
    name: "propose_yield",
    description: "Prepares opening a beginner yield strategy. Shows a confirm card; nothing happens until the customer confirms.",
    parameters: obj(
      { riskTier: { type: "string", enum: ["low", "medium", "high"] }, amountUsd: { type: "number" }, reason: { type: "string", description: "One sentence on why this fits them" } },
      ["riskTier", "amountUsd", "reason"],
    ),
  },
  {
    name: "propose_withdraw",
    description: "Prepares withdrawing everything in the box to the customer's own wallet (no fee). Shows a confirm card; nothing happens until they confirm.",
    parameters: obj({ reason: { type: "string" } }, ["reason"]),
  },
];

const money = (n: number) => `$${n.toFixed(2)}`;

async function balanceOf(account: Account) {
  return chainReady ? previewValueOnChain(account.boundAddress as Address).catch(() => 0) : 0;
}

async function runTool(name: string, input: Record<string, unknown>, account: Account, cards: Card[]): Promise<unknown> {
  switch (name) {
    case "get_my_account": {
      const [balance, allowance] = await Promise.all([balanceOf(account), dailyAllowance(account)]);
      return {
        ensName: account.ensName,
        balanceUsd: balance,
        wallet: account.privyWallet,
        worldIdVerified: Boolean(account.worldVerifiedAt),
        dailyAllowance: allowanceJson(allowance),
      };
    }
    case "get_my_history": {
      const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 30);
      return listHistory(account.privyUserId, { limit });
    }
    case "get_my_yield_positions":
      return positionSummaries(account.privyUserId);
    case "get_market": {
      const spot = await ethUsd();
      return { ethUsd: spot, tiers: getTiersInfo(spot) };
    }
    case "find_kiosk":
      return {
        kiosk: `${config.kioskId}.${config.ens.parentName}`,
        where: "ETHTokyo hackathon venue, floor 5F, south Hacking Space by the Partners and Mentor Station",
        map: "/kiosks",
        accepts: "Malaysian ringgit notes",
      };
    case "show_deposit_qr": {
      const { qr, expiresAt } = await issueDepositCode(account.privyUserId);
      cards.push({ type: "qr", qr, dataUrl: await QRCode.toDataURL(qr, { width: 360, margin: 2 }), expiresAt: expiresAt.toISOString() });
      return { shown: true, expiresInMinutes: 5 };
    }
    case "propose_yield": {
      const tier = String(input.riskTier) as "low" | "medium" | "high";
      const amount = Number(input.amountUsd);
      const balance = await balanceOf(account);
      if (!["low", "medium", "high"].includes(tier)) throw new Error("riskTier must be low, medium or high");
      if (!(amount > 0)) throw new Error("amountUsd must be positive");
      if (amount > balance + 1e-9) return { prepared: false, reason: `only ${money(balance)} is in the box` };
      const spot = await ethUsd().catch(() => null);
      const t = getTiersInfo(spot).find((x) => x.riskTier === tier)!;
      const range = t.fullRange || t.priceLowUsd === null || t.priceHighUsd === null ? "full range" : `${money(t.priceLowUsd)} – ${money(t.priceHighUsd)}`;
      cards.push({ type: "confirm_yield", riskTier: tier, label: t.label, amountUsd: Math.floor(amount * 100) / 100, apyBps: t.apyBps, range, reason: String(input.reason ?? "") });
      return { prepared: true, awaitingCustomerConfirmation: true };
    }
    case "propose_withdraw": {
      const balance = await balanceOf(account);
      const positions = await positionSummaries(account.privyUserId);
      if (!(balance > 0) && positions.length === 0) return { prepared: false, reason: "the box is empty" };
      cards.push({ type: "confirm_withdraw", amountUsd: balance + positions.reduce((s, p) => s + Number(p.amount ?? 0), 0), wallet: account.privyWallet, reason: String(input.reason ?? "") });
      return { prepared: true, awaitingCustomerConfirmation: true };
    }
  }
  throw new Error(`unknown tool ${name}`);
}

// ---- sessions ----------------------------------------------------------

const MSG_COLUMNS = `id, role, content, attachments, cards, created_at as "createdAt"`;

export async function listSessions(privyUserId: string) {
  const { rows } = await pool.query(
    `select id, title, created_at as "createdAt", updated_at as "updatedAt" from chat_sessions where privy_user_id = $1 order by updated_at desc limit 50`,
    [privyUserId],
  );
  return rows;
}

export async function createSession(privyUserId: string) {
  const { rows } = await pool.query(
    `insert into chat_sessions (id, privy_user_id) values ($1, $2) returning id, title, created_at as "createdAt", updated_at as "updatedAt"`,
    [crypto.randomUUID(), privyUserId],
  );
  return rows[0];
}

async function ownSession(id: string, privyUserId: string) {
  const { rows } = await pool.query("select id, title from chat_sessions where id = $1 and privy_user_id = $2", [id, privyUserId]);
  return rows[0] ?? null;
}

export async function getSession(id: string, privyUserId: string) {
  const session = await ownSession(id, privyUserId);
  if (!session) return null;
  const { rows } = await pool.query(`select ${MSG_COLUMNS} from chat_messages where session_id = $1 order by created_at`, [id]);
  return { ...session, messages: rows as ChatMessageRow[] };
}

export async function deleteSession(id: string, privyUserId: string) {
  const { rowCount } = await pool.query("delete from chat_sessions where id = $1 and privy_user_id = $2", [id, privyUserId]);
  return rowCount === 1;
}

async function saveMessage(sessionId: string, m: { role: "user" | "assistant"; content: string; attachments?: unknown[]; cards?: Card[] }): Promise<ChatMessageRow> {
  const { rows } = await pool.query(
    `insert into chat_messages (id, session_id, role, content, attachments, cards) values ($1, $2, $3, $4, $5, $6) returning ${MSG_COLUMNS}`,
    [crypto.randomUUID(), sessionId, m.role, m.content, JSON.stringify(m.attachments ?? []), JSON.stringify(m.cards ?? [])],
  );
  return rows[0];
}

// ---- one turn ------------------------------------------------------------

export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/;

export function checkFiles(files: UploadedFile[]): string | null {
  if (files.length > MAX_FILES) return `Up to ${MAX_FILES} files at a time`;
  for (const f of files) {
    if (!ALLOWED.test(f.type)) return `${f.name}: only images and PDFs`;
    if (!f.dataUrl.startsWith(`data:${f.type};base64,`)) return `${f.name}: unreadable file`;
    const bytes = Math.floor(((f.dataUrl.length - f.dataUrl.indexOf(",") - 1) * 3) / 4);
    if (bytes > MAX_FILE_BYTES) return `${f.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`;
  }
  return null;
}

/// The customer's message in, Maneki's reply (with any cards) out. Both are
/// saved; earlier turns come back as context.
export async function sendChatMessage(sessionId: string, privyUserId: string, text: string, files: UploadedFile[]) {
  const session = await ownSession(sessionId, privyUserId);
  if (!session) return null;
  const account = await findByPrivyUserId(privyUserId);
  if (!account) return null;

  const { rows: previous } = await pool.query(
    `select role, content, attachments from chat_messages where session_id = $1 order by created_at desc limit $2`,
    [sessionId, HISTORY_MESSAGES],
  );
  const userRow = await saveMessage(sessionId, { role: "user", content: text, attachments: files.map((f) => ({ name: f.name, type: f.type })) });
  if (session.title === "New chat") {
    const title = (text || files[0]?.name || "New chat").replace(/\s+/g, " ").slice(0, 60);
    await pool.query("update chat_sessions set title = $2 where id = $1", [sessionId, title]);
  }

  const parts: ContentPart[] = [{ type: "text", text: text || "Please look at the attached file(s)." }];
  for (const f of files) {
    parts.push(f.type === "application/pdf" ? { type: "file", file: { filename: f.name, file_data: f.dataUrl } } : { type: "image_url", image_url: { url: f.dataUrl } });
  }
  const messages: ChatMessage[] = [
    { role: "system", content: `${SYSTEM}\nToday is ${new Date().toUTCString()}.` },
    ...previous.reverse().map((m) =>
      m.role === "user"
        ? { role: "user" as const, content: m.content + (m.attachments?.length ? `\n[attached earlier: ${m.attachments.map((a: { name: string }) => a.name).join(", ")}]` : "") }
        : { role: "assistant" as const, content: m.content },
    ),
    { role: "user", content: parts },
  ];

  const cards: Card[] = [];
  let answer = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { message } = await chat({ messages, tools: TOOLS, maxTokens: 5000 });
    messages.push({ role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
    if (!message.tool_calls?.length) {
      answer = (message.content ?? "").trim();
      break;
    }
    for (const call of message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {}
      let content: string;
      try {
        content = JSON.stringify(await runTool(call.function.name, input, account, cards));
      } catch (err) {
        content = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  if (!answer) answer = cards.length ? "Here you go — nya!" : "Sorry, I got tangled up. Could you ask that again?";
  const reply = await saveMessage(sessionId, { role: "assistant", content: answer, cards });
  await pool.query("update chat_sessions set updated_at = now() where id = $1", [sessionId]);
  return { user: userRow, reply };
}
