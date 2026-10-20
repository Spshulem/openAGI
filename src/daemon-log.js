import fs from "node:fs";
import path from "node:path";

export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

// The Mac parent opens the shared stdout/stderr file with O_APPEND. Keep that
// descriptor/inode alive (including after a parent crash), retaining bounded
// tails rather than replacing it with a pipe or renaming its active file.
// This is best-effort diagnostic retention, not a transactional audit journal.
export function rotateDaemonLog({ logPath, fd = 2, maxBytes = DAEMON_LOG_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return false;
  try {
    const target = fs.lstatSync(logPath);
    const active = fs.fstatSync(fd);
    if (!target.isFile() || !active.isFile() || target.dev !== active.dev || target.ino !== active.ino) return false;
    if (active.size < maxBytes) return false;

    // Read only the newest bounded tail even when an old install left a huge
    // file. O_NOFOLLOW prevents archive symlinks redirecting private logs.
    const tail = Buffer.alloc(Math.min(maxBytes, active.size));
    const readFd = fs.openSync(logPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let length;
    try {
      const source = fs.fstatSync(readFd);
      if (source.dev !== active.dev || source.ino !== active.ino) return false;
      length = fs.readSync(readFd, tail, 0, tail.length, Math.max(0, source.size - tail.length));
    } finally { fs.closeSync(readFd); }

    for (let index = 3; index >= 2; index--) {
      const previous = `${logPath}.${index - 1}`;
      if (fs.existsSync(previous)) fs.renameSync(previous, `${logPath}.${index}`);
    }
    const archive = fs.openSync(`${logPath}.1`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(archive, 0o600);
      fs.writeFileSync(archive, tail.subarray(0, length));
    } finally { fs.closeSync(archive); }
    fs.ftruncateSync(fd, 0);
    return true;
  } catch { return false; }
}

let installed = false;
export function installDaemonLogRotation(dataDir) {
  if (installed || process.env.OPENAGI_MANAGED_DAEMON_LOG !== "1") return;
  installed = true;
  const rotate = () => rotateDaemonLog({ logPath: path.join(dataDir, "daemon.log") });
  rotate();
  const timer = setInterval(rotate, 30_000);
  timer.unref();
}
