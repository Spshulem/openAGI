export class DeterministicModelProvider {
  constructor(options = {}) {
    this.name = options.name ?? "deterministic";
  }

  isConfigured() {
    return true;
  }

  async generate({ input, scrutiny, memoryHits = [], agent, messages = [], tools = [], toolRegistry, context = {} }) {
    const text = String(input ?? "").trim();
    const lower = text.toLowerCase();
    const lines = [];

    if (/^(hi|hey|hello|yo|sup|good (morning|afternoon|evening))\b/.test(lower)) {
      lines.push(`Hey — I'm ${agent?.name ?? "OpenAGI"}, running locally. I can remember things, recall them later, schedule prompts, and call MCP tools when configured.`);
    } else if (/\bremember\b|\bsave (this|that)\b|\bdon't forget\b/.test(lower)) {
      const result = await maybeInvoke(toolRegistry, "remember", { content: text, importance: "normal" }, context);
      if (result?.ok) {
        lines.push(`Saved to memory (tier: ${result.result.tier}).`);
      } else {
        lines.push(`I'd save this to memory but the remember tool isn't available right now.`);
      }
    } else if (/\bremind me\b|\bevery (day|monday|week)\b|\bschedule\b|\bdaily\b/.test(lower)) {
      lines.push(`I detected a scheduling request, but without an OPENAI_API_KEY I can't parse the time precisely. Try POST /cron with a {prompt, delaySeconds | intervalSeconds | dailyAt} body, or set OPENAI_API_KEY to let the agent schedule it for you.`);
    } else if (/\bwhat (was|did) (i|you)\b|\blast message\b|\bprevious\b/.test(lower)) {
      const previous = messages.filter((m) => m.role === "user").slice(-2, -1)[0];
      lines.push(previous ? `Your previous message was: "${previous.content}"` : `I don't see a previous message in this session.`);
    } else {
      lines.push(`Heard: "${text}".`);
    }

    if (memoryHits.length > 0) {
      const top = memoryHits.slice(0, 3).map(({ item, score }) => `- [${item.tier} · ${score.toFixed(2)}] ${truncate(item.content, 160)}`).join("\n");
      lines.push(`\nRelated from memory:\n${top}`);
    }

    if (!process.env.OPENAI_API_KEY) {
      lines.push(`\n(Running without OPENAI_API_KEY — set it in .openagi/.env to enable real reasoning and tool use.)`);
    }

    return {
      provider: this.name,
      model: "deterministic",
      text: lines.join("\n"),
      toolCalls: []
    };
  }
}

export class OpenAIResponsesProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5";
    this.baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.maxToolHops = options.maxToolHops ?? 6;
    this.budgetGuard = options.budgetGuard ?? null;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async generate({ input, instructions, messages = [], memoryHits = [], scrutiny, agent, tools = [], toolRegistry, context = {} }) {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured.");
    this.budgetGuard?.check();

    const baseInput = [
      ...messages.slice(-12).map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      })),
      { role: "user", content: input }
    ];

    const baseInstructions = instructions ?? buildDefaultInstructions({ agent, scrutiny, memoryHits });
    const toolList = tools.length > 0 ? tools : toolRegistry?.toOpenAITools?.() ?? [];
    const toolCalls = [];

    let nextRequest = {
      model: this.model,
      instructions: baseInstructions,
      input: baseInput
    };
    if (toolList.length > 0) nextRequest.tools = toolList;

    let response;
    for (let hop = 0; hop < this.maxToolHops; hop += 1) {
      response = await this.postResponses(nextRequest);
      const calls = extractFunctionCalls(response);
      if (calls.length === 0) break;

      const outputs = [];
      for (const call of calls) {
        const parsedArgs = safeParseJson(call.arguments) ?? {};
        const invocation = await (toolRegistry?.invoke?.(call.name, parsedArgs, context) ?? Promise.resolve({ ok: false, error: "no toolRegistry" }));
        toolCalls.push({ name: call.name, arguments: parsedArgs, result: invocation });
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(invocation.ok ? invocation.result : { error: invocation.error })
        });
      }

      nextRequest = {
        model: this.model,
        previous_response_id: response.id,
        input: outputs
      };
      if (toolList.length > 0) nextRequest.tools = toolList;
    }

    return {
      provider: "openai",
      model: this.model,
      id: response?.id,
      text: extractResponseText(response) || "(no text)",
      toolCalls
    };
  }

  async postResponses(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json?.error?.message ?? `OpenAI request failed with ${response.status}`);
      this.budgetGuard?.record(json.usage, this.model);
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class AnthropicProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    this.baseUrl = options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
    this.version = options.version ?? "2023-06-01";
    this.maxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.maxToolHops = options.maxToolHops ?? 6;
    this.budgetGuard = options.budgetGuard ?? null;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async generate({ input, instructions, messages = [], memoryHits = [], scrutiny, agent, toolRegistry, context = {} }) {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
    this.budgetGuard?.check();

    const tools = toolRegistry?.toAnthropicTools?.() ?? [];
    const system = [
      {
        type: "text",
        text: instructions ?? buildDefaultInstructions({ agent, scrutiny, memoryHits }),
        cache_control: { type: "ephemeral" }
      }
    ];

    const convo = [
      ...messages.slice(-12).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
      })),
      { role: "user", content: input }
    ];

    const toolCalls = [];
    let response;

    for (let hop = 0; hop < this.maxToolHops; hop += 1) {
      response = await this.postMessages({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages: convo,
        ...(tools.length > 0 ? { tools } : {})
      });

      convo.push({ role: "assistant", content: response.content });

      const toolUses = (response.content ?? []).filter((c) => c.type === "tool_use");
      if (toolUses.length === 0) break;

      const toolResults = [];
      for (const use of toolUses) {
        const invocation = await (toolRegistry?.invoke?.(use.name, use.input ?? {}, context) ?? Promise.resolve({ ok: false, error: "no toolRegistry" }));
        toolCalls.push({ name: use.name, arguments: use.input, result: invocation });
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(invocation.ok ? invocation.result : { error: invocation.error }),
          is_error: !invocation.ok
        });
      }
      convo.push({ role: "user", content: toolResults });
    }

    const text = (response?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    return {
      provider: "anthropic",
      model: this.model,
      id: response?.id,
      text: text || "(no text)",
      toolCalls
    };
  }

  async postMessages(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.version
        },
        body: JSON.stringify(body)
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json?.error?.message ?? `Anthropic request failed with ${response.status}`);
      this.budgetGuard?.record(json.usage, this.model);
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createModelProvider(options = {}) {
  if (options.forceDeterministic === true) return new DeterministicModelProvider();
  const budgetGuard = options.budgetGuard ?? null;
  const anthropic = new AnthropicProvider({ ...(options.anthropic ?? {}), budgetGuard });
  if (anthropic.isConfigured()) return anthropic;
  const openai = new OpenAIResponsesProvider({ ...(options.openai ?? {}), budgetGuard });
  if (openai.isConfigured()) return openai;
  return new DeterministicModelProvider();
}

export function buildDefaultInstructions({ agent, scrutiny, memoryHits }) {
  const memory = (memoryHits ?? [])
    .slice(0, 5)
    .map((hit) => `- [${hit.item.tier}] ${hit.item.content}`)
    .join("\n");
  return `You are ${agent?.name ?? "an OpenAGI agent"}, an always-on local assistant.

Tools available to you (call them when useful):
- remember(content, tags?, importance?) — save a durable note
- recall(query, limit?) — search memory
- schedule_message(prompt, delaySeconds | intervalSeconds | dailyAt, channel?, target?) — schedule a future prompt that pings the user back
- list_skills / run_skill — invoke named skill prompts
- list_mcp_tools / run_mcp_tool — invoke tools from connected MCP servers
- list_sessions — see recent conversations

Guidelines:
- Be concise and conversational. No preamble like "Decision: act".
- Use tools without asking permission for safe actions (remember, recall, schedule).
- If asked to be reminded of something, call schedule_message.
- If asked to remember something, call remember.
- When the user references past info, call recall before answering.

Current scrutiny action: ${scrutiny?.action ?? "act"}.
Top memory hits:
${memory || "- (none)"}`;
}

export function extractResponseText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type === "message" || item.role === "assistant") {
      for (const content of item.content ?? []) {
        if (typeof content.text === "string") parts.push(content.text);
        if (typeof content.value === "string") parts.push(content.value);
      }
    }
  }
  return parts.join("\n").trim();
}

export function extractFunctionCalls(response) {
  if (!response?.output) return [];
  return response.output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments
    }));
}

function safeParseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function maybeInvoke(toolRegistry, name, args, context) {
  if (!toolRegistry?.invoke) return null;
  return toolRegistry.invoke(name, args, context);
}
