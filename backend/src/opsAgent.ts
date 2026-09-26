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
import { reserveStatus, treasuryBalances, vaultState } from "./treasury.js";
import { recentEvents } from "./chainEvents.js";

/// The treasury ops agent (Curvegrid AI Agent track). A Claude tool-use loop
/// kept separate from agent.ts's per-deposit tier rationale. It reads
/// on-chain state only through MultiBaas, and its only way to act is to
/// file a proposal — which policy.ts screens and a human approves before
/// anything is signed. It holds no keys and executes nothing itself.

const anthropic = config.agent.apiKey ? new Anthropic({ apiKey: config.agent.apiKey }) : null;
export const opsAgentReady = Boolean(anthropic) && multibaasReady;

const MAX_TURNS = 8;
const SAVED_QUERIES = [
  "cash_in_by_kiosk",
  "cash_in_by_denomination",
  "tkcash_holders",
  "deposits_by_user",
  "withdrawals",
  "reserve_attestations",
] as const;

const SYSTEM = `You are the treasury operations agent for Takarabako, a cash-in kiosk network on Ethereum Sepolia.
Customers insert banknotes at a kiosk; the treasury deposits the USD value into a yield vault (mUSDC) and mints tkCASH, a token that is a claim on the physical cash in that kiosk's box.

You answer operators' questions from live data and, when something needs doing, file proposals. Ground every number in a tool result from this conversation, and say which tool it came from; if the data isn't available, say so rather than estimating.

You cannot execute anything. Proposal tools only file a request that a human reviews; say "proposed", never "done". Proposals are checked against fixed limits and may be rejected — if one is, explain the limit and, where useful, propose something within it:
- vault APY between ${POLICY.minApyBps} and ${POLICY.maxApyBps} bps
- yield-reserve funding at most ${POLICY.maxYieldReserveFundingPerDay} USDC per UTC day
- float minting at most ${POLICY.maxFloatMintPerDay} mUSDC per UTC day
- pausing a kiosk is always allowed; unpausing is for humans only

Key health signals: vault reserveCoverage (below 1.2 means the yield reserve is getting thin), tkCASH supply vs total reserve (must be equal), attestation deltas (non-zero means a kiosk's physical count disagreed and its minting froze), and the treasury's Sepolia ETH (it pays gas for every deposit; below 0.05 ETH is urgent).

Answer in a few short paragraphs or a short list. Use plain language an operator can act on.`;

const obj = (properties: Record<string, unknown>, required: string[] = []): BetaTool["input_schema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS: BetaTool[] = [
  { name: "get_vault_state", description: "Vault APY, total liability to depositors, USDC it holds, and reserve coverage (balance ÷ liability).", input_schema: obj({}), strict: true },
  { name: "get_reserve_status", description: "tkCASH supply vs total kiosk reserve, each kiosk's reserve/active/frozen state, and recent operator attestations.", input_schema: obj({}), strict: true },
  { name: "get_treasury_balances", description: "The treasury wallet's Sepolia ETH (gas) and mUSDC float.", input_schema: obj({}), strict: true },
  {
    name: "run_event_query",
    description: `Runs one of the saved MultiBaas Event Queries over indexed contract events: ${SAVED_QUERIES.join(", ")}. Amounts are raw 6-decimal integers (divide by 1,000,000 for USD); kioskId is hex-encoded bytes32 text.`,
    input_schema: obj({ name: { type: "string", enum: [...SAVED_QUERIES] } }, ["name"]),
    strict: true,
  },
  {
    name: "list_recent_events",
    description: "Most recent indexed contract events, newest first. contract is a MultiBaas label: takarabako_vault, takarabako_cash_receipt, mock_usdc, uniswap_v3_npm or ens_user_registry; empty string for all.",
    input_schema: obj({ contract: { type: "string" }, limit: { type: "integer", description: "1 to 50" } }, ["contract", "limit"]),
    strict: true,
  },
  {
    name: "lookup_alias",
    description: "Resolves a MultiBaas address alias (e.g. vault, tkcash, treasury, or a customer's ENS label) to its address and linked contracts.",
    input_schema: obj({ alias: { type: "string" } }, ["alias"]),
    strict: true,
  },
  {
    name: "propose_fund_yield_reserve",
    description: "Proposes topping up the vault's yield reserve from the treasury's mUSDC. A human must approve.",
    input_schema: obj({ amount: { type: "number", description: "USDC" }, rationale: { type: "string" } }, ["amount", "rationale"]),
    strict: true,
  },
  {
    name: "propose_set_apy",
    description: "Proposes changing the vault's APY. A human must approve.",
    input_schema: obj({ bps: { type: "integer" }, rationale: { type: "string" } }, ["bps", "rationale"]),
    strict: true,
  },
  {
    name: "propose_pause_kiosk",
    description: "Proposes taking a kiosk out of service (no new cash-ins). A human must approve.",
    input_schema: obj({ kioskId: { type: "string" }, reason: { type: "string" }, rationale: { type: "string" } }, ["kioskId", "reason", "rationale"]),
    strict: true,
  },
  {
    name: "propose_mint_usdc_float",
    description: "Proposes minting mUSDC to the treasury so it can keep fronting deposits. A human must approve.",
    input_schema: obj({ amount: { type: "number", description: "USDC" }, rationale: { type: "string" } }, ["amount", "rationale"]),
    strict: true,
  },
];

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
  const result = await createProposal({ action, args, rationale: String(rationale ?? ""), source });
  if (!result.ok) return { rejected: true, reason: result.reason };
  filed.push(result.proposal.id);
  return { proposed: true, proposalId: result.proposal.id, status: "pending human approval" };
}

export interface AgentRun {
  answer: string;
  trace: TraceStep[];
  proposalIds: string[];
  model: string;
}

/// One question (or one monitor alert) → a grounded answer plus the trail
/// of tool calls behind it.
export async function askOpsAgent(question: string, source: "ask" | "monitor" = "ask"): Promise<AgentRun> {
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY is not set");
  if (!multibaasReady) throw new Error("MultiBaas is not configured — the agent reads everything through it");

  const messages: BetaMessageParam[] = [{ role: "user", content: question }];
  const trace: TraceStep[] = [];
  const proposalIds: string[] = [];
  let model = config.opsAgent.model;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.beta.messages.create({
      model: config.opsAgent.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // A policy decline re-runs on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    model = response.model;

    if (response.stop_reason === "refusal") {
      return { answer: "The model declined to answer this request.", trace, proposalIds, model };
    }
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = response.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n")
        .trim();
      return { answer: answer || "(no answer)", trace, proposalIds, model };
    }

    // Parallel tool calls run together; all results go back in one message.
    const results: BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (use) => {
        const input = (use.input ?? {}) as Record<string, unknown>;
        try {
          const output = await runTool(use.name, input, source, proposalIds);
          trace.push({ tool: use.name, input, output });
          return { type: "tool_result" as const, tool_use_id: use.id, content: JSON.stringify(output) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          trace.push({ tool: use.name, input, output: message, error: true });
          return { type: "tool_result" as const, tool_use_id: use.id, content: message, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { answer: "Stopped after too many tool calls without a final answer.", trace, proposalIds, model };
}
