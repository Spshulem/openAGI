// One public guide for the dashboard and the agent, including phone chats.
// Choosing a flow is education, never permission to enable an integration.
export const GET_STARTED_FLOWS = [
  {
    id: "chat", title: "Meet your agent", time: "2 minutes",
    description: "Tell your agent what you’re working on. Get one small, useful result and build from there.",
    steps: ["Connect your own model in Settings and save your dashboard login.", "Tell the agent what you want help with and how you prefer to work.", "Ask for one small result, then check the answer and model status."],
    link: "/setup", linkLabel: "Connect a model",
    prompt: "Help me get started with OpenAGI. Ask what I’m working on, then give me one small useful result in at most three short bullets. Offer a next step instead of a long tutorial."
  },
  {
    id: "memory", title: "Teach it how you work", time: "3 minutes",
    description: "Save a preference, recall it in another chat, and see how corrections help your agent adapt.",
    steps: ["Choose one non-sensitive preference you want remembered.", "Ask the agent to remember it, then ask it to recall it in another chat.", "Try correcting it and review the Memory and Skills tabs. Learning needs useful input and time; suggestions are not guaranteed."],
    link: "/?tab=memory", linkLabel: "Review memory",
    prompt: "Walk me through remembering how I work. Help me save one non-sensitive preference and verify that you can recall it."
  },
  {
    id: "agents", title: "Monitor your coding agents", time: "5 minutes",
    description: "Follow coding sessions and see what needs your attention. Start with a read-only view.",
    steps: ["Open Supervisor. Sessions started through OpenAGI appear under Managed sessions; existing app conversations appear under Other coding conversations after Scan now.", "To start a managed session, open Coding setup, sign in to Codex CLI or Claude Code on that computer, and save an existing Git project folder. Review the start approval before running.", "Inspect a real reply and choose Watch session for response updates. Observe mode applies to other coding conversations. A status is not proof that code passed tests, merged, or shipped."],
    link: "/?tab=coding-agents", linkLabel: "Set up Coding Agents",
    prompt: "Help me monitor my coding agents. Use the documented Supervisor and Coding setup screens. First ask whether I want to follow an existing conversation or start a managed Codex CLI or Claude Code session. Give me one working setup link and one next step."
  },
  {
    id: "screen", title: "See your screen and take action", time: "5 minutes",
    description: "Give your agent context from your Mac, or approve actions on a ready computer. You choose when.",
    steps: ["On the Mac app, choose Capture from the menu bar to opt into observation and grant Screen Recording yourself.", "Review Computer History. Captured text is history; it does not prove live screen access or input readiness.", "For Computer Use, check the selected node and its permissions, then request a harmless read-only screen summary. Approve the session explicitly before interaction."],
    link: "/?tab=computer-use", linkLabel: "Check Computer Use",
    prompt: "Help me understand screen observation and Computer Use. Ask about my computer and explain the options before we enable anything."
  },
  {
    id: "devices", title: "Connect your phone or another node", time: "5 minutes",
    description: "Reach your main agent from your phone or another computer. Keep each device’s access scoped.",
    steps: ["Choose the main computer and a private network or authenticated HTTPS address the other device can reach.", "For iPhone or Android, install a build of the companion app and run openagi pair-phone on the main. App source is included; a public store download is not promised.", "For another computer, use openagi pair with the main address. Check Nodes for a fresh heartbeat and the capabilities that device actually offers. Glasses use Connect glasses."],
    link: "/?tab=nodes", linkLabel: "Review connected nodes",
    prompt: "Help me connect my phone or another computer to OpenAGI. Ask which device I have and where my main agent runs."
  },
  {
    id: "build", title: "Build your own agent or device", time: "Explore",
    description: "Add a skill, connect an MCP tool, or run a node on your own hardware. Explore the source and license.",
    steps: ["Read the source and license: PolyForm Noncommercial 1.0.0 permits noncommercial use; it is not an OSI open-source license.", "Start with one skill or MCP connection before changing the runtime. Connect only tools and data you intend to share with your model.", "Run a separate node on supported hardware and test one advertised capability. Device integrations need their own compatible software and permissions."],
    link: "https://github.com/Spshulem/openAGI", linkLabel: "Explore the source",
    prompt: "Help me build on OpenAGI. Ask what I want to make and which hardware I have, then guide me through the smallest working example."
  }
];

export const GET_STARTED_GUIDANCE = `
When the user asks to get started, learn OpenAGI, or follow a guided setup:
- Start with their goal and operating system. Ask one question at a time, explain why the next step helps, and use one small verifiable result per step. Keep onboarding replies under 120 words unless they ask for more detail. Give the small result before offering commands or a longer tutorial.
- Use available read-only tools to check current configuration. Say when you cannot check it. A configured key, discovered CLI, historical screenshot, or online node does not prove a working model, authenticated agent, live computer control, or completed work.
- Keep credentials in Settings or the local CLI, never in chat. Model requests can send selected context to the configured provider; local storage does not mean all inference stays on-device.
- Explain and guide first. Onboarding is not blanket authorization to capture screens, start computer control, connect accounts, send messages, run coding agents, or enable background automation. Retain the normal approval gates.
- Offer to verify the user's result, help recover a failed step, or skip it. Do not claim a step completed from a link click or elapsed time. Get started uses stored evidence: a configured model, an actual model reply, a saved preference explicitly recalled in another chat, and a completed managed coding session.
- For coding setup, use these exact links and labels. [Supervisor](/fleet) has Managed sessions and Other coding conversations. [Coding setup](/?tab=coding-agents) has Git project folders and Start a coding session. There is no Connect Codex CLI button, machine picker, Projects subpage or read-only selector in Coding setup. Do not invent controls. Existing interactive CLI/app conversations are discovered by Supervisor; OpenAGI-managed sessions use their own session list and Watch session control. Watch does not send replies. CLI sign-in is separate from the chat API key; codex login or claude auth login runs on the supervisor computer. Codex history lives under its Codex home, not the project folder. Never ask for a key in chat.
- Be concrete about the distinction: the persistent runtime can combine scheduled work, memory and corrections, optional observation, reviewed skills, and multiple scoped nodes. Benefits depend on the inputs, permissions, and models the user enables. Do not promise autonomous improvement or guaranteed results.
Setup paths:
${GET_STARTED_FLOWS.map(flow => `${flow.title}: ${flow.steps.join(" ")} Open ${flow.link}.`).join("\n")}
`;
