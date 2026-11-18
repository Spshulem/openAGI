import { GET_STARTED_FLOWS } from "./get-started.js";

async function startGettingStartedChat(id) {
  const flow = GET_STARTED_FLOWS.find(item => item.id === id);
  if (!flow) return;
  if (state.modelReady === false) {
    try { sessionStorage.setItem("openagi.setupDraft", flow.prompt); } catch { /* browser storage unavailable */ }
    window.location.href = "/setup";
    return;
  }
  // A guide starts a new draft. Do not carry an unrelated composer into it.
  const previousInput = document.getElementById("input");
  if (previousInput) previousInput.value = flow.prompt;
  Object.assign(state, {
    chatDraft: flow.prompt, guidedFlow: flow.id,
    sessionId: null, messages: [], freshChatRequested: true, agentId: "main",
    channel: "local", from: "browser-" + Date.now(), activeRequestId: null,
    activeRequestStage: null, activeRequestError: null, activeRequestMissingSince: null,
    activeRequestText: "", activeRequestModel: ""
  });
  // Clear an old session/compose handoff before opening this new conversation.
  const url = new URL(window.location.href);
  for (const key of ["session", "request", "compose", "suggestion", "pending"]) url.searchParams.delete(key);
  url.searchParams.set("tab", "chat");
  history.replaceState(null, "", url.toString());
  await switchTab("chat");
  const input = document.getElementById("input");
  if (input) {
    input.value = flow.prompt;
    input.dispatchEvent(new Event("input"));
    input.focus();
  }
  // Draft only. The user reads/edits the request and chooses Send.
}

async function renderGettingStarted() {
  main.innerHTML = "";
  const page = document.createElement("div"); page.className = "guide-page";
  main.append(page);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  page.append(el("div", "Make it yours", "eyebrow"), el("h2", "Three ways to put your agent to work."));
  page.append(el("p", "Get a useful answer, teach a preference, or follow a coding session. Start with what matters to you.", "guide-intro"));
  let progress = null;
  try { progress = await fetchJson("/getting-started"); } catch { /* show an honest unavailable state */ }
  if (!page.isConnected) return;
  const milestones = [
    ["model", "Model configured", "Connect a model", "/setup"],
    ["chat", "First model reply", "Meet your agent", "chat"],
    ["memory", "Preference recalled in another chat", progress?.memorySaved ? "Verify your saved preference" : "Save a preference", "memory"],
    ["agents", "Managed session replied", "Connect a coding session", "agents"]
  ];
  const progressList = el("ol", "", "onboarding-milestones");
  progressList.setAttribute("aria-label", "Setup progress");
  for (const [id, label] of milestones) {
    const item = el("li", "", progress?.[id] ? "complete" : "");
    item.append(el("span", progress?.[id] ? "✓" : "○", "milestone-mark"), el("span", label));
    item.append(el("small", progress ? (progress[id] ? "Verified from saved activity" : id === "memory" && progress.memorySaved ? "Saved · try recalling it in a new chat" : "Ready when you are") : "Could not check progress"));
    progressList.append(item);
  }
  page.append(progressList);
  const next = progress && milestones.find(([id]) => !progress[id]);
  if (next) {
    const box = el("section", "", "guide-next");
    box.append(el("span", "Next step", "eyebrow"));
    const action = el(next[3] === "/setup" ? "a" : "button", next[2] + " →", "ui-btn ui-btn-primary");
    if (next[3] === "/setup") action.href = "/setup";
    else action.onclick = () => next[3] === "agents" ? window.location.assign("/fleet") : startGettingStartedChat(next[3]);
    box.append(action); page.append(box);
  }
  const cardFor = flow => {
    const card = el("section", "", "guide-card");
    card.append(el("h3", flow.title), el("p", flow.description));
    const action = el(flow.id === "agents" ? "a" : "button", flow.id === "agents" ? "Open Supervisor →" : "Try it in chat →", "ui-btn");
    if (flow.id === "agents") action.href = "/fleet";
    else action.onclick = () => startGettingStartedChat(flow.id);
    card.append(action);
    const details = el("details"); details.append(el("summary", "How it works"));
    const steps = el("ol"); for (const step of flow.steps) steps.append(el("li", step));
    const link = el("a", flow.linkLabel + " →"); link.href = flow.link;
    if (flow.link.startsWith("https://")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    details.append(steps, link);
    if (flow.id === "agents") {
      const chat = el("button", "Ask your agent for help"); chat.onclick = () => startGettingStartedChat("agents"); details.append(chat);
    }
    card.append(details); return card;
  };
  const core = el("div", "", "guide-grid guide-core");
  GET_STARTED_FLOWS.slice(0, 3).forEach(flow => core.append(cardFor(flow))); page.append(core);
  const more = el("details", "", "guide-more"); more.append(el("summary", "Explore screen access, devices and building your own integrations"));
  const grid = el("div", "", "guide-grid"); GET_STARTED_FLOWS.slice(3).forEach(flow => grid.append(cardFor(flow))); more.append(grid); page.append(more);
  const footer = el("div", "", "guide-footer");
  footer.append(el("span", "Progress comes from your saved activity. Opening a guide never marks it complete."));
  const guide = el("a", "Getting started guide ↗"); guide.href = "https://github.com/Spshulem/openAGI/blob/main/docs/GETTING_STARTED.md";
  guide.target = "_blank"; guide.rel = "noopener noreferrer"; footer.append(guide); page.append(footer);
}

export const getStartedUi = `const GET_STARTED_FLOWS = ${JSON.stringify(GET_STARTED_FLOWS)};\n`
  + [startGettingStartedChat, renderGettingStarted].map(fn => fn.toString()).join("\n");
