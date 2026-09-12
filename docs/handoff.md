# Handoff to the Anyone Protocol team

Two repositories were built for you, and they are one loop.

[anytoon][anytoon] runs the Anyone credentials issuer behind a TOON connector and
**sells** blind-signed credentials for tokens over ILP. **tuzzy** — this
repository — is the **credential buyer**: it buys bundles from that seller at
machine scale, in USDC, for a **crawler** that holds no payment code at all.
Between them sits a TOON hub that converts USDC into ANYONE at a rate it read
from a live Uniswap v3 TWAP.

Each repository documents its own node. This document is the only one that
describes **the pair**, and it exists so that nobody has to assemble the picture
out of two READMEs, five issues and a compose profile.

Every claim below names a command. The three verdicts you should take away are:

1. The buy side works, end to end, across a real conversion, on a local chain.
2. **Nothing has run anywhere but a local chain, and presentation is impossible
   today.** Section 2 is the one that matters.
3. One thing blocks the loop from closing, and it is yours: the `anon` daemon has
   nowhere to put a credential, and relays do not honour one. Section 3.

Vocabulary is fixed in [`CONTEXT.md`](../CONTEXT.md) here and in
[anytoon's][anytoon-context]. Where this document says **denomination**,
**rate**, **credential pool** or **provenance boundary**, it means what those
files say.

---

## 1. What the pair proves

One sentence: **a buyer holding only USDC can buy blind-signed Anyone credentials
from a node that is paid in ANYONE, without either side knowing the other's
token.**

```
 crawler              tuzzy                  hub                  anytoon
(unmodified)       (this repo)            (a dealer)         (issuer + minter)
    │                   │                     │                     │
    │  ordinary HTTP    │  pays 11000 µUSDC   │  pays 0.04 ANYONE   │
    │  fetches, no      │  on its own ────────┤──▶ converted at a ──┤──▶ blind
    │  payment code     │  channel            │  live 300s TWAP     │  signatures
    │                   │                     │                     │
    └── asks for one ───┘                     └─ the only hop that knows
        credential                               two tokens are involved
```

The hop in the middle is the part that did not exist until recently.
A forward across a **denomination boundary** — a hop whose two channels hold
different tokens, converting at a **rate it has declared** — is connector
ADR 0071: asked for in [connector#1286][c1286], answered there, and specced for
build as connector#1287. The sandbox below runs a connector image that does it.
Before it, the whole forwarding arithmetic was one subtraction in one unit, and
the USDC-in/ANYONE-out topology was not expressible. The sandbox profile that
stages it is [infra#9][i9]; the issuer path it stages was [infra#5][i5].

### The gates, and what each one is for

| Command | Where | What it proves | Needs |
|---|---|---|---|
| `make test` | tuzzy | Every decision tuzzy makes for itself: the **credential pool**, the epoch clamp, the low-water refill mark, the destructive `take`, the refusal-code policy, and a credential round-trip through the pool file. 17 tests. | Node 24+. No chain, no containers, nothing on disk. |
| `make test` | anytoon | The claim minter's and the buyer's own unit suites. | Same. |
| `make up-credentials` + `make smoke-credentials` | infra/sandbox | The **crossing**, end to end. 15 services. | Docker; a plain `anytoon` sibling clone. |
| `make sandbox-e2e` | tuzzy | tuzzy's own buyer against that crossing. The one integration gate here. | The sandbox above, already up. |
| `make local-e2e` | anytoon | The whole seller loop on a local anvil, ending in ten verified credentials. | Docker. Clones the connector repo for its anvil setup. |

`make sandbox-e2e` exits `78` when the sandbox is absent, so "the sandbox is not
here" is never reported as "tuzzy is broken". Tuzzy ships no compose stack and no
local chain of its own, and [ADR 0003](adr/0003-no-stack-of-its-own.md) says why:
a stack containing only buyer and seller has no hub, so it would prove the
purchase and structurally never prove the crossing.

### What `make smoke-credentials` asserts

Run from the sandbox, after `make setup && make up-credentials`:

- The **price triple** agrees. The issuer verifies the amount inside the signed
  claim against its own configured price, so three numbers must match or every
  paid request answers `402 CLAIM_INVALID`: the connector's route `price` in base
  units, the claim minter's `BUNDLE_PRICE`, and the issuer's `BUNDLE_PRICE`. The
  smoke re-derives the first from the other two on every run
  (`0.04 × 10^18 = 40000000000000000`) and compares it against what the node
  **advertises** at `GET /ilp`.
- The ANYONE **rate is live**, off the swap driver's own market — not a static
  allowance. The smoke polls `GET /rates` at both ends of the run and requires
  the ANYONE leg's `last_refreshed` *and its price* to have **moved**. Every
  other assertion in the file would pass against a frozen TWAP.
- The epoch key document serves **free**, and the free route is **scoped** to
  `/v1/keys/` — `../bundles` off it is refused `F00` before the issuer is
  touched, because a free route at the issuer root would be free credentials.
- An unpaid request to the paid route is refused.
- One **paid, hub-routed purchase** of a blind-signed bundle, checked from both
  sides: the client paid the hub *exactly* 11000 µUSDC off the claim the client
  itself holds, and the hub paid the anytoon node a number that is ≥ the bundle
  price, ~10¹²× the integer that arrived, and within 5% of what the pre-flight
  rate predicted. Any one of those alone would pass on a broken conversion.

### What `make sandbox-e2e` adds

That the **buyer** is correct, in its own units, with no knowledge of the far
token:

- one bundle bought, and the amount paid asserted to be exactly `11000` — the
  hub's static quote, in the client's own money;
- all ten credentials verified under the **epoch** key using only the two halves
  persisted to the pool file, so a credential survives the disk;
- `take` removes one and persists the removal **before** returning it;
- a second `buy` **declines**, because the pool is above its low-water mark.

Nothing in tuzzy references ANYONE. The price is read in our own money, the claim
is signed on our own channel, and the conversion is the hub's business.

### Two structural properties worth your attention

**The issuer is unmodified.** anytoon runs
`ghcr.io/anyone-protocol/credentials-issuer:latest` as published. The connector
requires the app behind it to be payment-oblivious; your issuer refuses to sign
without a payment claim signed by a key it trusts. A **claim minter** translates
between those two facts and does nothing else — it collects no money and
authorises nothing. No fork of your code exists anywhere in this work.

**The crawler is unmodified too, and tuzzy stays outside the provenance
boundary.** It authorises payment and never handles the fetched bytes
([ADR 0002](adr/0002-tuzzy-stays-outside-the-provenance-boundary.md)). A payment
component in the fetch path would become a permanent clause in Wuzzy's trust
model. It also does not pay source **gate**s; the crawler's existing x402 payer
does ([ADR 0001](adr/0001-the-gate-payer-stays-with-the-crawler.md)).

---

## 2. What the pair does not prove

Read this section before you rely on anything above.

### Nothing has run off a local chain

Every gate named in section 1 settles on `anvil` (chain 31337) or a local Solana
test validator, against mock tokens, with valueless committed keys. There is no
testnet run, no mainnet run, and **no gate runs automatically anywhere**. The only
workflow in any of the three repositories (`tuzzy`, `anytoon`, `infra`) builds and
publishes tuzzy's image on a tag; it runs no test and proves nothing about the
loop. Every number in this document came from a command a human chose to run.

anytoon has a mainnet path — `make up`, which settles real ANYONE on chain 1 and
pays real gas. It is **not a gate** and nobody should read it as one. Its own
README leads with that warning.

### The 18-decimal chain-1 configuration is checked by no gate

This is the narrowest and most important limit, so it is worth stating exactly.

The sandbox **does** exercise 18-decimal ANYONE arithmetic. `conf/anytoon.conf`
carries `BUNDLE_PRICE=0.04`, `conf/connector-anytoon.toml` carries
`price = 40000000000000000` and `decimals = 18`, and that `decimals` is asserted
at boot against the token's own `decimals()` — the real mainnet ANYONE ERC-20's
runtime bytecode, placed on anvil at its own mainnet address. A green boot is
itself proof the asset layer landed. The `u64` packet ceiling on an 18-decimal
leg (≈18.4 tokens, against a ~0.04 bundle) is asserted against the peering's
`max_packet_amount`, and the smoke notes that the connector's default of
`1000000` would have refused the converted packet `T04`.

What is **not** exercised is chain 1 itself — its gas, its liquidity, its
registry, its confirmation semantics — and, separately, **anytoon's own committed
deployment configuration**. `anytoon/config/connector.toml` points at chain 1
with `price = 10000000000000000` (0.01 ANYONE) and `BUNDLE_PRICE=0.01`. That
triple is reached only by `make up`. anytoon's two gates — `make local-e2e` and
`make hs-e2e` — both run `config/connector.local.toml`, which is 6-decimal mock
USDC with `price = 10000`.

So the coupling that an 18-decimal token breaks is exercised **in the sandbox's
own copy of the configuration, on anvil**, and not in the file a deployment
edits. anytoon's README states the hazard directly: an 18-decimal token makes
`10000` base units **dust, not 0.01**. A drift between the three numbers is
`402 CLAIM_INVALID` on every paid request, or — if the connector's price is under
what the downstream wants — `F06` on every forwarded PREPARE. Nothing catches it
except a smoke test pointed at the configuration you actually deploy.

### No gate exercises the `.anyone` ingress, and tuzzy has never dialled one

In a deployment the issuing node publishes no clearnet endpoint and no public
port: the **hidden-service endpoint** is the only way in. Two things rehearse
that, and both are explicitly rehearsals rather than gates, because `anon`
bootstraps against the real Anyone network and a check that goes red when someone
else's relays have a bad afternoon is not a gate:

- `make smoke-hs` in the sandbox (with `make up-hs`), which buys one bundle over
  a circuit with the chain RPC on the same circuit. It exits `75`
  (`EX_TEMPFAIL`) when the overlay would not carry and `1` when the sandbox
  itself is wrong, and it never confuses the two.
- `make hs-e2e` in anytoon, the same shape against its own stack.

Neither runs tuzzy. `make up-hs` needs *both* sibling checkouts (it is
`--profile full --profile hs`), one of them a worktree of an unmerged branch, and
nothing in the sandbox references this repository. tuzzy's own gate runs with
`socksProxy: undefined`, over clearnet loopback to the hub.

tuzzy has the configuration surface for it: `TUZZY_SOCKS_PROXY` is required when
the connector's host ends in `.anyone`, refused when it does not, and must be
`socks5h://` so the proxy resolves the name. **That logic is unit-tested and has
never carried a purchase.** No automated check in any of these repositories has
tuzzy buying a bundle over a circuit.

### Presentation is unproven, because it is impossible today

`take` hands out a credential. **Nothing can present one.** This is not a gap in
the work; it is the dependency in section 3, and it is tracked as
[toon-protocol/tuzzy#2][t2] with a named signal to watch rather than left as a
sentence in a README that would go stale.

"Done" in this repository therefore means *bought, verified, pooled and
takeable*. `take` writes a credential to stdout and nothing reads it. No
presenter has been built, deliberately: one written now would guess a wire format
you have not published, and a guess becomes a migration rather than a head start.

### Smaller limits, each of which changes how a result should be read

- **The crossing's own refusal codes have never been observed from a running
  connector here.** `T00` (stale rate), `F02` (no rate declared), `T04`
  (converted amount exceeds the outgoing leg's `u64`) and `R01` (fee alone
  exceeds the converted amount) are implemented as a **policy** in
  `src/refusal.ts` and unit-tested as a mapping. Only `T00` can be staged for
  real, and only by hand: `docker compose --profile credentials stop
  swap-driver`, wait ~2 minutes (`ttl_secs`), and every purchase refuses it;
  `start swap-driver` restores the market within one poll (~40s). `F02`, `T04`
  and `R01` have never come back from a live hop in any run.
- **The crossing's correctness depends on a running shell script.** A route price
  is static config and cannot float, so the hub quotes a fixed µUSDC price and
  carries the FX risk. The 11000 covers the worst rate inside the swap driver's
  ±2% triangle wave with about four times that band to spare. Stop the driver and
  everything refuses `T00`; make the rate wander past its band and purchases
  refuse `F06`. Both are true properties of dealing, not sandbox bugs — but the
  ANYONE routes are the only ones whose correctness is not a committed number.
- **The pair the packets actually convert appears on no surface.**
  `solana:USDC → evm:ANYONE` is composed at lookup out of a par row and the
  ANYONE quote read backwards; `GET /rates` lists only declared pairs. Its health
  must be inferred from two legs.
- **A quote path is at most two pools**, and this one uses both
  (ANYONE → WETH → USDC). There is no Solana rate source in the connector at
  all, which is why the numeraire is the EVM mock USDC.
- **The sandbox smoke's blinded blanks are structurally valid, not genuinely
  blinded.** They are 256-byte values with a leading zero byte; the issuer signs
  them either way, and what that smoke proves is the paid path rather than
  RSABSSA. tuzzy's own gate is different — it performs real blinding and verifies
  every returned signature under the epoch key — but do not read
  `make smoke-credentials` as a cryptographic check.
- **The issuer's epoch expires after 30 days.** The key job re-forges an expired
  one on the next `make up`, but a stack left running past the window signs
  nothing until it is restarted.
- **The pair has never run as two concurrent buyers.** The sandbox funds exactly
  one identity, so tuzzy's gate and `make smoke-credentials` are two clients of
  one channel and therefore of one nonce watermark. Running them together is
  documented as forbidden. Nothing here has tested contention on a channel.
- **"Machine scale" is a design intent, not a measured number.** No repository
  contains a benchmark or load target. Tuzzy is a CLI on a timer, sized by a
  low-water mark, and the reason it pays over a **payment channel** rather than
  per request is economic reasoning about gas amortisation — not a throughput
  figure anyone has recorded.
- **Nothing checks that the two components agree about egress.** Tuzzy's output
  is a credential, not a connection, so the crawler keeps its own transport
  configuration. A disagreement between them is a misconfiguration nothing
  detects. That cost is accepted deliberately (ADR 0002).

---

## 3. What Anyone must ship for the loop to close

One dependency, in two parts, and neither is ours.

### 1. The `anon` daemon needs somewhere to put a credential

The daemon builds the circuits, so it is the component that must present a
credential to a relay. It has nowhere to hold one.

This is not inference. The client configuration used by both hidden-service
rehearsals — `infra/sandbox/conf/anonrc-client` and
`anytoon/config/anonrc-client`, the second vendored from the first's source, both
for `anon` v0.4.10.2 — is, in full:

```
AgreeToTerms 1
User anond
DataDirectory /var/lib/anon
Nickname <name>
ClientOnly 1
ORPort 0
DirPort 0
ControlSocket 0
SocksPort 0.0.0.0:9050
SocksPolicy accept <four CIDRs>
SocksPolicy reject *
Log notice stdout
Log notice file /var/lib/anon/notice.log
```

There is no option for a credential, a token or a voucher. The service-side
config (`conf/anonrc`) adds `HiddenServiceDir` and `HiddenServicePort` and
nothing else. A buyer can hold a valid, verified, single-use credential and have
no way to hand it to the daemon that would use it.

**The first observable moment at which presentation becomes possible is the
daemon's configuration gaining an option for a credential.** That is the signal
[tuzzy#2][t2] watches. Until it appears, nothing in this repository will
anticipate the protocol.

### 2. Relays must honour a presented credential

A configuration option on the client is necessary and not sufficient. A
credential that a relay does not recognise buys nothing, so the relay side needs
whatever verification and single-use accounting your design calls for. Note one
constraint that falls out of the **credential pool**'s own properties: a
credential is `(serial, signature)` under one **epoch** key, single-use, and
unrecognisable to the issuer that signed it. If relays record serials, a
double-presentation is indistinguishable from fraud — which is why `take` marks a
credential spent and persists that *before* returning it, accepting the loss of
one credential on a crash rather than the risk of presenting one serial twice.

### What would help, beyond the two requirements

- **Publish the wire format before anyone implements against it.** We have
  deliberately not guessed one.
- **Say whether presentation is per-circuit, per-stream or per-relay-hop.** That
  is what sizes the **credential pool** and sets the purchase cadence, and it is
  the one number tuzzy cannot derive from its own side.
- **Say what a relay does with a credential it rejects**, and whether rejection
  is distinguishable from an unrelated circuit failure. A buyer that cannot tell
  those apart will either retry into a wall or drop good credentials.

### What you do **not** have to ship

- **No change to the credentials issuer.** It runs as its published image, and
  the claim minter exists precisely so that it does not have to change.
- **Nothing on the TOON side.** The denomination boundary the topology needs is
  decided (connector ADR 0071) and built. Neither the buy side nor the sell side
  is waiting on you.
- **No presenter from us, and none from you on our account.** When the daemon can
  read a credential, the likely addition here is a small step that writes
  `take`'s output where the daemon reads it. The **credential buyer** itself does
  not change.

---

## Commands referenced

```bash
# tuzzy (this repository)
make install && make test                # 17 unit tests. No chain, no containers.
make sandbox-e2e                          # the one integration gate; 78 = sandbox absent

# infra/sandbox — the crossing
make setup && make up-credentials         # 15 services; needs a plain anytoon clone
make smoke-credentials                    # the denomination boundary, end to end
make up-hs && make smoke-hs               # REHEARSAL: dials the real Anyone network

# anytoon — the seller
make test                                 # both unit suites
make local-e2e                            # the whole loop on a local anvil
make hs-e2e                               # REHEARSAL: the same, reached only over a circuit
make up                                   # chain 1. REAL MONEY. Not a gate.
```

[anytoon]: https://github.com/toon-protocol/anytoon
[anytoon-context]: https://github.com/toon-protocol/anytoon/blob/main/CONTEXT.md
[t2]: https://github.com/toon-protocol/tuzzy/issues/2
[i5]: https://github.com/toon-protocol/infra/issues/5
[i9]: https://github.com/toon-protocol/infra/issues/9
[c1286]: https://github.com/toon-protocol/connector/issues/1286
