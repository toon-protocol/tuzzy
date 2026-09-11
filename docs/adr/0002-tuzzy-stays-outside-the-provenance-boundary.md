# 2. Tuzzy stays outside the provenance boundary

Date: 2026-09-11

## Status

Accepted

## Context

Wuzzy's product claim is *search you can check, not trust*: every result ships
with an attestation naming a pinned protocol version, and a third party can
re-run the fetch and the canonicalisation and dispute the hash. The set of things
a disputer must model is therefore a liability, and everything inside it has to
be specified, versioned and reproducible forever.

Tuzzy pays for the anonymity the crawler's fetches travel through. There is an
obvious-looking efficiency available: since tuzzy already holds the credentials
and the egress configuration, it could also perform the fetch and hand back the
bytes. One component, one network path, one place to put retries.

That efficiency puts a payment component inside the provenance boundary. Its
bytes become what gets hashed into `contentHash` and attested. A disputer
re-running `wuzzy verify <url>` would then be reproducing the behaviour of a
credential broker — its buffering, its error handling, its version — none of
which is part of the published canonicalisation protocol, and all of which would
have to become part of it or become an unstated dependency of every attestation.

## Decision

Tuzzy authorises payment and **never handles the fetched bytes**.

It buys credentials, verifies them, pools them, and hands one out on request. It
does not fetch, does not proxy a fetch, and does not sit in the data path of one.

## Consequences

The canonicalisation protocol keeps exactly the surface it publishes, and nothing
in this repository can invalidate an attestation.

The crawler keeps its own egress path and therefore its own transport
configuration. Tuzzy's output is a credential, not a connection, which means some
component on the crawler's side must know how to present one — and that
component does not exist yet (see the README on what "done" means here).

There is a real cost: two components now need the same egress facts, and nothing
enforces that they agree. That is accepted deliberately. A disagreement between
them is a misconfiguration, whereas a payment broker in the fetch path would be a
permanent clause in the trust model.
