#!/usr/bin/env node
// Package only distributable inputs. Never archive a checkout or user state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["bin", "src", "examples", "scripts", "assets", "package.json", "package-lock.json", "LICENSE", "README.md", "docs/INSTALL.md", "docs/GETTING_STARTED.md"];

export function packageRuntime({ root = ROOT, destination, nodeExecutable = process.execPath, nodeLicense, platform = process.platform, arch = process.arch } = {}) {
  if (!["linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error("Unsupported portable runtime platform/architecture");
  if (!destination || !nodeLicense) throw new Error("destination and the matching Node.js LICENSE are required");
  const out = path.resolve(destination);
  // mkdir without recursive on the final directory refuses accidental reuse.
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(out);
  const copy = (source, relative) => {
    const target = path.join(out, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
  };
  for (const entry of ENTRIES) copy(path.join(root, entry), entry);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  // npm ci --omit=dev must have run in the clean release checkout first.
  // Copy the production graph, including dependency license files.
  copy(path.join(root, "node_modules"), "node_modules");
  const binary = platform === "win32" ? "node/node.exe" : "node/node";
  copy(nodeExecutable, binary);
  copy(nodeLicense, "node/LICENSE");
  if (platform === "win32") {
    fs.writeFileSync(path.join(out, "Start-OpenAGI.cmd"), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\necho Open http://127.0.0.1:43210/ in your browser after the server starts.\r\necho Keep this window open. Press Ctrl+C to stop.\r\n"%~dp0node\\node.exe" "%~dp0bin\\openagi.js" serve\r\nif errorlevel 1 pause\r\n');
  } else {
    fs.chmodSync(path.join(out, binary), 0o755);
    fs.writeFileSync(path.join(out, "start-openagi.sh"), '#!/bin/sh\nset -eu\nRUNTIME_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\ncd "$RUNTIME_DIR"\nprintf "%s\\n" "Open http://127.0.0.1:43210/ in your browser after the server starts." "Keep this terminal open. Press Ctrl+C to stop."\nexec "$RUNTIME_DIR/node/node" "$RUNTIME_DIR/bin/openagi.js" serve\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(out, "START_HERE.txt"), `OpenAGI ${pkg.version}\n\nWindows: extract the entire ZIP, then double-click Start-OpenAGI.cmd.\nLinux: extract the archive, then run ./start-openagi.sh in a terminal.\nOpen http://127.0.0.1:43210/ and connect your own model in Settings.\nKeep the terminal open; Ctrl+C stops the agent. No administrator account, Node installation, or npm command is needed.\n\nState is stored separately in ~/.openagi (Windows: %USERPROFILE%\\.openagi).\nAfter changing setup, restart the launcher if asked, then return to Get started.\nSee docs/INSTALL.md and docs/GETTING_STARTED.md.\nThis is the browser/CLI runtime; macOS screen capture and native computer control are separate features.\nLicense: LICENSE. Node.js and bundled dependency notices are in node/LICENSE and node_modules.\n`);
  const nodeSha256 = createHash("sha256").update(fs.readFileSync(nodeExecutable)).digest("hex");
  const manifest = { version: pkg.version, platform, arch, nodeVersion: process.version, nodeSha256 };
  fs.writeFileSync(path.join(out, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { directory: out, ...manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes("--out") || !args.includes("--node-license")) throw new Error("Usage: node scripts/package-runtime.mjs --out <new directory> --node-license <file>");
  console.log(JSON.stringify(packageRuntime({ destination: value("--out"), nodeLicense: value("--node-license") })));
}
