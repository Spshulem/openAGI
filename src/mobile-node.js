// The phone is a full client, so its credential is broader than the G2
// wearable's. Breadth is only safe when it is explicit: this module is the
// single enumerated answer to "what may a phone token do", kept as pure data
// so the gate in hosted-interface.js has nothing to get creative about.
export const MOBILE_PLATFORM = "mobile";

export const MOBILE_CAPABILITIES = [
  "mobile-task-client",
  "mobile-approval-client",
  "mobile-chat-client"
];

export const MOBILE_NODE_NAME_MAX = 60;

// A task/action id as minted by createId(): letters, digits, underscore, dash.
// Deliberately excludes "." and "/" so no id can carry a path segment.
const ID = "[a-zA-Z0-9_-]{1,120}";

const EXACT = new Set([
  "GET /mobile/summary",
  "GET /tasks",
  "POST /tasks",
  "GET /tasks/clarifications",
  "GET /pending-actions",
  "POST /message",
  "GET /events",
  "GET /brief/today",
  "POST /brief/focus/dismiss",
  "GET /recap/daily",
  "GET /plan/daily",
  "GET /outreach/digest",
  "POST /nodes/heartbeat",
  "POST /nodes/revoke",
  "POST /nodes/speech-token"
]);

const PATTERNS = [
  { method: "GET", re: new RegExp(`^/tasks/${ID}$`) },
  { method: "PATCH", re: new RegExp(`^/tasks/${ID}$`) },
  { method: "DELETE", re: new RegExp(`^/tasks/${ID}$`) },
  { method: "POST", re: new RegExp(`^/tasks/${ID}/complete$`) },
  { method: "POST", re: new RegExp(`^/tasks/clarifications/${ID}/answer$`) },
  { method: "POST", re: new RegExp(`^/pending-actions/${ID}/approve$`) },
  { method: "POST", re: new RegExp(`^/pending-actions/${ID}/deny$`) }
];

export function isMobileRouteAllowed(method, pathname) {
  if (typeof method !== "string" || typeof pathname !== "string") return false;
  if (pathname.includes("..") || pathname.includes("//")) return false;
  if (EXACT.has(`${method} ${pathname}`)) return true;
  // "GET /tasks/clarifications" is exact; the ID pattern must not swallow it.
  if (pathname === "/tasks/clarifications") return false;
  return PATTERNS.some((p) => p.method === method && p.re.test(pathname));
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export function boundedMobileNodeName(value) {
  const raw = typeof value === "string" ? value : "";
  const clean = raw.replace(CONTROL_CHARS, "").trim();
  if (!clean) return "Phone";
  return clean.slice(0, MOBILE_NODE_NAME_MAX);
}
