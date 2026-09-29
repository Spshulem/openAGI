import fs from "node:fs";
import path from "node:path";

const BWRAP = "/usr/bin/bwrap";

export function buildCodexSandboxLaunch({ pin, profileDir, profileFd, args, relayFd = null }) {
  if (process.platform !== "linux" || !pin?.fd || !Number.isInteger(profileFd)
    || !Array.isArray(args) || !path.isAbsolute(profileDir)) {
    throw new Error("Codex Linux sandbox requires pinned executable and profile descriptors.");
  }
  if (!fs.fstatSync(profileFd).isDirectory() || fs.realpathSync(profileDir) !== profileDir) {
    throw new Error("Codex sandbox profile must be a real directory.");
  }
  if (relayFd !== null && (!Number.isInteger(relayFd) || relayFd < 0)) {
    throw new Error("Codex relay requires a pinned script descriptor.");
  }
  const mounts = ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib64", "/lib64"];
  if (fs.existsSync("/etc/pki")) mounts.push("--ro-bind", "/etc/pki", "/etc/pki");
  return {
    command: BWRAP,
    args: [
      "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
      "--setenv", "PATH", "/usr/bin",
      "--setenv", "LANG", "C.UTF-8",
      "--setenv", "CODEX_HOME", "/profile",
      "--setenv", "HOME", "/profile/home",
      "--setenv", "TMPDIR", "/profile/tmp",
      "--setenv", "XDG_CONFIG_HOME", "/profile/xdg-config",
      "--setenv", "XDG_DATA_HOME", "/profile/xdg-data",
      ...mounts,
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--dir", "/opt", "--ro-bind-fd", "3", "/opt/codex",
      ...(relayFd === null ? [] : ["--ro-bind-fd", "4", "/opt/relay.py"]),
      "--bind-fd", "5", "/profile",
      "--chdir", "/profile/work",
      ...(relayFd === null ? ["/opt/codex"] : ["/usr/bin/python3", "/opt/relay.py"]), ...args
    ],
    cwd: "/",
    env: { PATH: "/usr/bin", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe", pin.fd, relayFd ?? "ignore", profileFd]
  };
}
