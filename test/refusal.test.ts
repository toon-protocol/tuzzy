import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FIRST_WAIT_MS, MAX_WAIT_MS, classify, waitFor } from '../src/refusal.ts';

test('a stale rate is worth retrying, and the class letter says so', () => {
  const action = classify('T00');
  assert.equal(action.kind, 'wait');
  assert.equal(action.kind === 'wait' && action.retryAfterMs, FIRST_WAIT_MS);
});

test('an undeclared rate is not worth retrying, because config cannot change under it', () => {
  assert.equal(classify('F02').kind, 'stop');
});

test('the two arithmetic refusals give OPPOSITE instructions and are never collapsed', () => {
  const tooBig = classify('T04');
  const tooSmall = classify('R01');
  assert.equal(tooBig.kind === 'resize' && tooBig.direction, 'smaller');
  assert.equal(tooSmall.kind === 'resize' && tooSmall.direction, 'larger');
});

test('backing off the same code lengthens the wait; a different code starts over', () => {
  const second = classify('T00', { code: 'T00', attempts: 1 });
  assert.equal(second.kind === 'wait' && second.retryAfterMs, FIRST_WAIT_MS * 2);

  // A T00 after some other refusal is a fresh outage, not a continuing one.
  const fresh = classify('T00', { code: 'T01', attempts: 9 });
  assert.equal(fresh.kind === 'wait' && fresh.retryAfterMs, FIRST_WAIT_MS);
});

test('the wait is capped: a long outage settles into a slow knock', () => {
  assert.equal(waitFor(100), MAX_WAIT_MS);
});

test('an unrecognised code falls back to its class letter, and never to "keep paying"', () => {
  assert.equal(classify('T99').kind, 'wait');
  assert.equal(classify('F99').kind, 'stop');
  assert.equal(classify('R99').kind, 'stop');
  assert.equal(classify('').kind, 'stop');
});
