import { GET_STARTED_FLOWS } from "./get-started.js";

function gettingStartedProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem("openagi.getStarted.v1") || "[]");
    return new Set(Array.isArray(saved) ? saved.filter(id => GET_STARTED_FLOWS.some(flow => flow.id === id)) : []);
  } catch { return new Set(); }
}

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

function renderGettingStarted() {
  const progress = gettingStartedProgress();
  main.innerHTML = "";
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const page = el("div", "", "guide-page");
  page.append(el("div", "Make it yours", "eyebrow"));
  page.append(el("h2", "A little more useful, every day."));
  page.append(el("p", "An agent that remembers your preferences, follows your work, and connects your devices. Start with one conversation. Add the rest when you need it.", "guide-intro"));
  const cardFor = (flow, featured = false) => {
    const card = el("section", "", featured ? "guide-featured" : "guide-card");
    if (featured) card.append(el("span", "01", "guide-number"));
    const body = el("div");
    if (featured) body.append(el("div", "Start here · " + flow.time, "eyebrow"));
    body.append(el("h3", flow.title), el("p", flow.description));
    const chat = el("button", featured ? "Meet your agent →" : "Try it in chat →", featured ? "ui-btn ui-btn-primary" : "");
    chat.type = "button";
    chat.onclick = () => startGettingStartedChat(flow.id);
    body.append(chat);
    const details = el("details");
    details.append(el("summary", "What you’ll try"));
    const steps = el("ol");
    for (const step of flow.steps) steps.append(el("li", step));
    const link = el("a", flow.linkLabel + " →"); link.href = flow.link;
    if (flow.link.startsWith("https://")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    details.append(steps, link);
    const label = el("label", "", "guide-check");
    const check = el("input"); check.type = "checkbox"; check.checked = progress.has(flow.id);
    check.onchange = () => {
      if (check.checked) progress.add(flow.id); else progress.delete(flow.id);
      try { localStorage.setItem("openagi.getStarted.v1", JSON.stringify([...progress])); } catch { /* private browsing */ }
      renderGettingStarted();
    };
    label.append(check, el("span", "I tried this guide"));
    details.append(label); body.append(details); card.append(body); return card;
  };
  page.append(cardFor(GET_STARTED_FLOWS[0], true));
  page.append(el("h3", "Explore at your own pace", "section-label"));
  const grid = el("div", "", "guide-grid");
  for (const flow of GET_STARTED_FLOWS.slice(1)) grid.append(cardFor(flow));
  page.append(grid);
  const footer = el("div", "", "guide-footer");
  footer.append(el("span", progress.size + " of " + GET_STARTED_FLOWS.length + " guides tried · Your personal checklist"));
  const guide = el("a", "Read the getting started guide ↗");
  guide.href = "https://github.com/Spshulem/openAGI/blob/main/docs/GETTING_STARTED.md"; guide.target = "_blank"; guide.rel = "noopener noreferrer";
  footer.append(guide); page.append(footer); main.append(page);
}

export const getStartedUi = `const GET_STARTED_FLOWS = ${JSON.stringify(GET_STARTED_FLOWS)};\n`
  + [gettingStartedProgress, startGettingStartedChat, renderGettingStarted].map(fn => fn.toString()).join("\n");
