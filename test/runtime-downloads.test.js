import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

const posixLinks = { skip: process.platform === "win32" && "npm uses command wrappers on Windows" };

test("dependency CLI and directory links work after the bundle and source move", posixLinks, t => {
  const opts = fixture(t);
  const modules = path.join(opts.root, "node_modules");
  fs.mkdirSync(path.join(modules, ".bin"));
  fs.mkdirSync(path.join(modules, "tool/bin"), { recursive: true });
  fs.writeFileSync(path.join(modules, "tool/package.json"), JSON.stringify({ version: "1.2.3" }));
  // Flattening this CLI into .bin also breaks its package-relative imports.
  fs.writeFileSync(path.join(modules, "tool/bin/tool.js"), "console.log(require('../package.json').version);\n");
  fs.symlinkSync("../tool/bin/tool.js", path.join(modules, ".bin/tool"));
  fs.symlinkSync("tool", path.join(modules, ".bin/forward"));
  fs.symlinkSync("tool", path.join(modules, "alias"));
  packageRuntime({ ...opts, nodeExecutable: process.execPath, platform: "linux", arch: "x64" });
  const moved = opts.destination + " relocated";
  fs.renameSync(opts.destination, moved);
  fs.renameSync(opts.root, opts.root + " moved");
  for (const relative of [".bin/tool", ".bin/forward", "alias/bin/tool.js"]) {
    const result = spawnSync(path.join(moved, "node/node"), [path.join(moved, "node_modules", relative)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "1.2.3");
  }
  assert.equal(fs.readlinkSync(path.join(moved, "node_modules/.bin/tool")), "../tool/bin/tool.js");
});

test("explicit Node executable and license inputs are copied as files even when symlinked", posixLinks, t => {
  const opts = fixture(t);
  for (const key of ["nodeExecutable", "nodeLicense"]) {
    fs.symlinkSync(opts[key], opts[key] + "-link");
    opts[key] += "-link";
  }
  packageRuntime({ ...opts, platform: "linux", arch: "x64" });
  for (const [key, bundled] of [["nodeExecutable", "node/node"], ["nodeLicense", "node/LICENSE"]]) {
    assert.equal(fs.lstatSync(path.join(opts.destination, bundled)).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(path.join(opts.destination, bundled)), fs.readFileSync(opts[key]));
  }
});

for (const [name, target] of [
  ["absolute internal", opts => path.join(opts.root, "src/main.js")],
  ["absolute external", opts => opts.nodeLicense],
  ["escaping relative", () => "../../outside"],
  ["dangling", () => "missing.js"],
  ["private source state", () => "../.env"],
  ["cyclic", () => "link"],
]) {
  test(`packaging rejects ${name} links`, posixLinks, t => {
    const opts = fixture(t);
    fs.symlinkSync(target(opts), path.join(opts.root, "src/link"));
    assert.throws(() => packageRuntime({ ...opts, platform: "linux", arch: "x64" }), /Unsafe runtime symlink/);
    assert.equal(fs.existsSync(path.join(opts.destination, "runtime-manifest.json")), false);
  });
}

test("link traversal cannot leave the bundle and return through an external link", posixLinks, t => {
  const opts = fixture(t);
  fs.mkdirSync(path.dirname(opts.destination), { recursive: true });
  fs.symlinkSync(path.join(opts.destination, "src/main.js"), path.join(path.dirname(opts.destination), "return"));
  fs.symlinkSync("..", path.join(opts.root, "node_modules/redirect"));
  // Lexical normalization and the final realpath can both look internal even
  // though following redirect/.. steps outside the bundle.
  fs.symlinkSync("../node_modules/redirect/../return", path.join(opts.root, "src/link"));
  assert.throws(() => packageRuntime({ ...opts, platform: "linux", arch: "x64" }), /Unsafe runtime symlink/);
});
