import { randomUUID } from "node:crypto";

// A reconnect request is deliberately ephemeral. The request itself is bound
// to the main process identity and the exact enrolled node; the only secret
// ever issued is a rotated owner-proxy credential delivered to that node.
export const NODE_RECONNECT_TTL_MS = 5 * 60 * 1000;

const RECONNECT_ID = "[a-f0-9-]{36}";

export function isNodeReconnectRequestRoute(method, pathname) {
  return method === "POST" && pathname === "/nodes/reconnect/request";
}

export function isNodeReconnectNodeRoute(method, pathname) {
  return (method === "GET" && new RegExp(`^/nodes/reconnect/requests/${RECONNECT_ID}$`).test(pathname))
    || (method === "POST" && new RegExp(`^/nodes/reconnect/requests/${RECONNECT_ID}/ack$`).test(pathname));
}

export function isNodeReconnectMobileRoute(method, pathname) {
  return (method === "GET" && pathname === "/nodes/reconnect/requests")
    || (method === "POST" && new RegExp(`^/nodes/reconnect/requests/${RECONNECT_ID}/(approve|deny)$`).test(pathname));
}

export function reconnectRequestId(pathname) {
  const match = /^\/nodes\/reconnect\/requests\/([a-f0-9-]{36})(?:\/(?:ack|approve|deny))?$/.exec(pathname);
  return match?.[1] ?? null;
}

function publicRequest(request) {
  return {
    requestId: request.requestId,
    mainNodeId: request.mainNodeId,
    targetNodeId: request.targetNodeId,
    targetName: request.targetName,
    targetPlatform: request.targetPlatform,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    status: request.status
  };
}

function expired(request, now) {
  if (request.status === "pending" && now >= request.expiresAtMs) {
    request.status = "expired";
    request.expiredAt = new Date(now).toISOString();
    return true;
  }
  return request.status === "expired" || now >= request.expiresAtMs;
}

export class NodeReconnectManager {
  constructor({ mainNodeId, nodeRegistry, ttlMs = NODE_RECONNECT_TTL_MS, now = () => Date.now() } = {}) {
    if (typeof mainNodeId !== "string" || !mainNodeId) throw new Error("mainNodeId is required");
    if (!nodeRegistry) throw new Error("nodeRegistry is required");
    this.mainNodeId = mainNodeId;
    this.nodeRegistry = nodeRegistry;
    this.ttlMs = Math.max(30_000, Math.min(15 * 60_000, Number(ttlMs) || NODE_RECONNECT_TTL_MS));
    this.now = now;
    this.requests = new Map();
  }

  create(targetNodeId) {
    const now = this.now();
    this.sweep(now);
    const enrollment = this.nodeRegistry.enrollment(targetNodeId);
    if (!enrollment) return { ok: false, code: "unknown_node", message: "This node is no longer enrolled on the main." };
    const existing = [...this.requests.values()].find((request) => request.targetNodeId === targetNodeId && request.status === "pending");
    if (existing && !expired(existing, now)) {
      return { ok: true, created: false, request: publicRequest(existing) };
    }
    const expiresAtMs = now + this.ttlMs;
    const request = {
      requestId: randomUUID(),
      mainNodeId: this.mainNodeId,
      targetNodeId,
      targetName: enrollment.name ?? targetNodeId,
      targetPlatform: enrollment.platform ?? null,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      status: "pending",
      ownerProxyToken: null,
      approvedAt: null,
      deniedAt: null,
      consumedAt: null
    };
    this.requests.set(request.requestId, request);
    return { ok: true, created: true, request: publicRequest(request) };
  }

  listForMobile(now = this.now()) {
    this.sweep(now);
    return [...this.requests.values()]
      .filter((request) => request.status === "pending" && request.mainNodeId === this.mainNodeId)
      .map(publicRequest)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  approve(requestId, approverNodeId) {
    const request = this.requests.get(requestId);
    const now = this.now();
    if (!request || request.mainNodeId !== this.mainNodeId) return { ok: false, code: "unknown_request", message: "Reconnect request not found." };
    if (expired(request, now)) return { ok: false, code: "request_expired", message: "This reconnect request expired. Start a new request on the node." };
    if (request.status !== "pending") return { ok: false, code: "request_not_pending", message: `This reconnect request is already ${request.status}.` };
    const approver = this.nodeRegistry.enrollment(approverNodeId);
    if (!approver || approver.platform !== "mobile") return { ok: false, code: "mobile_approval_required", message: "Approve this request from an enrolled owner phone." };
    if (approverNodeId === request.targetNodeId) return { ok: false, code: "approver_must_differ", message: "The target node cannot approve its own reconnect." };
    if (!this.nodeRegistry.isEnrolled(request.targetNodeId)) return { ok: false, code: "unknown_node", message: "This node is no longer enrolled on the main." };
    // Keep the raw credential only in memory until the exact target asks for
    // it. The registry stores a hash; neither the phone nor a dashboard gets
    // the credential or the owner's token.
    const ownerProxyToken = this.nodeRegistry.grantOwnerProxyToken(request.targetNodeId);
    if (!ownerProxyToken) return { ok: false, code: "unknown_node", message: "This node is no longer enrolled on the main." };
    request.ownerProxyToken = ownerProxyToken;
    request.status = "approved";
    request.approvedAt = new Date(now).toISOString();
    return { ok: true, request: publicRequest(request) };
  }

  deny(requestId, approverNodeId) {
    const request = this.requests.get(requestId);
    const now = this.now();
    if (!request || request.mainNodeId !== this.mainNodeId) return { ok: false, code: "unknown_request", message: "Reconnect request not found." };
    if (expired(request, now)) return { ok: false, code: "request_expired", message: "This reconnect request expired." };
    if (request.status !== "pending") return { ok: false, code: "request_not_pending", message: `This reconnect request is already ${request.status}.` };
    const approver = this.nodeRegistry.enrollment(approverNodeId);
    if (!approver || approver.platform !== "mobile") return { ok: false, code: "mobile_approval_required", message: "Deny this request from an enrolled owner phone." };
    request.status = "denied";
    request.deniedAt = new Date(now).toISOString();
    return { ok: true, request: publicRequest(request) };
  }

  statusForNode(requestId, nodeId) {
    const now = this.now();
    this.sweep(now);
    const request = this.requests.get(requestId);
    if (!request || request.mainNodeId !== this.mainNodeId) return { ok: false, code: "unknown_request", message: "Reconnect request not found." };
    if (request.targetNodeId !== nodeId) return { ok: false, code: "forbidden_node", message: "This reconnect request belongs to another node." };
    if (expired(request, now) && request.status !== "approved" && request.status !== "consumed") {
      return { ok: true, request: publicRequest(request) };
    }
    const result = publicRequest(request);
    if (request.status === "approved" && request.ownerProxyToken) result.ownerProxyToken = request.ownerProxyToken;
    return { ok: true, request: result };
  }

  acknowledge(requestId, nodeId) {
    const now = this.now();
    this.sweep(now);
    const request = this.requests.get(requestId);
    if (!request || request.mainNodeId !== this.mainNodeId) return { ok: false, code: "unknown_request", message: "Reconnect request not found." };
    if (request.targetNodeId !== nodeId) return { ok: false, code: "forbidden_node", message: "This reconnect request belongs to another node." };
    if (request.status === "consumed") return { ok: true, request: publicRequest(request) };
    if (request.status !== "approved" || !request.ownerProxyToken) return { ok: false, code: "request_not_approved", message: "Approve the reconnect from the owner phone first." };
    request.status = "consumed";
    request.consumedAt = new Date(now).toISOString();
    request.ownerProxyToken = null;
    return { ok: true, request: publicRequest(request) };
  }

  sweep(now = this.now()) {
    for (const [id, request] of this.requests) {
      if (request.status === "pending" && now >= request.expiresAtMs) {
        request.status = "expired";
        request.expiredAt = new Date(now).toISOString();
      }
      // Keep terminal metadata briefly for deterministic replay responses, but
      // never retain an approved credential after its request window.
      if (request.status === "approved" && now >= request.expiresAtMs) {
        request.status = "expired";
        request.ownerProxyToken = null;
      }
      if (request.status !== "pending" && request.status !== "approved" && now - request.expiresAtMs > this.ttlMs) this.requests.delete(id);
    }
  }
}
