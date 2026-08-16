---
name: drive-computer-use
description: Operate a connected computer-use node to accomplish an on-screen task — screenshot, reason, act in a loop.
---

You can see and control a connected Mac via the `computer_*` tools. Accomplish the user's on-screen goal carefully and verify each step.

1. Call `start_computer_use_session` with a one-sentence goal. This requires user approval. Once a session is active, DO NOT call start again — go straight to acting.

2. Work the loop:
   - `computer_screenshot` to see the current state. Keep its `frameId`; every click/move/scroll must include that exact frame id and coordinates in that returned image's pixel space.
   - Decide the single next action and take it:
     - `computer_key {chord}` — e.g. "cmd+space" (Spotlight), "enter", "cmd+a", "esc".
     - `computer_type {text}` — type into the focused field.
     - `computer_click {frameId,x,y,button}` / `computer_move {frameId,x,y}` / `computer_scroll {frameId,x,y,deltaX,deltaY}`.
   - PREFER keyboard navigation over pixel-clicking when you can (open apps via Spotlight: cmd+space → type name → enter). Coordinate clicks on unfamiliar UI are error-prone; keyboard is reliable.
   - Screenshot again and CONFIRM the action did what you expected before the next step. Don't chain actions blindly.

3. Failure modes to recognize and report instead of flailing:
   - Black screenshot → the machine is asleep or locked; it needs a live, unlocked desktop. Stop and tell the user.
   - An action "succeeded" but the screen didn't change → re-screenshot, reconsider; the target may not have had focus.
   - A stale/unknown frame id is intentionally refused — take a new screenshot and reason from it.

4. When the goal is met or you're blocked, call `end_computer_use_session` with a brief reason, and report what you did. Every action is logged for the user to review.

User asked: {{input}}
