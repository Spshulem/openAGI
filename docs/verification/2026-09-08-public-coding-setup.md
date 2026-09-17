# Public coding-agent setup follow-up

PR #93 was already merged and had no inline review threads or submitted reviews
when checked. Its sole bot comment reported a review usage limit, not a finding.
This follow-up addresses reproducibility of the built-in supervisor setup on
fresh installations, without private infrastructure or automatic authorization.

## Changes

- Enabling requires at least one owner-selected Git project.
- Omitting folders preserves the saved selection; an explicit list replaces it.
  Blank UI input now preserves saved projects and supports re-enabling them.
- Saved labels and short IDs distinguish similarly named projects without
  exposing absolute paths in the setup response.
- Missing CLI / legacy empty-project states show recovery instructions instead
  of a start form. The public guide remains available with external adapters.
- Instructions distinguish the supervisor computer from the browser computer,
  particularly for an enrolled remote node.

## Verification

Using Node 22, 47 tests passed across:

```sh
node --test --test-concurrency=1 \
  test/builtin-coding-supervisor.test.js \
  test/coding-supervisor-setup-ui.test.js \
  test/coding-supervisor-http.test.js \
  test/coding-supervisor-node.test.js \
  test/coding-supervisor.test.js \
  test/coding-supervisor-adapter.test.js
```

The built-in, setup-UI and HTTP files passed again (17 tests).
The UI tests execute shipped handlers with a small DOM fixture; they are not
pixel-level browser verification. HTTP tests exercise the real authenticated
interface with disposable storage and a fake provider process: empty setup is
rejected, starts require approval, replay is rejected, and re-enabling saved
folders starts no process. Restart preservation and missing CLI behavior are
covered independently.

## Safety review and limits

No new routes, credentials, shell arguments, dependencies, permission modes or
live configuration changes. Existing auth/Origin gates and exact approval
binding remain unchanged. Workspace paths are still revalidated when enabling;
rejected setup leaves persisted configuration unchanged. Labels use textContent,
and the fixed public documentation link uses noopener/noreferrer. Tests include
a hostile label rendered as literal text.

No installed app update, provider account login, real model run, remote-machine
configuration, computer input, or iMessage round trip was performed. Those are
not established by these fixture tests. Users still supply their own provider
accounts, project selection and optional node pairing.
