// test/sec-mcp-argv.test.js
//
// SEC-5. ALLOWED_STDIO_COMMANDS constrains the executable and nothing else, so
// every runner on it could still be told to execute a string:
//
//   {"command":"node","args":["-e","<any JS>"]}
//   {"command":"python","args":["-c","<any python>"]}
//   {"command":"docker","args":["run","-v","/:/host","alpine","sh","-c","…"]}
//
// and the comment above the list claimed it closed the RCE path. Separately,
// POST /mcp/register registered directly — bypassing the human approval the
// agent-facing register_mcp_server tool is gated by — which is reachable from
// the dashboard XSS (SEC-4) and unauthenticated under SEC-1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpRegistry } from "../src/mcp-registry.js";

function registry() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec5-"));
  return new McpRegistry({ dataDir, configPath: null });
}

const EVAL_SHAPES = [
  ["node", ["-e", "require('child_process').execSync('id')"]],
  ["node", ["--eval", "require('fs').unlinkSync('/etc/hosts')"]],
  ["node", ["--eval=process.exit(1)"]],
  ["node", ["-p", "require('child_process').execSync('id').toString()"]],
  ["node", ["--print", "1"]],
  ["node", ["-pe", "require('child_process').execSync('id').toString()"]],
  ["/usr/local/bin/node", ["-e", "1"]],
  ["bun", ["-e", "Bun.spawnSync(['id'])"]],
  ["deno", ["eval", "Deno.run({cmd:['id']})"]],
  ["deno", ["repl"]],
  ["python", ["-c", "import os; os.system('id')"]],
  ["python3", ["-c", "import os; os.system('id')"]],
  ["python3", ["-u", "-c", "import os; os.system('id')"]],
  ["npx", ["-c", "id > /tmp/pwned"]],
  ["npx", ["--call", "id"]],
  // nested interpreter behind a wrapper
  ["uv", ["run", "--with", "requests", "python", "-c", "import os; os.system('id')"]],
  ["uvx", ["--from", "x", "python3", "-c", "1"]],
  ["docker", ["run", "--rm", "alpine", "sh", "-c", "id"]],
  // Bypasses found while attacking the first version of this guard: a flag
  // that consumes the NEXT token used to end the option scan early, and a
  // short flag with its value attached never matched exactly.
  ["npx", ["-p", "evil-pkg", "-c", "id > /tmp/pwned"]],
  ["npx", ["--package", "evil", "--call", "id"]],
  ["python3", ["-uc", "import os; os.system('id')"]],
  ["python3", ["-cprint(1)"]],
  ["python3", ["-W", "ignore", "-c", "import os"]],
  ["node", ["-r", "./preload.js", "-e", "1"]],
  ["node", ["-e1+1"]]
];

const DOCKER_ESCAPES = [
  ["docker", ["run", "-v", "/:/host", "alpine"]],
  ["docker", ["run", "--volume", "/:/host", "alpine"]],
  ["docker", ["run", "--name", "x", "-v", "/Users:/host", "alpine"]],
  ["docker", ["run", "--mount", "type=bind,src=/,dst=/host", "alpine"]],
  ["docker", ["run", "--privileged", "alpine"]],
  ["docker", ["run", "--network=host", "alpine"]],
  ["docker", ["run", "--net", "host", "alpine"]],
  ["docker", ["run", "--pid=host", "alpine"]],
  ["docker", ["run", "--ipc=host", "alpine"]],
  ["docker", ["run", "--userns=host", "alpine"]],
  ["docker", ["run", "--device", "/dev/kmem", "alpine"]],
  ["docker", ["run", "--cap-add", "SYS_ADMIN", "alpine"]],
  ["docker", ["run", "--security-opt", "seccomp=unconfined", "alpine"]],
  ["docker", ["run", "-v/:/host", "alpine"]],          // attached value
  ["docker", ["run", "-v=/:/host", "alpine"]],
  ["docker", ["run", "--volume=/:/host", "alpine"]]
];

// Real registrations that must keep working — including the one in the live
// install (npx -y @modelcontextprotocol/server-filesystem /tmp).
const LEGIT = [
  ["npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]],
  ["npx", ["-y", "mcp-remote", "--header", "statsig-api-key=abc"]],
  ["npx", ["-p", "some-package", "some-bin"]],
  ["node", ["/opt/servers/mcp-server.js", "--config", "cfg.json"]],
  ["node", ["server.js", "-c", "config.json"]],
  ["python3", ["-u", "-m", "mcp_server_git", "--repository", "/tmp/r"]],
  ["uvx", ["mcp-server-fetch"]],
  ["uv", ["run", "--with", "x", "mcp-server", "-c", "cfg.yaml"]],
  ["docker", ["run", "--rm", "-i", "ghcr.io/example/mcp:latest"]],
  ["bun", ["run", "server.ts"]],
  ["deno", ["run", "--allow-net", "server.ts"]]
];

test("SEC-5: eval-shaped argv is rejected for every allowed runner", () => {
  const reg = registry();
  for (const [command, args] of EVAL_SHAPES) {
    assert.throws(
      () => reg.registerServer({ name: `t-${command}-${args[0]}`, command, args }),
      /argument|not permitted|eval/i,
      `must reject: ${command} ${args.join(" ")}`
    );
  }
});

test("SEC-5: host-escaping docker argv is rejected", () => {
  const reg = registry();
  for (const [command, args] of DOCKER_ESCAPES) {
    assert.throws(
      () => reg.registerServer({ name: `d-${args.join("-")}`, command, args }),
      /docker|argument|not permitted/i,
      `must reject: ${command} ${args.join(" ")}`
    );
  }
});

test("SEC-5: ordinary MCP server registrations still work", () => {
  const reg = registry();
  let i = 0;
  for (const [command, args] of LEGIT) {
    const name = `ok-${i++}`;
    assert.doesNotThrow(
      () => reg.registerServer({ name, command, args }),
      `must accept: ${command} ${args.join(" ")}`
    );
    assert.equal(reg.servers.get(name).command, command);
  }
});

test("SEC-5: non-string / NUL-bearing args are rejected", () => {
  const reg = registry();
  assert.throws(() => reg.registerServer({ name: "n1", command: "node", args: [{ toString: () => "-e" }] }), /string/i);
  assert.throws(() => reg.registerServer({ name: "n2", command: "node", args: ["server.js\0-e"] }), /NUL|string/i);
});

test("SEC-5: one bad mcp.json entry disables that server, it does not stop the daemon booting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec5-cfg-"));
  const cfg = path.join(dir, "mcp.json");
  fs.writeFileSync(cfg, JSON.stringify({
    servers: {
      good: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      bad: { command: "node", args: ["-e", "require('child_process').execSync('id')"] },
      remote: { url: "https://mcp.example.com/mcp", auth: "oauth" }
    }
  }));
  const reg = new McpRegistry({ dataDir: dir, configPath: null });
  const loaded = reg.loadConfigFile(cfg);
  assert.deepEqual(loaded.map((s) => s.name).sort(), ["good", "remote"]);
  assert.equal(reg.rejectedFromConfig.length, 1);
  assert.equal(reg.rejectedFromConfig[0].name, "bad");
  assert.match(reg.rejectedFromConfig[0].error, /-e/);
});

test("SEC-5: the comment above the command allowlist does not claim to close RCE", () => {
  const src = fs.readFileSync(new URL("../src/mcp-registry.js", import.meta.url), "utf8");
  const head = src.slice(0, src.indexOf("const ALLOWED_STDIO_COMMANDS"));
  assert.ok(
    !/closes the\s*\n?\/\/\s*"register \/bin\/sh -c <payload>" RCE path/.test(head),
    "the overclaiming comment is still there"
  );
});

// ── the HTTP register path must go through the same approval as the tool ───

test("SEC-5: POST /mcp/register queues for human approval instead of registering", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec5-http-"));
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_AUTH_TOKEN = "";
  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    const spec = { name: "evil", command: "npx", args: ["-y", "some-package"], trustLevel: "trusted" };
    const res = await fetch(`${base}/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec)
    });
    const body = await res.json();
    assert.equal(body.status, "awaiting_confirmation", `expected approval gate, got ${JSON.stringify(body)}`);
    assert.ok(body.actionId, "no pending action id returned");
    assert.equal(
      runtime.mcp.listServers().some((s) => s.name === "evil"),
      false,
      "server was registered without approval"
    );

    // The queued action is the same shape the tool path produces, and the
    // approval card names the command so a human can see what they're OKing.
    const pending = await (await fetch(`${base}/pending-actions?status=pending`)).json();
    const queued = pending.actions.find((a) => a.id === body.actionId);
    assert.equal(queued.toolName, "register_mcp_server");
    assert.match(queued.summary, /npx/);

    // Approving runs it, exactly once.
    const approved = await fetch(`${base}/pending-actions/${encodeURIComponent(body.actionId)}/approve`, { method: "POST" });
    assert.equal(approved.status, 200);
    assert.equal(runtime.mcp.listServers().some((s) => s.name === "evil"), true, "approval did not register the server");
  } finally {
    await app.close?.();
    _resetDataDirCache();
  }
});

test("SEC-5: POST /mcp/register rejects an eval-shaped spec before anyone is asked to approve it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec5-http2-"));
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_AUTH_TOKEN = "";
  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    const res = await fetch(`${base}/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "rce", command: "node", args: ["-e", "process.exit(0)"] })
    });
    assert.equal(res.status, 400);
    const pending = await (await fetch(`${base}/pending-actions?status=pending`)).json();
    assert.equal(pending.actions.length, 0, "an un-runnable spec was still queued for a human to approve");
  } finally {
    await app.close?.();
    _resetDataDirCache();
  }
});
