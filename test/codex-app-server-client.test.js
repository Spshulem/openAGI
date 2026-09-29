import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient as ProductionClient } from "../src/codex-app-server-client.js";

const fixtureToken = Symbol.for("openagi.codex.test-fixture");
function CodexAppServerClient(options) {
  return new ProductionClient({ ...options, [fixtureToken]: options?.args !== undefined });
}

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.js", import.meta.url));

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-client-"));
}

test("production client rejects caller-supplied app-server arguments rather than disabling confinement", () => {
  assert.throws(() => new ProductionClient({
    command: process.execPath,
    args: [fixture, "--untrusted"]
  }), (error) => error?.code === "CODEX_CONFIG");
});

test("a symlinked Codex profile is rejected before chmod can mutate its target", async () => {
  const root = tempRoot();
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { mode: 0o750 });
  fs.chmodSync(outside, 0o750);
  fs.symlinkSync(outside, path.join(root, "codex-home"));
  const command = "/usr/bin/true";
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(command)).digest("hex");
  const client = new ProductionClient({ command, expectedSha256, codexHome: path.join(root, "codex-home") });
  try {
    await assert.rejects(client.connect(), (error) => error?.code === "CODEX_ISOLATION");
    assert.equal(fs.statSync(outside).mode & 0o777, 0o750);
  } finally {
    await client.close();
  }
});

test("production Codex refuses OAuth before pre-login isolation is qualified", async () => {
  const root = tempRoot();
  const command = "/usr/bin/true";
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(command)).digest("hex");
  const client = new ProductionClient({ command, expectedSha256, codexHome: path.join(root, "codex-home") });
  try {
    await assert.rejects(client.startLogin({ mode: "device" }),
      (error) => error?.code === "CODEX_PRELOGIN_REQUIRED");
    assert.equal(fs.existsSync(path.join(root, "codex-home")), false);
  } finally {
    await client.close();
  }
});

test("production Codex refuses inference before a provider-defined served-effort contract exists", async () => {
  const root = tempRoot();
  const command = "/usr/bin/true";
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(command)).digest("hex");
  const client = new ProductionClient({ command, expectedSha256, codexHome: path.join(root, "codex-home") });
  try {
    // A stale or forged readiness flag cannot override the missing upstream contract.
    client.readiness = "chat-ready";
    await assert.rejects(client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      model: "gpt-test", effort: "medium", input: "Hello"
    }), (error) => error?.code === "CODEX_ATTESTATION_REQUIRED");
    assert.equal(fs.existsSync(path.join(root, "codex-home")), false);
  } finally {
    await client.close();
  }
});

test("a mutable public fixture flag cannot bypass the production inference hold", async () => {
  const root = tempRoot();
  const command = "/usr/bin/true";
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(command)).digest("hex");
  const client = new ProductionClient({ command, expectedSha256, codexHome: path.join(root, "codex-home") });
  try {
    assert.throws(() => { client.fixtureLaunch = true; }, TypeError);
    Object.defineProperty(client, "fixtureLaunch", { value: true });
    await assert.rejects(client.runChatTurn({ input: "Hello" }),
      (error) => error?.code === "CODEX_ATTESTATION_REQUIRED");
    assert.equal(fs.existsSync(path.join(root, "codex-home")), false);
  } finally {
    await client.close();
  }
});

test("a test token cannot authorize arbitrary app-server executable arguments", () => {
  assert.throws(() => new ProductionClient({
    command: process.execPath,
    args: [fixture, "--untrusted"],
    [fixtureToken]: true
  }), (error) => error?.code === "CODEX_CONFIG");
});

test("the fixture validator launches exactly the argument vector it inspected", () => {
  let reads = 0;
  const client = new ProductionClient({
    command: process.execPath,
    get args() { return ++reads <= 6 ? [fixture] : ["--eval", "0"]; },
    [fixtureToken]: true
  });
  assert.deepEqual(client.args, [fixture]);
  assert.equal(reads, 1);
});

test("fixture exemption rejects mutable argument elements before disabling the sandbox", () => {
  const mutableMode = { toString: () => "--mode=normal" };
  for (const args of [
    [fixture, mutableMode],
    [Buffer.from(fixture), "--mode=normal"]
  ]) {
    assert.throws(() => new ProductionClient({
      command: process.execPath, args, [fixtureToken]: true
    }), (error) => error?.code === "CODEX_CONFIG");
  }
});

test("the pinned real Codex app-server starts only inside the Linux sandbox", {
  skip: process.platform !== "linux" || !process.env.OPENAGI_TEST_REAL_CODEX_BIN
}, async () => {
  const root = tempRoot();
  const command = process.env.OPENAGI_TEST_REAL_CODEX_BIN;
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(command)).digest("hex");
  const client = new CodexAppServerClient({
    command, expectedSha256, codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "codex-home", "work"), requestTimeoutMs: 12_000
  });
  assert.equal(client.status().sandboxed, true);
  try {
    await client.connect();
    assert.equal(fs.statSync(path.join(root, "codex-home", "egress.sock")).isSocket(), true);
    assert.equal((await client.getAccount()).account, null);
    assert.equal(client.status().readiness, "login-required");
    await client.close();
    await client.connect();
    assert.equal((await client.getAccount()).account, null);
  } finally {
    await client.close();
    assert.equal(fs.existsSync(path.join(root, "codex-home", "egress.sock")), false);
  }
});

test("closing during broker startup prevents a later Codex child", {
  skip: process.platform !== "linux" || !process.env.OPENAGI_TEST_REAL_CODEX_BIN
}, async () => {
  const root = tempRoot();
  const command = process.env.OPENAGI_TEST_REAL_CODEX_BIN;
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(command)).digest("hex");
  const client = new ProductionClient({ command, expectedSha256, codexHome: path.join(root, "codex-home") });
  const startup = client.connect();
  try {
    await client.close();
    await assert.rejects(startup, (error) => error?.code === "CODEX_PROCESS_EXIT" || error?.code === "CODEX_STATE");
    assert.equal(client.proc, null);
    assert.equal(client.status().state, "stopped");
    assert.equal(fs.existsSync(path.join(root, "codex-home", "egress.sock")), false);
  } finally {
    await client.close();
    await Promise.allSettled([startup]);
  }
});

test("CodexAppServerClient default launch profile explicitly disables Codex built-ins", () => {
  const client = new CodexAppServerClient({ command: process.execPath });
  assert.match(client.args.join(" "), /app-server.*--stdio.*--strict-config/);
  for (const required of [
    "web_search=\"disabled\"",
    "features.shell_tool=false",
    "features.unified_exec=false",
    "features.view_image=false",
    "features.apps=false",
    "features.browser_use=false",
    "features.computer_use=false",
    "features.plugins=false",
    "features.hooks=false",
    "features.skill_search=false",
    "features.multi_agent=false",
    "agents.enabled=false",
    "history.persistence=\"none\"",
    "forced_login_method=\"chatgpt\""
  ]) assert.ok(client.args.includes(required), `missing strict override: ${required}`);
});

test("CodexAppServerClient bounds concurrent administrative requests", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=hang-limits"],
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    maxPendingRequests: 2,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  const first = client.getLimits().catch((error) => error);
  const second = client.getLimits().catch((error) => error);
  try {
    await assert.rejects(client.getLimits(), (error) => error?.code === "CODEX_BACKPRESSURE");
  } finally {
    await client.close();
    await Promise.allSettled([first, second]);
  }
});

test("CodexAppServerClient releases request capacity when an outbound frame is refused", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await client.connect();
    client.maxFrameBytes = 16;
    await assert.rejects(client.getLimits(), (error) => error?.code === "CODEX_BACKPRESSURE");
    assert.equal(client.pending.size, 0);
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient converts a child stdin EPIPE into a rejected request", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=close-stdin-after-initialize"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(client.getAccount(), (error) => error?.code === "CODEX_PROCESS_EXIT");
    assert.equal(client.status().state, "stopped");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient handles an app-server stdin EPIPE without an uncaught exception", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=hang-limits"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await client.connect();
    const pending = client.getLimits();
    void pending.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    assert.doesNotThrow(() => client.proc.stdin.emit("error", epipe));
    await assert.rejects(pending, (error) => error?.code === "CODEX_PROCESS_EXIT");
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient initializes in a dedicated profile with a secret-free child environment", async () => {
  const root = tempRoot();
  const codexHome = path.join(root, "codex-home");
  const workDir = path.join(root, "work");
  const saved = {
    OPENAGI_AUTH_TOKEN: process.env.OPENAGI_AUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    FAKE_SENTINEL_SECRET: process.env.FAKE_SENTINEL_SECRET
  };
  Object.assign(process.env, {
    OPENAGI_AUTH_TOKEN: "must-not-reach-child",
    OPENAI_API_KEY: "must-not-reach-child",
    ANTHROPIC_API_KEY: "must-not-reach-child",
    FAKE_SENTINEL_SECRET: "must-not-reach-child"
  });

  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    codexHome,
    workDir,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    const initialized = await client.connect();
    assert.equal(initialized.codexHome, fs.realpathSync(codexHome));
    assert.equal(fs.statSync(codexHome).mode & 0o777, 0o700);
    assert.equal(fs.statSync(workDir).mode & 0o777, 0o700);

    const account = await client.getAccount();
    assert.equal(account.account.type, "chatgpt");
    const models = await client.listModels();
    assert.deepEqual(models.map((model) => model.id), ["gpt-test"]);
  } finally {
    await client.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(client.status().state, "stopped");
  assert.equal(client.status().pid, null);
});

test("CodexAppServerClient reserves one login attempt before awaiting app-server", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=delayed-login"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await client.connect();
    const first = client.startLogin({ mode: "device" });
    await assert.rejects(client.startLogin({ mode: "device" }), (error) => error?.code === "CODEX_BACKPRESSURE");
    assert.equal((await first).loginId, "login-1");
    assert.equal(client.status().loginPending, true);
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient expires a pending login and recycles its child", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    loginTimeoutMs: 30, requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    const result = await client.startLogin({ mode: "device" });
    assert.equal(result.loginId, "login-1");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(client.status().loginPending, false);
    assert.equal(client.status().state, "tainted");
    await assert.rejects(client.cancelLogin(result.loginId), (error) => error?.code === "CODEX_LOGIN_EXPIRED");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient does not retain an unsafe login URL or listener", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=invalid-login-url"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await assert.rejects(client.startLogin({ mode: "device" }), (error) => error?.code === "CODEX_PROTOCOL");
    assert.equal(client.status().loginPending, false);
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient returns the authoritative completed chat message and observed usage", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });
  const deltas = [];

  try {
    const result = await client.runChatTurn({
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: "gpt-test",
      effort: "medium",
      developerInstructions: "No tools.",
      input: "Hello",
      messages: [],
      turnContext: null,
      onTextDelta: (text) => deltas.push(text)
    });

    assert.deepEqual(deltas, ["Authoritative final"]);
    assert.equal(result.turnId, "turn-1");
    assert.equal(result.text, "Authoritative final");
    assert.equal(result.requestedModel, "gpt-test");
    assert.equal(result.observedModel, null);
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, quota: null });
  } finally {
    await client.close();
  }
});

test("a reroute event does not attest the model used for an upstream response", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=rerouted"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    const result = await client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      model: "gpt-test", effort: "medium", input: "Hello"
    });
    assert.equal(result.observedModel, null);
    assert.equal(result.observedEffort, null);
  } finally {
    await client.close();
  }
});

test("a failed turn cannot expose text delivered before its terminal event", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=failed-after-delta"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  const visible = [];
  try {
    await assert.rejects(client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      model: "gpt-test", input: "Hello", onTextDelta: (text) => visible.push(text)
    }), (error) => error?.code === "CODEX_TURN_FAILED");
    assert.deepEqual(visible, []);
  } finally {
    await client.close();
  }
});

test("a terminal message cannot become visible before turn/start acknowledges its identity", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=terminal-before-invalid-ack"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  const visible = [];
  try {
    await assert.rejects(client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      model: "gpt-test", input: "Hello", onTextDelta: (text) => visible.push(text)
    }), (error) => error?.code === "CODEX_PROTOCOL");
    assert.deepEqual(visible, []);
  } finally {
    await client.close();
  }
});

test("a terminal message without its own turn ID cannot release text", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=terminal-missing-id"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  const visible = [];
  try {
    await assert.rejects(client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      model: "gpt-test", input: "Hello", onTextDelta: (text) => visible.push(text)
    }), (error) => error?.code === "CODEX_PROTOCOL");
    assert.deepEqual(visible, []);
  } finally {
    await client.close();
  }
});

for (const mode of ["terminal-alias-mismatch", "terminal-duplicated", "terminal-before-duplicate-ack"]) {
  test(`${mode} cannot release a completed turn`, async () => {
    const root = tempRoot();
    const client = new CodexAppServerClient({
      command: process.execPath, args: [fixture, `--mode=${mode}`],
      codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
      requestTimeoutMs: 1_000, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
    });
    const visible = [];
    try {
      await assert.rejects(client.runChatTurn({
        ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
        model: "gpt-test", input: "Hello", onTextDelta: (text) => visible.push(text)
      }), (error) => error?.code === "CODEX_PROTOCOL");
      assert.deepEqual(visible, []);
    } finally {
      await client.close();
    }
  });
}

test("a valid terminal before turn/start acknowledgement is delivered once after identity matches", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=terminal-before-valid-ack"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  const visible = [];
  try {
    const result = await client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      model: "gpt-test", input: "Hello", onTextDelta: (text) => visible.push(text)
    });
    assert.equal(result.text, "Authoritative final");
    assert.deepEqual(visible, ["Authoritative final"]);
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient admits only one turn while a thread is starting", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=delayed-thread"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  const options = { ephemeral: true, approvalPolicy: "never", sandbox: "read-only", model: "gpt-test", input: "Hello" };
  try {
    await client.connect();
    const first = client.runChatTurn(options);
    void first.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.status().state, "starting-thread");
    const second = client.runChatTurn(options);
    await assert.rejects(second, (error) => error?.code === "CODEX_BACKPRESSURE");
    assert.equal((await first).text, "Authoritative final");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient rejects thread lifecycle identities that disagree with the start response", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=thread-id-mismatch"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await assert.rejects(client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only", input: "Hello"
    }), (error) => error?.code === "CODEX_PROTOCOL");
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient refuses a thread that reports network access", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=unsafe-thread-network"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await assert.rejects(client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only", input: "Hello"
    }), (error) => error?.code === "CODEX_ISOLATION");
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient does not start a turn after abort during thread creation", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=abort-during-thread"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  const controller = new AbortController();
  try {
    await client.connect();
    const pending = client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only", input: "Hello", signal: controller.signal
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient invalidates its child after an uncertain thread start", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=hang-thread"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 100, shutdownTimeoutMs: 1_000
  });
  const options = { ephemeral: true, approvalPolicy: "never", sandbox: "read-only", input: "Hello" };
  try {
    await assert.rejects(client.runChatTurn(options), (error) => error?.code === "CODEX_TIMEOUT");
    assert.equal(client.status().state, "tainted");
    await assert.rejects(client.runChatTurn(options));
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient recycles an accepted turn when its start response is lost", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=hang-turn-start"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 100, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await assert.rejects(client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only", input: "Hello"
    }), (error) => error?.code === "CODEX_TIMEOUT");
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient fails closed and recycles when Codex attempts a built-in command", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=builtin"],
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    await assert.rejects(
      client.runChatTurn({
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        model: "gpt-test",
        input: "Run a command"
      }),
      (error) => error?.code === "CODEX_ISOLATION"
    );
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
  assert.equal(client.status().state, "stopped");
});

test("CodexAppServerClient does not stream buffered output after an isolation violation", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=builtin-followed-by-delta"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, turnTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  const deltas = [];
  try {
    await assert.rejects(client.runChatTurn({
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      input: "Hello", onTextDelta: (delta) => deltas.push(delta)
    }), (error) => error?.code === "CODEX_ISOLATION");
    assert.deepEqual(deltas, []);
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient rejects prohibited items disclosed only in the completed turn", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=hidden-command"],
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    await assert.rejects(
      client.runChatTurn({
        input: "do not run commands",
        model: "gpt-test",
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only"
      }),
      (error) => error?.code === "CODEX_ISOLATION"
    );
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient confirms active cancellation with turn/interrupt before reuse", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=hang"],
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 5_000,
    interruptTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });
  const controller = new AbortController();

  try {
    await client.connect();
    const turn = client.runChatTurn({
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: "gpt-test",
      input: "Wait",
      signal: controller.signal
    });
    for (let attempt = 0; attempt < 100 && !client.activeTurn?.turnId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(client.activeTurn?.turnId, "the turn must be accepted before interruption");
    controller.abort();
    await assert.rejects(turn, (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR");
    assert.equal(client.status().state, "ready");
    assert.ok(client.status().pid);
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient exposes only the official device-code login mode", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    await assert.rejects(
      client.startLogin({ mode: "chatgptAuthTokens" }),
      (error) => error?.code === "CODEX_LOGIN_MODE"
    );
    const login = await client.startLogin({ mode: "device" });
    assert.deepEqual(login, {
      type: "chatgptDeviceCode",
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device"
    });
    assert.equal(client.status().loginPending, true);
    assert.deepEqual(await client.cancelLogin("login-1"), { status: "canceled" });
    assert.equal(client.status().loginPending, false);
    await client.logout();
  } finally {
    await client.close();
  }
});

test("Codex rejects a phishing HTTPS verification URL and unsupported browser callback", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=hostile-login-url"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await assert.rejects(client.startLogin({ mode: "browser" }), (error) => error?.code === "CODEX_LOGIN_MODE");
    await assert.rejects(client.startLogin({ mode: "device" }), (error) => error?.code === "CODEX_PROTOCOL");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient recycles its listener after uncertain login cancellation", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=hang-login-cancel"],
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 100, shutdownTimeoutMs: 1_000
  });
  try {
    const login = await client.startLogin({ mode: "device" });
    await assert.rejects(client.cancelLogin(login.loginId), (error) => error?.code === "CODEX_TIMEOUT");
    assert.equal(client.status().loginPending, false);
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient rejects every app-server request instead of creating an approval queue", async () => {
  const root = tempRoot();
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=server-request"],
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    await assert.rejects(
      client.runChatTurn({
        input: "do not approve anything",
        model: "gpt-test",
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only"
      }),
      (error) => error?.code === "CODEX_ISOLATION"
    );
    assert.equal(client.status().serverRequestsDenied, 1);
    assert.equal(client.status().state, "tainted");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient refuses qualification when effective feature surfaces disagree", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture],
    expectedSha256,
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "isolation-failed");
    assert.equal(result.reason, "effective-feature-disagreement");
    assert.equal(client.status().readiness, "isolation-failed");
    assert.equal(client.status().binarySha256, expectedSha256);
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient refuses qualification when an integration catalog is non-empty", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=catalog-nonempty"],
    expectedSha256,
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "isolation-failed");
    assert.equal(result.reason, "integration-catalog-not-empty");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient refuses qualification when catalog evidence is missing", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=missing-catalog-evidence"], expectedSha256,
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "isolation-failed");
    assert.equal(result.reason, "integration-catalog-unverified");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient refuses qualification when managed requirements can enable integrations", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=config-requirement"],
    expectedSha256,
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "isolation-failed");
    assert.equal(result.reason, "effective-requirements-present");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient refuses qualification when any built-in feature remains enabled", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=feature-enabled"],
    expectedSha256,
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "isolation-failed");
    assert.equal(result.reason, "effective-feature-enabled");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient refuses qualification when a required feature has no effective evidence", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=missing-feature-evidence"], expectedSha256,
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "isolation-failed");
    assert.equal(result.reason, "effective-feature-unverified");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient refuses qualification when effective sandbox policy is unsafe", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=unsafe-effective-config"],
    expectedSha256,
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "isolation-failed");
    assert.equal(result.reason, "effective-config-unsafe");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient qualifies effective config with all project layers included", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fixture, "--mode=require-config-layers"],
    expectedSha256,
    codexHome: path.join(root, "codex-home"),
    workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000
  });

  try {
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "canary-required");
    assert.equal(result.reason, "negative-canaries-not-run");
  } finally {
    await client.close();
  }
});

test("CodexAppServerClient inspects integration catalogs at the sandbox working directory", async () => {
  const root = tempRoot();
  const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const client = new CodexAppServerClient({
    command: process.execPath, args: [fixture, "--mode=require-sandbox-catalog-cwd"], expectedSha256,
    codexHome: path.join(root, "codex-home"), workDir: path.join(root, "work"),
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 1_000
  });
  try {
    await client.connect();
    // Reproduce the production cwd mapping with a host-side fake app-server.
    client.sandboxed = true;
    const result = await client.inspectReadiness({ model: "gpt-test" });
    assert.equal(result.readiness, "canary-required");
  } finally {
    await client.close();
  }
});
