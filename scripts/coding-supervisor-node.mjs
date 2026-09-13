import fs from 'node:fs';
import path from 'node:path';
import { createNodeControlWorker } from '../src/node-control.js';
import { createCodingNodeCapability } from '../src/coding-supervisor-node.js';

const configFile = process.argv[2];
if (!configFile || !path.isAbsolute(configFile)) throw new Error('Pass an absolute owner-only node configuration file.');
const stat = fs.statSync(configFile);
if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Node configuration must be owned by this user with mode 0600.');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (!path.isAbsolute(config.dataDir ?? '')) throw new Error('An absolute data directory is required.');
const node = createCodingNodeCapability(config);
const worker = createNodeControlWorker({ remote: config.remote, token: config.nodeToken, nodeId: config.nodeId,
  capabilities: async () => [node.capability], execute: command => node.execute(command) });
const heartbeat = async () => {
  try {
    const response = await fetch(new URL('/nodes/heartbeat', config.remote), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.nodeToken}`, 'x-openagi-node-id': config.nodeId },
      body: JSON.stringify({ nodeId: config.nodeId, name: config.name || 'Coding supervisor', role: 'node', platform: process.platform, capabilities: [node.capability] }) });
    if (!response.ok) console.error(`Coding node heartbeat refused (${response.status}).`);
  } catch { console.error('Coding node main connection unavailable.'); }
};
worker.start();
void heartbeat();
const timer = setInterval(heartbeat, 30000);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer); node.stop(); await worker.stop(); process.exit(0); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
console.log('Coding supervisor node started; outbound authenticated connection only.');
