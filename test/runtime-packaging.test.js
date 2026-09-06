import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
test('distributions install locked production dependencies and ship the supervisor adapter', () => {
  const mac = read('scripts/build-mac-app.sh');
  assert.match(mac, /"\$\{ROOT\}\/scripts"/);
  assert.match(mac, /"\$\{ROOT\}\/package-lock.json"/);
  assert.match(mac, /npm ci --omit=dev --ignore-scripts/);
  const docker = read('Dockerfile');
  assert.equal((docker.match(/npm ci --omit=dev --ignore-scripts/g) || []).length, 2);
  assert.match(docker, /COPY --chown=openagi:openagi scripts .\/scripts/);
  assert.match(read('scripts/install.sh'), /npm ci --omit=dev --ignore-scripts/);
  assert.equal((read('scripts/update.sh').match(/npm ci --omit=dev --ignore-scripts/g) || []).length, 3);
});
