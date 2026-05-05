import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function safeFilename(value) {
  return String(value ?? "default")
    .trim()
    .replaceAll(":", "_")
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJsonAtomic(filePath, value, mode = 0o600) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function writeTextAtomic(filePath, data, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, data, { mode });
  const fd = fs.openSync(tempPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

export function appendJsonLine(filePath, value, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const line = `${JSON.stringify(value)}\n`;
  const fd = fs.openSync(filePath, "a", mode);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function loadEnvFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  const loaded = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
    loaded[key] = value;
  }
  return loaded;
}
