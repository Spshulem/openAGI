import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

async function total(path) {
  const entries = await readdir(path)
  let bytes = 0
  for (const entry of entries) {
    const item = join(path, entry)
    const info = await stat(item)
    bytes += info.isDirectory() ? await total(item) : info.size
  }
  return bytes
}

const bytes = await total(fileURLToPath(new URL('../dist', import.meta.url)))
if (bytes > MAX_BYTES) {
  throw new Error(`Bundle is ${bytes} bytes; limit is ${MAX_BYTES}`)
}
console.log(`Bundle size: ${bytes} bytes`)
