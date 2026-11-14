// Loaded into every test process by `npm test` (see package.json).
//
// Tests must never reach a real model provider. Several tests build a runtime
// with the default provider, which picks a live one whenever these variables
// are set, so a developer shell or agent session with real keys turned those
// tests into live API calls (and failures). Tests that exercise provider
// selection set the variables they need themselves, after this runs.
for (const key of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL"
]) {
  delete process.env[key];
}
