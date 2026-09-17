import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const suspicious = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|client[_-]?secret|refresh[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i,
  /Authorization\s*:\s*["']Bearer\s+[A-Za-z0-9._-]{20,}/i,
]

async function files(path) {
  const result = []
  for (const entry of await readdir(path)) {
    const item = join(path, entry)
    const info = await stat(item)
    if (info.isDirectory()) result.push(...(await files(item)))
    else result.push(item)
  }
  return result
}

const findings = []
for (const file of await files(fileURLToPath(new URL('../dist', import.meta.url)))) {
  const text = await readFile(file, 'utf8').catch(() => '')
  if (suspicious.some(pattern => pattern.test(text))) findings.push(file)
}
if (findings.length) throw new Error(`Potential secret material in: ${findings.join(', ')}`)
console.log('Packaged secret scan passed')
