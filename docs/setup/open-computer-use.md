# Open Computer Use engine (experimental)

OpenAGI can use iFurySt's MIT-licensed `open-computer-use` **0.3.3** on each
macOS 14+ computer node. This is a pinned upstream dependency, not a fork or a
claim to OpenAI's native Codex computer-use capability. It does not grant the
coding supervisor unrestricted desktop access.

## Install on each controlled Mac

From an OpenAGI source checkout, using Node 22+:

```sh
node scripts/install-open-computer-use.mjs --install
```

The installer verifies the pinned archive's SHA-512 digest and the bundled Mac
app's code signature. It retains upstream LICENSE and other bundled notices,
runs no npm lifecycle scripts, and changes no Codex/Claude configuration. It
does not enable the backend. A failed installation is retained for inspection;
the installer refuses to overwrite an existing version directory.

Run the returned native `binary` path with `doctor` interactively and grant
Screen Recording and Accessibility to Open Computer Use. Keep OpenAGI's own
signed helper and permissions: it enforces the existing privacy checks.
Then set these in the **controlled node's** canonical OpenAGI environment:

```dotenv
OPENAGI_COMPUTER_BACKEND=open-computer-use
OPENAGI_OCU_PATH=/absolute/path/returned/by/installer/OpenComputerUse
```

Keep `OPENAGI_COMPUTER_HELPER` pointing to the signed OpenAGI helper. Enable
Computer Use in OpenAGI and restart that node with no active control session.
The main routes requests over the existing authenticated node transport;
there is no public MCP listener and no owner token sent to upstream.

## Migration boundaries

- Upstream supplies screenshots, Accessibility trees, coordinate/element
  clicks, dragging, typing, keys, setting values, and element scrolling.
- Native list/activate-app, pointer movement, and coordinate scrolling remain
  available because these do not map directly to upstream 0.3.3's tools.
- Rich paste, text selection, and secondary actions are not advertised by this
  initial adapter. Select `OPENAGI_COMPUTER_BACKEND=native` to restore the full
  native operation set. Unsupported actions never silently switch backends.
- OpenAGI still owns node selection, approvals, expiring leases, action IDs,
  screenshot freshness, cancellation, and logs. Changing windows invalidates
  the engine state. Global pointer fallback is disabled for upstream clicks.
- Readiness checks verify both OpenAGI's gate and upstream's non-prompting
  permission probe. An upstream denial fails the action without automatic
  retry. macOS permissions require human approval and a physical smoke test.
- This is not a default replacement yet. Live cancellation, excluded-window
  behavior, Retina coordinates, window switching, and multi-node selection
  must pass on a Mac before promoting it. App-targeted upstream actions are
  not an atomic extension of OpenAGI's native window-identity check; keep this
  experimental backend out of unattended sensitive workflows.

## Upstream updates

Upstream: https://github.com/iFurySt/open-codex-computer-use/tree/v0.3.3

Review a release, update `src/integrations/ocu-release.js` (version, exact
archive URL and digest) together, run the Open Computer Use compatibility
workflow and physical Mac acceptance, then ship one OpenAGI update. Never
follow `latest` automatically. MIT permits redistribution with copyright and
license notices retained; review upstream third-party notices on every update.

The stdio transport explicitly sets `OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY=1`.
Do not remove this: v0.3.3 otherwise delegates to a shared LaunchServices app
agent which outlives the stdio child. Each OpenAGI engine connection must own its
dispatcher and snapshot cache. Global pointer fallbacks remain disabled.

## G2 rollout contract

G2 is the voice/display node, not a desktop executor. Pair it with the main as
usual. Install/configure the engine on each controlled Mac; do not install an
unrestricted MCP server on the glasses or share the main's bearer token with
upstream. A G2 question uses the main's existing computer tools and requests
approval for a specific goal and Mac in OpenAGI's Approvals screen. Spoken
instructions are not a substitute for that approval.

Cancelling an in-flight G2 tool request now revokes its approved desktop
session and dispatches `session.end` to the original target, including when
cancellation races lease creation. It cannot undo already-delivered input.
Do not equate closing the display with a confirmed Stop: the physical G2
gesture, transport cancellation, and the target Mac must be tested together.

These server-side changes alone do not require a new G2 bundle or re-pairing.
They require updating the main and computer node runtimes. Production default
promotion is still blocked by upstream's app-scoped dispatch: v0.3.3 accepts no
expected window ID, privacy policy, or per-event secure-field guard. OpenAGI's
precheck is not atomic with upstream input. Do not retire the native dispatcher
until this contract is enforced at input dispatch, not merely in a UI test.
