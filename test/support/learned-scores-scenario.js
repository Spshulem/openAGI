// A fixed, deterministic pass through every runtime path that can ask the
// optional local scoring service for a score: a chat turn (scrutiny, routing,
// propagation, memory), a saved draft, an agent-completed task, a proactive
// suggestion, grading, memory decay and the cron table. It returns a
// normalized snapshot (ids and timestamps replaced) so a run with no scoring
// service can be compared byte for byte with the runtime as it was before
// learned scores existed (test/fixtures/learned-scores-inert.json).
import fs from "node:fs";
import path from "node:path";
import { createDurableRuntime, DeterministicModelProvider } from "../../src/index.js";
import { DirectionalAdaptiveScrutiny } from "../../src/directional-adaptive-scrutiny.js";
import { ScrutinyPanel } from "../../src/scrutiny-panel.js";

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const ID = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*)_[0-9a-f]{16}\b/g;

export function normalize(value, dataDir = null) {
  if (typeof value === "string") {
    const text = dataDir ? value.split(dataDir).join("<dataDir>") : value;
    return text.replace(ISO, "<ts>").replace(ID, "$1_<id>");
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, dataDir));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [normalize(key, dataDir), normalize(entry, dataDir)]));
  }
  return value;
}

export const FIXED_SCRUTINY_ARGS = {
  signal: {
    id: "sig_fixed",
    risk: 0.4,
    novelty: 0.5,
    repetition: 0.3,
    urgency: 0.6,
    impact: 0.55,
    externalPressure: 0.5,
    internalPressure: 0.6,
    citations: ["a", "b"],
    specificity: 0.6,
    confidence: 0.7,
    ambiguity: 0.3
  },
  workflow: { name: "fixed" },
  memories: [{ score: 0.5 }],
  context: { name: "fixed" }
};

class ScenarioProvider extends DeterministicModelProvider {
  async generate(input) {
    const { task, toolRegistry, context } = input;
    if (task === "observer") {
      return {
        provider: "scenario",
        model: "scenario",
        text: JSON.stringify({ category: "knowledge", title: "Save the vendor checklist", rationale: "It came up twice today." })
      };
    }
    const text = String(input.input ?? "");
    const toolCalls = [];
    if (/draft/.test(text)) {
      await toolRegistry.invoke("save_draft", { title: "Vendor follow-up", body: "Thanks for the call today.", kind: "email" },
        { ...context, __scrutinyPolicy: null });
      toolCalls.push({ name: "save_draft", ok: true, result: { ok: true } });
    }
    if (/finish/.test(text)) {
      const pending = context.runtime.tasks.list({ queue: "agent", status: "pending" })[0];
      if (pending) {
        await toolRegistry.invoke("complete_task", { id: pending.id }, { ...context, __scrutinyPolicy: null });
        toolCalls.push({ name: "complete_task", ok: true, result: { ok: true } });
      }
    }
    return { provider: "scenario", model: "scenario", text: `Done: ${text.slice(0, 40)}`, toolCalls };
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Run the scenario in dataDir. runtimeOptions is passed to
 * createDurableRuntime (for example a modelClient or a router mode).
 */
export async function runLearnedScoresScenario({ dataDir, runtimeOptions = {} }) {
  const single = new DirectionalAdaptiveScrutiny().evaluate(structuredClone(FIXED_SCRUTINY_ARGS));
  const panel = new ScrutinyPanel().evaluate(structuredClone(FIXED_SCRUTINY_ARGS));

  const runtime = createDurableRuntime({
    dataDir,
    modelProvider: new ScenarioProvider(),
    autoConnectMcp: false,
    ...runtimeOptions
  });
  runtime.observations.getRecentContext = async () => ({
    apps: [{ app: "Browser", n: 4 }],
    snippets: [
      { app: "Browser", text: "Vendor checklist: insurance, payment terms, onboarding call." },
      { app: "Mail", text: "Re: vendor checklist, can you send the latest version?" }
    ]
  });

  // A specialist the router can match against (activationCount 1).
  runtime.propagation.propagate({
    signal: {
      domain: "sales", taskType: "follow-up", tags: ["message", "local", "acme"],
      summary: "weekly acme pipeline follow-up email", specialistScope: "weekly acme pipeline follow-up email"
    },
    workflow: null,
    scrutiny: { reasons: ["seeded"] },
    tools: []
  });
  await settle();

  runtime.tasks.add({ title: "Tidy the vendor folder" }, { source: "test", queue: "agent" });

  const turns = [
    "draft a follow-up to the vendor about the checklist",
    "weekly acme pipeline follow-up email",
    "please finish the vendor folder task",
    "we should automate this with a specialist agent"
  ];
  const replies = [];
  for (const text of turns) {
    const turn = await runtime.agentHost.handleMessage({ channel: "local", from: "user", text });
    replies.push({ reply: turn.reply, action: turn.output.action, score: turn.output.scrutiny.score });
    await settle();
  }

  const draft = runtime.drafts.list({ status: "pending" })[0];
  if (draft) runtime.drafts.approve(draft.id);

  const observed = await runtime.proactiveObserver.observe({ force: true });
  const suggestion = observed.candidate ? runtime.proactiveObserver.resolve(observed.candidate.id, "accepted") : null;

  const decayAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const decay = runtime.memory.decay(decayAt);
  await settle();

  return normalize({
    scrutiny: { single, panel },
    replies,
    observed: { suggested: observed.suggested ?? 0, skipped: observed.skipped ?? false, reason: observed.reason ?? null },
    suggestion,
    outputs: runtime.outputs,
    outcomes: [...runtime.outcomes.outcomes.values()],
    memory: [...runtime.memory.items.values()],
    decay: Object.fromEntries(Object.entries(decay).map(([key, items]) => [key, items.length])),
    specialists: runtime.propagation.list({ includeRetired: true }),
    cron: runtime.cron.listJobs()
      .map((job) => ({ id: job.id, name: job.name, enabled: job.enabled, task: job.task }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    memoryEventOps: readLines(path.join(dataDir, "memory", "memory-events.jsonl")).map((event) => event.op),
    outcomeEventOps: readLines(path.join(dataDir, "outcomes", "events.jsonl")).map((event) => event.op),
    files: listFiles(dataDir)
  }, dataDir);
}
