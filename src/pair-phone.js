// The same reachability rule the phone apps enforce, enforced here first: the
// CLI must refuse to mint a code the phone could never spend, and say exactly
// what to change. A six-digit code that fails silently on the phone is the
// worst possible first experience.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isTailnetHost(hostname) {
  if (hostname.endsWith(".ts.net")) return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateLanHost(hostname) {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function assertPhoneReachable(baseUrl) {
  const parsed = new URL(baseUrl);
  const host = parsed.hostname;
  if (LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `a phone cannot reach ${host}. Bind OpenAGI to your tailnet or LAN address and set `
      + "OPENAGI_AUTH_TOKEN, then run this again."
    );
  }
  if (parsed.protocol === "http:" && !isTailnetHost(host) && !isPrivateLanHost(host)) {
    throw new Error(
      `refusing to pair over cleartext http to ${host}: use https, or reach OpenAGI over your tailnet.`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("the daemon url must be http or https");
  }
  return parsed.origin;
}

export function buildPairingUrl({ baseUrl, code, platform }) {
  if (platform !== "ios" && platform !== "android") {
    throw new Error("platform must be ios or android");
  }
  if (!/^\d{6}$/.test(String(code))) throw new Error("the code must be six digits");
  const origin = assertPhoneReachable(baseUrl);
  const url = new URL("openagi://pair");
  url.searchParams.set("url", origin);
  url.searchParams.set("code", String(code));
  url.searchParams.set("platform", platform);
  return url.toString();
}
