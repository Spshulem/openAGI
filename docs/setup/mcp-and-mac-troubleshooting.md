# MCP and Mac setup troubleshooting

## Connect an Obsidian MCP server

OpenAGI accepts custom MCP servers; an Obsidian entry in the built-in catalog
is not required. Use the configuration supplied by the particular server you
chose. Different Obsidian servers use different packages, transports and auth.

For a local server, use its **stdio** configuration (command, argument array,
and environment variables). The executable must be available to the Mac app,
which does not run your interactive shell startup files. An absolute path to
`node`, `npx`, `python3` or `uvx` can avoid a PATH difference. Keep arguments
as separate array entries, including a vault path that contains spaces. Do not
paste a shell command into the command field.

Register the server in the dashboard's MCP controls and approve the registration.
If its setup needs custom `env` or `cwd`, those fields currently belong in
`mcp.json` in the active OpenAGI data directory; the registration UI reports
fields it does not carry. Preserve existing servers when editing that file.
Store secrets in that directory's `.env` and use `${YOUR_VARIABLE}` references
in the MCP configuration. Restart the daemon after a manual configuration edit,
then connect and confirm that the server's expected tools appear.

For HTTP, supply the server's **Streamable HTTP MCP endpoint**, not an Obsidian
REST API URL or a legacy SSE-only endpoint. HTTP MCP registration deliberately
rejects loopback/private-network URLs. A local Obsidian plugin normally needs a
stdio MCP bridge; do not expose its private API publicly or disable URL guards
to make it connect. Use only a bridge documented by the server's publisher.

First test a harmless read of a new, non-private test note. This checks the
actual server, vault and permissions without granting write access by default.
Automated protocol fixtures do not prove compatibility with every Obsidian
server or plugin version.

## Report one reproducible failed attempt

Include the OpenAGI app version, macOS version, MCP server package/version,
stdio versus HTTP, and the redacted error from that same attempt. Say whether
initialization, tool discovery or the first tool call failed. Omit API keys,
authorization URLs, tokens, vault paths and private note contents.

`POST /message` returns `X-Request-ID`; JSON errors and streaming failure events
carry the matching `requestId`. Match it to `agent-turn-failed` or
`agent-turn-completed` in the active data directory's `daemon.log` (terminal
installs write to stderr). Successful-turn logs contain timing/model metadata,
not prompts, replies or tool arguments/results.

Set `OPENAGI_LOG_LEVEL=debug` in `.env` and restart for HTTP request and SSE
open/close events. The default is `info`; `warn` and `error` reduce routine
records. Access logs omit query strings, headers, bodies, client addresses and
dynamic route identifiers. Existing legacy logs and MCP server stderr have
their own formats and may contain private information: review any excerpt
before sharing.

The Mac-managed daemon checks `daemon.log` every 30 seconds and at startup.
At 5 MiB it retains a tail of up to 5 MiB in `daemon.log.1`, shifts older tails
through `.2` and `.3`, and truncates the active file without replacing the
inherited append descriptor. Archives are private (0600). A busy interval can
temporarily exceed the threshold; rotation is best-effort diagnostic retention,
not a complete audit journal. Terminal/service installs keep their existing
stderr/log-manager policy. Individual MCP stderr logs are separate.

Boot and Mac child spawn/exit/stop/respawn records include timestamps and PIDs.
An `env-override-ignored` warning names a `.env` key whose value was shadowed by
the parent or an earlier env file; it never includes either value. The Mac app
deliberately keeps its managed daemon on loopback. Use supported node pairing
for remote access rather than changing this security default.

## Reproduce Mac privacy-control reachability and helper permissions

Use a current **signed installed app** and record its version and macOS version.
For menu-bar reachability, test the built-in notched display, a small/scaled
display and a crowded menu bar. Record which entry points can reach Capture,
pause and privacy wipe without editing configuration. Do not enable capture
merely to collect a bug report.

If the menu-bar icon is hidden, reopen the running OpenAGI app from Finder or
Spotlight, or run `open 'openagi://privacy'`. Both reveal the native Capture
Privacy panel, including pause and delete controls. They do not change capture
or grant permission. For a fresh launch, `open -a OpenAGI --args --show-permissions`
also reveals that panel. The URL entry point requires a build containing the
registered scheme; older installed versions may not recognize it.

For helper attribution, record the exact app/helper labels shown in System
Settings → Privacy & Security → Accessibility and Screen Recording, then the
readiness probe's `inputReady`, `screenshotReady` and reason. Grant only the
permissions you intend to allow. Test both an allowed window and an intentionally
excluded window. A privacy exclusion must stay excluded. Do not reset all macOS
permissions or use a blanket auto-approver as a troubleshooting step.

A separately launched computer helper can have a different macOS permission
identity from the signed app. Its status now calls out that launch context;
launch through the signed app, or check the specific launcher/helper shown by
macOS, then restart that process after changing a grant. This guidance does not
claim to change macOS attribution or to bypass a privacy exclusion.

Source tests cannot establish permission attribution or notch behavior in an
installed signed build. Keep those reports open until that reproduction exists.
