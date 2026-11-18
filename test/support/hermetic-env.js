// Loaded into every test process by `npm test` (see package.json).
//
// Tests must never reach a real model provider. Several tests build a runtime
// with the default provider, which picks a live one whenever these variables
// are set, so a developer shell or agent session with real keys turned those
// tests into live API calls (and failures). Tests that exercise provider
// selection set the variables they need themselves, after this runs.
// The optional local scoring service is cleared for the same reason: a
// running one on the developer's machine must not answer test runtimes.
for (const key of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAGI_MODEL_URL",
  "OPENAGI_MODEL_TOKEN_FILE"
]) {
  delete process.env[key];
}
