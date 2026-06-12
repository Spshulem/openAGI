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
