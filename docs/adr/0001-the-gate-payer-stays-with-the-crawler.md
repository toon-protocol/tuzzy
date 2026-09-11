# 1. The gate payer stays with the crawler

Date: 2026-09-11

## Status

Accepted

## Context

Wuzzy's crawler meets two kinds of demand for money, and it is tempting to treat
them as one problem because both are "paying for a fetch".

The first is **circuit credentials**: blind-signed bundles bought from one
counterparty, continuously, at machine scale, to route crawler egress through
Anyone relays. The second is **source gates** under honor-or-skip: a site posts a
machine-access price, and the crawler pays it or does not crawl. These differ in
every dimension that matters — layer (transport vs HTTP), counterparty count
(one vs a long tail), cadence (continuous vs unpredictable), and therefore rail.

Wuzzy's crawler already has an x402 payer, because x402 is Wuzzy's existing and
permanently committed rail. The question was whether tuzzy should take over gate
payment too, so that all paying lived in one place.

Three things decided it.

A TOON-gated source greets an unpaid request with a `402` carrying **two**
`accepts` entries: a vanilla `scheme:"exact"` on-chain entry and a
`toon-channel` entry. An x402 payer that has never heard of TOON takes the first
by graceful degradation. **So TOON as a site-gate rail already works against an
unmodified crawler**, and what is forgone by not upgrading is off-chain batching
and n-hop reach — optimisations, not capabilities.

In the other direction, `ToonClient.h402Fetch` does **not** pay a vanilla x402
challenge: when no `toon-channel` entry is offered it surfaces the challenge to
the caller unchanged. A TOON client is therefore not automatically an x402 payer,
so moving gate payment here would mean building a second payer, not moving one.

And the crawler is the component that knows which source it is about to fetch and
under what policy. A payer one process away from that decision has to be told,
which means an interface whose only purpose is to carry a decision back to where
it came from.

## Decision

Tuzzy pays for **credentials** and nothing else. Source gates stay with the
crawler's existing x402 payer.

The two paying roles are named separately in `CONTEXT.md` — **credential buyer**
and **gate payer** — so that the split is structural rather than something a
later reader has to infer from which code happens to exist.

## Consequences

Tuzzy ships one component instead of two, and the site-gate touchpoint needs no
work at all: it is already true.

Sources that post a price on a rail neither payer speaks resolve to *skip*. That
is the correct outcome under honor-or-skip and it must stay cheap to reach — but
it does mean the set of crawlable paid sources is the union of what the crawler's
x402 payer can pay, not of what TOON could route to.

Batching and n-hop reach are left on the table for gate payments. If the long
tail of TOON-gated sources ever becomes commercially significant, the upgrade is
a `toon-channel` payer in the crawler — still not here, because the decision
about which source to pay for is the crawler's.
