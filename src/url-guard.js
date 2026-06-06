// SSRF guard shared by MCP registration and the fetch_url tool.
//
// Rejects URLs that point at loopback / link-local / RFC1918 / cloud-metadata
// endpoints, and constrains the protocol to http/https. Combined with the
// env-var allowlist this closes the SSRF + secret-exfil chain (e.g. an agent
// being steered by injected web/transcript content into fetching
// http://169.254.169.254/... and returning the response).
//
// This is a host-string check (it does not resolve DNS) — matching the
// project's existing baseline. It is intentionally conservative.

function isBlockedHost(host) {
  return (
    host === "localhost" || host === "0.0.0.0" || host === "::" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "169.254.169.254" || // AWS / GCP IMDS
    /^fd[0-9a-f]{2}:/.test(host) || // ULA
    /^fe80:/.test(host) || // link-local
    host === "::1"
  );
}

// Extract the embedded IPv4 from an IPv4-mapped IPv6 host, in either the dotted
// form (`::ffff:127.0.0.1`) or the hex form Node normalizes to
// (`::ffff:7f00:1`). Returns null when the host isn't a mapped address. Without
// this, `http://[::ffff:127.0.0.1]/` would slip past the loopback/RFC1918 checks.
function ipv4FromMappedV6(host) {
  const m = /^::ffff:(.+)$/i.exec(host);
  if (!m) return null;
  const rest = m[1];
  if (rest.includes(".")) return rest; // ::ffff:127.0.0.1
  const g = rest.split(":");           // ::ffff:7f00:1 → ["7f00","1"]
  if (g.length !== 2) return null;
  const a = parseInt(g[0], 16);
  const b = parseInt(g[1], 16);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
}

export function assertSafePublicUrl(value, label = "url") {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`${label} protocol must be http or https, got "${u.protocol}".`);
  }
  // URL.hostname keeps brackets for IPv6 (e.g. "[::1]") — strip them so the
  // loopback/link-local checks below match.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedV4 = ipv4FromMappedV6(host);
  if (isBlockedHost(host) || (mappedV4 && isBlockedHost(mappedV4))) {
    throw new Error(
      `${label} host "${host}" is not allowed (loopback, private, or link-local). ` +
      `Use a public hostname.`
    );
  }
  return u;
}

// fetch() that re-validates the host on EVERY redirect hop, so a public URL
// cannot 30x-redirect into an internal address. Returns the final Response.
export async function safeFetch(url, init = {}, { label = "url", maxRedirects = 5 } = {}) {
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertSafePublicUrl(current, label);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`${label}: too many redirects`);
}
