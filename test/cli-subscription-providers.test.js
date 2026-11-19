import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ClaudeCliProvider,
  CodexCliProvider,
  claudeCliStatus,
  codexCliStatus
} from "../src/cli-subscription-providers.js";
import { createModelProvider } from "../src/model-provider.js";

test("claudeCliStatus and codexCliStatus detect host binary and account config safely", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cli-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  fs.writeFileSync(fakeCodex, "#!/bin/sh\necho ok\n", { mode: 0o755 });

  // No ~/.claude or ~/.codex auth yet
  assert.equal(claudeCliStatus({ env: { PATH: binDir }, homeDir: dir }).available, false);
  assert.equal(codexCliStatus({ env: { PATH: binDir }, homeDir: dir }).available, false);

  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".codex", "auth.json"), "{}");

  const cStatus = claudeCliStatus({ env: { PATH: binDir, CLAUDE_CLI_MODEL: "claude-opus-4-7" }, homeDir: dir });
  assert.equal(cStatus.available, true);
  assert.equal(cStatus.model, "claude-opus-4-7");

  const xStatus = codexCliStatus({ env: { PATH: binDir, CODEX_CLI_MODEL: "gpt-5.4" }, homeDir: dir });
  assert.equal(xStatus.available, true);
  assert.equal(xStatus.model, "gpt-5.4");
});

test("ClaudeCliProvider strips ANTHROPIC_API_KEY and runs multi-hop tool loop via ToolRegistry", async () => {
  let hop = 0;
  let capturedEnv = null;
  let capturedArgs = null;
  const streamed = [];
  const provider = new ClaudeCliProvider({
    bin: "/usr/local/bin/claude-stub",
    model: "claude-sonnet-4-6",
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ant-should-not-leak" },
    run: async (_bin, args, opts) => {
      hop += 1;
      capturedArgs = args;
      capturedEnv = opts.env;
      if (hop === 1) {
        return {
          code: 0,
          stdout: JSON.stringify({
            subtype: "success",
            structured_output: {
              reply: "",
              tool_calls: [{ name: "echo_tool", arguments_json: "{\"msg\":\"hello\"}" }]
            }
          })
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          subtype: "success",
          structured_output: {
            reply: "Tool echoed hello cleanly.",
            tool_calls: []
          }
        })
      };
    }
  });

  const registry = {
    toOpenAITools: () => [{ type: "function", name: "echo_tool", description: "Echo", parameters: {} }],
    invoke: async (name, args) => ({ ok: true, result: { echoed: `${name}:${args.msg}` } })
  };

  const result = await provider.generate({
    input: "echo hello",
    messages: [],
    toolRegistry: registry,
    agent: { name: "OpenAGI" },
    onTextDelta: (ev) => streamed.push(ev.text)
  });

  assert.equal(result.provider, "claude-cli");
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.text, "Tool echoed hello cleanly.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].result.result.echoed, "echo_tool:hello");
  assert.deepEqual(streamed, ["Tool echoed hello cleanly."]);
  assert.equal(capturedEnv.ANTHROPIC_API_KEY, undefined);
  assert.ok(capturedArgs.includes("--safe-mode"));
  assert.ok(capturedArgs.includes("--no-session-persistence"));
});

test("CodexCliProvider strips OPENAI_API_KEY, passes out-schema, and completes multi-hop turn", async () => {
  let hop = 0;
  let capturedEnv = null;
  const provider = new CodexCliProvider({
    bin: "/usr/local/bin/codex-stub",
    model: "gpt-5.4",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp",
      OPENAI_API_KEY: "sk-openai-should-not-leak",
      CODEX_LB_API_KEY: "lb-pass"
    },
    run: async (_bin, args) => {
      hop += 1;
      const outIdx = args.indexOf("-o");
      assert.ok(outIdx >= 0);
      const outFile = args[outIdx + 1];
      const payload = hop === 1
        ? { reply: "", tool_calls: [{ name: "ping", arguments_json: "{}" }] }
        : { reply: "Pong from Codex account.", tool_calls: [] };
      fs.writeFileSync(outFile, JSON.stringify(payload));
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  // Spy via wrapper to capture opts.env cleanly
  const origRun = provider.run;
  provider.run = async (bin, args, opts) => {
    capturedEnv = opts.env;
    return await origRun(bin, args, opts);
  };

  const registry = {
    toOpenAITools: () => [{ type: "function", name: "ping", description: "Ping", parameters: {} }],
    invoke: async () => ({ ok: true, result: { pong: true } })
  };

  const res = await provider.generate({ input: "ping", messages: [], toolRegistry: registry });
  assert.equal(res.provider, "codex-cli");
  assert.equal(res.text, "Pong from Codex account.");
  assert.equal(res.toolCalls.length, 1);
  assert.equal(capturedEnv.OPENAI_API_KEY, undefined);
  assert.equal(capturedEnv.CODEX_LB_API_KEY, "lb-pass");
});

test("createModelProvider selects claude-cli and codex-cli when preferred and configured", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cli-factory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "claude"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "codex"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".codex", "auth.json"), "{}");

  const c = createModelProvider({ preferred: "claude-cli", mobile: false, claudeCli: { env: { PATH: binDir }, homeDir: dir } });
  assert.equal(c.name, "claude-cli");

  const x = createModelProvider({ preferred: "codex-cli", mobile: false, codexCli: { env: { PATH: binDir }, homeDir: dir } });
  assert.equal(x.name, "codex-cli");
});
