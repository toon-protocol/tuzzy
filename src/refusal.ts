/**
 * What to do about a refused packet.
 *
 * A refusal is not an error here, it is an instruction, and acting on the wrong
 * one costs money: **payment is per attempt** (connector ADR 0042). A packet
 * arrives with its covering claim, and a refusal does not refund it -- so a
 * retry is a purchase, and a hot retry loop against a refusal that will never
 * clear is a way to spend a channel down to nothing while achieving nothing.
 *
 * Four codes matter to a buyer paying across a denomination boundary, and
 * connector ADR 0071 makes them deliberately distinguishable:
 *
 * - `T00` the hop's rate is **stale**: its own poller fell behind. Nothing about
 *   the packet or the path is wrong, staleness is an outage on purpose, and the
 *   `T` class is the instruction -- retry. Just not immediately, and not often.
 * - `F02` the hop has **no declared rate** for the crossing. Final, because a
 *   declaration is config and config is immutable for the process lifetime
 *   (ADR 0009): this path cannot start working while that process runs.
 * - `T04` the converted amount **exceeds the outgoing leg's `u64`** -- ADR 0071's
 *   real ceiling, ~18.4 tokens on an 18-decimal leg. Send less.
 * - `R01` the **fee alone exceeds** the converted amount. Send more.
 *
 * `T04` and `R01` are opposite instructions, which is why the connector reports
 * them as different codes and why this module refuses to collapse them: telling
 * a sender to send more when it must send less is worse than saying nothing.
 */

/** What the caller should do next. */
export type Action =
  /** Try again later. `retryAfterMs` says how much later. */
  | { readonly kind: 'wait'; readonly retryAfterMs: number; readonly why: string }
  /** This path will not work. Stop asking; a human has to change something. */
  | { readonly kind: 'stop'; readonly why: string }
  /** The amount was wrong in the named direction. */
  | { readonly kind: 'resize'; readonly direction: 'smaller' | 'larger'; readonly why: string };

/** How many consecutive refusals we have already backed off through. */
export interface BackoffState {
  readonly code: string;
  readonly attempts: number;
}

/**
 * First delay, and the ceiling.
 *
 * The floor is not "as fast as possible". A stale rate clears when the hop's
 * poller recovers or its next observation lands, which is a cadence measured in
 * the operator's `ttl` -- seconds to minutes, never milliseconds -- and every
 * attempt in between is paid for. The ceiling exists so a long outage settles
 * into a slow knock rather than an ever-lengthening silence: the pool is sized
 * to ride the outage out, so there is no value in waiting longer than this.
 */
export const FIRST_WAIT_MS = 15_000;
export const MAX_WAIT_MS = 10 * 60_000;

/** Exponential, capped, deterministic: `attempts` is read from disk, so this is a pure function. */
export function waitFor(attempts: number): number {
  const doubled = FIRST_WAIT_MS * 2 ** Math.max(0, attempts);
  return Math.min(doubled, MAX_WAIT_MS);
}

/**
 * Classify a refusal into the one action it licenses.
 *
 * `prior` is the backoff already accumulated, read from the pool file -- a CLI
 * has no memory between runs, so the disk is the only place this can live.
 * An unrecognised code falls back to its **class letter**, which is the part of
 * the code the protocol guarantees a meaning for: `T` temporary, `F` final,
 * `R` the sender must change something.
 */
export function classify(code: string, prior?: BackoffState): Action {
  const attempts = prior?.code === code ? prior.attempts : 0;

  switch (code) {
    case 'T00':
      return {
        kind: 'wait',
        retryAfterMs: waitFor(attempts),
        why: "the hop's rate is stale; its poller has to catch up",
      };
    case 'F02':
      return {
        kind: 'stop',
        why: 'the hop declares no rate for this crossing, and config is immutable while it runs',
      };
    case 'T04':
      return {
        kind: 'resize',
        direction: 'smaller',
        why: "the converted amount does not fit the outgoing leg's u64 ceiling",
      };
    case 'R01':
      return {
        kind: 'resize',
        direction: 'larger',
        why: 'the fee alone exceeds the converted amount',
      };
    default:
      break;
  }

  switch (code.charAt(0)) {
    case 'T':
      return {
        kind: 'wait',
        retryAfterMs: waitFor(attempts),
        why: `${code} is temporary`,
      };
    case 'R':
      return { kind: 'stop', why: `${code} says this request was wrong, and we cannot tell how` };
    default:
      // `F`, and anything unrecognised. A code we do not understand is not a
      // code to keep paying against.
      return { kind: 'stop', why: `${code} is final` };
  }
}
