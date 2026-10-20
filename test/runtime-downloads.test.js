import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageRuntime } from "../scripts/package-runtime.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-download-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "source");
  fs.mkdirSync(root);
  for (const name of ["bin", "src", "examples", "scripts", "assets", "node_modules/ws", "docs"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const name of ["package-lock.json", "LICENSE", "README.md", "docs/INSTALL.md", "docs/GETTING_STARTED.md", "src/main.js", "node_modules/ws/LICENSE"]) fs.writeFileSync(path.join(root, name), "public fixture\n");
  for (const name of [".env", ".openagi", "private-token", "logs"]) fs.writeFileSync(path.join(root, name), "must not ship");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const nodeExecutable = path.join(dir, "fake-node"), nodeLicense = path.join(dir, "node-license");
  fs.writeFileSync(nodeExecutable, "binary fixture");
  fs.writeFileSync(nodeLicense, "Node and third-party notices");
  return { root, destination: path.join(dir, "folder with spaces", "OpenAGI"), nodeExecutable, nodeLicense };
}

test("portable Linux bundle includes production code, executable, notices and a launcher but no private state", t => {
  const opts = fixture(t);
  const result = packageRuntime({ ...opts, platform: "linux", arch: "arm64" });
  assert.equal(result.version, "1.2.3");
  assert.equal(result.arch, "arm64");
  assert.equal(result.nodeSha256.length, 64);
  assert.equal(fs.readFileSync(path.join(opts.destination, "node/LICENSE"), "utf8"), "Node and third-party notices");
  assert.ok(fs.existsSync(path.join(opts.destination, "node_modules/ws/LICENSE")));
  for (const name of [".env", ".openagi", "private-token", "logs"]) assert.equal(fs.existsSync(path.join(opts.destination, name)), false);
  assert.match(fs.readFileSync(path.join(opts.destination, "start-openagi.sh"), "utf8"), /exec "\$RUNTIME_DIR\/node\/node"/);
  if (process.platform !== "win32") assert.ok(fs.statSync(path.join(opts.destination, "start-openagi.sh")).mode & 0o100);
  assert.throws(() => packageRuntime({ ...opts, platform: "linux", arch: "arm64" }), /exist/i, "existing output is never overwritten");
});

test("Windows bundle has a relocatable CMD launcher without npm or a shell-policy change", t => {
  const opts = fixture(t);
  packageRuntime({ ...opts, platform: "win32", arch: "x64" });
  assert.ok(fs.existsSync(path.join(opts.destination, "node/node.exe")));
  const cmd = fs.readFileSync(path.join(opts.destination, "Start-OpenAGI.cmd"), "utf8");
  assert.match(cmd, /"%~dp0node\\node\.exe" "%~dp0bin\\openagi\.js" serve/);
  assert.doesNotMatch(cmd, /npm|ExecutionPolicy|powershell/i);
  assert.throws(() => packageRuntime({ ...opts, destination: opts.destination + "-other", nodeLicense: null, platform: "win32", arch: "x64" }), /LICENSE/);
});
