// Exercise the published Windows archive, not a source checkout or repackaged build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

assert.equal(process.platform, 'win32');
const runtime = process.env.ACCEPTANCE_RUNTIME;
const require = createRequire(path.join(process.env.ACCEPTANCE_BROWSER, 'package.json'));
const { chromium } = require('playwright');
const evidence = path.resolve('acceptance-results');
fs.mkdirSync(evidence, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'openagi-windows-acceptance-'));
const checks = [];
const observations = [];
const record = name => { checks.push(name); console.log('PASS:', name); };
let child, browser, logs = '', fixtureRequests = 0;
// Deterministic Chat Completions server tests Windows transport and UI integration.
// This is deliberately not evidence of real local-model quality or inference.
const fixture = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
  const body = JSON.parse(raw);
  assert.equal(body.model, 'windows-acceptance-fixture');
  fixtureRequests++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'qa-completion', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Windows onboarding response received.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
const base = 'http://127.0.0.1:43479';
const launch = async () => {
  // cmd.exe resolves only Windows system programs: no separately installed Node/npm.
  child = spawn(process.env.ComSpec, ['/d', '/s', '/c', '""' + path.join(runtime, 'Start-OpenAGI.cmd') + '""'], {
    cwd: os.tmpdir(), windowsVerbatimArguments: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec, PATH: path.join(process.env.SystemRoot, 'System32'),
      TEMP: os.tmpdir(), TMP: os.tmpdir(), USERPROFILE: data, HOME: data,
      OPENAGI_DATA_DIR: data, OPENAGI_DISCOVERY: '0', HOST: '127.0.0.1', PORT: '43479' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let launchError;
  child.on('error', error => { launchError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { logs += value; });
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, 'CMD launcher must remain running');
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('CMD launcher did not become healthy');
};
const stop = async () => {
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    await exited;
  }
  child = null;
};
try {
  await launch();
  assert.equal((await (await fetch(base + '/health')).json()).firstRun, true);
  record('Published CMD launcher boots with spaces in path and no Node/npm on PATH');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('heading', { name: 'Choose your model', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/setup');
  await page.screenshot({ path: path.join(evidence, 'choose.png') });
  record('Fresh Windows browser opens deterministic model wizard');
  await page.getByRole('radio', { name: /Local model/ }).check();
  await page.getByRole('button', { name: 'Continue →', exact: true }).click();
  await page.getByLabel('Model server URL').fill('http://127.0.0.1:1/v1');
  await page.getByLabel('Installed model name').fill('windows-acceptance-fixture');
  await page.getByRole('button', { name: 'Connect & verify →' }).click();
  await page.locator('#output.error').waitFor();
  assert.equal(fs.existsSync(path.join(data, '.env')), false);
  record('Failed model connection remains recoverable and saves no configuration');
  await page.getByLabel('Model server URL').fill(modelUrl);
  await page.getByRole('button', { name: 'Connect & verify →' }).click();
  await page.getByRole('heading', { name: 'Your agent is ready.', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'ready.png') });
  record('Windows setup verifies Chat Completions fixture and saves configuration');
  await page.getByRole('link', { name: 'Meet your agent →' }).click();
  await page.getByRole('button', { name: 'Help me get my first useful result', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message your OpenAGI agent…' });
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(el => el.value.includes('Help me get started with OpenAGI')));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('paragraph').filter({ hasText: 'Windows onboarding response received.' }).first().waitFor();
  assert.ok(fixtureRequests >= 2, 'Both verification and chat reach the model endpoint');
  await page.screenshot({ path: path.join(evidence, 'chat.png') });
  record('Guided onboarding draft sends and displays fixture-backed chat reply');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const narrow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  observations.push({ name: '390px chat width (outside Windows desktop acceptance)', ...narrow, overflow: narrow.document > narrow.viewport });
  await page.screenshot({ path: path.join(evidence, 'narrow-chat.png'), fullPage: true });
  console.log('OBSERVATION:', JSON.stringify(narrow));
  await page.setViewportSize({ width: 1280, height: 900 });
  await stop();
  await launch();
  assert.equal((await (await fetch(base + '/health')).json()).firstRun, false);
  await page.reload();
  await page.getByRole('heading', { name: 'Chat', exact: true }).waitFor();
  await page.getByRole('listitem').filter({ hasText: 'Windows onboarding response received.' }).first().click();
  await page.getByRole('paragraph').filter({ hasText: 'Windows onboarding response received.' }).first().waitFor();
  assert.deepEqual(errors, []);
  record('CMD restart preserves setup, browser access and saved conversation');
} finally {
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ platform: process.platform, release: 'v0.0.66', checks, observations, fixtureRequests, inference: 'deterministic local HTTP fixture; not real model inference' }, null, 2));
  // Never upload saved auth, browser storage, or the generated data directory.
  fs.writeFileSync(path.join(evidence, 'launcher.log'), logs.replace(/(token[=: ]+)\S+/gi, '$1[redacted]'));
  await browser?.close();
  await stop();
  await new Promise(resolve => fixture.close(resolve));
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
