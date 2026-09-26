import { config } from "./config.js";

/// An OpenAI-compatible chat client (OpenRouter by default) for the yield
/// and treasury agents. Tool calling uses the OpenAI format; the treasury
/// agent's tools are defined once and converted for either provider.

export const llmReady = Boolean(config.ai.apiKey);

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatResult {
  message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
  finishReason: string | null;
  model: string;
}

export async function chat(opts: { messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number; timeoutMs?: number }): Promise<ChatResult> {
  if (!llmReady) throw new Error("AI_API_KEY is not set");
  const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.ai.apiKey}`,
      "content-type": "application/json",
      // OpenRouter attribution headers; ignored by other providers.
      "http-referer": config.publicBackendUrl || "https://takarabako.bytetrix.tech",
      "x-title": "Takarabako",
    },
    body: JSON.stringify({
      model: config.ai.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 4000,
      ...(opts.tools?.length
        ? { tools: opts.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
        : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  const body = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message: ChatResult["message"]; finish_reason: string | null }>; model?: string; error?: { message?: string } }
    | null;
  if (!res.ok || !body?.choices?.length) {
    throw new Error(`AI request failed (${res.status}): ${body?.error?.message ?? "no choices returned"}`);
  }
  const choice = body.choices[0];
  return { message: choice.message, finishReason: choice.finish_reason, model: body.model ?? config.ai.model };
}

/// One prompt in, plain text out (no tools).
export async function complete(system: string, user: string, maxTokens = 1500): Promise<string> {
  const { message } = await chat({ messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens });
  return (message.content ?? "").trim();
}
