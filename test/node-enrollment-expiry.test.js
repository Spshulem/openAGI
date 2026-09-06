import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeEnrollmentCodes } from '../src/node-enrollment.js';

test('G2 codes last thirty minutes and remain single use', () => {
  const codes = new NodeEnrollmentCodes({ platforms: ['even_g2'] });
  const issued = codes.issue('even_g2', { now: 0 });
  assert.equal(Date.parse(issued.expiresAt), 30 * 60 * 1000);
  assert.equal(codes.consume(issued.code, 'even_g2', { now: 29 * 60 * 1000 }).ok, true);
  assert.equal(codes.consume(issued.code, 'even_g2', { now: 29 * 60 * 1000 }).ok, false);
  const next = codes.issue('even_g2', { now: 0 });
  assert.equal(codes.consume(next.code, 'even_g2', { now: 30 * 60 * 1000 + 1 }).reason, 'expired');
});
