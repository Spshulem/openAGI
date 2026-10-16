// Phone-only mode with a cloud model: when the cloud can't be reached (a
// flight, a dead zone), the turn is answered by the phone's own model instead
// of failing. Only network failures fall back; a bad key or a spent quota is
// a real error the owner has to fix, so it surfaces as one.

const NETWORK_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"
]);

export const OFFLINE_NOTE = "(Offline, so this answer came from this iPhone's on-device model.)";

export function isNetworkError(error, depth = 0) {
  if (!error || depth > 4) return false;
  if (NETWORK_CODES.has(error.code)) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (/fetch failed|socket hang up|network|timed out|getaddrinfo/i.test(String(error.message ?? ""))) return true;
  return isNetworkError(error.cause, depth + 1);
}

export class OfflineFallbackProvider {
  constructor(primary, fallback) {
    this.primary = primary;
    this.fallback = fallback;
  }

  get model() { return this.primary.model; }
  get name() { return this.primary.constructor?.name ?? "provider"; }
  isConfigured() { return this.primary.isConfigured?.() ?? true; }

  async generate(args = {}) {
    try {
      return await this.primary.generate(args);
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      // The cloud may have streamed a partial answer before dropping; the
      // first fallback delta resets what the person sees.
      let first = true;
      const onTextDelta = args.onTextDelta
        ? (delta) => {
            const reset = first || delta?.reset;
            first = false;
            args.onTextDelta({ ...delta, reset });
          }
        : undefined;
      const result = await this.fallback.generate({ ...args, onTextDelta });
      return { ...result, text: `${OFFLINE_NOTE}\n\n${result?.text ?? ""}`, offlineFallback: true };
    }
  }
}
