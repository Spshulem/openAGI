import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ATTRIBUTES = ["openagi-provider", "chatgpt-host-oauth"];
const GENERATION_ATTRIBUTES = ["openagi-provider", "chatgpt-host-oauth-revocation"];
// The core systemd unit writes ~/.openagi but mounts the rest of HOME read-only.
// Keep the interprocess lock in a private child of that existing writable root.
const LOCK_PATH = path.join(os.homedir(), ".openagi", "chatgpt-host-oauth", "chatgpt-oauth.lock");

function decodeMountPoint(value = "") {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
}

export function hasUniqueReadOnlyHomeMount(mountinfo, home = os.userInfo().homedir) {
  const accountHome = path.resolve(home);
  const mounts = mountinfo.split("\n").map((line) => line.split(" "))
    .filter((fields) => fields.length > 5)
    .map((fields) => ({ mountPoint: decodeMountPoint(fields[4]), options: fields[5]?.split(",") ?? [] }));
  const homeMounts = mounts.filter((mount) => mount.mountPoint === "/home");
  // A writable bind below the account home (for example the service data root
  // or the staged release) cannot replace the stable HOME inode used as the
  // lock anchor. A bind on HOME itself can, so reject only that exact overlay.
  const overlaysAccountHome = mounts.some((mount) => mount.mountPoint === accountHome);
  return !overlaysAccountHome && homeMounts.length === 1 && homeMounts[0].options.includes("ro") === true;
}

export function isTrustedLockAnchorAncestor(directory, stat, readOnlyHome) {
  return stat.isDirectory() && (stat.mode & 0o022) === 0 &&
    (stat.uid === 0 ||
      (directory === "/" && (stat.mode & 0o222) === 0) ||
      (directory === "/home" && stat.uid === 65534 && readOnlyHome));
}

export async function runSecretTool(args, input, { binary = "/usr/bin/secret-tool", timeoutMs = 15_000, lookup = args[0] === "lookup" } = {}) {
  if (process.platform !== "linux") throw new Error("Secret Service is only supported on Linux.");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", HOME: os.homedir(),
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "",
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || "" }
      });
    } catch { reject(new Error("Secret Service unavailable.")); return; }
    const chunks = [];
    let bytes = 0;
    let stderrBytes = 0;
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 16_384) { failed = true; child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 4_096) { failed = true; child.kill("SIGKILL"); }
    });
    child.on("error", () => { failed = true; });
    child.on("close", (code) => {
      clearTimeout(timer);
      // libsecret's lookup returns 1 without stderr for no match; failures
      // print a diagnostic on stderr. Never disclose that diagnostic.
      if (!failed && lookup && code === 1 && stderrBytes === 0 && bytes === 0) resolve("");
      else if (failed || code !== 0 || stderrBytes > 0) reject(new Error("Secret Service unavailable."));
      else resolve(Buffer.concat(chunks, bytes).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

export class SecretToolChatGptStore {
  constructor({ run = runSecretTool, withLock } = {}) {
    this.run = run;
    this.lock = withLock || withKernelLock;
  }

  async read() {
    const raw = await this.run(["lookup", ...ATTRIBUTES]);
    if (!raw) return null;
    let value;
    try { value = JSON.parse(raw); }
    catch { throw new Error("Invalid ChatGPT credential store."); }
    if (typeof value.accessToken !== "string" || typeof value.refreshToken !== "string" || !Number.isFinite(value.expiresAt)) {
      throw new Error("Invalid ChatGPT credential store.");
    }
    return value;
  }

  async write(value) {
    if (typeof value?.accessToken !== "string" || typeof value.refreshToken !== "string" || !Number.isFinite(value.expiresAt)) {
      throw new TypeError("Invalid ChatGPT token record.");
    }
    await this.run(["store", "--label=OpenAGI ChatGPT OAuth", ...ATTRIBUTES], JSON.stringify(value));
  }

  async clear() {
    await this.run(["clear", ...ATTRIBUTES]);
  }

  async readGeneration() {
    const generation = (await this.run(["lookup", ...GENERATION_ATTRIBUTES])).trim();
    if (!generation) return null;
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(generation)) {
      throw new Error("Invalid ChatGPT credential generation.");
    }
    return generation;
  }

  async bumpGeneration() {
    const generation = randomUUID();
    await this.run(["store", "--label=OpenAGI ChatGPT OAuth revocation", ...GENERATION_ATTRIBUTES], generation);
    return generation;
  }

  async withLock(fn) { return this.lock(fn); }
}

export async function withKernelLock(fn, lockPath = LOCK_PATH) {
  if (process.platform !== "linux") throw new Error("ChatGPT credential lock is only supported on Linux.");
  const parent = path.dirname(lockPath);
  const dataRoot = path.dirname(parent);
  // The private data root is not stable if a different user can rename any
  // directory above it (notably a shared project directory in system mode).
  // ProtectHome=read-only presents /home as a read-only bind owned by nobody
  // inside the unit; verify that mount before trusting the remapped owner.
  const readOnlyProtectedHome = async () => hasUniqueReadOnlyHomeMount(
    await fs.readFile("/proc/self/mountinfo", "utf8"), os.userInfo().homedir
  );
  for (let current = path.resolve(path.dirname(dataRoot)); ; current = path.dirname(current)) {
    let ancestor;
    try { ancestor = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch { throw new Error("Unsafe ChatGPT credential lock ancestor."); }
    try {
      const stat = await ancestor.stat();
      const trustedOwner = stat.uid === process.getuid() || stat.uid === 0 ||
        (current === "/" && (stat.mode & 0o222) === 0) ||
        (current === "/home" && stat.uid === 65534 && await readOnlyProtectedHome());
      if (!stat.isDirectory() || !trustedOwner || (stat.mode & 0o022) !== 0) {
        throw new Error("Unsafe ChatGPT credential lock ancestor.");
      }
    } finally { await ancestor.close(); }
    if (current === path.dirname(current)) break;
  }
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  let rootHandle;
  try { rootHandle = await fs.open(dataRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch { throw new Error("Unsafe ChatGPT credential lock data directory."); }
  try {
    const root = await rootHandle.stat();
    if (!root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o022) !== 0) {
      throw new Error("Unsafe ChatGPT credential lock data directory.");
    }
  } finally { await rootHandle.close(); }
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const dirHandle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    let dir = await dirHandle.stat();
    if (!dir.isDirectory() || dir.uid !== process.getuid()) throw new Error("Unsafe ChatGPT credential lock directory.");
    if ((dir.mode & 0o077) !== 0) await dirHandle.chmod(0o700);
    dir = await dirHandle.stat();
    if ((dir.mode & 0o077) !== 0) throw new Error("Unsafe ChatGPT credential lock directory.");
  } finally { await dirHandle.close(); }
  const handle = await fs.open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let anchor;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error("Unsafe ChatGPT credential lock file.");
    }
    // The OS account's home directory is a stable per-UID inode when its parent
    // and all ancestors cannot be renamed by this UID. Locking .openagi lets
    // another same-UID process rename that tree and enter on a new lock inode.
    const home = os.userInfo().homedir;
    for (let current = path.dirname(home); ; current = path.dirname(current)) {
      let ancestor;
      try { ancestor = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch { throw new Error("Unsafe ChatGPT credential lock anchor."); }
      try {
        const ancestorStat = await ancestor.stat();
        const readOnlyHome = current === "/home" && ancestorStat.uid === 65534 && await readOnlyProtectedHome();
        if (!isTrustedLockAnchorAncestor(current, ancestorStat, readOnlyHome)) {
          throw new Error("Unsafe ChatGPT credential lock anchor.");
        }
      } finally { await ancestor.close(); }
      if (current === path.dirname(current)) break;
    }
    try { anchor = await fs.open(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch { throw new Error("Unsafe ChatGPT credential lock anchor."); }
    const anchorStat = await anchor.stat();
    if (!anchorStat.isDirectory() || anchorStat.uid !== process.getuid() || (anchorStat.mode & 0o022) !== 0) {
      throw new Error("Unsafe ChatGPT credential lock anchor.");
    }
    // Descriptor-only flock acquires the lock on the inherited home-directory
    // open description. Node retains it for the full callback, even if the
    // private credential subtree is replaced while the callback is running.
    const child = spawn("/usr/bin/flock", ["-x", "-w", "20", "3"], {
      stdio: ["ignore", "ignore", "ignore", anchor.fd],
      env: { PATH: "/usr/bin:/bin" }
    });
    await new Promise((resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 23_000);
      child.once("error", () => { clearTimeout(timeout); reject(new Error("ChatGPT credential lock unavailable.")); });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) reject(new Error("ChatGPT credential lock timed out."));
        else if (code === 0) resolve();
        else reject(new Error("ChatGPT credential lock unavailable."));
      });
    });
    return await fn();
  } finally { if (anchor) await anchor.close(); await handle.close(); }
}
