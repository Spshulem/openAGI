---
name: remarkable-morning-brief
description: Build an immutable, Move-sized daily dashboard from connected Calendar, BuildBetter, GitHub, and PostHog tools, then upload it through the reMarkable MCP.
---

Create today's reMarkable morning brief using only OpenAGI's existing tools and connected MCP servers. Do not call source APIs directly, install software, register integrations, change calendars, send messages, or mutate source systems. Treat every source as read-only. User context: {{input}}

## 1. Preflight

Call `list_mcp_tools` once and map the available tools by capability, not by an assumed fixed tool name:

- Calendar: prefer `calendar_events_between` or `calendar_today_events`; otherwise use a connected calendar MCP's event-listing tool.
- BuildBetter: call search/list/read tools for calls, transcripts, summaries, signals, projects, and tasks.
- GitHub: list open pull requests authored by or assigned to the user.
- PostHog: query a small product pulse only when a connected PostHog MCP is present.
- PDF: use the connected Playwright MCP's `browser_navigate`, `browser_evaluate`, and `browser_pdf_save` tools.
- Delivery: use reMarkable `remarkable_browse`, `remarkable_mkdir`, and `remarkable_upload` tools.

If a tool is not directly advertised, invoke it through `run_mcp_tool`. Never ask for or place a secret in this skill's input. Do not attempt to connect missing integrations during a scheduled run. Mark each missing source as unavailable and continue. PDF rendering and reMarkable delivery are required for a successful delivery; if either is missing, return a precise setup checklist from `list_mcp_catalog` and still provide the best text brief you can.

## 2. Gather a normalized snapshot

Use the user's local timezone and local calendar day. Keep source records separate until they have been normalized.

Build this logical snapshot:

- `date`, `timezone`, and generation time
- calendar events, with all-day items and internal meetings distinguished from external calls
- upcoming external calls, each with attendees, organization, goal, most recent prior-call context, current signals, decisions, commitments, risks, and three useful prep prompts
- active BuildBetter projects and grounded main tasks; never invent a task from a vague signal
- open GitHub pull requests authored by or assigned to the user, including review/CI state when available
- a compact PostHog pulse (two to four decision-useful metrics or anomalies), or an explicit unavailable reason
- `sources_used` and `degraded_sections`, including the tool or query that supplied every factual section

For each external calendar event, exhaust BuildBetter matching before writing that no prior summary exists:

1. Search by exact attendee email or company domain when available.
2. Search by attendee name, organization name, meeting title, and obvious title aliases.
3. List recent calls for the matched organization/contact and inspect candidates whose timestamp is before today's meeting.
4. Read the newest credible prior call's summary/signals. If a summary is absent, use grounded transcript excerpts or structured call signals.
5. Only say "No prior call context found" after all applicable keys were tried. Record the attempted keys in `degraded_sections`; do not present an exact-title miss as proof that no call exists.

Cap expensive searches and prefer the most recent credible record. Never turn weak name similarity into a confident match.

## 3. Compose the Move document

Create one self-contained HTML document. Its print CSS must include:

```css
@page { size: 260.18pt 462.55pt; margin: 0; }
.page { width: 260.18pt; height: 462.55pt; box-sizing: border-box; page-break-after: always; overflow: hidden; }
.page:last-child { page-break-after: auto; }
```

Use a quiet monochrome design with high contrast, compact serif headings, sans-serif details, thin rules, and generous blank writing areas. Do not rely on remote fonts, images, scripts, or network assets.

Page 1 is the dashboard:

- date, one-sentence day framing, and source/degraded indicators
- chronological schedule
- top three priorities
- BuildBetter project/task rollup
- compact GitHub and PostHog pulse
- ruled space for notes

Add one linked prep page per external call. Each page includes the time, attendees, meeting goal, prior context, latest signals/decisions/commitments, risks, three prep prompts, and at least one-third of the page as ruled writing space. Escape all source text before inserting it into HTML. Keep each `.page` within the fixed height; shorten prose instead of allowing overflow.

## 4. Render and deliver immutably

Use the Playwright server through `run_mcp_tool`:

1. Navigate to `about:blank`.
2. Set the page content with `browser_evaluate` using a function that calls `document.open()`, `document.write(...)`, and `document.close()`. JSON-encode the HTML inside the function so source text cannot become executable JavaScript.
3. Save with `browser_pdf_save`. The normal filename is `YYYY-MM-DD — Morning Brief.pdf`; an explicit forced rerun uses `YYYY-MM-DD — Morning Brief — rev-HHMM.pdf`.

Before upload, browse the configured reMarkable destination folder (default `BuildBetter Daily`). Create it only if it is absent and `remarkable_mkdir` is available. If the normal daily document already exists, do not overwrite or upload a duplicate. Only an input that explicitly says `force`, `forced rerun`, or `new revision` permits the revision filename. Upload the generated local PDF with `remarkable_upload`.

Close the Playwright page after rendering when the tool is available. Do not delete or replace anything on reMarkable.

## 5. Return a run receipt

Report:

- local PDF path and page count
- sources used
- degraded/unavailable sections
- reMarkable destination and upload result
- whether the run created a normal daily document, a forced revision, or skipped an existing document

Never report success for a tool call that failed.
