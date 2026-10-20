# Task capture and intent

The short- and long-horizon observers distinguish planned work, work in
progress, completed work, reading context, and unknown intent. Task proposals
must include an exact evidence excerpt from the supplied recent chat or screen
context, and must describe unfinished work with a concrete next step.
Completed, context-only, unknown, missing, or unsupported intent is declined.
This is model-assisted extraction; it does not guarantee perfect intent
classification.

Reading somebody else's bug report is not a commitment to fix it. “I fixed
the parser yesterday” should not produce a new task. “I will review PR 42
tomorrow” can support a proposal. Existing pending tasks are supplied to the
observer so it can avoid duplicates. Screen text remains untrusted context.

Suggestions require acceptance by default. With `OPENAGI_AUTO_TASKS=1`, only
an unfinished task whose title exactly matches a complete supplied owner chat
statement can be created automatically. The statement must have at least four
words and 20 characters. It is filed in the user's queue with a fixed capture
description; generated rationale cannot append extra work. Paraphrases, short
fragments and screen-derived plans still appear as proposals
for review, even when that flag is enabled. Older proposals without intent
metadata also require review; accepting a proposal manually still works.

The evidence checks use the existing recent-context window. They do not add
an episodic-session store or infer a persistent user goal from screen text.
The narrower behavior addresses noisy capture without requiring that proposed
architecture. Use the observer's existing mute and dismiss controls when a
suggestion is irrelevant.
