/**
 * The credential pool: the only precious state this repository holds.
 *
 * A credential is bearer material -- `(prepared, signature)` under one epoch
 * key, single-use, and unrecognisable to the issuer that signed it. Three
 * consequences shape everything here:
 *
 * - **Losing the file loses money** that nobody can reissue. It is written
 *   atomically (temp + rename) so a crash mid-write cannot truncate it.
 * - **Copying the file duplicates spendable value.** Mode `0600`, and there is
 *   no backup path in this repository on purpose.
 * - **A take is destructive before it is useful.** `take` removes the credential
 *   and persists that removal *before* returning it. A crash in between loses
 *   one credential; the alternative risks presenting one serial twice, and a
 *   relay recording serials would read that as a double-spend by the one
 *   crawler whose whole pitch is that it is honest.
 *
 * The pool is shallow on purpose, and its floor is set by how long a supplier
 * can be unavailable rather than by how fast a refill completes -- see
 * `src/refusal.ts` for why an outage has to be waited out slowly.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Credential, KeyDocument } from './credentials.ts';
import type { BackoffState } from './refusal.ts';

/**
 * What the pool remembers between runs.
 *
 * `epoch` is the key document the held credentials were signed under. It is
 * stored rather than re-fetched because it is what makes them expire: every
 * credential is signed under exactly one epoch, and `not_after` is the cliff.
 */
export interface Pool {
  readonly epoch: KeyDocument | null;
  readonly credentials: readonly Credential[];
  /** Set while backing off a refusal; cleared by the purchase that succeeds. */
  readonly backoff: (BackoffState & { readonly until: string }) | null;
}

export const EMPTY: Pool = { epoch: null, credentials: [], backoff: null };

export function load(path: string): Pool {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw err;
  }
  // A pool file we cannot parse is not an empty pool. Treating it as one would
  // buy a fresh bundle and overwrite whatever was in there, which is the one
  // unrecoverable mistake available here.
  const parsed = JSON.parse(raw) as Pool;
  return { epoch: parsed.epoch ?? null, credentials: parsed.credentials ?? [], backoff: parsed.backoff ?? null };
}

/** Atomic: a reader either sees the whole previous pool or the whole new one. */
export function save(path: string, pool: Pool): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pool, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Whether the held epoch still covers `now`. An expired epoch makes every credential in it worthless. */
export function epochIsLive(pool: Pool, now: number): boolean {
  if (pool.epoch === null) return false;
  return now >= Date.parse(pool.epoch.not_before) && now < Date.parse(pool.epoch.not_after);
}

/** Credentials that are actually spendable right now. */
export function spendable(pool: Pool, now: number): readonly Credential[] {
  return epochIsLive(pool, now) ? pool.credentials : [];
}

export interface RefillPolicy {
  /** Buy when spendable credentials fall to this or below. */
  readonly lowWater: number;
  /**
   * Do not buy a bundle that would outlive its own epoch by less than this.
   *
   * Bundles are indivisible -- exactly `k` credentials at one price, no partial
   * bundle -- so buying `k` an hour before the epoch rolls is buying most of a
   * bundle's worth of nothing.
   */
  readonly minEpochRemainingMs: number;
}

export type RefillDecision =
  | { readonly buy: false; readonly why: string }
  | { readonly buy: true; readonly why: string };

/**
 * Whether this run should buy.
 *
 * Pure, and takes `now` as a parameter: the decision is entirely a function of
 * what is on disk and what time it is, which is what lets a CLI make it the
 * same way a daemon would.
 */
export function decideRefill(pool: Pool, policy: RefillPolicy, now: number): RefillDecision {
  if (pool.backoff !== null && now < Date.parse(pool.backoff.until)) {
    return { buy: false, why: `backing off ${pool.backoff.code} until ${pool.backoff.until}` };
  }

  const held = spendable(pool, now).length;
  if (held > policy.lowWater) {
    return { buy: false, why: `${held} credentials held, low-water is ${policy.lowWater}` };
  }

  // An epoch about to roll is the one case where an empty pool is still not a
  // reason to buy. We cannot know the NEXT epoch's key until the issuer
  // publishes it, so the honest move is to wait for it rather than spend on
  // credentials that die first.
  if (pool.epoch !== null && epochIsLive(pool, now)) {
    const remaining = Date.parse(pool.epoch.not_after) - now;
    if (remaining < policy.minEpochRemainingMs) {
      return { buy: false, why: `epoch ${pool.epoch.epoch_id} ends in ${remaining}ms` };
    }
  }

  return { buy: true, why: `${held} credentials held, at or below low-water ${policy.lowWater}` };
}

/**
 * Remove one credential and persist the removal, then return it.
 *
 * The write happens before the return, which is the whole point: this function
 * is allowed to lose a credential and is not allowed to hand the same one out
 * twice.
 */
export function take(path: string, now: number): Credential | null {
  const pool = load(path);
  const live = spendable(pool, now);
  if (live.length === 0) return null;

  const [head, ...rest] = live;
  save(path, { ...pool, credentials: rest });
  return head;
}
