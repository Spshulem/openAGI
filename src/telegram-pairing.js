// src/telegram-pairing.js
// Pairing security for the Telegram channel: a one-time 6-digit code
// (node:crypto randomInt) valid 10 minutes and single use; 5 failed attempts
// trigger a 15-minute lockout; a successful "/pair <code>" persists the chat
// id into <dir>/allowlist.json (0600 via writeJsonAtomic's default mode).
// Every method takes an injectable now (epoch ms) so the state machine is
// testable as pure logic — no timers, no network, no Telegram API.
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const CODE_TTL_MS = 10 * 60 * 1000;   // a code is valid for 10 minutes
export const MAX_ATTEMPTS = 5;                // failures before lockout engages
export const LOCKOUT_MS = 15 * 60 * 1000;     // lockout duration

function codesEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export class TelegramPairing {
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "channels", "telegram");
    ensureDir(this.dir);
    this.allowlistPath = path.join(this.dir, "allowlist.json");
    this.active = null;       // { code, createdAt } — at most one live code
    this.failedAttempts = 0;
    this.lockedUntil = 0;     // epoch ms; attempts before this are rejected
  }

  // Issue a fresh one-time code, invalidating any previous one. Does NOT
  // clear an active lockout — generating codes never resets the guess budget.
  generateCode({ now = Date.now() } = {}) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    this.active = { code, createdAt: now };
    this.failedAttempts = 0;
    return { code, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
  }

  // One pairing attempt from a chat. Persists the chat id on success.
  attempt(chatId, code, { now = Date.now() } = {}) {
    if (now < this.lockedUntil) return { ok: false, reason: "locked" };
    // No code is open, so there is nothing to guess. Counting this would let a
    // stranger lock the owner out before the owner ever issues a code.
    if (!this.active) return { ok: false, reason: "no-active-code" };
    if (now - this.active.createdAt > CODE_TTL_MS) {
      this.active = null;
      return this._fail(now, "expired");
    }
    if (!codesEqual(code, this.active.code)) return this._fail(now, "invalid");
    this.active = null; // single use
    this.failedAttempts = 0;
    this._persist(String(chatId), now);
    return { ok: true };
  }

  isAllowed(chatId) {
    return this._read().chats.some((c) => c.chatId === String(chatId));
  }

  allowlist() {
    return this._read().chats.map((c) => c.chatId);
  }

  status() {
    return {
      pairedChats: this.allowlist().length,
      codeActive: Boolean(this.active),
      lockedUntil: this.lockedUntil > Date.now() ? new Date(this.lockedUntil).toISOString() : null
    };
  }

  _fail(now, reason) {
    this.failedAttempts += 1;
    if (this.failedAttempts >= MAX_ATTEMPTS) {
      this.lockedUntil = now + LOCKOUT_MS;
      this.failedAttempts = 0;
      this.active = null; // burn the code on lockout
      return { ok: false, reason: "locked" };
    }
    return { ok: false, reason };
  }

  _read() {
    return readJsonFile(this.allowlistPath, { version: 1, chats: [] });
  }

  _persist(chatId, now) {
    const data = this._read();
    if (data.chats.some((c) => c.chatId === chatId)) return;
    data.chats.push({ chatId, pairedAt: new Date(now).toISOString() });
    writeJsonAtomic(this.allowlistPath, data);
  }
}
