# Open Computer Use adapter verification

- Upstream `iFurySt/open-codex-computer-use` v0.3.3 selected, MIT license.
- The exact npm archive passed the pinned SHA-512 check and its Mac app passed
  `codesign --verify --deep --strict`. Installed under the operator's OpenAGI
  tools directory, without changing the active backend or agent configuration.
- A real local MCP initialize and tools/list succeeded against the installed
  native executable, returning all nine upstream tools. The process was closed
  afterward. This test did not capture the screen or perform input.
- The installed native executable's `doctor` reported Accessibility and Screen
  Recording granted on this Mac. No permission settings were changed.
- 47 focused Node 22 tests passed: adapter, bounded stdio transport,
  computer-server leases/authentication/frames, Cua compatibility, readiness,
  canonical data directory, and environment persistence.
- Tests cover wrong-window rejection, element-index mapping, screenshot pixel
  coordinates, stale frames, unsupported operations, archive substitution,
  error responses, cancellation, and timeout termination. Test data is synthetic.

## Not verified / release gate

No physical screenshot/click/type round trip, multi-Mac control, or
default-backend migration is claimed. The adapter is
experimental and opt-in. Existing native control remains the default; the
signed native helper is still required for privacy checks and fallback actions.
Upstream app targeting does not provide an atomic OpenAGI window-identity check
at event dispatch. Validate this limitation before promoting the backend for
sensitive/unattended work. The setup guide lists the reduced operation set.
