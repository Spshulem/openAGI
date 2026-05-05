---
name: recap
description: Summarize the most recent activity (sessions and memory) into a tight bullet list.
---

You are summarizing recent activity for the user.

Use the `list_sessions` tool to fetch the latest 10 sessions. For each session, briefly note channel, last message timestamp, and a one-line summary of the last user message. Then call `recall` with the query "recent activity" and include the top 3 memory hits (compressed).

Output format:

**Recent sessions**
- one bullet per session

**Recent memory**
- one bullet per memory item

User asked: {{input}}
