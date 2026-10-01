import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO, "scripts", "install-systemd.sh");

function runPrintUnit(mode, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-systemd-test-"));
  const home = path.join(root, "home");
  const serviceDir = path.join(root, "current");
  fs.mkdirSync(path.join(serviceDir, "examples"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync("bash", [INSTALLER, mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      OPENAGI_NODE_BIN: process.execPath,
      OPENAGI_SERVICE_DIR: serviceDir,
      OPENAGI_INSTALL_SYSTEMD_PRINT_UNIT: "1",
      ...extraEnv
    }
  });
  return { ...result, root, home, serviceDir };
}

function literal(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("user systemd unit can target a staged release/current symlink", () => {
  const { status, stdout, stderr, home, serviceDir } = runPrintUnit("user");
  assert.equal(status, 0, stderr);
  assert.match(stdout, new RegExp(`ExecStart=${literal(process.execPath)} ${literal(path.join(serviceDir, "examples", "hosted-server.js"))}`));
  assert.match(stdout, new RegExp(`WorkingDirectory=${literal(serviceDir)}`));
  assert.match(stdout, new RegExp(`EnvironmentFile=-${literal(path.join(home, ".openagi", ".env"))}`));
  assert.match(stdout, new RegExp(`Environment=OPENAGI_DATA_DIR=${literal(path.join(home, ".openagi"))}`));
  assert.match(stdout, /RestrictNamespaces=true/);
  assert.match(stdout, new RegExp(`ReadWritePaths=${literal(path.join(home, ".openagi"))} ${literal(serviceDir)}`));
  assert.doesNotMatch(stdout, new RegExp(literal(REPO)), "release-managed units must not point back to the mutable checkout");
});

test("systemd installer rejects newline-injected service paths before printing a unit", () => {
  const result = runPrintUnit("user", { OPENAGI_SERVICE_DIR: `/tmp/openagi\nEnvironment=BAD=1` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENAGI_SERVICE_DIR must be an absolute path without newlines/);
  assert.equal(result.stdout, "");
});

test("systemd installer restarts an existing service after rewriting the unit", () => {
  const script = fs.readFileSync(INSTALLER, "utf8");
  assert.doesNotMatch(script, /enable --now/, "enable --now alone does not replace an already-running ExecStart");
  assert.match(script, /systemctl --user enable "\$\{UNIT_NAME\}"\n[\s\S]*systemctl --user restart "\$\{UNIT_NAME\}"/);
  assert.match(script, /systemctl enable "\$\{UNIT_NAME\}"\n[\s\S]*systemctl restart "\$\{UNIT_NAME\}"/);
});
