import crypto from "node:crypto";

export const NODE_ENROLLMENT_CODE_TTL_MS = 10 * 60 * 1000;
export const NODE_ENROLLMENT_MAX_ATTEMPTS = 5;
export const NODE_ENROLLMENT_LOCKOUT_MS = 15 * 60 * 1000;

// One-time codes are deliberately process-local. They authorize a single
// credential exchange, are never useful after a restart, and do not create a
// second durable identity store alongside NodeRegistry.
export class NodeEnrollmentCodes {
  constructor({ platforms = [] } = {}) {
    this.platforms = new Set(platforms);
    this.active = null;
    this.failedAttempts = 0;
    this.lockedUntil = 0;
  }

  issue(platform, { now = Date.now() } = {}) {
    if (!this.platforms.has(platform)) throw new Error("unsupported node platform");
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    this.active = { code, platform, createdAt: now };
    if (now >= this.lockedUntil) {
      this.lockedUntil = 0;
      this.failedAttempts = 0;
    }
    return {
      code,
      platform,
      expiresAt: new Date(now + NODE_ENROLLMENT_CODE_TTL_MS).toISOString()
    };
  }

  consume(code, platform, { now = Date.now() } = {}) {
    if (!this.platforms.has(platform)) return this._fail(now, "unsupported-platform");
    if (now < this.lockedUntil) return { ok: false, reason: "locked" };
    if (!this.active) return this._fail(now, "no-active-code");
    if (now - this.active.createdAt > NODE_ENROLLMENT_CODE_TTL_MS) {
      this.active = null;
      return this._fail(now, "expired");
    }
    if (this.active.platform !== platform || !safeEqual(code, this.active.code)) {
      return this._fail(now, "invalid");
    }
    const enrollment = { platform: this.active.platform };
    this.active = null;
    this.failedAttempts = 0;
    return { ok: true, ...enrollment };
  }

  status({ now = Date.now() } = {}) {
    return {
      codeActive: Boolean(this.active),
      lockedUntil: this.lockedUntil > now ? new Date(this.lockedUntil).toISOString() : null
    };
  }

  _fail(now, reason) {
    this.failedAttempts += 1;
    if (this.failedAttempts >= NODE_ENROLLMENT_MAX_ATTEMPTS) {
      this.lockedUntil = now + NODE_ENROLLMENT_LOCKOUT_MS;
      this.failedAttempts = 0;
      this.active = null;
      return { ok: false, reason: "locked" };
    }
    return { ok: false, reason };
  }
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
