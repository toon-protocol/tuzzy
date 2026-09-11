# 3. No stack of its own

Date: 2026-09-11

## Status

Accepted

## Context

anytoon — this repository's counterpart, and the seller to tuzzy's buyer — ships a
`docker compose` stack and a `make local-e2e` that brings the whole loop up on a
local anvil. It is a good shape, and the obvious thing was to mirror it: tuzzy
plus anytoon on anvil, six or so services, runnable on every change with no
third-party money and no dependency on any network being healthy.

That was the plan, and two things invalidated it.

The first is that the interesting part of tuzzy's production path stopped being
the purchase and became the **crossing**. Connector ADR 0071 made a forward across
a denomination boundary core behaviour: tuzzy pays USDC, the hub converts at a
declared rate, and the issuing node is paid in ANYONE. A stack containing only
tuzzy and anytoon has no hub, no dealer and no pools, so it cannot express the
topology tuzzy actually runs in. It would prove the purchase and structurally
never prove the crossing.

The second is that the TOON sandbox grew a `credentials` profile
(`toon-protocol/infra#9`) that does exactly this: 15 services, one plain sibling
clone, a real Uniswap v3 asset layer on anvil, and a purchase converted uUSDC to
ANYONE at a live TWAP with both sides' books asserted in their own units. The
earlier objections to depending on it — twenty services and a checkout of an
unmerged branch — were the reason for asking for that profile, and they are gone.

Keeping our own stack would mean maintaining a second copy of anytoon's wiring in
order to prove strictly less.

## Decision

Tuzzy ships **no compose stack and no local chain**. Testing splits in two:

1. **Unit tests** for everything tuzzy decides for itself — the pool, the epoch
   clamp, the refill low-water mark, the destructive take, the refusal-code
   policy, and the credential round-trip. No chain, no containers, nothing on
   disk. This is anytoon's own precedent: its `credentials.ts` is unit-tested
   without a running stack and its `make test` needs neither chain nor container.
2. **One integration gate**, `make sandbox-e2e`, running tuzzy's buyer against
   the sandbox's `credentials` profile — the only place the crossing exists.

## Consequences

Tuzzy cannot be tested end to end from a clone of tuzzy alone. The gate needs
sibling `infra` and `anytoon` checkouts and 15 running services, and it exits
`78` when they are absent so that "the sandbox is not here" is never reported as
"tuzzy is broken".

In exchange, the one gate tuzzy has proves the thing that actually ships: a real
bundle bought across a real denomination boundary at a live rate, with nothing in
this repository aware that ANYONE was involved.

The unit tests carry more weight than they would in a repository with a stack, so
the seams have to stay honest: anything that can only be checked with a chain
attached is a thing this repository should not be deciding.

If the sandbox ever stops carrying the credentials profile, this decision has to
be revisited rather than worked around — a stack rebuilt here would still not
contain a dealer.
