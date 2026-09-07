import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rawOrigins = process.argv.slice(2).filter(argument => argument !== '--')
const origins = [...new Set(rawOrigins.map(normalizeOrigin))]
if (origins.length > 16) fail('Agents packages support at most 16 exact origins.')
// Keep the generic policy generic; restricted packages need WSS to their main
// for relayed speech, plus the optional direct Deepgram destination.
// This does not add Deepgram to the app's separate main-server URL allowlist.
const networkOrigins = origins.length ? [...new Set([...origins, ...origins.map(origin => origin.replace(/^https:/, 'wss:')), 'https://api.deepgram.com', 'wss://api.deepgram.com'])] : []

run('pnpm', ['run', 'build'], {
  VITE_G2_MODE: 'openagi', VITE_OPENAGI_ORIGIN: origins[0] ?? '', VITE_AGENT_DEFAULT_ORIGIN: origins[0] ?? '',
  VITE_AGENT_ALLOWED_ORIGINS: origins.join(','),
})
const manifestDir = path.join(root, 'build', 'openagi-g2')
fs.mkdirSync(manifestDir, { recursive: true })
const manifestPath = path.join(manifestDir, 'app.json')
fs.writeFileSync(manifestPath, JSON.stringify({
  package_id: 'sh.agents.even.g2', edition: '202601', name: 'Agents', version: '0.4.3', min_app_version: '2.2.6', min_sdk_version: '0.0.13', entrypoint: 'index.html',
  permissions: [
    { name: 'g2-microphone', desc: 'Listen after you tap Ask or explicitly enable foreground always-listening.' },
    { name: 'network', desc: 'Connect to your selected agent. Optional live speech streams through your main or directly to Deepgram.', whitelist: networkOrigins },
  ], supported_languages: ['en'],
}, null, 2) + '\n')
run('pnpm', ['exec', 'evenhub', 'pack', manifestPath, path.join(root, 'dist')])

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function fail(message) { console.error(message); process.exit(1) }

function normalizeOrigin(value) {
  let origin
  try { origin = new URL(value) } catch { fail(`Agent origin is not a valid HTTPS URL: ${value}`) }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    fail(`Agent origin must be exact HTTPS with no path, query, or credentials: ${value}`)
  }
  return origin.origin
}
