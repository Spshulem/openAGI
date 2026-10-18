// Context cap for the provider tool loop.
//
// The stateless OpenAI loop resends the whole conversation every hop, so a
// long tool chain (computer use, fleet screens) re-bills every earlier tool
// output on every call. Three limits keep one call bounded:
//   • clip     — a single tool output past TOOL_OUTPUT_MAX_CHARS keeps its head
//                plus a note, before it ever enters the conversation.
//   • rolling  — large outputs older than the most recent few become a short
//                stub ("[tool output trimmed: <tool> <N> chars]").
//   • hard cap — an estimated per-call input ceiling (chars/4, default 60k
//                tokens, OPENAGI_MAX_INPUT_TOKENS): stub oldest tool outputs,
//                then drop oldest chat turns. Never the system prompt, the
//                latest user message, or a function_call item — stubbing
//                keeps each function_call_output (and its call_id) in place,
//                so the call/result pairing the API requires survives.
//
// Prompt caching only pays on an unchanged PREFIX, so trimming is monotonic
// (a stubbed item stays stubbed) and batched with slack: the rolling stub
// waits until twice the keep count has piled up, and the hard cap trims to
// 75% of the ceiling. The prefix is rewritten every few hops, not every hop.

export const DEFAULT_MAX_INPUT_TOKENS = 60_000;
export const TOOL_OUTPUT_MAX_CHARS = 20_000;
export const KEEP_RECENT_TOOL_OUTPUTS = 3;
// Stubbing a short output saves nothing and loses information the model may
// still use, so the rolling pass leaves anything this small alone.
const STUB_MIN_CHARS = 1_000;
// The hard cap stubs smaller outputs too, but never one shorter than its stub.
const HARD_CAP_STUB_MIN_CHARS = 100;
// A screenshot is billed by image size, not by its base64 length; chars/4 on
// a data URL would overstate it ~100x. A typical screen tile count lands near
// this many tokens.
const IMAGE_TOKEN_ESTIMATE = 1_500;
const CHARS_PER_TOKEN = 4;
const HARD_CAP_TARGET = 0.75;

export function maxInputTokensFromEnv(env = process.env) {
  const value = Number(env.OPENAGI_MAX_INPUT_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_INPUT_TOKENS;
}

export function trimmedToolStub(tool, chars) {
  return `[tool output trimmed: ${tool ?? "tool"} ${chars} chars]`;
}

export function clipToolOutput(text, tool, max = TOOL_OUTPUT_MAX_CHARS) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[tool output clipped: ${tool ?? "tool"} ${value.length} chars, first ${max} kept]`;
}

export function estimateTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// Tracks what each OpenAI Responses input item is (history turn, latest user
// message, function_call, tool output, screenshot) without adding fields to
// the items themselves — the request body must stay exactly the API shape.
export class ToolLoopContext {
  constructor({ maxInputTokens = DEFAULT_MAX_INPUT_TOKENS, keepRecent = KEEP_RECENT_TOOL_OUTPUTS } = {}) {
    this.maxInputTokens = maxInputTokens;
    this.keepRecent = keepRecent;
    this.meta = new WeakMap();
  }

  mark(item, info) {
    this.meta.set(item, { ...info, stubbed: false });
    return item;
  }

  // Mutates `input` in place so trims carry over to later hops. `fixedChars`
  // is the untrimmable part of the request (instructions + tool schemas).
  fit(input, { fixedChars = 0 } = {}) {
    const stats = { stubbed: 0, dropped: 0 };
    const outputs = () => input.filter((item) => {
      const info = this.meta.get(item);
      return info && (info.kind === "output" || info.kind === "image") && !info.stubbed;
    });
    const latestHop = Math.max(-1, ...input.map((item) => this.meta.get(item)?.hop ?? -1));

    // Rolling stub: keep the latest hop's outputs and the most recent few
    // large ones; once twice that many have piled up, stub the rest at once.
    const large = outputs().filter((item) => itemChars(item) >= STUB_MIN_CHARS);
    if (large.length > this.keepRecent * 2) {
      let excess = large.length - this.keepRecent;
      for (const item of large) {
        if (excess <= 0) break;
        if (this.meta.get(item).hop === latestHop) continue;
        this.stub(item);
        stats.stubbed += 1;
        excess -= 1;
      }
    }

    const limitChars = this.maxInputTokens * CHARS_PER_TOKEN;
    let total = fixedChars + input.reduce((sum, item) => sum + itemChars(item), 0);
    if (total > limitChars) {
      const target = limitChars * HARD_CAP_TARGET;
      // 1. Oldest tool outputs from earlier hops.
      for (const item of outputs()) {
        if (total <= target) break;
        if (this.meta.get(item).hop === latestHop || itemChars(item) < HARD_CAP_STUB_MIN_CHARS) continue;
        total -= this.stub(item);
        stats.stubbed += 1;
      }
      // 2. Oldest chat turns from before this message.
      while (total > target) {
        const index = input.findIndex((item) => this.meta.get(item)?.kind === "history");
        if (index < 0) break;
        total -= itemChars(input[index]);
        input.splice(index, 1);
        stats.dropped += 1;
      }
      // 3. The latest hop's outputs, all but the newest, as a last resort.
      const latest = outputs().filter((item) => this.meta.get(item).hop === latestHop).slice(0, -1);
      for (const item of latest) {
        if (total <= target) break;
        if (itemChars(item) < HARD_CAP_STUB_MIN_CHARS) continue;
        total -= this.stub(item);
        stats.stubbed += 1;
      }
    }
    stats.estimatedTokens = estimateTokens(total);
    if (total > limitChars) {
      const error = new Error(`Input exceeds OPENAGI_MAX_INPUT_TOKENS (${stats.estimatedTokens} estimated tokens; limit ${this.maxInputTokens}). Shorten the latest message or increase the configured input limit.`);
      error.code = "INPUT_CONTEXT_TOO_LARGE";
      throw error;
    }
    return stats;
  }

  // Replace an output's body with a stub; returns the chars saved.
  stub(item) {
    const info = this.meta.get(item);
    const before = itemChars(item);
    if (info.kind === "image" || item.type === "tool_result") {
      item.content = trimmedToolStub(info.tool, before);
    } else {
      item.output = trimmedToolStub(info.tool, before);
    }
    info.stubbed = true;
    return before - itemChars(item);
  }
}

// Anthropic keeps results inside user messages. Flatten only for accounting
// and trimming, then remove dropped history messages from the wire request.
// Tool-use blocks and their result IDs always stay paired.
export class AnthropicToolLoopContext extends ToolLoopContext {
  fit(messages, options = {}) {
    const isResults = (message) => Array.isArray(message.content)
      && message.content.length > 0
      && message.content.every((block) => block.type === "tool_result");
    const items = messages.flatMap((message) => isResults(message) ? message.content : [message]);
    const stats = super.fit(items, options);
    const kept = new Set(items);
    const retained = messages.filter((message) => isResults(message) || kept.has(message));
    messages.splice(0, messages.length, ...retained);
    return stats;
  }
}

export function itemChars(item) {
  if (!item || typeof item !== "object") return 0;
  if (typeof item.output === "string") return item.output.length;
  if (typeof item.content === "string") return item.content.length;
  if (Array.isArray(item.content)) {
    return item.content.reduce((sum, part) => {
      if (part?.type === "input_image" || part?.type === "image") return sum + IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
      if (typeof part?.text === "string") return sum + part.text.length;
      return sum + JSON.stringify(part ?? "").length;
    }, 0);
  }
  if (item.type === "function_call") return String(item.name ?? "").length + String(item.arguments ?? "").length;
  return JSON.stringify(item).length;
}
