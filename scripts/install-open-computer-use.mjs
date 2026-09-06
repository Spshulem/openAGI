import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../src/data-dir.js";
import { OCU_VERSION } from "../src/integrations/open-computer-use-executor.js";

export const OCU_INTEGRITY = "A4xCoXgu+Mwi2OdhL15FHY/VcnhhxIJwRgSmC2LwX9mTya85VO2NZN8PNholvgQeTeOlPpej+eEucHXtPhhVrA==";
export function verifyOcuArchive(bytes) {
  if (crypto.createHash("sha512").update(bytes).digest("base64") !== OCU_INTEGRITY) throw new Error("Open Computer Use archive integrity mismatch; nothing installed.");
}
export async function installOpenComputerUse() {
  if (process.platform !== "darwin" || Number(os.release().split(".")[0]) < 23) throw new Error("This OpenAGI adapter currently requires macOS 14 or later.");
  const destination = path.join(resolveDataDir(), "tools", "open-computer-use", OCU_VERSION);
  if (fs.existsSync(destination)) throw new Error("This version's install directory already exists; inspect it rather than overwriting it.");
  const response = await fetch(`https://registry.npmjs.org/open-computer-use/-/open-computer-use-${OCU_VERSION}.tgz`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("Could not download the pinned Open Computer Use package.");
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 150 * 1024 * 1024) throw new Error("Open Computer Use archive exceeded its size limit.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks); verifyOcuArchive(bytes);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.mkdirSync(destination, { mode: 0o700 });
  const archive = path.join(destination, "upstream.tgz");
  fs.writeFileSync(archive, bytes, { mode: 0o600, flag: "wx" });
  // Exact, hash-verified archive. No npm lifecycle scripts, global agent config,
  // privileged installer, automatic enabling, or local build.
  execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", destination], { timeout: 60_000 });
  const app = path.join(destination, "package/dist/Open Computer Use.app");
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 15_000 });
  const binary = path.join(app, "Contents/MacOS/OpenComputerUse");
  fs.accessSync(binary, fs.constants.X_OK);
  return { version: OCU_VERSION, binary, enabled: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--install")) {
    console.log("Run with --install to download and verify Open Computer Use 0.3.3 into the OpenAGI data directory. Does not enable computer control or alter Codex/Claude configuration.");
  } else {
    try { console.log(JSON.stringify(await installOpenComputerUse(), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
