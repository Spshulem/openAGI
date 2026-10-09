# Principle recall requires relevance

Lexical memory retrieval now applies the principle ranking bonus only after a
text match or an explicit high-risk tag match establishes relevance. A memory's
`kind: principle` is no longer sufficient to make it a retrieval result.

Previously an unrelated principle received a score of 0.1 even for an empty or
punctuation-only query. Returning that result also increased its strength and
recorded a recall, including in the durable memory snapshot and recall journal.
Such results could consume retrieval slots and reinforce unrelated context.

The fix preserves the bonus for relevant principles, risk-tag recall without
lexical overlap, scope isolation, and exclusion of superseded memories. It does
not change vector search, correction protection, retention, permissions, storage
formats, or the meaning of explicit user feedback. No live memories are removed
or rewritten by this change, and prior inflated recall counts are not reset.

## Regression verification

```sh
node --test test/principle-recall-relevance.test.js
```

Use the repository's supported Node version (22 or newer). Tests use synthetic
content and disposable state; no provider credentials or model calls are needed.

Before the fix, three of six cases failed: unrelated-query recall, empty-query
recall, and durable no-match retrieval. A synthetic unrelated principle was
returned with score 0.1 and its strength rose from 0.50 to 0.53. After the fix,
those queries return no result and leave strength, recall metadata, snapshot,
and journal unchanged. Matching queries still persist recall credit on restart.
All six cases pass, including relevance ranking, risk tags, and scope/corrections.

Production recall coverage is an exposure metric, not evidence that a memory
was useful. It also includes legacy access timestamps. Removing false retrievals
may reduce this metric; do not treat an increased recall count as a goal by
itself. Evaluate usefulness with representative query checks and explicit user
feedback, without logging private query or memory content.
