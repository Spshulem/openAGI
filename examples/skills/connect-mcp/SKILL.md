---
name: connect-mcp
description: Connect an MCP server (catalog or custom URL/stdio) and make its tools usable — including completing OAuth on a headless host.
---

Connect an MCP server so its tools become available to the agent.

1. Pick the registration path:
   - Known integration → `list_mcp_catalog`, then `connect_catalog_mcp` with the catalog id.
   - Custom server → `register_mcp_server` with one of: stdio (a `command` + `args`), http+bearer (a `url` + `apiKey`, using `${ENV_VAR}` for the secret), or http+oauth (a `url`). Then `connect_mcp_server`.

2. OAuth servers: connecting surfaces an authorization URL. The OAuth callback is a loopback (`http://127.0.0.1:<port>/callback`) on the AGENT HOST. If the host is headless (no browser), a laptop browser can't reach that loopback — tell the user to tunnel it first, then approve:
   - on the laptop: `ssh -L <port>:127.0.0.1:<port> <host>`  (the host pins the port via `OPENAGI_OAUTH_CALLBACK_PORT`)
   - open the auth URL in the laptop browser, sign in, approve → the redirect tunnels back and the server flips to connected.

3. Verify with `list_mcp_tools`. Large servers (lots of tools) may NOT be advertised as direct functions — a cap keeps the model's tool list within provider limits. Reach any capped tool with `run_mcp_tool(server, tool, args)`; `list_mcp_tools` shows them all.

4. Secrets hygiene: never commit real keys. Reference them as `${ENV_VAR}` that resolves from the host's `.env`.

User asked: {{input}}
