#!/usr/bin/env node
/**
 * tuzzy — buys Anyone Protocol circuit credentials over TOON, in USDC.
 *
 *   tuzzy buy      decide whether to buy, and if so buy once
 *   tuzzy take     hand out one credential, marked spent before it leaves
 *   tuzzy status   what is held, and whether a purchase is due
 *
 * **Exit codes are the interface**, because the caller is a timer and not a
 * person. They distinguish the three things an operator would do differently:
 *
 *   0   did what was asked, including correctly deciding not to buy
 *   1   this stack is wrong -- our config, or an answer that does not verify
 *   69  a human has to change something before this can work (EX_UNAVAILABLE)
 *   75  temporary; the next tick will do (EX_TEMPFAIL)
 *
 * The 69/75 split is the one that matters. `F02` -- a hop with no declared rate
 * for the crossing -- cannot clear while that process runs, so retrying it on a
 * timer spends a covering claim every tick for nothing. `T00` clears on its own.
 */
import { buy } from './buy.ts';
import { fromEnv } from './config.ts';
import * as pool from './pool.ts';

const EX_UNAVAILABLE = 69;
const EX_TEMPFAIL = 75;

function fail(message: string, code: number): never {
  console.error(`\n  ${message}\n`);
  process.exit(code);
}

const command = process.argv[2] ?? 'status';

let config;
try {
  config = fromEnv();
} catch (err) {
  fail((err as Error).message, 1);
}

switch (command) {
  case 'buy': {
    const outcome = await buy(config);
    switch (outcome.kind) {
      case 'bought':
        console.log(
          `bought ${outcome.count} credentials under epoch ${outcome.epoch} for ${outcome.paid} base units`,
        );
        break;
      case 'declined':
        console.log(`not buying: ${outcome.why}`);
        break;
      case 'refused': {
        const where = outcome.refusedBy === undefined ? '' : ` by ${outcome.refusedBy}`;
        const detail = `${outcome.code}${where} — ${outcome.action.why}`;
        if (outcome.action.kind === 'wait') {
          // Loud enough to notice in a log, quiet enough not to page: this is
          // the supplier's outage, and the pool is sized to ride it out.
          console.error(`refused ${detail}; waiting ${Math.round(outcome.action.retryAfterMs / 1000)}s`);
          process.exit(EX_TEMPFAIL);
        }
        fail(`refused ${detail}`, EX_UNAVAILABLE);
      }
      case 'broken':
        fail(outcome.why, 1);
    }
    break;
  }

  case 'take': {
    const credential = pool.take(config.pool, Date.now());
    if (credential === null) {
      // Temporary on purpose: an empty pool is what `buy` exists to fix, and a
      // consumer that sees this should ask again rather than give up.
      fail('the pool holds no spendable credential', EX_TEMPFAIL);
    }
    // stdout is the interface, and it carries the whole credential: `prepared`
    // is what a verifier checks the signature against and is not recoverable
    // from the signature alone.
    console.log(JSON.stringify(credential));
    break;
  }

  case 'status': {
    const held = pool.load(config.pool);
    const now = Date.now();
    const live = pool.spendable(held, now).length;
    const decision = pool.decideRefill(
      held,
      { lowWater: config.lowWater, minEpochRemainingMs: config.minEpochRemainingMs },
      now,
    );
    console.log(
      JSON.stringify(
        {
          pool: config.pool,
          epoch: held.epoch?.epoch_id ?? null,
          epochEnds: held.epoch?.not_after ?? null,
          epochLive: pool.epochIsLive(held, now),
          spendable: live,
          // Deliberately distinct from `spendable`: credentials held under a
          // dead epoch are still on disk and are worth nothing.
          onDisk: held.credentials.length,
          lowWater: config.lowWater,
          backoff: held.backoff,
          wouldBuy: decision.buy,
          why: decision.why,
        },
        null,
        2,
      ),
    );
    break;
  }

  default:
    fail(`unknown command "${command}" — try buy, take or status`, 1);
}
