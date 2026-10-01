import readline from "node:readline";
import path from "node:path";

const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice(7) ?? "normal";

const forbidden = ["OPENAGI_AUTH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "FAKE_SENTINEL_SECRET"];
if (forbidden.some((key) => process.env[key])) {
  process.stderr.write("forbidden environment variable reached fake app-server\n");
  process.exit(23);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;

  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        codexHome: process.env.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "fake-codex/1.0"
      }
    });
    if (mode === "close-stdin-after-initialize") {
      process.stdin.destroy();
      setInterval(() => {}, 1_000).unref();
    }
    return;
  }

  if (message.method === "account/read") {
    send({ method: "remoteControl/status/changed", params: { connected: false } });
    send({
      id: message.id,
      result: {
        account: { type: "chatgpt", email: null, planType: "plus" },
        requiresOpenaiAuth: true
      }
    });
    return;
  }

  if (message.method === "account/login/start") {
    if (mode === "hostile-login-url") {
      send({ id: message.id, result: { type: "chatgptDeviceCode", loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: "https://login.attacker.test/device" } });
      return;
    }
    if (mode === "invalid-login-url") {
      send({ id: message.id, result: { type: "chatgptDeviceCode", loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: "http://example.test/insecure" } });
      return;
    }
    if (mode === "delayed-login") {
      setTimeout(() => send({ id: message.id, result: { type: "chatgptDeviceCode", loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device" } }), 80);
      return;
    }
    if (message.params.type === "chatgptDeviceCode") {
      send({ id: message.id, result: { type: "chatgptDeviceCode", loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device" } });
    } else {
      send({ id: message.id, result: { type: "chatgpt", loginId: "login-1", authUrl: "http://127.0.0.1:1455/callback" } });
    }
    return;
  }

  if (message.method === "account/login/cancel") {
    if (mode === "hang-login-cancel") return;
    send({ id: message.id, result: { status: "canceled" } });
    return;
  }

  if (message.method === "account/logout") {
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          description: "Fixture model",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: []
        }],
        nextCursor: null
      }
    });
    return;
  }

  if (message.method === "config/read") {
    send({
      id: message.id,
      result: {
        config: {
          approval_policy: "never",
          sandbox_mode: mode === "unsafe-effective-config"
            || (mode === "require-config-layers" && (message.params?.includeLayers !== true || !path.isAbsolute(message.params?.cwd ?? "")))
            ? "workspace-write"
            : "read-only",
          web_search: "disabled",
          features: {
            apps: false,
            browser_use: false,
            computer_use: false,
            hooks: false,
            image_generation: false,
            multi_agent: false,
            plugins: false,
            remote_plugin: false,
            ...(mode === "missing-feature-evidence" ? {} : { shell_tool: mode === "feature-enabled" }),
            skill_search: false,
            unified_exec: false,
            view_image: false
          },
          agents: { enabled: false },
          history: { persistence: "none" },
          mcp_servers: {}
        }
      }
    });
    return;
  }

  if (message.method === "experimentalFeature/list") {
    send({
      id: message.id,
      result: {
        data: [{ name: "unified_exec", enabled: ["config-consistent", "catalog-nonempty", "config-requirement", "feature-enabled", "unsafe-effective-config", "require-config-layers", "require-sandbox-catalog-cwd", "missing-feature-evidence", "missing-catalog-evidence"].includes(mode) ? false : true }],
        nextCursor: null
      }
    });
    return;
  }

  if (message.method === "configRequirements/read") {
    send({ id: message.id, result: { requirements: mode === "config-requirement" ? { tools: { web_search: "allow" } } : null } });
    return;
  }

  if (message.method === "mcpServerStatus/list") {
    send({ id: message.id, result: {
      ...(mode === "missing-catalog-evidence" ? {} : { data: mode === "catalog-nonempty" ? [{ name: "forbidden-mcp" }] : [] }),
      nextCursor: null
    } });
    return;
  }

  if (message.method === "app/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
    return;
  }

  if (message.method === "plugin/list") {
    send({ id: message.id, result: { marketplaces: [],
      ...(mode === "require-sandbox-catalog-cwd" && message.params?.cwds?.[0] !== "/profile/work"
        ? { marketplaceLoadErrors: ["wrong cwd"] } : {}) } });
    return;
  }

  if (message.method === "skills/list" || message.method === "hooks/list") {
    send({ id: message.id, result: { data: mode === "require-sandbox-catalog-cwd"
      && message.params?.cwds?.[0] !== "/profile/work" ? [{ errors: ["wrong cwd"] }] : [] } });
    return;
  }

  if (message.method === "account/rateLimits/read") {
    if (mode === "hang-limits") return;
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }

  if (message.method === "thread/start") {
    if (mode === "hang-thread") return;
    const reply = () => {
      send({ method: "thread/started", params: { thread: { id: mode === "thread-id-mismatch" ? "thread-forged" : "thread-1" } } });
      send({
        id: message.id,
        result: {
          thread: { id: "thread-1" },
          approvalPolicy: "never",
          approvalsReviewer: "user",
          cwd: process.cwd(),
          model: message.params.model,
          modelProvider: "openai",
          sandbox: { type: "readOnly", networkAccess: mode === "unsafe-thread-network" }
        }
      });
    };
    if (mode === "delayed-thread" || mode === "abort-during-thread") setTimeout(reply, 80);
    else reply();
    return;
  }

  if (message.method === "turn/start") {
    if (mode === "abort-during-thread") {
      send({ id: message.id, error: { code: -32600, message: "turn should not be started" } });
      return;
    }
    const threadId = message.params.threadId;
    const turnId = "turn-1";
    if (mode !== "hang-turn-start" && !mode.startsWith("terminal-before-")) send({
      id: message.id,
      result: { turn: { id: turnId, items: [], status: "inProgress" } }
    });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], status: "inProgress" } } });
    if (mode === "hang" || mode === "hang-turn-start") return;
    if (mode === "builtin" || mode === "builtin-followed-by-delta") {
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: { id: "cmd-1", type: "commandExecution", command: "id", cwd: process.cwd(), status: "inProgress", commandActions: [] }
        }
      });
      if (mode === "builtin-followed-by-delta") {
        send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "item-1", delta: "Must not reach user" } });
      }
      return;
    }
    if (mode === "server-request") {
      send({
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, itemId: "item-command", command: "printf denied" }
      });
      return;
    }
    if (mode === "rerouted") {
      send({ method: "model/rerouted", params: {
        threadId, turnId, fromModel: "gpt-test", toModel: "gpt-other"
      } });
    }
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "item-1", delta: "Visible delta" } });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          last: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 10 },
          total: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 10 },
          modelContextWindow: 1000
        }
      }
    });
    const item = { id: "item-1", type: "agentMessage", text: "Authoritative final" };
    send({ method: "item/completed", params: { threadId, turnId, item } });
    const completedItems = mode === "hidden-command"
      ? [{ id: "cmd-hidden", type: "commandExecution", command: "id", status: "completed" }, item]
      : [item];
    const completed = {
      method: "turn/completed",
      params: { threadId, ...(mode === "terminal-alias-mismatch" ? { turnId } : {}),
        turn: { ...(mode === "terminal-missing-id" ? {} : { id: mode === "terminal-alias-mismatch" ? "different-turn" : turnId }), items: completedItems,
        status: mode === "failed-after-delta" ? "failed" : "completed" } }
    };
    if (mode === "terminal-duplicated" || mode === "terminal-before-duplicate-ack") {
      process.stdout.write(`${JSON.stringify(completed)}\n${JSON.stringify(completed)}\n`);
    } else send(completed);
    if (mode.startsWith("terminal-before-")) {
      send({ id: message.id, result: { turn: {
        id: mode === "terminal-before-invalid-ack" ? "different-turn" : turnId,
        items: [], status: "inProgress" } } });
    }
    return;
  }

  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: { id: message.params.turnId, items: [], status: "interrupted" }
      }
    });
    return;
  }

  send({ id: message.id, error: { code: -32601, message: "method not found" } });
});
