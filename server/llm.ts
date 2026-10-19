/**
 * Client for an OpenAI-compatible chat endpoint — what oMLX, Ollama, LM Studio
 * and vLLM expose locally. Nothing here knows about tickets.
 */

export type LlmSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Context window of the model in tokens; sizes what a prompt may carry. */
  contextTokens: number;
};

export type ToolCall = { id: string; name: string; arguments: string };

/** One tool as the OpenAI wire format wants it, without the "function" wrapper. */
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export class LlmError extends Error {
  readonly status: number;
  /** What the endpoint itself answered; a 400 on a tools request means the model cannot do tools. */
  readonly endpointStatus?: number;
  // 424 keeps a model failure apart from a TANSS outage in the UI.
  constructor(message: string, status = 424, endpointStatus?: number) {
    super(message);
    this.status = status;
    this.endpointStatus = endpointStatus;
  }
}

export type LlmClient = {
  listModels(settings: Pick<LlmSettings, "baseUrl" | "apiKey">): Promise<string[]>;
  chat(settings: LlmSettings, messages: ChatMessage[], opts?: { json?: boolean; maxTokens?: number }): Promise<string>;
  /** Like chat(), but the model may answer with tool calls instead of text. */
  chatWithTools(
    settings: LlmSettings,
    messages: ChatMessage[],
    tools: readonly ToolDef[],
    opts?: { maxTokens?: number },
  ): Promise<{ text: string; toolCalls: ToolCall[] }>;
};

const TIMEOUT_MS = 180_000;

export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  if (!/\/v\d+$/.test(url)) url = `${url}/v1`;
  return url;
}

function headers(apiKey: string, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

async function call(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = (error as Error).name === "AbortError";
    throw new LlmError(aborted ? "Das Modell hat nicht rechtzeitig geantwortet" : `KI-Endpoint nicht erreichbar (${url})`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail =
      (data as { error?: { message?: string } | string } | null)?.error ?? text.slice(0, 200);
    const message = typeof detail === "string" ? detail : detail?.message ?? "";
    throw new LlmError(`KI-Endpoint antwortet ${response.status}${message ? `: ${message}` : ""}`, 424, response.status);
  }
  return data;
}

/** Our message shape as the OpenAI endpoint wants it. */
function wire(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content: m.content };
}

function messageText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((c) => String((c as { text?: string }).text ?? "")).join("")
    : String(content ?? "");
}

export function createLlmClient(): LlmClient {
  return {
    async listModels(settings) {
      const base = normalizeBaseUrl(settings.baseUrl);
      if (!base) throw new LlmError("KI-URL fehlt", 400);
      const data = (await call(`${base}/models`, { headers: headers(settings.apiKey, false) })) as {
        data?: { id?: string }[];
      } | null;
      return (data?.data ?? [])
        .map((m) => String(m.id ?? ""))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    },
    async chat(settings, messages, opts = {}) {
      const base = normalizeBaseUrl(settings.baseUrl);
      if (!base || !settings.model) throw new LlmError("KI ist nicht eingerichtet (Einstellungen)", 400);
      const body: Record<string, unknown> = {
        model: settings.model,
        messages: messages.map(wire),
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? 800,
        stream: false,
      };
      if (opts.json) body.response_format = { type: "json_object" };
      const data = (await call(`${base}/chat/completions`, {
        method: "POST",
        headers: headers(settings.apiKey, true),
        body: JSON.stringify(body),
      })) as { choices?: { message?: { content?: string | { text?: string }[] } }[] } | null;
      const content = data?.choices?.[0]?.message?.content;
      const text = messageText(content);
      if (!text.trim()) throw new LlmError("Das Modell hat eine leere Antwort geliefert");
      return stripThinking(text);
    },
    async chatWithTools(settings, messages, tools, opts = {}) {
      const base = normalizeBaseUrl(settings.baseUrl);
      if (!base || !settings.model) throw new LlmError("KI ist nicht eingerichtet (Einstellungen)", 400);
      const body: Record<string, unknown> = {
        model: settings.model,
        messages: messages.map(wire),
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? 800,
        stream: false,
      };
      if (tools.length) body.tools = tools.map((t) => ({ type: "function", function: t }));
      const data = (await call(`${base}/chat/completions`, {
        method: "POST",
        headers: headers(settings.apiKey, true),
        body: JSON.stringify(body),
      })) as {
        choices?: {
          message?: {
            content?: unknown;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      } | null;
      const message = data?.choices?.[0]?.message;
      const toolCalls = (message?.tool_calls ?? [])
        .map((c) => ({
          id: String(c.id ?? ""),
          name: String(c.function?.name ?? ""),
          arguments: String(c.function?.arguments ?? "{}"),
        }))
        // No id means we cannot send a matching tool_call_id back — stricter endpoints 400 on that.
        .filter((c) => c.name && c.id);
      const text = stripThinking(messageText(message?.content));
      // No text is normal when the model asks for a tool; nothing at all is not.
      if (!text && toolCalls.length === 0) throw new LlmError("Das Modell hat eine leere Antwort geliefert");
      return { text, toolCalls };
    },
  };
}

/** Reasoning models wrap their scratchpad in <think>…</think>; drop it. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Finds the first JSON object in a model answer, fences and chatter aside. */
export function extractJson<T>(text: string): T | null {
  const cleaned = stripThinking(text).replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
