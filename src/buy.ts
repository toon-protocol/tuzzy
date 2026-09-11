/**
 * One purchase attempt, start to finish.
 *
 * The shape of the flow is fixed by the issuer: the epoch key document is free
 * and has to come first (a buyer cannot blind anything without it), then `k`
 * blanks are blinded, then one paid request buys their signatures, then they are
 * unblinded and verified before anything is banked.
 *
 * Two things about paying that are easy to get wrong and expensive to learn:
 *
 * - **A refusal is still paid for.** Payment is per attempt (connector ADR
 *   0042): the covering claim rides with the packet and a reject does not refund
 *   it. So this module never retries inside a run -- it classifies, records the
 *   backoff, and returns. The timer decides when to come back.
 * - **A paid 4xx is a real answer.** A non-201 from the issuer rides home on a
 *   FULFILL and costs exactly what a 201 costs. It is reported as a failure that
 *   was charged for, never as a free one.
 */
import { ToonClient } from '@toon-protocol/client';

import type { Config } from './config.ts';
import { blindBlanks, finalizeCredentials, importEpochKey, type KeyDocument } from './credentials.ts';
import * as pool from './pool.ts';
import { classify, type Action } from './refusal.ts';

export type Outcome =
  | { readonly kind: 'bought'; readonly count: number; readonly paid: bigint; readonly epoch: string }
  | { readonly kind: 'declined'; readonly why: string }
  | { readonly kind: 'refused'; readonly code: string; readonly action: Action; readonly refusedBy?: string }
  /** Our own fault, or the issuer's -- not a payment outcome. */
  | { readonly kind: 'broken'; readonly why: string };

/** Records a wait on disk, because a CLI has nowhere else to keep it. */
function recordBackoff(config: Config, code: string, action: Action, now: number): void {
  const current = pool.load(config.pool);
  if (action.kind !== 'wait') {
    // `stop` and `resize` are not waits: a human has to act, and a backoff
    // timestamp would quietly turn "this is broken" into "try again later".
    pool.save(config.pool, { ...current, backoff: null });
    return;
  }
  const attempts = current.backoff?.code === code ? current.backoff.attempts + 1 : 1;
  pool.save(config.pool, {
    ...current,
    backoff: { code, attempts, until: new Date(now + action.retryAfterMs).toISOString() },
  });
}

export async function buy(config: Config, now = Date.now()): Promise<Outcome> {
  if (config.priceCeiling < 0n) {
    return { kind: 'broken', why: 'TUZZY_PRICE_CEILING is unset; refusing to buy at any price' };
  }

  const held = pool.load(config.pool);
  const decision = pool.decideRefill(
    held,
    { lowWater: config.lowWater, minEpochRemainingMs: config.minEpochRemainingMs },
    now,
  );
  if (!decision.buy) return { kind: 'declined', why: decision.why };

  const client = await ToonClient.create({
    connector: config.connector,
    mnemonic: config.mnemonic,
    evmPrivateKey: config.evmPrivateKey,
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    channelStore: config.channelStore,
    deposit: config.deposit,
    autoOpenChannel: true,
    timeoutMs: config.timeoutMs,
    // Present only for a hidden-service connector. When it is, the client sends
    // chain RPC through it too by default, which is the point: reading chain
    // state on the clearnet would announce our settlement address either side of
    // every paid request.
    ...(config.socksProxy === undefined ? {} : { socksProxy: config.socksProxy }),
  });

  const sealed = config.sealTo === undefined ? undefined : { sealTo: config.sealTo };

  // The key document is free at the ISSUING node's own edge and priced like any
  // other route through a hub. When those are different nodes, a second client
  // with no channel and nothing to spend is the honest way to the free one --
  // and it proves the route really is free, because this client cannot pay.
  const direct = config.keysConnector === config.connector;
  const keysClient = direct
    ? client
    : await ToonClient.create({
        connector: config.keysConnector,
        mnemonic: config.mnemonic,
        evmPrivateKey: config.evmPrivateKey,
        chain: config.keysChain,
        rpcUrl: config.rpcUrl,
        channelStore: `${config.channelStore}.keys`,
        deposit: 0n,
        timeoutMs: config.timeoutMs,
        ...(config.socksProxy === undefined ? {} : { socksProxy: config.socksProxy }),
      });

  try {
    // --- 1. The epoch key document -----------------------------------------
    // No `sealTo`: this route terminates at the node we are asking.
    const keys = await keysClient.send(config.keysRoute, { method: 'GET', target: 'current' });
    if (!keys.fulfilled) {
      const action = classify(keys.code ?? '', held.backoff ?? undefined);
      recordBackoff(config, keys.code ?? '', action, now);
      return { kind: 'refused', code: keys.code ?? '(none)', action, refusedBy: keys.refusedBy };
    }
    if (keys.status !== 200) {
      return { kind: 'broken', why: `key document returned HTTP ${keys.status}: ${keys.text()}` };
    }

    const doc = keys.json() as KeyDocument;
    let publicKey: CryptoKey;
    try {
      publicKey = await importEpochKey(doc);
    } catch (err) {
      return { kind: 'broken', why: `unusable epoch key: ${(err as Error).message}` };
    }

    // Re-decide against the epoch we actually got. The pool's own copy may be a
    // previous epoch, in which case "how long until the cliff" was the wrong
    // question a moment ago and is the right one now.
    const rescored = pool.decideRefill(
      { ...held, epoch: doc },
      { lowWater: config.lowWater, minEpochRemainingMs: config.minEpochRemainingMs },
      now,
    );
    if (!rescored.buy) return { kind: 'declined', why: rescored.why };

    // --- 2. The price, from the node, against our ceiling -------------------
    const quoted = await client.price(config.bundlesRoute);
    if (quoted === null || quoted === undefined) {
      return { kind: 'broken', why: `${config.connector} quotes no price for ${config.bundlesRoute}` };
    }
    const price = BigInt(typeof quoted === 'object' ? ((quoted as { base?: unknown }).base ?? 0) : quoted);
    if (price > config.priceCeiling) {
      // Honor-or-skip, applied to our own supplier. Skipping is a real outcome
      // and has to stay cheap to reach.
      return {
        kind: 'declined',
        why: `${config.bundlesRoute} quotes ${price}, above the ceiling ${config.priceCeiling}`,
      };
    }

    // --- 3. Blind, and pay --------------------------------------------------
    const blanks = await blindBlanks(publicKey, config.bundleSize);
    const answer = await client.send(
      config.bundlesRoute,
      {
        method: 'POST',
        target: 'v1/bundles',
        headers: {
          'content-type': 'application/json',
          // Rides through the connector and the minter untouched, so a retry
          // after a timeout returns the same bundle rather than buying a second.
          'idempotency-key': crypto.randomUUID(),
        },
        body: { epoch: doc.epoch_id, blinded_blanks: blanks.map((b) => b.blinded) },
      },
      sealed,
    );

    if (!answer.fulfilled) {
      const code = answer.code ?? '';
      const action = classify(code, held.backoff ?? undefined);
      recordBackoff(config, code, action, now);
      return { kind: 'refused', code: code || '(none)', action, refusedBy: answer.refusedBy };
    }
    const paid = BigInt(answer.claim?.amount ?? 0);
    if (answer.status !== 201 && answer.status !== 200) {
      return {
        kind: 'broken',
        why: `issuance failed and was still charged ${paid}: HTTP ${answer.status} ${answer.text()}`,
      };
    }

    // --- 4. Unblind, verify, bank ------------------------------------------
    const { epoch, blind_signatures } = answer.json() as {
      epoch: string;
      blind_signatures: string[];
    };
    let credentials;
    try {
      credentials = await finalizeCredentials(publicKey, blanks, blind_signatures);
    } catch (err) {
      // Paid for and unusable. Loud, and not a backoff: retrying buys another
      // bundle from a stack that is answering wrongly.
      return { kind: 'broken', why: `bundle paid for (${paid}) but does not verify: ${(err as Error).message}` };
    }

    // Re-read rather than reusing `held`: this run has been talking to a network
    // and the only safe assumption is that the file is whatever it is now.
    const latest = pool.load(config.pool);
    const keep = latest.epoch?.epoch_id === doc.epoch_id ? latest.credentials : [];
    pool.save(config.pool, {
      epoch: doc,
      credentials: [...keep, ...credentials],
      backoff: null,
    });

    return { kind: 'bought', count: credentials.length, paid, epoch };
  } finally {
    await client.close();
    if (!direct) await keysClient.close();
  }
}
