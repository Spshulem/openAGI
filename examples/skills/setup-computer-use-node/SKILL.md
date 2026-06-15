---
name: setup-computer-use-node
description: Guide setting up a Mac as a computer-use node so the agent can see the screen and control mouse/keyboard.
---

Walk the user through turning a Mac into a computer-use node. macOS-only; needs a display and user-granted permissions you can't grant for them. Produce copy-pasteable steps; substitute `<host>`, `<port>`, `<secret>`.

1. Install `cliclick` (`brew install cliclick`) — used for input synthesis (click/type/key/move).
2. Ensure a DISPLAY exists. A headless Mac has no framebuffer and capture fails with "could not create image from display." Options: attach an HDMI dummy plug, OR create a virtual display (e.g. BetterDisplay) — which needs a one-time GUI session (Screen Sharing).
3. Grant permissions to the runtime's `node` binary in System Settings → Privacy & Security:
   - **Screen Recording** (for screenshots)
   - **Accessibility** (for mouse/keyboard via cliclick)
   These require a GUI session to approve; on a headless box, do it once over Screen Sharing.
4. Run `openagi computer-server --token <secret> --port <port>`. Persist via launchd, and put `/opt/homebrew/bin` on the job's PATH so cliclick is found.
5. On the MAIN: set `OPENAGI_COMPUTER_USE=1`, `OPENAGI_COMPUTER_NODE=http://<host>:<port>`, `OPENAGI_COMPUTER_NODE_TOKEN=<secret>`, then restart. The `computer_*` tools now execute on the node.

Notes to pass along:
- Screenshots are auto-downscaled to ~`OPENAGI_COMPUTER_SCALE_WIDTH` (default 1280) and click coordinates are mapped to the display's LOGICAL points (Retina-correct) — the model works in the returned image's space.
- `scroll` is not supported (cliclick has no scroll primitive); it returns an honest error.
- Verify via the node's `/screenshot` HTTP endpoint (it runs in the GUI session) — NOT a plain SSH shell, which has no WindowServer access and will report "could not create image from display" even when a display exists.
- The screen must be UNLOCKED and awake — a locked/asleep display captures black. Disable auto-lock / display sleep on a dedicated node.

User asked: {{input}}
