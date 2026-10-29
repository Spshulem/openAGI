// Shared discovery keeps HTTP and stdio inventories consistent. Build the
// replacement locally so a failed page never publishes a partial tool list.
export async function collectMcpTools(request) {
  const tools = [];
  const cursors = new Set();
  let params = {};
  for (let page = 0; page < 100; page++) {
    const result = await request("tools/list", params);
    if (!Array.isArray(result?.tools)) {
      throw new Error("Invalid MCP tools/list response: tools must be an array");
    }
    tools.push(...result.tools);
    const cursor = result.nextCursor;
    if (cursor == null) return tools;
    if (typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor)) {
      throw new Error("Invalid MCP tools/list pagination cursor");
    }
    cursors.add(cursor);
    params = { cursor };
  }
  throw new Error("MCP tools/list pagination exceeded 100 pages");
}
