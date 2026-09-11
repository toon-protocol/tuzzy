# Context

The vocabulary of this repository. Three systems meet here — Wuzzy, TOON and
Anyone Protocol — and each has a word for something the others also name, so the
terms below are the ones that win. This file is a glossary and nothing else: no
configuration, no rationale for decisions (those live in `docs/adr/`), no
implementation.

Where a term is already fixed by [anytoon's glossary](../anytoon/CONTEXT.md),
this file does not redefine it. The two repositories are the two sides of one
rail and must not drift.

## Tuzzy

This repository: the **payer** side of Wuzzy's TOON integration. It buys, and it
is not bought from.

Not "Wuzzy on TOON" in the sense of a port, and not a fork. Wuzzy is Memetic
Block's product and stays theirs; tuzzy is the component that sits beside an
unmodified crawler and buys what the crawler's anonymity costs.

Two paying roles exist in the whole system — the **credential buyer** and the
**gate payer** — and only the first is in this repository.

## Crawler

Wuzzy's `WuzzyBot`, consumed **unmodified** — the counterpart of the way anytoon
consumes the credentials issuer as a published image. It is
**payment-oblivious** in the same sense an **app** is: it makes ordinary
requests and holds no key toward any payment.

The direction is the mirror of anytoon's, and the mirror is the whole design.
anytoon put a payment-oblivious app *behind* a collecting connector; tuzzy puts a
payment-oblivious crawler *in front of* a paying component.

## Payer

TOON's term for what tuzzy is: the side that seals a request into a packet, and
attaches a signed claim on a payment channel it opened itself on chain.

Note the collision. anytoon's glossary defines **payer** as *the channel identity
the connector collected from*, which is that repository's payment reference —
there, the payer is someone else. Here it is us. Both readings are correct from
their own side of the same channel; qualify the word when the two repositories
are discussed together.

## App

An ordinary, payment-oblivious HTTP service behind a connector route.

**Tuzzy is not one, and this is the settled answer to "is Wuzzy a TOON app or a
TOON client?"** It is the client. Wuzzy's demand side — agents paying per query —
is x402/USDC on Base as a stated design commitment, so `/search` acquires no
second gate. See **Query rail**.

## Rail

Which payment system moves the money — not which layer it moves at, and not who
is paid. x402/USDC-on-Base and TOON channels are two rails.

Wuzzy's own overview uses the word this way in all three of its TOON
touchpoints, and keeping it narrow is what makes **honor-or-skip** analyzable:
the policy is stated as rail-agnostic, and whether it actually is depends on
which rails the paying component speaks.

## Query rail

The demand side: agents paying Wuzzy per query. **x402 / USDC on Base,
permanently** — a design commitment, not a default, because the keyless property
depends on it.

Named here only to record that it is **out of scope**. Nothing in this repository
meters, prices or serves a query.

## Honor-or-skip

The crawler's policy where a source posts a machine-access price: pay the posted
price, or do not crawl. Never evade.

Two obligations, not one. "Skip" is a real outcome and must stay cheap to reach —
a component that cannot pay a given rail is required to skip, not to fall back to
crawling for free.

## Circuit customer

What Wuzzy's crawler fleet becomes when Anyone's paid exits ship on TOON rails:
continuous, non-speculative, round-the-clock demand for priority circuits.

This is the **primary** touchpoint and the reason tuzzy exists. anytoon proved an
operator can *sell* blind-signed credentials for tokens over ILP; nobody has
shown a buyer doing it at machine scale.

## Hidden-service endpoint

Fixed by anytoon's glossary and not redefined here. The address is a **host**: it
is not a scheme, not a carriage and not a transport.

The TOON client learned this the hard way — a `.anyone`/SOCKS5h *transport
overlay* was built and then removed, and hidden-service support returned as a
host that demands a `socksProxy`. Do not reintroduce the overlay reading.

## Credential buyer

The one component tuzzy ships: it buys **bundles** of blind-signed
**credentials** from anytoon over ILP, verifies them under the **epoch** key, and
holds them until something can present them.

One counterparty, continuous, high volume — which is why it pays over a **payment
channel** and not per request. Claims bank off-chain and one redemption converts
the running total, so gas amortises across everything since the last one. Per-
request on-chain settlement would be the wrong economics for exactly the workload
that makes Wuzzy an interesting **circuit customer**.

## Gate payer

Whatever pays a source's posted machine-access price at the HTTP layer, under
**honor-or-skip**.

**It is not in this repository, and that is a decision.** The crawler already has
an x402 payer, because x402 is Wuzzy's existing rail. A TOON-gated source greets
with a `402` carrying both a vanilla `exact` entry and a `toon-channel` entry, and
an x402 payer that has never heard of TOON takes the first one — so TOON as a
site-gate rail already works against an unmodified crawler. What that forgoes is
off-chain batching and n-hop reach, which are optimisations, not capabilities.

Distinct from the **credential buyer** in layer, counterparty, cadence and rail.
The two are never one component.

## Provenance boundary

What a third party must re-run to check a result: the fetch, and the pinned
extract/normalize/hash procedure named by the attestation.

**Tuzzy is outside it and stays outside it.** It authorises payment and never
handles the fetched bytes. A payment component inside this boundary is one more
thing a disputer has to model, against a product whose claim is *search you can
check, not trust*.

## Denomination

Which asset and scale a packet's `amount` is counted in. **A unit of 1 is the
lowest denomination of the token used by that bidirectional payment channel** —
RFC 0027's own definition, and a property of the channel rather than of the
packet. `a↔b` in USDC and `b↔c` in ANYONE are not concerned with each other's
terms.

**Rate**, **spread** and **segment** are fixed by the connector's own glossary
and ADR 0071 and are not redefined here. What matters on this side: a hop whose
two channels hold different tokens converts at a rate **it has declared**, and
refuses the forward when none is declared — there is no implicit 1:1. A probe
answers in the prober's own unit however many boundaries the path crossed,
because a reject converts its running cost back at each one.

Tuzzy is always on the USDC side of such a boundary and never holds the far
token. Say **denomination** for the unit and **rate** for the conversion between
units; the hub deals, we do not.

## Credential pool

The credentials this repository holds between buying them and handing them out.

Bearer material: a credential is `(prepared, signature)` under one **epoch** key,
single-use, and unrecognisable to the issuer that signed it. `prepared` is the
randomizer-prefixed serial the signature actually covers — say **prepared** when
naming what is held, because `verify(key, signature, prepared)` is the check a
relay will make and the bare serial will not satisfy it. Losing the pool
loses money that nobody can reissue; copying it creates a second spendable copy
of the same thing.

It is the most precious state here but not the only precious state, and the
correction matters: the **channel store** holds a nonce watermark that is **not
on chain**. A client that forgets it re-signs claims at nonces the connector
has already banked, and every one is refused as a replay until the watermark is
resynced from what the counterparty reports. The channel *identity* is on chain;
the watermark is the counterparty's journal. Only the **anon** sidecar's state
is genuinely disposable.

Shallow on purpose, and its floor is set by how long a supplier can be
unavailable rather than by how fast a refill completes. A boundary that refuses
for want of a fresh rate answers `T00` — retrying is the *correct* move, and
each attempt still spends the claim that covered it, so the pool has to be deep
enough that the retry can be slow. A refusal of `F02` is the other case
entirely: no rate is declared for the crossing, config is immutable for the
process lifetime, and no amount of retrying that path will work.
