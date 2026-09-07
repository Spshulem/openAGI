import { registerCodingSupervisorTools } from "./coding-supervisor.js";
// Called only after the hosted interface's shared authentication/Origin gate.
export async function codingSupervisorRoute(runtime, method, pathname, url, readBody) {
  if (!pathname.startsWith("/coding-agents")) return null;
  const supervisor = runtime.codingSupervisor;
  if (method === "GET" && pathname === "/coding-agents/setup") {
    try { return { status: 200, body: await supervisor?.setup() ?? { enabled: false } }; }
    catch { return { status: 503, body: { enabled: false, error: "The coding node is unavailable." } }; }
  }
  if (method === "POST" && pathname === "/coding-agents/configure") {
    try {
      const body = await readBody();
      const result = await supervisor.configure({ enabled: body.enabled, workspaces: body.workspaces });
      registerCodingSupervisorTools(runtime.tools, supervisor);
      return { status: 200, body: result };
    } catch { return { status: 400, body: { error: "Choose existing absolute Git project folders. Stop managed sessions before changing setup; external adapters must be configured separately." } }; }
  }
  if (method === "GET" && pathname === "/coding-agents") {
    const snapshot = await supervisor?.refresh() ?? { configured: false, sessions: [], checkedAt: null, error: null };
    return { status: snapshot.error ? 503 : 200, body: snapshot };
  }
  if (!supervisor?.configured) return { status: 503, body: { error: "Coding supervisor is not configured. See the coding-supervisor setup guide." } };
  try {
    if (method === "POST" && pathname === "/coding-agents/watch") {
      const body = await readBody();
      return { status: 200, body: await supervisor.setWatch({ provider: body.provider, sessionId: body.sessionId, enabled: body.enabled }) };
    }
    if (method === "POST" && pathname === "/coding-agents/reconcile" && (!supervisor.external || supervisor.remote)) {
      const body = await readBody();
      if (supervisor.remote) return { status: 200, body: await supervisor.request({ operation: "reconcile", provider: body.provider, sessionId: body.sessionId, confirmedStopped: body.confirmedStopped }) };
      return { status: 200, body: supervisor.builtin.reconcile({ provider: body.provider, sessionId: body.sessionId, confirmedStopped: body.confirmedStopped }) };
    }
    if (method === "POST" && pathname === "/coding-agents/start") {
      const body = await readBody();
      const result = await runtime.tools.invoke("start_coding_agent", { provider: body.provider, workspaceId: body.workspaceId, message: body.message,
        ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) }, { source: "http", route: pathname });
      return { status: result.ok ? 202 : 400, body: result.ok ? result.result : { error: result.error } };
    }
    if (method === "POST" && pathname === "/coding-agents/stop" && (!supervisor.external || supervisor.remote)) {
      const body = await readBody();
      if (supervisor.remote) return { status: 200, body: await supervisor.request({ operation: "stop", provider: body.provider, sessionId: body.sessionId }) };
      return { status: 200, body: supervisor.builtin.cancel({ provider: body.provider, sessionId: body.sessionId }) };
    }
    if (method === "GET" && pathname === "/coding-agents/session") {
      const target = { provider: url.searchParams.get("provider"), sessionId: url.searchParams.get("sessionId") };
      return { status: 200, body: await supervisor.inspect(target) };
    }
    if (method === "POST" && pathname === "/coding-agents/reply") {
      const body = await readBody();
      // Ignore client context, confirmation flags, backend paths, request IDs,
      // and fingerprints. Only the approval executor can confirm a reply.
      const result = await runtime.tools.invoke("reply_to_coding_agent", {
        provider: body.provider, sessionId: body.sessionId, message: body.message
      }, { source: "http", route: "/coding-agents/reply" });
      return { status: result.ok ? 202 : 400, body: result.ok ? result.result : { error: result.error } };
    }
  } catch {
    return { status: 400, body: { error: "The coding session could not be read. Refresh its status and check the supervisor connection." } };
  }
  return { status: 404, body: { error: "Unknown coding supervisor route." } };
}
