# Checkpoints and candidate testing

No live service or installed glasses app has been changed.

| Preserved work | Commit | Branch |
| --- | --- | --- |
| Original OpenAGI working-tree changes (68 files) | `a16ed63c3055842ad69743b3ac501bcb29d188f1` | `codex/checkpoint-g2-before-redesign-20260912` |
| Existing G2 base source/review notes (4 paths) | `4408eb1fc545d0b43509b24a4f84f63d027c9fc4` | `codex/checkpoint-before-openagi-redesign-20260912` in the G2 repo |
| Reviewed 0.4.17 plus approved scope | `08b80e194d3643ae1e9ca20a69c17d8560996648` | Parent of redesign implementation |

The two historical working-tree checkpoints are local safety copies, not new verified releases. Ignored environment files, private runtime state, dependencies and generated artifacts were not staged.

Preserved 0.4.17 artifact: `/Users/shooby/Downloads/OpenAGI-Agent-0.4.17-2507228.ehpk`.
SHA-256: `374c0cff1c557d939cee29566e9bc34b4ae46caed842c51cf42885e0ef1e0e7b`.

For source comparison, use `git diff 08b80e194d3643ae1e9ca20a69c17d8560996648..codex/g2-experience-redesign`. Create a separate worktree at that immutable commit if needed; never hard-reset a working checkout. Reinstallation of the retained client is a separate device operation requiring explicit user action/authorization.

Candidate verification commands and artifact paths will be added to the implementation verification record. Any saved manual draft/request receipt has its own lifetime; source rollback does not revert server side effects or grant fresh recording consent.
