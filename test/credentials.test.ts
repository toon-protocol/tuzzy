/**
 * The round-trip, against a keypair this test generates.
 *
 * anytoon's equivalent reads the epoch key out of `data/keys/` that `make keys`
 * produced. This one generates its own, because Q28's whole point is that
 * tuzzy's own logic is testable with nothing on disk and no containers.
 *
 * The assertion that matters is the last one: a credential survives a trip
 * through the pool file -- base64 in, JSON out -- and still verifies, using
 * only the two halves we persist. The blinding factor is spent by `finalize`
 * and deliberately not kept, so if `prepared` were not enough, this is where it
 * would show.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SUITE_NAME,
  blindBlanks,
  finalizeCredentials,
  importEpochKey,
  suite,
  type KeyDocument,
} from '../src/credentials.ts';

const BUNDLE_SIZE = 4;

async function issuerStandIn(): Promise<{ doc: KeyDocument; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    {
      name: 'RSA-PSS',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-384',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const now = Date.now();
  return {
    doc: {
      epoch_id: 'test-epoch',
      not_before: new Date(now - 60_000).toISOString(),
      not_after: new Date(now + 3_600_000).toISOString(),
      alg: SUITE_NAME,
      pubkey: Buffer.from(spki).toString('base64'),
    },
    privateKey,
  };
}

test('a bundle round-trips, and each credential survives the pool file and still verifies', async () => {
  const { doc, privateKey } = await issuerStandIn();
  const publicKey = await importEpochKey(doc);

  const blanks = await blindBlanks(publicKey, BUNDLE_SIZE);
  assert.equal(blanks.length, BUNDLE_SIZE);
  for (const blank of blanks) {
    assert.equal(Buffer.from(blank.blinded, 'base64').length, 256);
  }

  const blindSignatures = await Promise.all(
    blanks.map(async (blank) =>
      Buffer.from(
        await suite.blindSign(privateKey, new Uint8Array(Buffer.from(blank.blinded, 'base64'))),
      ).toString('base64'),
    ),
  );

  const credentials = await finalizeCredentials(publicKey, blanks, blindSignatures);
  assert.equal(credentials.length, BUNDLE_SIZE);

  // Through the pool file and back.
  const persisted = JSON.parse(JSON.stringify(credentials)) as typeof credentials;
  for (const credential of persisted) {
    assert.ok(
      await suite.verify(
        publicKey,
        new Uint8Array(Buffer.from(credential.signature, 'base64')),
        new Uint8Array(Buffer.from(credential.prepared, 'base64')),
      ),
      'the two halves we persist must be enough to verify without the blinding factor',
    );
  }
});

test('a bundle short of signatures is refused, rather than banking the part that arrived', async () => {
  const { doc, privateKey } = await issuerStandIn();
  const publicKey = await importEpochKey(doc);
  const blanks = await blindBlanks(publicKey, 2);
  const one = Buffer.from(
    await suite.blindSign(privateKey, new Uint8Array(Buffer.from(blanks[0].blinded, 'base64'))),
  ).toString('base64');

  await assert.rejects(() => finalizeCredentials(publicKey, blanks, [one]), /asked for 2/);
});

test('an expired epoch is refused at import, before anything is blinded', async () => {
  const { doc } = await issuerStandIn();
  const expired = { ...doc, not_after: new Date(Date.now() - 1).toISOString() };
  await assert.rejects(() => importEpochKey(expired), /not currently valid/);
});
