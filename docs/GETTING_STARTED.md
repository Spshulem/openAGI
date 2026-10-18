# Your first useful result with OpenAGI

OpenAGI is a persistent agent on a host you choose. You can chat, remember
preferences, track work, schedule prompts, connect tools, observe activity, and
reach the same main agent from other devices. Start with one useful result and
add access only when you need it.

**[Install or download](INSTALL.md)**, then use the three-step `/setup` wizard:
choose a model, connect and verify it, and enter your workspace. API keys stay
in setup; you do not need to paste them into chat. An unreachable provider or
fallback echo does not pass model verification.

Use Anthropic or OpenAI with an API key, sign in with an eligible ChatGPT plan,
connect an Ollama/LM Studio server, or choose Apple Intelligence in the native
Mac or iPhone app. Apple Intelligence requires macOS 26/iOS 26, compatible
hardware, enabled Intelligence, and downloaded models. Local servers need an
installed model; use the server URL ending in `/v1`. Small local models have
limits on context, tools, and vision. Verification proves a text response,
not that every tool or computer-control workflow works with that model.

Start in **Chat**, or open **Get started** in the sidebar to choose a guide.
**Meet your agent** and **Try it in chat** open
a new conversation with an editable starter request. Nothing is sent until you
press Send. The agent asks one question at a time and helps check your result.
You can also ask "Help me get started" from a connected phone chat.

## 1. Meet your agent

Tell it one goal, such as planning your day or keeping track of a project.
Ask what tools it can actually use. Start with a small request you can check,
such as organizing a few tasks you provide. Check the answer before trusting a
background workflow. Review Tasks, Approvals, and Integrations from the dashboard.

The difference is continuity: the runtime can combine conversations, remembered
preferences, scheduled work, and inputs you enable between chats. It needs a
running host and a working model. It does not automatically see every app or
learn a routine just because you installed it.

## 2. Teach it a preference, then correct it

Try "Remember that I prefer short daily plans." Ask what it remembers, then
correct the preference and check **Memory**. Test recall in another chat.

Memory has short, medium, and longer-term tiers with retention and consolidation.
It can be incomplete or wrong, so corrections and review matter. **Skills** holds
reusable workflows and suggestions from recurring activity. Review suggested
skills before accepting them. Inputs, configuration, and available evidence
determine what can be learned; there is no promised first-hour or first-week
result.

## 3. Monitor coding agents

**More → Coding Agents** configures supported CLI providers and specific Git
projects, then lets you inspect sessions and review approved instructions.
**Fleet** monitors recent supported desktop/CLI sessions and groups what needs
your attention. Start in **observe** mode. Installed applications, CLI sign-in,
permissions, and the computer running the supervisor determine available sources.

Ask the agent to explain what it found in one session. Read the actual result
and verification evidence; an agent reporting "done" does not establish passing
tests or delivery. Starting a managed run, sending a reply, and automatic nudging
are distinct actions. See [Coding Agents](setup/coding-supervisor.md) and
[Fleet](setup/fleet-supervisor.md) for exact setup and mode limits.

## 4. Understand the screen, then try Computer Use

These are two different capabilities:

| Capability | Set it up | Check the result |
| --- | --- | --- |
| Optional macOS observation | Menu bar → Capture; grant Screen Recording yourself | Review **Computer History** and ask about captured activity |
| Interactive Computer Use | Choose a supported computer node, check permissions/readiness, and explicitly request and approve a session | Begin with a harmless screen summary; verify the selected app and fresh result before requesting input |

Observation can provide historical context and support routine suggestions.
Captured text is not a current screenshot or proof that clicks and typing work.
Computer Use needs its own approval and capabilities; pairing a phone or Linux
server does not turn that device into a desktop executor. You control macOS
Screen Recording and Accessibility permissions. OpenAGI does not grant them.

Selected screen context can be sent to your configured model. Start with a
non-sensitive window. Read [readiness](setup/computer-use-readiness.md) and the
[optional Computer Use backend](setup/open-computer-use.md).

## 5. Connect a phone, another computer, or glasses

Choose one **main** host to keep the agent's state. Each other device pairs
with its own scoped identity. Check **More → Nodes** for a fresh heartbeat and
advertised capabilities.

- **iPhone or Android:** build/install the companion app, then on the main run
  `node bin/openagi.js pair-phone --platform ios --url https://your-main.example`
  (or `--platform android`). Use the one-time code in the app, not in an agent
  chat. Follow [mobile setup](../mobile/README.md) for private-network and
  HTTPS requirements. The companion source includes tasks, chat, approvals,
  and supervisor surfaces; see [mobile features](../mobile/FEATURES.md).
  Source availability does not imply a public app-store download.
- **Another computer:** install the runtime there and use
  `node bin/openagi.js pair <main-url>` following
  [the node connection guide](setup/nodes.md). Keep credentials in local
  configuration, not chat. An authenticated HTTPS address is the default for
  remote pairing; don't expose an unauthenticated daemon to the internet.
- **Even G2:** use **Connect glasses** on the dashboard and the
  [G2 guide](setup/even-g2.md). Glasses are a voice/display client, not the
  computer that executes desktop actions.

The main must be awake and reachable. Widget refresh, live chat, push delivery,
and screen control have different platform requirements; test the flow you
intend to use on your own device.

## 6. Build on the runtime

Start with a [skill](../examples/skills) or an MCP connection in Integrations.
Add one capability, test it, and expand. The Docker image supports Linux x64 and
arm64 for servers and compatible single-board computers. Mobile clients and
device integrations are in the repository; hardware support requires compatible
software, transport, and permissions.

The code is **source-available under [PolyForm Noncommercial 1.0.0](../LICENSE)**,
not an OSI open-source license. Inspect, learn, and build within those terms;
commercial use needs separate permission. Do not assume every device or model
works without integration work.

## Stay in control

Local storage means you choose where state is kept. It does not mean no data
leaves the host: model providers and connected services receive selected
requests/context. Review what you connect and the model you choose.

Use **Approvals** for pending actions, **Memory** for stored context,
**Skills** for reusable workflows, **Computer History** for observations,
**Computer Use** for control activity, **Nodes** for devices, and **Credits**
for the agent's tracked model spend. Coding CLI/provider usage can be billed
separately. Checks in Get started mean "I tried this guide" in this browser;
they do not grant permissions or certify that a connection is working.
