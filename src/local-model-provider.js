import { buildDefaultInstructions, buildTurnContext, toolResultImage } from "./model-provider.js";
import { ToolLoopContext, clipToolOutput, maxInputTokensFromEnv } from "./context-trim.js";

// Ollama and LM Studio expose Chat Completions, not OpenAI's Responses API.
export class LocalModelProvider {
  constructor(options = {}) {
    this.name = "local";
    this.model = options.model ?? process.env.OPENAGI_LOCAL_MODEL ?? "";
    this.baseUrl = options.baseUrl ?? process.env.OPENAGI_LOCAL_BASE_URL ?? "http://localhost:11434/v1";
    this.apiKey = options.apiKey ?? process.env.OPENAGI_LOCAL_API_KEY ?? "";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxToolHops = options.maxToolHops ?? 6;
    this.maxInputTokens = options.maxInputTokens ?? maxInputTokensFromEnv();
  }

  isConfigured() { return Boolean(this.model.trim()); }

  async generate({ input, instructions, turnContext, scrutiny, memoryHits = [], messages = [], agent,
    toolRegistry, context = {}, onProgress, onTextDelta, maxToolHops }) {
    if (!this.isConfigured()) throw new Error("Choose a model installed in your local model server.");
    const endpoint = new URL(this.baseUrl);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("Enter an HTTP or HTTPS model server URL without credentials or a query.");
    }
    const budget = new ToolLoopContext({ maxInputTokens: this.maxInputTokens });
    const system = { role: "system", content: instructions ?? buildDefaultInstructions({ agent }) };
    const reference = turnContext ?? buildTurnContext({ scrutiny, memoryHits });
    const conversation = [
      ...messages.slice(-12).map(message => budget.mark({ role: message.role === "assistant" ? "assistant" : "user", content: String(message.content ?? "") }, { kind: "history" })),
      budget.mark({ role: "user", content: reference ? `${reference}\n\n${input}` : String(input) }, { kind: "anchor" })
    ];
    const tools = (toolRegistry?.toOpenAITools?.() ?? []).map(tool => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: "object", properties: {} }
    } }));
    const toolCalls = [];
    const hops = Math.max(1, Math.min(Number(maxToolHops) || this.maxToolHops, this.maxToolHops));
    for (let hop = 0; hop <= hops; hop++) {
      context.signal?.throwIfAborted?.();
      onProgress?.({ stage: "model", provider: "local", model: this.model, hop: hop + 1, maxToolHops: hops });
      budget.fit(conversation, { fixedChars: system.content.length + JSON.stringify(tools).length });
      const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, messages: [system, ...conversation], stream: false,
          ...(tools.length && hop < hops ? { tools } : {}) })
      });
      if (!response.ok) throw new Error(`Local model server returned HTTP ${response.status}. Check the server URL and installed model.`);
      const result = await response.json();
      const message = result.choices?.[0]?.message;
      const calls = message?.tool_calls ?? [];
      if (!calls.length || hop === hops) {
        const text = String(message?.content ?? "").trim();
        if (!text) throw new Error("The local model returned no answer. Try a model that supports chat and tool use.");
        onTextDelta?.({ text, reset: true, provider: "local", model: this.model, hop: hop + 1 });
        return { provider: "local", model: this.model, text, toolCalls, usage: result.usage };
      }
      conversation.push(budget.mark({ role: "assistant", content: message.content ?? null, tool_calls: calls }, { kind: "call", hop }));
      const imageMessages = [];
      for (const call of calls) {
        context.signal?.throwIfAborted?.();
        let args;
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { throw new Error("The local model returned an invalid tool call. Try another model."); }
        onProgress?.({ stage: "tool", provider: "local", model: this.model, hop: hop + 1, tool: call.function.name });
        const invocation = await toolRegistry.invoke(call.function.name, args, context);
        toolCalls.push({ name: call.function.name, arguments: args, result: invocation });
        const result = invocation.ok ? invocation.result : { error: invocation.error };
        const image = invocation.ok ? toolResultImage(result) : null;
        conversation.push(budget.mark({ role: "tool", tool_call_id: call.id,
          content: clipToolOutput(JSON.stringify(image ? { ...image.meta, image: "[attached as image below]" } : result), call.function.name)
        }, { kind: "output", contentKey: "content", tool: call.function.name, hop }));
        if (image) imageMessages.push(budget.mark({ role: "user", content: [
          { type: "text", text: `Screenshot (${image.meta.width}×${image.meta.height}, click coordinates are in this image's space):` },
          { type: "image_url", image_url: { url: `data:image/${image.format};base64,${image.data}` } }
        ] }, { kind: "image", tool: call.function.name, hop }));
      }
      // Chat Completions requires the entire tool-result batch before a user message.
      conversation.push(...imageMessages);
    }
  }
}
