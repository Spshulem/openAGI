import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rawOrigin = process.argv.slice(2).find(argument => argument !== '--') ?? process.env.OPENAGI_PUBLIC_ORIGIN
if (!rawOrigin) fail('Usage: pnpm package:openagi -- https://your-openagi-host')
let origin
try { origin = new URL(rawOrigin) } catch { fail('OpenAGI origin must be a valid HTTPS URL.') }
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') fail('OpenAGI origin must be one exact HTTPS origin with no path, query, or credentials.')
const normalizedOrigin = origin.origin

run('pnpm', ['run', 'build'], { VITE_G2_MODE: 'openagi', VITE_OPENAGI_ORIGIN: normalizedOrigin })
const manifestDir = path.join(root, 'build', 'openagi-g2')
fs.mkdirSync(manifestDir, { recursive: true })
const manifestPath = path.join(manifestDir, 'app.json')
fs.writeFileSync(manifestPath, JSON.stringify({
  package_id: 'sh.openagi.even.g2', edition: '202601', name: 'OpenAGI', version: '0.1.0', min_app_version: '2.0.0', min_sdk_version: '0.0.13', entrypoint: 'index.html',
  permissions: [
    { name: 'g2-microphone', desc: 'Listen to a spoken OpenAGI question only after you explicitly tap Ask.' },
    { name: 'network', desc: 'Send a spoken question to your paired OpenAGI and receive its answer.', whitelist: [normalizedOrigin] },
  ], supported_languages: ['en'],
}, null, 2) + '\n')
run('pnpm', ['exec', 'evenhub', 'pack', manifestPath, path.join(root, 'dist')])

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function fail(message) { console.error(message); process.exit(1) }
