// Migrator: extract persona/memory/telegram from a synthetic OpenClaw and
// Hermes install, and apply into OpenAGI (persona.md + .env + POSTed memories).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractOpenClaw, extractHermes, detectSource, applyMigration } from "../src/migrate.js";

function makeOpenClaw() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-src-"));
  fs.mkdirSync(path.join(dir, "workspace", "memory"), { recursive: true });
  fs.mkdirSync(path.join(dir, "cron"), { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace", "IDENTITY.md"), "# IDENTITY\n- **Name:** Peri\n- Vibe: sharp");
  fs.writeFileSync(path.join(dir, "workspace", "SOUL.md"), "# SOUL\nBe helpful, not performatively helpful.");
  fs.writeFileSync(path.join(dir, "workspace", "USER.md"), "# USER\n- Name: Spencer");
  fs.writeFileSync(path.join(dir, "workspace", "memory", "car-search.md"), "Evaluating EVs under $60k");
  fs.writeFileSync(path.join(dir, "workspace", "memory", "cruise.md"), "Australia to New Zealand, March");
  fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify({
    channels: { telegram: { accounts: { default: { botToken: "123:ABC" }, wedding: { botToken: "456:DEF" } } } }
  }));
  fs.writeFileSync(path.join(dir, "cron", "jobs.json"), JSON.stringify([{ name: "Daily Todo" }]));
  return dir;
}

test("extractOpenClaw pulls persona, memories, telegram, cron notes", () => {
  const dir = makeOpenClaw();
  const x = extractOpenClaw(dir);
  assert.equal(x.agentName, "Peri");
  assert.match(x.persona, /Be helpful, not performatively/);
  assert.match(x.persona, /Name: Spencer/);
  assert.equal(x.memories.length, 2);
  assert.ok(x.memories.some((m) => m.name === "car-search" && /EVs/.test(m.content)));
  assert.deepEqual(x.telegram.map((t) => t.label).sort(), ["default", "wedding"]);
  assert.ok(x.notes.some((n) => /cron job/.test(n)));
  fs.rmSync(dir, { recursive: true });
});

test("extractHermes reads USER.md + MEMORY.md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-src-"));
  fs.writeFileSync(path.join(dir, "USER.md"), "# USER\n- Name: Spencer\n- TZ: PST");
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "Durable: the standup is 9am Mondays.");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ telegram: { botToken: "999:ZZZ" } }));
  const x = extractHermes(dir);
  assert.equal(x.source, "hermes");
  assert.match(x.persona, /Name: Spencer/);
  assert.ok(x.memories.some((m) => m.name === "MEMORY" && /standup is 9am/.test(m.content)));
  assert.equal(x.telegram[0].token, "999:ZZZ");
  fs.rmSync(dir, { recursive: true });
});

test("detectSource identifies an OpenClaw home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  fs.mkdirSync(path.join(home, ".openclaw"));
  fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}");
  assert.equal(detectSource(home), "openclaw");
  fs.rmSync(home, { recursive: true });
});

test("applyMigration writes persona.md + telegram env and POSTs memories", async () => {
  const src = makeOpenClaw();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-data-"));
  const posted = [];
  const client = { request: async (m, route, body) => { posted.push({ route, body }); return { ok: true }; } };
  const extracted = extractOpenClaw(src);

  const result = await applyMigration({ extracted, dataDir, client });
  assert.equal(result.importedMemories, 2);
  assert.ok(posted.every((p) => p.route === "/memory/remember"));
  assert.ok(posted[0].body.tags.includes("openclaw-import"));

  const persona = fs.readFileSync(path.join(dataDir, "persona.md"), "utf8");
  assert.match(persona, /Peri/);
  const env = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.match(env, /TELEGRAM_BOT_TOKEN=123:ABC/);
  assert.match(env, /TELEGRAM_POLLING=1/);

  fs.rmSync(src, { recursive: true });
  fs.rmSync(dataDir, { recursive: true });
});

test("dry run plans without writing anything", async () => {
  const src = makeOpenClaw();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-data2-"));
  const result = await applyMigration({ extracted: extractOpenClaw(src), dataDir, client: { request: async () => ({ ok: true }) }, dryRun: true });
  assert.equal(result.applied, false);
  assert.equal(result.memories, 2);
  assert.ok(!fs.existsSync(path.join(dataDir, "persona.md")), "nothing written on dry run");
  fs.rmSync(src, { recursive: true });
  fs.rmSync(dataDir, { recursive: true });
});

test("applyMigration preserves an existing token (won't overwrite)", async () => {
  const src = makeOpenClaw();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-data3-"));
  fs.writeFileSync(path.join(dataDir, ".env"), "TELEGRAM_BOT_TOKEN=existing:token\n");
  await applyMigration({ extracted: extractOpenClaw(src), dataDir, client: { request: async () => ({ ok: true }) } });
  const env = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.match(env, /TELEGRAM_BOT_TOKEN=existing:token/);
  assert.ok(!env.includes("123:ABC"), "did not clobber the existing token");
  fs.rmSync(src, { recursive: true });
  fs.rmSync(dataDir, { recursive: true });
});
