import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import * as sandbox from "../src/codex-sandbox.js";
import { pinExecutable } from "../src/codex-app-server-client.js";

test("a real Linux bubblewrap child cannot read host files or reach host loopback", { skip: process.platform !== "linux" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-sandbox-"));
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile, { mode: 0o700 });
  for (const name of ["work", "home", "tmp", "xdg-config", "xdg-data"]) fs.mkdirSync(path.join(profile, name), { mode: 0o700 });
  const outside = path.join(root, "private-marker");
  fs.writeFileSync(outside, "private");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  const pin = pinExecutable("/usr/bin/python3");
  const profileFd = fs.openSync(profile, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    assert.equal(typeof sandbox.buildCodexSandboxLaunch, "function");
    const probe = `import json, pathlib, socket\ns=socket.socket(); s.settimeout(1)\nprint(json.dumps({"private_visible":pathlib.Path(${JSON.stringify(outside)}).exists(),"host_home_visible":pathlib.Path(${JSON.stringify(os.homedir())}).exists(),"host_loopback_reachable":s.connect_ex(("127.0.0.1",${port}))==0,"work_writable":pathlib.Path("/profile/work").is_dir()}))`;
    const launch = sandbox.buildCodexSandboxLaunch({ pin, profileDir: profile, profileFd, args: ["-c", probe] });
    const result = spawnSync(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: launch.stdio, timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.deepEqual(JSON.parse(result.stdout.toString()), {
      private_visible: false,
      host_home_visible: false,
      host_loopback_reachable: false,
      work_writable: true
    });
  } finally {
    fs.closeSync(profileFd);
    pin.close();
    listener.close();
  }
});

test("a confined relay exposes only the broker over loopback", { skip: process.platform !== "linux" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-relay-"));
  for (const name of ["work", "home", "tmp", "xdg-config", "xdg-data"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const broker = net.createServer((socket) => {
    socket.on("data", () => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
  });
  await new Promise((resolve) => broker.listen(path.join(root, "egress.sock"), resolve));
  const pin = pinExecutable("/usr/bin/python3");
  const profileFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const relayPath = new URL("../src/codex-proxy-relay.py", import.meta.url);
  const relayFd = fs.openSync(relayPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const probe = "import os,socket; s=socket.create_connection(('127.0.0.1',18787),2); s.sendall(b'CONNECT api.openai.com:443 HTTP/1.1\\r\\nHost: api.openai.com\\r\\n\\r\\n'); print(os.environ['HTTPS_PROXY'],s.recv(128).decode().split('\\r\\n')[0]); s.close()";
    const launch = sandbox.buildCodexSandboxLaunch({ pin, profileDir: root, profileFd, relayFd, args: ["-c", probe] });
    const result = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: launch.stdio });
    let stdout = "";
    let stderr = "";
    result.stdout.on("data", (chunk) => { stdout += chunk; });
    result.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => result.kill("SIGKILL"), 10_000);
    const code = await new Promise((resolve, reject) => {
      result.once("error", reject);
      result.once("exit", resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /http:\/\/127\.0\.0\.1:18787 HTTP\/1\.1 403 Forbidden/);
  } finally {
    fs.closeSync(relayFd);
    fs.closeSync(profileFd);
    pin.close();
    await new Promise((resolve) => broker.close(resolve));
  }
});

test("the sandbox binds the opened profile directory even after its pathname is replaced", { skip: process.platform !== "linux" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-profile-fd-"));
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  for (const name of ["work", "home", "tmp", "xdg-config", "xdg-data"]) fs.mkdirSync(path.join(profile, name));
  fs.writeFileSync(path.join(profile, "work", "marker"), "pinned");
  const profileFd = fs.openSync(profile, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const pin = pinExecutable("/usr/bin/python3");
  try {
    fs.renameSync(profile, path.join(root, "original"));
    fs.mkdirSync(profile);
    fs.mkdirSync(path.join(profile, "work"));
    fs.writeFileSync(path.join(profile, "work", "marker"), "replacement");
    const launch = sandbox.buildCodexSandboxLaunch({ pin, profileDir: profile, profileFd,
      args: ["-c", "import pathlib; print(pathlib.Path('/profile/work/marker').read_text())"] });
    const result = spawnSync(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: launch.stdio, timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.equal(result.stdout.toString().trim(), "pinned");
  } finally {
    fs.closeSync(profileFd);
    pin.close();
  }
});

test("idle relay clients cannot start an unbounded number of threads", { skip: process.platform !== "linux" }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-relay-cap-"));
  for (const name of ["work", "home", "tmp", "xdg-config", "xdg-data"]) fs.mkdirSync(path.join(profile, name));
  const broker = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve) => broker.listen(path.join(profile, "egress.sock"), resolve));
  const pin = pinExecutable("/usr/bin/python3");
  const profileFd = fs.openSync(profile, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const relayFd = fs.openSync(new URL("../src/codex-proxy-relay.py", import.meta.url), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const probe = "import os,socket,time; sockets=[socket.create_connection(('127.0.0.1',18787),3) for _ in range(24)]; time.sleep(.5); print(len(os.listdir('/proc/%d/task' % os.getppid()))); [s.close() for s in sockets]";
    const launch = sandbox.buildCodexSandboxLaunch({ pin, profileDir: profile, profileFd, relayFd, args: ["-c", probe] });
    const proc = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: launch.stdio });
    let output = "";
    let diagnostic = "";
    proc.stdout.on("data", (chunk) => { output += chunk; });
    proc.stderr.on("data", (chunk) => { diagnostic += chunk; });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    const code = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("exit", resolve); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, diagnostic);
    assert.ok(Number(output.trim()) <= 11, `relay created ${output.trim()} threads`);
  } finally {
    fs.closeSync(relayFd);
    fs.closeSync(profileFd);
    pin.close();
    await new Promise((resolve) => broker.close(resolve));
  }
});
