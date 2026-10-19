import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError, createLlmClient } from "./llm.ts";

const SETTINGS = { baseUrl: "http://model:1234/v1", apiKey: "", model: "m", contextTokens: 32768 };

const TOOLS = [
  {
    name: "ticket_lesen",
    description: "Liest ein Ticket samt Verlauf",
    parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
];

/** Answers every fetch with one canned body; keeps what was sent. */
function stubFetch(body: unknown, status = 200) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("chatWithTools", () => {
  it("sends the tool definitions and reads tool calls back", async () => {
    const sent = stubFetch({
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "ticket_lesen", arguments: '{"id": 4711}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = await createLlmClient().chatWithTools(SETTINGS, [{ role: "user", content: "Was ist bei #4711?" }], TOOLS);
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "ticket_lesen", arguments: '{"id": 4711}' }]);
    // An answer without text is the normal case here, not an error.
    expect(result.text).toBe("");
    expect(sent[0].body.tools).toEqual([{ type: "function", function: TOOLS[0] }]);
    expect(sent[0].body.max_tokens).toBe(800);
  });

  it("puts assistant tool calls and tool results into the wire format", async () => {
    const sent = stubFetch({ choices: [{ message: { content: "Bei #4711 läuft das Backup wieder." } }] });
    const result = await createLlmClient().chatWithTools(
      SETTINGS,
      [
        { role: "user", content: "Was ist bei #4711?" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "ticket_lesen", arguments: '{"id": 4711}' }] },
        { role: "tool", toolCallId: "call_1", content: "Ticket #4711: Backup DC01" },
      ],
      TOOLS,
      { maxTokens: 2000 },
    );
    expect(result.text).toBe("Bei #4711 läuft das Backup wieder.");
    expect(result.toolCalls).toEqual([]);
    const messages = sent[0].body.messages as Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "ticket_lesen", arguments: '{"id": 4711}' } }],
    });
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Ticket #4711: Backup DC01" });
    expect(sent[0].body.max_tokens).toBe(2000);
  });

  it("omits the tools key when the toolbox is empty", async () => {
    const sent = stubFetch({ choices: [{ message: { content: "fertig" } }] });
    await createLlmClient().chatWithTools(SETTINGS, [{ role: "user", content: "Antworte jetzt" }], []);
    expect(sent[0].body).not.toHaveProperty("tools");
  });

  it("keeps the endpoint status on the error so a 400 on tools can be told apart", async () => {
    stubFetch({ error: { message: "tools not supported" } }, 400);
    const error = await createLlmClient()
      .chatWithTools(SETTINGS, [{ role: "user", content: "x" }], TOOLS)
      .catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).endpointStatus).toBe(400);
  });

  it("drops tool calls without an id, like the ones without a name", async () => {
    stubFetch({
      choices: [
        {
          message: {
            tool_calls: [
              { id: "", type: "function", function: { name: "ticket_lesen", arguments: "{}" } },
              { type: "function", function: { name: "ticket_lesen", arguments: "{}" } },
              { id: "call_3", type: "function", function: { name: "ticket_lesen", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    const result = await createLlmClient().chatWithTools(SETTINGS, [{ role: "user", content: "x" }], TOOLS);
    expect(result.toolCalls).toEqual([{ id: "call_3", name: "ticket_lesen", arguments: "{}" }]);
  });

  it("still rejects an answer that is neither text nor a tool call", async () => {
    stubFetch({ choices: [{ message: { content: "" } }] });
    await expect(createLlmClient().chatWithTools(SETTINGS, [{ role: "user", content: "x" }], TOOLS)).rejects.toBeInstanceOf(
      LlmError,
    );
  });
});

describe("chat", () => {
  it("keeps a think-only answer as an empty string instead of failing", async () => {
    stubFetch({ choices: [{ message: { content: "<think>überlegt</think>" } }] });
    expect(await createLlmClient().chat(SETTINGS, [{ role: "user", content: "x" }])).toBe("");
  });

  it("still rejects an answer that is empty before stripping", async () => {
    stubFetch({ choices: [{ message: { content: "   " } }] });
    await expect(createLlmClient().chat(SETTINGS, [{ role: "user", content: "x" }])).rejects.toBeInstanceOf(LlmError);
  });
});
