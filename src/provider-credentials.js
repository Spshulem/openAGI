// Catch a known provider/key mismatch before a credential is persisted or sent.
// Custom endpoints remain explicit: they must implement the Responses API.
export function validateOpenAIKey(apiKey, baseUrl) {
  if (!String(apiKey ?? "").trim().startsWith("sk-or-")) return;
  const endpoint = new URL(baseUrl || "https://api.openai.com/v1");
  if (endpoint.hostname.replace(/\.$/, "") !== "api.openai.com") return;
  const error = new Error("This is an OpenRouter key. Set a Responses-compatible base URL and its model, or use an OpenAI API key.");
  error.code = "PROVIDER_CONFIG_MISMATCH";
  throw error;
}
