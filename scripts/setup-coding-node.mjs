// Local provisioning: never store or print the main's owner credential. The
// enrollment helper receives the new node credential on stdin, not argv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BuiltinCodingSupervisor } from '../src/builtin-coding-supervisor.js';
const [configFile, remote, backendDir, workspace, ...helper] = process.argv.slice(2);
if (![configFile, workspace].every(value => typeof value === 'string' && path.isAbsolute(value)) || !helper.length) throw new Error('Absolute config and workspace paths plus an enrollment helper are required.');
const url = new URL(remote);
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('An HTTPS main origin is required.');
if (fs.existsSync(configFile)) throw new Error('Configuration already exists; do not overwrite a paired node.');
const dataDir = path.dirname(configFile);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(dataDir, 0o700);
const config = { dataDir, nodeId: crypto.randomUUID(), nodeToken: crypto.randomBytes(32).toString('base64url'), remote: url.origin,
  name: 'Mac coding supervisor', ...(backendDir && backendDir !== '-' ? { backendDir } : {}) };
const builtin = new BuiltinCodingSupervisor({ dataDir });
builtin.configure({ enabled: true, workspaces: [workspace] });
// Save before enrollment so an uncertain response cannot lose the credential.
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const result = execFileSync(helper[0], helper.slice(1), { input: JSON.stringify({ nodeId: config.nodeId, nodeToken: config.nodeToken }), encoding: 'utf8', timeout: 30000, maxBuffer: 4096 });
const enrollment = JSON.parse(result);
if (enrollment.enrolled !== true || enrollment.nodeId !== config.nodeId) throw new Error('Enrollment could not be confirmed. Retain the configuration; do not generate a new token.');
console.log(JSON.stringify({ enrolled: true, nodeId: config.nodeId, configFile }));
