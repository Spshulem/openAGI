# OpenAGI: 3-Minute Workflow Demo

## Demo Thesis

**OpenAGI turns ambient activity into a routed task system.**

Most agents wait for a prompt. OpenAGI watches local activity, decides what
matters, and routes work into either:

- **My tasks**: work the user should do.
- **Agent tasks**: work OpenAGI has committed to prepare or complete.

The strongest short demo is the workflow loop, not a long autonomous run:

```text
Local activity -> proactive observation -> task routing -> agent queue -> review
```

## What Works

- Local screen and activity capture.
- A proactive observer that reviews recent activity every 10 minutes.
- Suggestions grounded in observed apps and on-screen text.
- Separate user and agent task queues.
- A task lifecycle scan every 15 minutes.
- An agent pulse every 30 minutes that drains the agent queue.
- Due-date reminders, daily plans, and daily recaps.
- Draft-first handling for observer-created agent work.

In the inspected local app data, OpenAGI had already generated 78 proactive
suggestions, including 58 task proposals. The previous empty task list was
caused by task proposals remaining in Suggestions instead of being written to
the task store. That path has been fixed for new observer output.

> When demonstrating the fix, restart the source server. If using the packaged
> Mac app, rebuild and restart it so the bundled runtime includes the change.

## Timed Demo

### 0:00-0:20 - Frame the Difference

Say:

> Most agents wait for a prompt. OpenAGI watches local activity, decides what
> matters, and routes work into human tasks or agent tasks.

### 0:20-0:55 - Show Proactive Suggestions

Open the **Suggestions** view.

Say:

> This is what OpenAGI noticed from screen and app activity. These did not
> originate as chat prompts; they came from the proactive observer.

Point out:

- The concrete title and rationale.
- Whether the proposal is for the `user` or `agent` queue.
- The task bucket, such as `today` or `this_week`.
- References to real work such as PRs, tickets, meetings, or branches.

### 0:55-1:35 - Show Task Routing

Open the **Tasks** view.

Say:

> The important difference is routing. Some work is mine. Some work the agent
> has committed to. It is not a chat transcript pretending to be a task list.

Show:

- **My tasks** for human-owned work.
- **Agent tasks** for work OpenAGI is preparing.
- Buckets, priorities, status, and source attribution.

If a reliable task needs to be seeded immediately:

```bash
curl -s -X POST http://127.0.0.1:43210/tasks \
  -H 'content-type: application/json' \
  -d '{
    "title": "Draft follow-up notes from the BuildBetter demo call",
    "queue": "agent",
    "bucket": "today",
    "description": "Produce a draft only. Do not send."
  }'
```

Refresh the Tasks view after running the command.

### 1:35-2:15 - Show the Always-On Loop

Open the **Cron** view.

Say:

> The system keeps running after this conversation ends. The observer notices
> work, the lifecycle scan reconciles progress, reminders track deadlines, and
> the agent pulse drains work from its own queue.

Point out:

- Proactive observer: every 10 minutes.
- Task lifecycle scan: every 15 minutes.
- Task reminders: every 15 minutes.
- Agent queue pulse: every 30 minutes.
- Daily planning and retrospective jobs.

### 2:15-2:50 - Show Safety and Review

Show a suggestion, approval, or draft-review surface that already has data.

Say:

> OpenAGI separates noticing, queuing, drafting, and approval. Observer-created
> agent work is draft-first, so noticing something does not automatically send,
> publish, or take an irreversible action.

### 2:50-3:00 - Close with the Positioning

Say:

> Hermes is strong as a self-improving execution runtime. OpenClaw is strong as
> a gateway and task-automation platform. OpenAGI's wedge is ambient local
> observation: it notices what you are doing, turns that into routed tasks, and
> uses memory and scrutiny to decide what should become agent work.

## Competitive Framing

Do not position OpenAGI as having more integrations, channels, or tools. The
credible distinction is the shape of the workflow.

| Product | Strongest framing | OpenAGI distinction |
| --- | --- | --- |
| Hermes | Skills, tools, MCP, execution backends, self-improving agent runtime | Ambient local observation feeding a persistent human/agent task system |
| OpenClaw | Messaging gateway, scheduled/background work, channels, task automation | Screen-to-task routing and observation-driven task lifecycle as a first-class workflow |
| OpenAGI | Proactive observer, scrutiny, tiered memory, bounded specialists | Notices work before a prompt and decides who should own it |

## Claims to Avoid

- Do not claim Hermes or OpenClaw cannot run background tasks.
- Do not claim they lack memory, skills, MCP support, or automation.
- Do not claim OpenAGI wins on integration count or tool breadth.
- Do not rely on a live model producing the perfect suggestion during the demo.
- Do not demo irreversible autonomous actions.
- Do not spend the three minutes explaining the full architecture.

## Presenter Checklist

- Restart the runtime containing the latest source.
- Confirm the Tasks, Suggestions, and Cron views load.
- Keep one concrete task proposal available.
- Seed one agent task before the presentation if necessary.
- Verify the agent task says draft-only.
- Keep the comparison focused on ambient observation and task routing.
- End on the workflow difference, not a feature-count comparison.
