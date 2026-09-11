/**
 * The one integration gate: tuzzy's buyer against the TOON sandbox.
 *
 * It buys a real bundle across a real **denomination boundary** — paying uUSDC
 * on a channel with the hub, which converts at a live Uniswap v3 TWAP and
 * forwards ANYONE to the issuing node. Nothing in tuzzy knows that happened,
 * and proving that is half the point: the price we read and the amount we pay
 * are both in our own money.
 *
 * Bring the far side up first, in a sibling `infra` checkout:
 *
 *   cd ../infra/sandbox && make up-credentials
 *
 * Deliberately NOT part of `npm test`. Everything tuzzy decides for itself is
 * tested with no chain and no containers; this gate exists for the one thing
 * that cannot be: the crossing.
 *
 * Exit codes follow the sandbox's own convention of saying WHICH SIDE failed:
 *
 *   0   tuzzy bought, banked, took and declined, all as it should
 *   1   tuzzy is wrong
 *   78  the sandbox is not there (EX_CONFIG) — not a tuzzy failure
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buy } from '../src/buy.ts';
import type { Config } from '../src/config.ts';
import { importEpochKey, suite } from '../src/credentials.ts';
import * as pool from '../src/pool.ts';

const EX_CONFIG = 78;

const HUB = process.env.HUB_URL ?? 'http://localhost:3200';
const ANYTOON_EDGE = process.env.ANYTOON_EDGE_URL ?? 'http://localhost:3230';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';

/** The hub's static quote for the crossing, in the client's own money. */
const HUB_PRICE = 11_000n;
const BUNDLE_SIZE = 10;

const REPO = dirname(dirname(new URL(import.meta.url).pathname));
const SANDBOX = process.env.SANDBOX_DIR ?? join(dirname(REPO), 'infra', 'sandbox');

/** Hermetic: never the operator's real pool, and thrown away after. */
const POOL = join(mkdtempSync(join(tmpdir(), 'tuzzy-e2e-')), 'pool.json');

const config: Config = {
  connector: HUB,
  // A forwarded route is opened at the far node, so the envelope is sealed to it.
  sealTo: ANYTOON_EDGE,
  // The key document is free at the issuing node's own edge, and priced by the
  // hub like any other route. Straight at the issuer, with no channel.
  keysConnector: ANYTOON_EDGE,
  keysChain: 'evm',
  bundlesRoute: 'g.anyone.credentials',
  keysRoute: 'g.anyone.credentials.keys',
  bundleSize: BUNDLE_SIZE,
  // Above the hub's quote, and not by much: a ceiling that cannot bind proves
  // nothing about the ceiling.
  priceCeiling: HUB_PRICE * 2n,
  pool: POOL,
  // THE SANDBOX'S OWN STORE, deliberately, and the reason is the lesson this
  // gate taught. The channel store holds a nonce watermark that is **not on
  // chain**: a fresh store against a live channel re-signs at a nonce the hub
  // has already banked, and every purchase is refused
  // `F01 ... nonce does not advance this channel's watermark (replay)`. The
  // client's own docs say it plainly -- never delete a channel store for a live
  // channel.
  //
  // The sandbox funds exactly one identity, so this gate is necessarily a second
  // client of that identity's channel, and the watermark has one home. The cost
  // is a rule rather than a mechanism: **do not run this concurrently with
  // `make smoke-credentials`**, because two writers to one watermark is the
  // hazard the file exists to prevent.
  channelStore: process.env.TUZZY_CHANNEL_STORE ?? join(SANDBOX, '.toon-client', 'channels.json'),
  // Low enough that the SECOND purchase must decline. With the default this run
  // would just buy again and the refill gate would go unproven.
  lowWater: 5,
  minEpochRemainingMs: 60_000,
  // The sandbox's client leg is mock USDC on a Solana payment_channel account;
  // production would be USDC on Base. Nothing in tuzzy cares which.
  chain: 'solana',
  rpcUrl: RPC_URL,
  mnemonic: 'test test test test test test test test test test test junk',
  evmPrivateKey: undefined,
  deposit: 10_000_000n,
  socksProxy: undefined,
  timeoutMs: 60_000,
};

function step(n: string): void {
  console.log(`\n── ${n}`);
}

/** `Outcome` carries bigints, and an assertion message is built eagerly. */
function show(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

// ── 0. is the far side even there? ────────────────────────────────────────
step('0. the sandbox is up');
for (const [name, url] of [['hub', HUB], ['anytoon-connector', ANYTOON_EDGE]] as const) {
  try {
    const res = await fetch(`${url}/ilp`, { signal: AbortSignal.timeout(5_000) });
    assert.ok(res.ok, `${name} answered ${res.status} on /ilp`);
  } catch (err) {
    console.error(
      `\n  ${name} is not answering at ${url}: ${(err as Error).message}\n\n` +
        '  This gate needs the TOON sandbox running the credentials profile:\n' +
        '      cd ../infra/sandbox && make up-credentials\n\n' +
        '  That is the sandbox missing, not tuzzy failing.\n',
    );
    process.exit(EX_CONFIG);
  }
  console.log(`  ✔ ${name} self-describes at ${url}`);
}

// ── 1. buy ────────────────────────────────────────────────────────────────
step('1. one bundle, bought across the denomination boundary');
const bought = await buy(config);
assert.equal(bought.kind, 'bought', `expected a purchase, got ${show(bought)}`);
assert.equal(bought.kind === 'bought' && bought.count, BUNDLE_SIZE);
assert.equal(
  bought.kind === 'bought' && bought.paid,
  HUB_PRICE,
  'the client pays the hub its advertised price, in the client\'s own money — the one exact number in this flow',
);
console.log(`  ✔ ${BUNDLE_SIZE} credentials for ${HUB_PRICE} uUSDC, epoch ${bought.kind === 'bought' && bought.epoch}`);

// ── 2. banked, and verifiable from the file alone ─────────────────────────
step('2. the pool holds them, and they verify from what was persisted');
const banked = pool.load(POOL);
assert.equal(pool.spendable(banked, Date.now()).length, BUNDLE_SIZE);
assert.ok(banked.epoch !== null);
const epochKey = await importEpochKey(banked.epoch);
for (const credential of banked.credentials) {
  assert.ok(
    await suite.verify(
      epochKey,
      new Uint8Array(Buffer.from(credential.signature, 'base64')),
      new Uint8Array(Buffer.from(credential.prepared, 'base64')),
    ),
    'a banked credential must verify under the epoch key, using only the two halves on disk',
  );
}
console.log(`  ✔ all ${BUNDLE_SIZE} verify under epoch ${banked.epoch.epoch_id}`);

// ── 3. take is destructive, and persists that before returning ────────────
step('3. take hands one out exactly once');
const taken = pool.take(POOL, Date.now());
assert.ok(taken !== null);
assert.equal(pool.load(POOL).credentials.length, BUNDLE_SIZE - 1, 'the removal is on disk, not just returned');
assert.ok(
  !pool.load(POOL).credentials.some((c) => c.signature === taken.signature),
  'and the credential that left is gone',
);
console.log('  ✔ one out, nine left, the departure recorded before it left');

// ── 4. the refill gate actually gates ─────────────────────────────────────
step('4. a pool above its low-water mark does not buy again');
const second = await buy(config);
assert.equal(second.kind, 'declined', `expected a decline, got ${show(second)}`);
console.log(`  ✔ declined: ${second.kind === 'declined' && second.why}`);

console.log('\n  tuzzy bought across the boundary, banked, took and declined. Nothing here knew about ANYONE.\n');
