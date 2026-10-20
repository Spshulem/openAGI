# Website feature refresh

Copy and placement for the public OpenAGI site, audited against main and the
v0.0.58 release on 2026-10-18. This is an editorial handoff, not a deployed
website or a release announcement. The canonical site lives in
[`buildbetter-app/bb-website/openagi`](https://github.com/buildbetter-app/bb-website/tree/main/openagi),
and Vercel's `buildbetter/openagi` project deploys it from `main` to
`openagi.sh` and `www.openagi.sh`. It is separate from this application repo.
The separate local `companion-site` is a hardware catalogue.

## Hero supporting copy

Keep the proactive personal-agent positioning and add the concrete product:

> A personal agent that keeps context and keeps work moving. Chat across
> sessions, learn useful routines from activity you choose to share, and
> supervise your coding agents from one place. Connect your own models,
> tools and devices, with controls for what the agent can do.

Keep **Download for Mac** linked to
<https://github.com/Spshulem/openAGI/releases/latest>. Add **Explore Supervisor**
linked to
<https://github.com/Spshulem/openAGI/blob/main/docs/setup/fleet-supervisor.md>.
Add a Supervisor navigation link to the section below.

## Supervisor section

Place this beside memory, routine learning and device access as a primary
feature, rather than burying it in an integrations list.

### One view of your coding agents

> See which Codex, Claude Code, Conductor and Antigravity sessions are working,
> waiting on checks, blocked, or waiting for you. Open the thread and PR behind
> each question. Supervisor uses verification evidence to help you decide what
> needs attention.

- **Stay in control.** Observe plans, approve proposed nudges, or explicitly
  enable bounded automatic nudging.
- **Answer the real question.** Review the agent's decision with its context,
  and answer through a supported route or open its app.
- **Talk through the queue.** Optional voice on Mac, Android and Even G2 lets
  you ask about the fleet. Actions require a readback and spoken approval code.
- **Improve the system.** Health metrics surface failures and repeated nudges.
  A configured repair worker can open and review a bounded PR for you to merge.

Use an actual Supervisor screenshot showing Needs you, Watching and PR/check
status. Sanitize repository names, private messages, paths and account details;
label synthetic demonstration data if used. Do not present a mock as live work.

## Other feature cards

### Your agent, across devices

> Use the Mac app, a browser, paired phones or compatible glasses. The mobile
> source includes tasks, chat, approvals and Supervisor. iOS also has a
> phone-agent mode on compatible devices and an offline workspace.

Label mobile apps **source/QA builds**, with no public store download promise.
Keep foldable-device acceptance and unfinished integration work out of the
shipping-feature list.

### Connect the work you choose

> Connect Gmail and Google Calendar, approved messaging contacts, MCP tools
> and reviewed skills. Give the agent its own number through a supported
> provider. Pebble Index transcripts can become memories and reminder tasks.

Link to the
[connection guide](https://github.com/Spshulem/openAGI/blob/main/docs/setup/partner-and-integrations.md).
Mention Sendblue, Linq, Twilio, Telnyx and Surge as optional providers requiring
the owner's accounts and configuration. Describe email/calendar writes as
approved actions; do not imply a draft was sent or a phone number is included.

### Keep long runs bounded

> Track model spend and set daily, per-turn and estimated input limits.
> When a limit stops a long task, saved progress helps you continue with a
> record of completed actions.

Do not call estimated token limits exact billing guarantees or promise that a
continuation can safely replay an uncertain external action.

## Replace overbroad privacy and autonomy claims

Use this privacy copy in the hero, comparison table and privacy section:

> Your agent's state lives on the host you choose. You choose the model and
> connected services. Cloud models receive selected prompts and tool context;
> connected services receive the data needed for their actions. Use a supported
> local model when you want inference on your device. Screen observation is
> optional, and live computer actions have separate permissions and approval.

Replace the existing “Your data never leaves” wording and blanket “no cloud
component” implications. Optional iOS alerts use encrypted payloads through a
relay and Apple's push service; paired app requests still need a reachable host.
Avoid guarantees that corrections can never recur or that the agent will do a
fixed fraction of someone's work after a fixed number of weeks.

Keep **source-available / PolyForm Noncommercial 1.0.0** accurate. Native screen
capture, computer control and local-model support vary by platform; the portable
browser/CLI runtime is not a native capture app.

## Publication checklist and evidence

| Item | Evidence and availability |
| --- | --- |
| Supervisor, voice, diagnosis and repair worker | Present in v0.0.58 source and documented in the [Supervisor guide](https://github.com/Spshulem/openAGI/blob/main/docs/setup/fleet-supervisor.md); require configuration |
| iOS push and phone-agent/workspace additions | Merged #208/#209 after v0.0.58; source/QA availability, not a store release |
| New messaging/Google/Pebble connections | Merged #210 after v0.0.58; owner accounts, configuration and live acceptance required |
| Provider, cost and approval improvements | Merged #212–#214 after v0.0.58; not evidence that an installed app has updated |
| Guided onboarding and Windows/Linux portable downloads | #215 is open; publish download claims only when the release assets exist |

Before publishing, recheck the latest release assets, use only those download
links, and verify desktop/mobile layout, navigation and screenshot privacy in
the actual website project. The README refresh and this copy do not deploy the
public website.
