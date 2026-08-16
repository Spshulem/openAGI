---
name: setup-computer-use-node
description: Guide setting up a Mac as a computer-use node so the agent can see the screen and control mouse/keyboard.
---

Walk the user through turning a Mac into a computer-use node. macOS-only; needs a display and user-granted permissions you can't grant for them. Prefer the paired-node outbound relay; it needs no inbound port or extra service credential.

1. Install the distributed OpenAGI app on the Mac, pair its daemon to the main, and enable Computer Use. The node connects OUT to the main over the existing authenticated pairing; do not expose a computer-control port.
2. Ensure a display exists. A headless Mac has no framebuffer. Attach a display/HDMI dummy plug, or create a virtual display with a user-approved tool.
3. Grant OpenAGI in System Settings → Privacy & Security:
   - **Screen Recording** (for screenshots)
   - **Accessibility** (for CGEvent mouse/keyboard/scroll input)
   These require a GUI session to approve; on a headless box, do it once over Screen Sharing.
4. Verify the node is online and its Computer use service says ready in Nodes. `computer_use_status` should list it as an available node.
5. Start a chat request naming that node; approve the scoped session, then let the agent inspect and act.

Notes to pass along:
- Screenshots are auto-downscaled to ~`OPENAGI_COMPUTER_SCALE_WIDTH` (default 1280) and click coordinates are mapped to the display's LOGICAL points (Retina-correct) — the model works in the returned image's space.
- The app bundle includes the signed helper and supports click, move, type, key, and scroll. There is no shell-command input fallback.
- Verify through the authenticated node readiness shown by OpenAGI, not a public screenshot HTTP endpoint.
- The screen must be UNLOCKED and awake — a locked/asleep display captures black. Disable auto-lock / display sleep on a dedicated node.

User asked: {{input}}
