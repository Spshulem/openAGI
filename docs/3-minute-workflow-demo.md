# OpenAGI: 3-Minute Demo

Updated from `origin/main` at `bb0aebb` and a live local daemon inspection on
2026-08-13.

## The One-Line Position

**Text it, let it watch, and OpenAGI turns your real work into owned tasks and
reusable skills that improve with you.**

Hermes and OpenClaw can also execute tools, run background jobs, use memory, and
connect channels. Do not compete on feature count. Show OpenAGI's closed loop:

```text
iMessage or Quick Ask
  -> human task / agent task
  -> ambient on-device observation
  -> repeated workflow detected with evidence
  -> user approves a durable SKILL.md
  -> OpenAGI runs the improved workflow next time
  -> one Review queue keeps the user in control
```

## What Is Demo-Ready

- **iMessage conversational bridge:** an incoming message can reach the main
  agent and the plain-text answer is sent back through Messages.app.
- **iMessage inbox:** a private self-chat can be read locally and converted into
  tasks. It is opt-in, read-only, forward-only by default, and requires Full
  Disk Access.
- **Task ownership:** Tasks visibly separates **My tasks** from **Agent tasks**.
  Observer-created agent work is draft-first when an external action is implied.
- **Ambient observation:** about every 30 seconds the Mac batches window titles
  and on-device OCR. Images stay local; the observer reasons from text evidence.
- **Multi-horizon learning:** hourly and nightly miners look for repeated action
  sequences across sessions, days, and weeks instead of treating one click as a
  habit.
- **Evidence-backed skill suggestions:** the Skills view shows observed count,
  confidence, time, horizons, action sequence, and the proposed skill body.
- **One-click materialization:** accepting a learned skill writes a real
  `SKILL.md` with its observation provenance and reloads it immediately.
- **Unified Review:** tasks, drafts, clarifications, and suggestions are
  searchable in one queue.
- **Latest `main`: conversational skill authoring:** the approval-gated
  `create_skill` tool can save a workflow requested in normal chat, reload it,
  and later schedule it. This is only demoable after the latest `main` changes
  are integrated and the daemon is rebuilt/restarted.

The inspected daemon already has populated Tasks, Skills, Suggestions, Today,
and Review surfaces. Do not quote volatile totals in the presentation; show one
good item from each surface.

## Required Preflight

Do this before the audience is present.

1. **Integrate and restart the intended build.** The latest remote changes have
   been fetched, but the current feature branch has uncommitted edits in files
   that also changed on `main`. Resolve those edits before updating; do not run
   a blind update on the dirty checkout.
2. Run `openagi doctor` and confirm the daemon and Mac node are healthy.
3. In **Integrations**, confirm iMessage is enabled with the self-chat handle.
   The currently inspected daemon reports iMessage ingestion as disabled.
4. Verify macOS grants the OpenAGI process **Full Disk Access** and
   **Automation -> Messages**.
5. Verify local iMessage access without changing anything:

   ```bash
   openagi imessage-search "demo preflight" --days 1 --limit 1
   ```

6. Start the conversational bridge in a separate terminal. Use the trigger mode
   so unrelated texts never invoke the agent:

   ```bash
   SELF_HANDLE="your iCloud email or phone"
   openagi imessage-bridge \
     --allow "$SELF_HANDLE" \
     --respond trigger \
     --trigger OpenAGI \
     --capture allow
   ```

7. In **Skills**, preselect one safe suggested workflow with a clear action
   sequence and more than one observation. Do not depend on a miner producing a
   new candidate during the demo.
8. In **Tasks**, keep the existing Vimeo migration task as the fallback item.
   In **Review**, pre-apply the search term `Vimeo`.
9. Open these surfaces in order: Messages, Tasks, Skills, Review.

## The Three-Minute Script

### 0:00-0:15 - Hook

Show Messages on the phone or Mac.

Say:

> Most agents wait inside a chat box. OpenAGI can meet me in iMessage, watch the
> work happening on my Mac, and learn the workflows I repeat.

### 0:15-0:45 - iMessage to Owned Work

Send this to the configured self-chat:

> OpenAGI, add "Cancel Vimeo and move the recordings" to my tasks today. Prepare
> the migration checklist as an agent task. Draft only; do not contact anyone.

Show the plain-text iMessage response. Move on after 12 seconds even if the
response is still in flight; the pre-existing Vimeo task is the fallback.

Say:

> One message creates two different commitments: what I need to do and what the
> agent has agreed to prepare. That ownership survives this conversation.

### 0:45-1:15 - My Tasks Versus Agent Tasks

Open **Tasks** and filter to **today**.

Show:

- The Vimeo item under **My tasks**.
- The checklist or draft under **Agent tasks**.
- Its source, bucket, status, and draft-only constraint.

Say:

> This is not a transcript pretending to be a task list. Human work and agent
> work have separate owners, statuses, deadlines, and review rules.

Do not wait for the agent queue to finish live. The ownership transition is the
point; long execution is not.

### 1:15-2:05 - Watching Becomes a Skill

Open **Skills** and select the prepared suggested workflow.

Point to:

- `observed N x`, confidence, time, and day/week horizon badges;
- the detected app/action sequence;
- the complete proposed skill body;
- **Accept - write SKILL.md**.

Say:

> OpenAGI does not call one observation a habit. It mines repeated sequences
> across sessions, days, and weeks, then shows the evidence and the exact skill
> it wants to create.

Click **Accept - write SKILL.md** only if the selected workflow is safe.

Say:

> Approval writes a real, inspectable skill with its provenance and reloads it
> immediately. The next time this pattern appears, OpenAGI has a reusable way to
> help instead of starting from zero.

### 2:05-2:35 - Review and Safety

Open **Review** with the prepared `Vimeo` search.

Show that tasks, drafts, and suggestions can be searched and handled from one
place. Approve nothing irreversible.

Say:

> Watching does not mean acting without control. OpenAGI separates noticing,
> queuing, drafting, and approval. Anything consequential stays reviewable.

### 2:35-3:00 - Close the Loop

Return briefly to the accepted skill or the two task owners.

Say:

> Hermes and OpenClaw are capable agent runtimes and gateways. OpenAGI's
> difference is where the work comes from and what happens afterward: it learns
> from my actual activity, decides whether I or the agent owns the next step,
> and turns repeated behavior into an approved skill. Text it, let it watch, and
> it gets better at the work I actually do.

Stop there. Do not open Cron or explain the architecture.

## Optional Latest-Main Ending

Use this instead of the Review segment only after `create_skill` is verified in
the running daemon.

Ask in chat:

> Create a reusable skill named `vimeo-migration-review`. It should inspect open
> Vimeo migration tasks, draft a concise checklist, flag missing context, and
> never send or delete anything. Show me the full skill before saving it.

Then show the approval card and say:

> OpenAGI can learn from observation, or I can teach it directly in normal
> language. Either path produces the same durable, reviewable skill artifact.

Approve only if the displayed instructions match the request. Do not run the
new skill during the three-minute version.

## Why This Is Different

| Capability | Hermes / OpenClaw overlap | OpenAGI demo distinction |
| --- | --- | --- |
| Messaging | Channels can invoke an agent | iMessage is both a conversational gateway and a private local inbox |
| Background work | Jobs and automation are expected | Work is explicitly routed to human or agent ownership |
| Memory | Persistent context is expected | Ambient local activity feeds tasks, suggestions, and workflow evidence |
| Skills | Reusable tools and skills are expected | Repeated real behavior proposes a skill with count, confidence, horizons, and provenance |
| Safety | Approvals and permissions may exist | Noticing, tasking, drafting, skill creation, and consequential action are separate gates |
| Daily workflow | Agents can summarize and execute | Tasks, drafts, clarifications, and suggestions converge in one Review queue |

The defensible claim is not "OpenAGI has features they lack." It is:

> OpenAGI closes the loop from ambient work signal to ownership to learned,
> user-approved capability.

## Failure Plan

- **No iMessage reply:** move to Tasks after 12 seconds and use the pre-existing
  Vimeo item. Say the bridge is asynchronous; do not troubleshoot on stage.
- **New task is delayed:** show the existing task and agent draft. Do not refresh
  repeatedly.
- **Suggested skill is weak:** use the preselected candidate; never force a new
  observer/miner run live.
- **Skill acceptance fails:** show the full evidence and proposed body, then say
  materialization is approval-gated. Do not open a terminal to debug.
- **Latest `create_skill` is absent:** skip the optional ending. The learned-skill
  acceptance path is the primary self-improvement proof.
- **Review is noisy:** keep the prepared `Vimeo` search active.

## Claims to Avoid

- Do not say Hermes or OpenClaw lack memory, skills, MCP, channels, scheduling,
  background work, or approvals.
- Do not claim every observation becomes a task or skill.
- Do not say screenshots are uploaded. OpenAGI's documented path keeps images
  local and sends on-device OCR text for reasoning.
- Do not claim fully autonomous external action. Emphasize draft-first work and
  explicit approval.
- Do not promise that skill learning is instant; candidates come from repeated
  patterns across multiple time horizons.
- Do not show giant queue totals. Show one coherent workflow.

## Presenter Checklist

- [ ] Latest intended code is integrated, rebuilt, and restarted.
- [ ] `openagi doctor` passes.
- [ ] iMessage ingestion is enabled and the bridge is running.
- [ ] Full Disk Access and Messages automation permissions work.
- [ ] The self-chat trigger replies once without looping.
- [ ] One human task and one draft-only agent task are visible.
- [ ] One safe learned-skill candidate is preselected.
- [ ] The candidate shows repeated observations and provenance.
- [ ] `Vimeo` is prepared in Review search.
- [ ] The optional `create_skill` ending is used only if verified live.
- [ ] A timer is visible to the presenter, not the audience.
