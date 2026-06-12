// Main-side tool: `search_imessages`. Lets the agent answer questions about the
// user's iMessages even though chat.db lives on a different machine (a Mac
// node). The tool proxies to that node's iMessage service (see
// imessage-server.js), which the node runs with `openagi imessage-server`.
//
// Enabled only when OPENAGI_IMESSAGE_NODE is set (the node's base URL, e.g.
// http://macmini.tailnet:43298). OPENAGI_IMESSAGE_NODE_TOKEN authenticates.
// Off by default — no node configured → no tool, so non-Mac mains are clean.

export function registerImessageSearchTool(runtime, { fetchImpl = globalThis.fetch } = {}) {
  const nodeUrl = (process.env.OPENAGI_IMESSAGE_NODE ?? "").replace(/\/$/, "");
  if (!nodeUrl) return { registered: false, reason: "OPENAGI_IMESSAGE_NODE not set" };
  const nodeToken = process.env.OPENAGI_IMESSAGE_NODE_TOKEN ?? null;

  runtime.tools.register({
    name: "search_imessages",
    sideEffects: false,
    description: "Search the user's iMessage / text history by content, person, and recency. Use to answer questions about past texts (e.g. 'what did Sarah say about dinner?', 'find the address someone sent me last week'). Returns matching messages newest-first.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for in messages (substring match)." },
        person: { type: "string", description: "Filter to a contact — a phone number or email handle (partial match)." },
        days: { type: "integer", description: "Only messages from the last N days." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 20)." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      try {
        const res = await fetchImpl(`${nodeUrl}/search`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(nodeToken ? { authorization: `Bearer ${nodeToken}` } : {}) },
          body: JSON.stringify({ query: args.query ?? "", handle: args.person ?? null, days: args.days ?? null, limit: args.limit ?? 20 })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { error: body.error ?? `iMessage node returned ${res.status}` };
        const results = (body.results ?? []).map((m) => ({
          from: m.fromMe ? "me" : m.handle,
          at: m.date,
          text: m.text
        }));
        return { count: results.length, results };
      } catch (error) {
        return { error: `couldn't reach the iMessage node at ${nodeUrl}: ${error.message}` };
      }
    }
  });
  return { registered: true, nodeUrl };
}
