import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config } from "./config.js";
import { POLICY, type ProposalAction } from "./policy.js";
import { createProposal } from "./proposals.js";
import { mb, mbError, mbEvents, mbQuery, multibaasReady } from "./multibaas.js";
import { executeProposal, reserveStatus, treasuryBalances, vaultState } from "./treasury.js";
import { recentEvents } from "./chainEvents.js";
import { checkAllKiosks, checkKiosk, type IntegrityReport } from "./integrity.js";
import { MANDATE, mandateStatus } from "./mandate.js";
import { chat, llmReady, type ChatMessage, type ToolDef } from "./llm.js";

/// The treasury ops agent (Curvegrid AI Agent track): a tool-use loop kept
/// separate from agent.ts's per-deposit tier rationale. It reads on-chain
/// state only through MultiBaas. It acts only through proposals: policy.ts
/// screens every one, actions inside its mandate (mandate.ts) execute at
/// once, and everything else waits for a human. It holds no keys itself.
/// Runs on an OpenAI-compatible API (llm.ts) when AI_API_KEY is set,
/// otherwise on Anthropic.

const anthropic = !llmReady && config.agent.apiKey ? new Anthropic({ apiKey: config.agent.apiKey }) : null;
export const opsAgentReady = (llmReady || Boolean(anthropic)) && multibaasReady;

const MAX_TURNS = 8;
const SAVED_QUERIES = [
  "cash_in_by_kiosk",
  "cash_in_by_denomination",
  "tkcash_holders",
  "deposits_by_user",
  "withdrawals",
  "aqua_pulled_by_token",
  "reserve_attestations",
] as const;

const mandateText = MANDATE.map(
  (r) => `- ${r.label}: ${r.autonomous ? (r.dailyLimit !== null ? `on your own up to ${r.dailyLimit} USDC a day` : "on your own") : "always needs a human"}`,
).join("\n");

const SYSTEM = `You are the treasury operations agent for Takarabako, a cash-in kiosk network on Ethereum Sepolia.
Customers insert banknotes at a kiosk; the treasury deposits the USD value into a yield vault (mUSDC) and mints tkCASH, a token that is a claim on the physical cash in that kiosk's box.

You answer operators' questions from live data and act when something needs doing. Ground every number in a tool result from this conversation, and say which tool it came from; if the data isn't available, say so rather than estimating.

You act only through the propose_* tools. Hard limits, enforced in code — a proposal that breaks one is rejected:
- vault APY between ${POLICY.minApyBps} and ${POLICY.maxApyBps} bps
- yield-reserve funding at most ${POLICY.maxYieldReserveFundingPerDay} USDC per UTC day
- float minting at most ${POLICY.maxFloatMintPerDay} mUSDC per UTC day
- pausing a kiosk is always allowed; unpausing is for humans only

Your mandate — what executes immediately, without a human:
${mandateText}
${config.opsAgent.autonomy ? "" : "(Autonomy is switched off right now: everything waits for a human.)\n"}A tool result with "executed": true was done on your own authority: say so, with the transaction. "proposed": true means it waits for an operator: say "proposed", never "done".

Cash integrity: check_cash_integrity compares three independent records per kiosk — notes signed by the kiosk's device key, tkCASH minted on-chain, and operators' physical counts. A short count means cash left the box after it was credited; a mint without a signed note means a deposit that didn't come from the box. Both are serious: pause the kiosk and say plainly what the numbers show and what a human should check.

Key health signals: vault reserveCoverage (below 1.2 means the yield reserve is getting thin), tkCASH supply vs total reserve (must be equal), attestation deltas (non-zero means a kiosk's count disagreed and its minting froze), and the treasury's Sepolia ETH (it pays gas for every deposit; below 0.05 ETH is urgent).

Answer in a few short paragraphs or a short list. Use plain language an operator can act on.`;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/// The tools, once, in a provider-neutral shape.
const TOOLS: ToolDef[] = [
  { name: "get_vault_state", description: "Vault APY, total liability to depositors, USDC it holds, and reserve coverage (balance ÷ liability).", parameters: obj({}) },
  { name: "get_reserve_status", description: "tkCASH supply vs total kiosk reserve, each kiosk's reserve/active/frozen state, and recent operator attestations.", parameters: obj({}) },
  { name: "get_treasury_balances", description: "The treasury wallet's Sepolia ETH (gas) and mUSDC float.", parameters: obj({}) },
  {
    name: "check_cash_integrity",
    description: "Reconciles a kiosk's machine-signed notes, on-chain tkCASH mints and physical counts over the last 7 days, and lists any findings. kioskId empty string = every kiosk.",
    parameters: obj({ kioskId: { type: "string" } }, ["kioskId"]),
  },
  { name: "get_mandate", description: "Your mandate: which actions you may execute on your own, the daily limits, and how much of each you've used today.", parameters: obj({}) },
  {
    name: "run_event_query",
    description: `Runs one of the saved MultiBaas Event Queries over indexed contract events: ${SAVED_QUERIES.join(", ")}. Amounts are raw 6-decimal integers (divide by 1,000,000 for USD); kioskId is hex-encoded bytes32 text.`,
    parameters: obj({ name: { type: "string", enum: [...SAVED_QUERIES] } }, ["name"]),
  },
  {
    name: "list_recent_events",
    description: "Most recent indexed contract events, newest first. contract is a MultiBaas label: takarabako_vault, takarabako_cash_receipt, mock_usdc, oneinch_aqua or ens_user_registry; empty string for all.",
    parameters: obj({ contract: { type: "string" }, limit: { type: "integer", description: "1 to 50" } }, ["contract", "limit"]),
  },
  {
    name: "lookup_alias",
    description: "Resolves a MultiBaas address alias (e.g. vault, tkcash, treasury, or a customer's ENS label) to its address and linked contracts.",
    parameters: obj({ alias: { type: "string" } }, ["alias"]),
  },
  {
    name: "propose_fund_yield_reserve",
    description: "Tops up the vault's yield reserve from the treasury's mUSDC. Executes at once within your mandate, otherwise waits for a human.",
    parameters: obj({ amount: { type: "number", description: "USDC" }, rationale: { type: "string" } }, ["amount", "rationale"]),
  },
  {
    name: "propose_set_apy",
    description: "Changes the vault's APY. Always waits for a human.",
    parameters: obj({ bps: { type: "integer" }, rationale: { type: "string" } }, ["bps", "rationale"]),
  },
  {
    name: "propose_pause_kiosk",
    description: "Takes a kiosk out of service (no new cash-ins). Within your mandate: executes at once.",
    parameters: obj({ kioskId: { type: "string" }, reason: { type: "string" }, rationale: { type: "string" } }, ["kioskId", "reason", "rationale"]),
  },
  {
    name: "propose_mint_usdc_float",
    description: "Mints mUSDC to the treasury so it can keep fronting deposits. Executes at once within your mandate, otherwise waits for a human.",
    parameters: obj({ amount: { type: "number", description: "USDC" }, rationale: { type: "string" } }, ["amount", "rationale"]),
  },
];

const ANTHROPIC_TOOLS: BetaTool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters as BetaTool["input_schema"],
  strict: true,
}));

const PROPOSE: Record<string, ProposalAction> = {
  propose_fund_yield_reserve: "fund_yield_reserve",
  propose_set_apy: "set_apy",
  propose_pause_kiosk: "pause_kiosk",
  propose_mint_usdc_float: "mint_usdc_float",
};

export interface TraceStep {
  tool: string;
  input: unknown;
  output: unknown;
  error?: boolean;
}

async function runTool(name: string, input: Record<string, unknown>, source: "ask" | "monitor", filed: string[]): Promise<unknown> {
  switch (name) {
    case "get_vault_state":
      return vaultState();
    case "get_reserve_status":
      return reserveStatus();
    case "get_treasury_balances":
      return treasuryBalances();
    case "check_cash_integrity": {
      const id = String(input.kioskId ?? "").trim();
      return id ? checkKiosk(id) : checkAllKiosks();
    }
    case "get_mandate":
      return mandateStatus();
    case "run_event_query": {
      const q = String(input.name);
      if (!(SAVED_QUERIES as readonly string[]).includes(q)) throw new Error(`not a saved query: ${q}`);
      return mbQuery(q, 100);
    }
    case "list_recent_events": {
      const limit = Math.min(Number(input.limit) || 20, 50);
      const contract = String(input.contract || "") || undefined;
      return mbEvents({ contractLabel: contract, limit }).catch(() => recentEvents(limit));
    }
    case "lookup_alias": {
      try {
        const { data } = await mb.addresses.getAddress(String(input.alias));
        return data.result;
      } catch (err) {
        throw mbError(err);
      }
    }
  }
  const action = PROPOSE[name];
  if (!action) throw new Error(`unknown tool ${name}`);
  const { rationale, ...args } = input;
  const result = await createProposal({ action, args, rationale: String(rationale ?? ""), source, execute: executeProposal });
  if (!result.ok) return { rejected: true, reason: result.reason };
  filed.push(result.proposal.id);
  const p = result.proposal;
  if (p.autonomous && p.status === "executed") return { executed: true, autonomous: true, proposalId: p.id, txHash: p.txHash };
  if (p.autonomous && p.status === "failed") return { executed: false, autonomous: true, proposalId: p.id, error: p.error };
  return { proposed: true, proposalId: p.id, status: "pending human approval", why: result.mandate };
}

export interface AgentRun {
  answer: string;
  trace: TraceStep[];
  proposalIds: string[];
  model: string;
}

async function useTool(name: string, input: Record<string, unknown>, source: "ask" | "monitor", trace: TraceStep[], filed: string[]) {
  try {
    const output = await runTool(name, input, source, filed);
    trace.push({ tool: name, input, output });
    return { ok: true as const, content: JSON.stringify(output) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    trace.push({ tool: name, input, output: message, error: true });
    return { ok: false as const, content: message };
  }
}

/// The loop on an OpenAI-compatible API (llm.ts).
async function runOpenAi(question: string, source: "ask" | "monitor"): Promise<AgentRun> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: question },
  ];
  const trace: TraceStep[] = [];
  const proposalIds: string[] = [];
  let model = config.ai.model;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { message, model: used } = await chat({ messages, tools: TOOLS, maxTokens: 6000 });
    model = used;
    messages.push({ role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
    if (!message.tool_calls?.length) {
      return { answer: (message.content ?? "").trim() || "(no answer)", trace, proposalIds, model };
    }
    const results = await Promise.all(
      message.tool_calls.map(async (call) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {}
        const r = await useTool(call.function.name, input, source, trace, proposalIds);
        return { role: "tool" as const, tool_call_id: call.id, content: r.content };
      }),
    );
    messages.push(...results);
  }
  return { answer: "Stopped after too many tool calls without a final answer.", trace, proposalIds, model };
}

/// The loop on Anthropic (when no AI_API_KEY is set).
async function runAnthropic(question: string, source: "ask" | "monitor"): Promise<AgentRun> {
  const messages: BetaMessageParam[] = [{ role: "user", content: question }];
  const trace: TraceStep[] = [];
  const proposalIds: string[] = [];
  let model = config.opsAgent.model;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic!.beta.messages.create({
      model: config.opsAgent.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // A policy decline re-runs on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      tools: ANTHROPIC_TOOLS,
      messages,
    });
    model = response.model;
    if (response.stop_reason === "refusal") {
      return { answer: "The model declined to answer this request.", trace, proposalIds, model };
    }
    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      return { answer: answer || "(no answer)", trace, proposalIds, model };
    }
    const results: BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (use) => {
        const r = await useTool(use.name, (use.input ?? {}) as Record<string, unknown>, source, trace, proposalIds);
        return { type: "tool_result" as const, tool_use_id: use.id, content: r.content, ...(r.ok ? {} : { is_error: true }) };
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { answer: "Stopped after too many tool calls without a final answer.", trace, proposalIds, model };
}

/// One question (or one monitor alert) → a grounded answer plus the trail
/// of tool calls behind it.
export async function askOpsAgent(question: string, source: "ask" | "monitor" = "ask"): Promise<AgentRun> {
  if (!llmReady && !anthropic) throw new Error("No AI configured — set AI_API_KEY (or ANTHROPIC_API_KEY)");
  if (!multibaasReady) throw new Error("MultiBaas is not configured — the agent reads everything through it");
  return llmReady ? runOpenAi(question, source) : runAnthropic(question, source);
}

/// The agent looks into a kiosk's cash-integrity findings: explains what
/// the three records show, and pauses the kiosk (within its mandate) if cash
/// is missing or mints are unbacked.
export async function investigateKiosk(report: IntegrityReport, source: "ask" | "monitor" = "monitor"): Promise<AgentRun> {
  return askOpsAgent(
    `Cash integrity check for kiosk ${report.kioskId} came back ${report.status.toUpperCase()}. Report:\n${JSON.stringify(report)}\n\n` +
      "Investigate: say in 3-5 short sentences what the three records show and the most likely cause, citing the numbers. " +
      "If cash is missing from the box or tkCASH was minted without a machine-signed note, pause the kiosk with propose_pause_kiosk. " +
      "End with the one thing a human should check first.",
    source,
  );
}
