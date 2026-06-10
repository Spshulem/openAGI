// test/buildbetter-transcripts.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { BuildBetterTaskSource } from "../src/integrations/buildbetter-tasks.js";

function fakeObservations() {
  const rows = [];
  return {
    record: async (o) => { rows.push(o); return { count: 1 }; },
    search: async () => rows,
    existsRef: async (ref) => rows.some((o) => o.ref === ref),
    _rows: rows
  };
}

test("syncTranscripts records one transcript per call and dedupes", async () => {
  const observations = fakeObservations();
  const src = new BuildBetterTaskSource({
    apiKey: "k", userEmail: "me@x.com",
    runtime: { observations }
  });
  // Stub the two network calls.
  src.getRecentCalls = async () => [{ id: 7, name: "Acme Discovery", started_at: "2026-06-01T10:00:00Z" }];
  src.getTranscript = async (callId) => `Transcript for ${callId}: ship it by Friday.`;

  const first = await src.syncTranscripts({ now: new Date("2026-06-02T00:00:00Z") });
  assert.equal(first.created, 1);
  assert.equal(observations._rows[0].kind, "transcript");
  assert.equal(observations._rows[0].ref, "buildbetter:call:7");

  // Second run: same call already recorded -> no new row.
  const second = await src.syncTranscripts({ now: new Date("2026-06-02T00:05:00Z") });
  assert.equal(second.created, 0);
});

test("ingestMode defaults to signals", () => {
  const prev = process.env.BUILDBETTER_INGEST_MODE;
  delete process.env.BUILDBETTER_INGEST_MODE;
  const src = new BuildBetterTaskSource({ apiKey: "k", userEmail: "me@x.com" });
  assert.equal(src.ingestMode, "signals");
  if (prev !== undefined) process.env.BUILDBETTER_INGEST_MODE = prev;
});

test("syncTranscripts skips with a reason when identity can't be determined (no silent empty)", async () => {
  const observations = fakeObservations();
  // Auth present (api key) but no email/name, and `me` returns no user.
  const src = new BuildBetterTaskSource({ apiKey: "k", runtime: { observations } });
  src.query = async () => ({ me: { person: null } });
  let fetched = 0;
  src.getTranscript = async () => { fetched += 1; return "x"; };
  const res = await src.syncTranscripts({ now: new Date("2026-06-02T00:00:00Z") });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /identity/i);
  assert.equal(observations._rows.length, 0, "records nothing");
  assert.equal(fetched, 0, "never even fetches transcripts");
});

test("getTranscript assembles speaker-labeled lines, falling back to Speaker N", async () => {
  const src = new BuildBetterTaskSource({ apiKey: "k", userEmail: "me@x.com" });
  src.query = async () => ({
    interview: [{
      id: 7,
      monologues: [
        { speaker: 0, text: "Hello there", attendee: { person: { first_name: "Ada", last_name: "Lovelace" } } },
        { speaker: 1, text: "Hi", attendee: null }
      ]
    }]
  });
  const t = await src.getTranscript(7);
  assert.equal(t, "Ada Lovelace: Hello there\nSpeaker 1: Hi");
});

test("getTranscript returns empty string when there are no monologues", async () => {
  const src = new BuildBetterTaskSource({ apiKey: "k", userEmail: "me@x.com" });
  src.query = async () => ({ interview: [{ id: 7, monologues: [] }] });
  assert.equal(await src.getTranscript(7), "");
});

test("sync dispatches by ingestMode", async () => {
  const calls = [];
  const make = (mode) => {
    const src = new BuildBetterTaskSource({ apiKey: "k", userEmail: "me@x.com", ingestMode: mode });
    src.syncSignals = async () => { calls.push(`${mode}:signals`); return { created: 0 }; };
    src.syncTranscripts = async () => { calls.push(`${mode}:transcripts`); return { created: 0 }; };
    return src;
  };
  await make("signals").sync({ now: new Date("2026-06-02T00:00:00Z") });
  await make("transcripts").sync({ now: new Date("2026-06-02T00:00:00Z") });
  await make("both").sync({ now: new Date("2026-06-02T00:00:00Z") });
  assert.deepEqual(calls, [
    "signals:signals",
    "transcripts:transcripts",
    "both:signals", "both:transcripts"
  ]);
});

test("syncTranscripts does not refetch an already-ingested transcript", async () => {
  const observations = fakeObservations();
  const src = new BuildBetterTaskSource({ apiKey: "k", userEmail: "me@x.com", runtime: { observations } });
  src.getRecentCalls = async () => [{ id: 7, name: "Acme", started_at: "2026-06-01T10:00:00Z" }];
  let fetchCount = 0;
  src.getTranscript = async () => { fetchCount += 1; return "some transcript text"; };
  await src.syncTranscripts({ now: new Date("2026-06-02T00:00:00Z") });
  await src.syncTranscripts({ now: new Date("2026-06-02T00:05:00Z") });
  assert.equal(fetchCount, 1, "transcript fetched once; second run skips via existsRef");
});
