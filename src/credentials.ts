/**
 * The buyer's half of the credential protocol.
 *
 * Vendored from `anytoon/buyer/src/credentials.ts`, which is unit-tested there
 * against the issuer's own invariants. It is copied rather than imported
 * because anytoon publishes no package and its buyer is explicitly "a demo and
 * a smoke test, not an SDK". The duplication is a known cost, recorded here so
 * the next person finds it deliberately: if these two ever disagree, anytoon's
 * is the one the issuer was tested against.
 *
 * Invariant I1 forbids hand-rolled crypto: every protocol step runs inside
 * @cloudflare/blindrsa-ts. This module only sequences the library's calls and
 * handles encoding, so it is testable without a running stack.
 *
 * What tuzzy adds: `finalize` yields the `prepared` message beside each
 * signature. anytoon's buyer discards it because it verifies and exits, but a
 * credential that has to survive in a pool and be presented later is the
 * *pair* -- `verify(key, signature, prepared)` is the check a relay will make,
 * and `prepared` is not recoverable from the signature.
 */
import { RSABSSA } from '@cloudflare/blindrsa-ts';

/** The suite the issuer's key document must name. */
export const SUITE_NAME = 'RSABSSA-SHA384-PSS-Randomized';

export const suite = RSABSSA.SHA384.PSS.Randomized();

export interface KeyDocument {
  readonly epoch_id: string;
  readonly not_before: string;
  readonly not_after: string;
  readonly alg: string;
  /** Strict-base64 SPKI of the epoch public key. */
  readonly pubkey: string;
}

/** One credential in flight: the message the signature will cover, and the blinding factor. */
export interface Blank {
  readonly prepared: Uint8Array;
  readonly inv: Uint8Array;
  /** base64 of the blinded blank, as the issuer expects it. */
  readonly blinded: string;
}

/**
 * One credential at rest: exactly what a presenter needs and nothing else.
 *
 * Both halves are base64 because this is what lands in the pool file. The
 * blinding factor is deliberately absent -- it is spent by `finalize` and
 * keeping it would persist a secret with no remaining use.
 */
export interface Credential {
  readonly prepared: string;
  readonly signature: string;
}

export async function importEpochKey(doc: KeyDocument): Promise<CryptoKey> {
  if (doc.alg !== SUITE_NAME) {
    throw new Error(`key document names ${doc.alg}, expected ${SUITE_NAME}`);
  }
  const now = Date.now();
  if (now < Date.parse(doc.not_before) || now >= Date.parse(doc.not_after)) {
    throw new Error(`epoch ${doc.epoch_id} is not currently valid`);
  }
  return crypto.subtle.importKey(
    'spki',
    new Uint8Array(Buffer.from(doc.pubkey, 'base64')),
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
}

/**
 * Blinds `count` fresh serials. The issuer sees only `blinded`; invariant I2
 * says it must never see the serial, and this is the buyer-side half of that.
 */
export async function blindBlanks(publicKey: CryptoKey, count: number): Promise<Blank[]> {
  const blanks: Blank[] = [];
  for (let i = 0; i < count; i++) {
    const serial = crypto.getRandomValues(new Uint8Array(32));
    const prepared = suite.prepare(serial);
    const { blindedMsg, inv } = await suite.blind(publicKey, prepared);
    blanks.push({ prepared, inv, blinded: Buffer.from(blindedMsg).toString('base64') });
  }
  return blanks;
}

/**
 * Unblinds and verifies, returning the pairs a pool can hold.
 *
 * `finalize` checks the signature against the epoch key, so a stack that
 * returns k blobs of garbage fails here rather than passing as "we got k
 * credentials back". A bundle is all-or-nothing on purpose: a partially
 * verifying bundle means something is wrong with the issuer or the wire, and
 * banking the half that happened to verify would hide it.
 */
export async function finalizeCredentials(
  publicKey: CryptoKey,
  blanks: readonly Blank[],
  blindSignatures: readonly string[],
): Promise<Credential[]> {
  if (blindSignatures.length !== blanks.length) {
    throw new Error(`asked for ${blanks.length} signatures, got ${blindSignatures.length}`);
  }

  const credentials: Credential[] = [];
  for (const [i, blank] of blanks.entries()) {
    const blindSig = new Uint8Array(Buffer.from(blindSignatures[i], 'base64'));
    const signature = await suite.finalize(publicKey, blank.prepared, blindSig, blank.inv);
    if (!(await suite.verify(publicKey, signature, blank.prepared))) {
      throw new Error(`credential ${i} does not verify under the epoch key`);
    }
    credentials.push({
      prepared: Buffer.from(blank.prepared).toString('base64'),
      signature: Buffer.from(signature).toString('base64'),
    });
  }
  return credentials;
}
