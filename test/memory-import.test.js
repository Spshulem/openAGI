// POST /memory/remember — direct memory import (for migrations / seeding).
import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";

test("POST /memory/remember imports a memory item", async () => {
  const runtime = createDefaultRuntime();
  const app = createHostedInterface(runtime, { port: 0 });
  const address = await app.listen();
  try {
    const res = await fetch(`${address.url}/memory/remember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Spencer's cruise: Australia → New Zealand, Mar 15-30", tags: ["cruise"], importance: "high" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.id);
    // It's recallable.
    const hits = runtime.memory.retrieve("cruise itinerary");
    assert.ok(hits.some((h) => /Australia/.test(h.item.content)));
    assert.ok(hits.some((h) => h.item.tags.includes("import") && h.item.tags.includes("cruise")));
  } finally {
    await app.close();
  }
});

test("POST /memory/remember rejects empty content", async () => {
  const app = createHostedInterface(createDefaultRuntime(), { port: 0 });
  const address = await app.listen();
  try {
    const res = await fetch(`${address.url}/memory/remember`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "  " })
    });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test("POST /memory/:id/correct locks a user correction and refuses stale or empty writes", async () => {
  const runtime = createDefaultRuntime();
  const stale = runtime.memory.remember({ source: "test", content: "The review starts at three", tags: ["review"] });
  const app = createHostedInterface(runtime, { port: 0 });
  const address = await app.listen();
  try {
    const corrected = await fetch(`${address.url}/memory/${encodeURIComponent(stale.id)}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "The review starts at four" })
    });
    assert.equal(corrected.status, 200);
    const body = await corrected.json();
    assert.equal(body.locked, true);
    assert.equal(body.supersededCount, 1);
    assert.equal(runtime.memory.items.get(stale.id).metadata.supersededBy, body.id);
    assert.equal(runtime.memory.items.get(body.id).metadata.userAuthored, true);
    assert.equal(runtime.memory.retrieve("review starts")[0].item.id, body.id);

    const repeat = await fetch(`${address.url}/memory/${encodeURIComponent(stale.id)}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "Try to overwrite the stale row again" })
    });
    assert.equal(repeat.status, 409);

    const activeId = body.id;
    const empty = await fetch(`${address.url}/memory/${encodeURIComponent(activeId)}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "   " })
    });
    assert.equal(empty.status, 400);

    const oversized = await fetch(`${address.url}/memory/${encodeURIComponent(activeId)}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "x".repeat(10_001) })
    });
    assert.equal(oversized.status, 400);

    const raced = runtime.memory.remember({ source: "test", content: "The launch is Monday", tags: ["launch"] });
    const submitRace = (correction) => fetch(`${address.url}/memory/${encodeURIComponent(raced.id)}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction })
    });
    const raceResponses = await Promise.all([
      submitRace("The launch is Tuesday"),
      submitRace("The launch is Wednesday")
    ]);
    assert.deepEqual(raceResponses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(
      [...runtime.memory.items.values()].filter((item) => item.metadata?.corrects?.includes(raced.id)).length,
      1,
      "concurrent submissions create one correction for the stale row"
    );
  } finally {
    await app.close();
  }
});

test("memory correction route inherits dashboard authentication", async () => {
  const runtime = createDefaultRuntime();
  const stale = runtime.memory.remember({ source: "test", content: "A private stored fact" });
  const app = createHostedInterface(runtime, { port: 0, authToken: "test-dashboard-token" });
  const address = await app.listen();
  try {
    const denied = await fetch(`${address.url}/memory/${encodeURIComponent(stale.id)}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "An unauthorized replacement" })
    });
    assert.equal(denied.status, 401);
    assert.equal(stale.metadata.supersededBy, undefined);

    const allowed = await fetch(`${address.url}/memory/${encodeURIComponent(stale.id)}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-dashboard-token" },
      body: JSON.stringify({ correction: "The authorized corrected fact" })
    });
    assert.equal(allowed.status, 200);
  } finally {
    await app.close();
  }
});
