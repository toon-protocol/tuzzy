import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { KeyDocument } from '../src/credentials.ts';
import { EMPTY, decideRefill, load, save, spendable, take } from '../src/pool.ts';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const HOUR = 3_600_000;

function poolPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tuzzy-')), 'data', 'pool.json');
}

function epoch(notAfter: number): KeyDocument {
  return {
    epoch_id: 'e1',
    not_before: new Date(NOW - HOUR).toISOString(),
    not_after: new Date(notAfter).toISOString(),
    alg: 'RSABSSA-SHA384-PSS-Randomized',
    pubkey: 'not-a-real-key',
  };
}

const POLICY = { lowWater: 2, minEpochRemainingMs: HOUR };

function withCredentials(n: number, notAfter = NOW + 24 * HOUR) {
  return {
    epoch: epoch(notAfter),
    credentials: Array.from({ length: n }, (_, i) => ({ prepared: `p${i}`, signature: `s${i}` })),
    backoff: null,
  };
}

test('a missing pool file is an empty pool, not an error', () => {
  assert.deepEqual(load(poolPath()), EMPTY);
});

test('the pool file is written 0600, because it is bearer material', () => {
  const path = poolPath();
  save(path, withCredentials(1));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('take persists the removal BEFORE returning, so the same credential never goes out twice', () => {
  const path = poolPath();
  save(path, withCredentials(2));

  const first = take(path, NOW);
  assert.equal(first?.signature, 's0');
  // The proof is on disk, not in the return value: a crash here must not be
  // able to hand s0 out again.
  assert.equal(load(path).credentials.length, 1);

  assert.equal(take(path, NOW)?.signature, 's1');
  assert.equal(take(path, NOW), null);
});

test('credentials whose epoch has ended are not spendable, and take refuses them', () => {
  const path = poolPath();
  save(path, withCredentials(3, NOW - 1));

  assert.equal(spendable(load(path), NOW).length, 0);
  assert.equal(take(path, NOW), null);
});

test('a pool above its low-water mark does not buy', () => {
  const decision = decideRefill(withCredentials(5), POLICY, NOW);
  assert.equal(decision.buy, false);
});

test('a pool at or below its low-water mark buys', () => {
  assert.equal(decideRefill(withCredentials(2), POLICY, NOW).buy, true);
  assert.equal(decideRefill(EMPTY, POLICY, NOW).buy, true);
});

test('an active backoff blocks the purchase even with an empty pool', () => {
  const pool = {
    ...EMPTY,
    backoff: { code: 'T00', attempts: 1, until: new Date(NOW + 60_000).toISOString() },
  };
  assert.equal(decideRefill(pool, POLICY, NOW).buy, false);
  // And releases once it expires.
  assert.equal(decideRefill(pool, POLICY, NOW + 61_000).buy, true);
});

test('an epoch about to roll blocks the purchase: a bundle is indivisible and would die with it', () => {
  const decision = decideRefill(withCredentials(0, NOW + 60_000), POLICY, NOW);
  assert.equal(decision.buy, false);
  assert.match(decision.why, /epoch e1 ends in/);
});
