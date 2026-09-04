import assert from "node:assert/strict";
import test from "node:test";
import { MCP_CATALOG, matchCatalog } from "../src/mcp-catalog.js";

test("Superhuman Mail uses the official OAuth server without embedded credentials", () => {
  const entries = MCP_CATALOG.filter((entry) => entry.id === "superhuman-mail");
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.status, "available");
  assert.equal(entry.authType, "oauth");
  assert.equal(entry.category, "communication");
  assert.deepEqual(entry.register, {
    url: "https://mcp.mail.superhuman.com/mcp", transport: "http", auth: "oauth"
  });
  assert.match(entry.description, /Business or higher/);
});

test("Superhuman suggestions stay specific to Mail and stop after registration", () => {
  const mail = [{ text: "Open mail.superhuman.com to review the inbox" }];
  const ids = (snippets, registered) => matchCatalog([], snippets, registered).map(({ entry }) => entry.id);
  assert.ok(ids(mail).includes("superhuman-mail"));
  assert.ok(!ids(mail, new Set(["superhuman-mail"])).includes("superhuman-mail"));
  assert.ok(!ids([{ text: "Superhuman Docs" }]).includes("superhuman-mail"));
});
