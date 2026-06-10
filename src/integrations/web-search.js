// src/integrations/web-search.js
import { PROVIDERS, PROVIDER_BY_NAME, firecrawl } from "./web-search-providers.js";
import { assertSafePublicUrl, safeFetch } from "../url-guard.js";

const PROVIDER_NAMES = PROVIDERS.map((p) => p.name);

// opts.providers is a test seam; production uses the real PROVIDERS list.
export function registerWebSearchTools(runtime, opts = {}) {
  const providers = opts.providers ?? PROVIDERS;
  const byName = opts.providers
    ? Object.fromEntries(opts.providers.map((p) => [p.name, p]))
    : PROVIDER_BY_NAME;

  runtime.tools.register({
    name: "web_search",
    description: "Search the live web. Returns a list of results (title, url, snippet, and often page content). Picks a configured provider automatically; pass `provider` to force one.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        provider: { type: "string", enum: PROVIDER_NAMES, description: "Force a specific provider. Omit to auto-select." },
        num_results: { type: "integer", minimum: 1, maximum: 20, description: "Max results (default 5)." },
        recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Optional recency hint." }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args) => {
      const numResults = args.num_results ?? 5;
      // Resolution order: explicit arg -> WEB_SEARCH_PROVIDER -> priority list.
      let order = [];
      if (args.provider) {
        const p = byName[args.provider];
        if (!p) return { error: `Unknown provider: ${args.provider}` };
        if (!p.isConfigured()) return { error: `Provider ${args.provider} is not configured (missing API key).` };
        order = [p];
      } else {
        const envDefault = process.env.WEB_SEARCH_PROVIDER && byName[process.env.WEB_SEARCH_PROVIDER];
        const configured = providers.filter((p) => p.isConfigured());
        order = envDefault && envDefault.isConfigured() ? [envDefault, ...configured.filter((p) => p !== envDefault)] : configured;
      }
      if (order.length === 0) return { error: "No web search provider configured. Set EXA_API_KEY, TAVILY_API_KEY, BRAVE_API_KEY, SERPAPI_API_KEY, FIRECRAWL_API_KEY, or PERPLEXITY_API_KEY in ~/.openagi/.env." };

      const errors = [];
      for (const p of order) {
        try {
          const results = await p.search(args.query, { numResults, recency: args.recency });
          return { provider: p.name, count: results.length, results };
        } catch (err) {
          errors.push(`${p.name}: ${err.message}`);
        }
      }
      return { error: `All providers failed. ${errors.join("; ")}` };
    }
  });

  runtime.tools.register({
    name: "fetch_url",
    description: "Fetch the contents of a web page as markdown/text. Uses Firecrawl when configured, otherwise a plain fetch.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        format: { type: "string", enum: ["markdown", "text"], description: "Output format (default markdown)." }
      },
      required: ["url"],
      additionalProperties: false
    },
    handler: async (args) => {
      // SSRF guard: reject loopback / private / link-local / metadata hosts and
      // non-http(s) protocols before touching the network. Done up front so the
      // Firecrawl path can't be used to reach internal hosts either.
      try {
        assertSafePublicUrl(args.url, "fetch_url url");
      } catch (err) {
        return { error: err.message };
      }
      if (firecrawl.isConfigured()) {
        try {
          const content = await firecrawl.fetch(args.url);
          if (content) return { url: args.url, format: "markdown", content };
        } catch (err) {
          // fall through to plain fetch
        }
      }
      try {
        // safeFetch re-validates the host on every redirect hop so a public URL
        // can't 30x-redirect into an internal address.
        const res = await safeFetch(args.url, { headers: { "user-agent": "OpenAGI/1.0" } }, { label: "fetch_url url" });
        if (!res.ok) return { error: `${args.url} -> ${res.status}` };
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { url: args.url, format: "text", content: text.slice(0, 20_000) };
      } catch (err) {
        return { error: `fetch_url failed: ${err.message}` };
      }
    }
  });

  return { registered: true };
}
