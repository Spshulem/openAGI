// src/integrations/web-search-providers.js
// Provider adapters for web_search/fetch_url. Each adapter is independent and
// env-gated. Responses are mapped to a NormalizedResult:
//   { title, url, snippet, publishedDate?, content? }

const TIMEOUT_MS = 15_000;

// Strip credential query params so they never reach error messages / logs.
const sanitizeUrl = (url) => String(url).replace(/([?&](?:api_key|key)=)[^&]*/gi, "$1[REDACTED]");

async function postJson(url, { headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`${sanitizeUrl(url)} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, { headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`${sanitizeUrl(url)} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const str = (v) => (typeof v === "string" ? v : "");

export const exa = {
  name: "exa",
  isConfigured: () => Boolean(process.env.EXA_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.EXA_API_KEY;
    const data = await postJson("https://api.exa.ai/search", {
      headers: { "x-api-key": apiKey },
      body: { query, numResults: opts.numResults ?? 5, contents: { text: true } }
    });
    return (data.results ?? []).map((r) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.text).slice(0, 400),
      publishedDate: r.publishedDate ?? undefined, content: r.text ?? undefined
    }));
  }
};

export const tavily = {
  name: "tavily",
  isConfigured: () => Boolean(process.env.TAVILY_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
    const data = await postJson("https://api.tavily.com/search", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { query, max_results: opts.numResults ?? 5, search_depth: "basic", include_answer: false }
    });
    return (data.results ?? []).map((r) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.content).slice(0, 400),
      publishedDate: r.published_date ?? undefined, content: r.raw_content ?? undefined
    }));
  }
};

export const firecrawl = {
  name: "firecrawl",
  isConfigured: () => Boolean(process.env.FIRECRAWL_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.FIRECRAWL_API_KEY;
    const data = await postJson("https://api.firecrawl.dev/v2/search", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { query, limit: opts.numResults ?? 5 }
    });
    // v2 returns { data: { web: [...] } } or { data: [...] } depending on sources.
    const rows = Array.isArray(data.data) ? data.data : (data.data?.web ?? []);
    return rows.map((r) => ({
      title: str(r.title), url: str(r.url),
      snippet: str(r.description || r.snippet).slice(0, 400),
      content: r.markdown ?? undefined
    }));
  },
  async fetch(url, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.FIRECRAWL_API_KEY;
    const data = await postJson("https://api.firecrawl.dev/v2/scrape", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { url, formats: ["markdown"] }
    });
    return str(data.data?.markdown);
  }
};

export const brave = {
  name: "brave",
  isConfigured: () => Boolean(process.env.BRAVE_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.BRAVE_API_KEY;
    const count = opts.numResults ?? 5;
    const data = await getJson(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { headers: { accept: "application/json", "x-subscription-token": apiKey } }
    );
    return (data.web?.results ?? []).map((r) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.description).slice(0, 400),
      publishedDate: r.page_age ?? undefined
    }));
  }
};

export const perplexity = {
  name: "perplexity",
  isConfigured: () => Boolean(process.env.PERPLEXITY_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.PERPLEXITY_API_KEY;
    const data = await postJson("https://api.perplexity.ai/chat/completions", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { model: "sonar", messages: [{ role: "user", content: query }] }
    });
    const answer = str(data.choices?.[0]?.message?.content);
    const citations = Array.isArray(data.citations) ? data.citations : [];
    const out = [];
    if (answer) out.push({ title: "Perplexity answer", url: citations[0] ?? "", snippet: answer.slice(0, 400), content: answer });
    for (const c of citations) out.push({ title: c, url: c, snippet: "" });
    return out.slice(0, (opts.numResults ?? 5) + 1);
  }
};

export const serpapi = {
  name: "serpapi",
  isConfigured: () => Boolean(process.env.SERPAPI_API_KEY) || Boolean(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID),
  async search(query, opts = {}) {
    const num = opts.numResults ?? 5;
    if (process.env.SERPAPI_API_KEY || opts.apiKey) {
      const key = opts.apiKey ?? process.env.SERPAPI_API_KEY;
      const data = await getJson(
        `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${num}&api_key=${encodeURIComponent(key)}`
      );
      return (data.organic_results ?? []).map((r) => ({
        title: str(r.title), url: str(r.link), snippet: str(r.snippet).slice(0, 400),
        publishedDate: r.date ?? undefined
      }));
    }
    // Google Programmable Search fallback. cse.list caps `num` at 10 (1–10);
    // a higher value (the tool schema allows up to 20) returns a 400.
    const cseNum = Math.min(10, Math.max(1, num));
    const data = await getJson(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}&cx=${encodeURIComponent(process.env.GOOGLE_CSE_ID)}&q=${encodeURIComponent(query)}&num=${cseNum}`
    );
    return (data.items ?? []).map((r) => ({
      title: str(r.title), url: str(r.link), snippet: str(r.snippet).slice(0, 400)
    }));
  }
};

// Default priority order (spec): exa -> tavily -> brave -> serpapi -> firecrawl -> perplexity.
export const PROVIDERS = [exa, tavily, brave, serpapi, firecrawl, perplexity];
export const PROVIDER_BY_NAME = Object.fromEntries(PROVIDERS.map((p) => [p.name, p]));
