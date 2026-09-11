# tuzzy

Buys [Anyone Protocol][anyone] circuit credentials over [TOON][toon], in USDC,
for a crawler that never handles payment.

It is the **buyer** to [anytoon][anytoon]'s seller. anytoon showed that an
operator can sell blind-signed credentials for tokens over ILP; this is the other
half — a continuous, non-speculative, machine-scale customer for them.

```
 crawler                tuzzy                 hub                 anytoon
(unmodified)         (this repo)          (a dealer)         (issuer + minter)
    │                     │                   │                     │
    │   ordinary HTTP     │  pays  11000      │   pays 0.04 ANYONE  │
    │   fetches, no       │  uUSDC on its ────┤──▶ converted at a ──┤──▶ blind
    │   payment code      │  own channel      │   live TWAP         │   signatures
    │                     │                   │                     │
    └── asks for one ─────┘                   └─ the only hop that knows
        credential                               two tokens are involved
```

**Nothing here knows what ANYONE is.** The price is read in our own money, the
claim is signed on our own channel, and the denomination boundary is the hub's
business — a packet's amount is denominated by the channel it rides, so a number
never crosses a unit without a hop converting it.

Requires Node 24+ and `@toon-protocol/client` 3.0.0 or newer.

---

## 1. What it does, and what it does not

It buys bundles, verifies them under the issuer's epoch key, and pools them. On
request it hands one out.

**It does not present them.** Nothing relay-side enforces credentials yet — the
Anyone-routed crawling phase follows Wuzzy's core and tracks Anyone's paid-exit
rollout — so "done" here means *bought, verified, pooled and takeable*. The
`take` command is the seam a presenter will use; the presenter is not ours and
does not exist. This is stated plainly rather than left for someone to discover.

**It does not pay source gates.** The crawler's existing x402 payer does that, and
a TOON-gated source already answers an x402 payer by graceful degradation —
[ADR 0001](docs/adr/0001-the-gate-payer-stays-with-the-crawler.md).

**It does not touch fetched bytes.** A payment component inside the provenance
boundary would become a permanent clause in Wuzzy's trust model —
[ADR 0002](docs/adr/0002-tuzzy-stays-outside-the-provenance-boundary.md).

---

## 2. Quick start

```bash
make install
make test        # every decision tuzzy makes for itself. No chain, no containers.
```

Then, against a real counterparty:

```bash
cd ../infra/sandbox && make up-credentials   # the far side, incl. the dealer
cd -            && make sandbox-e2e          # buy, bank, take, decline
```

`make sandbox-e2e` is the only test that needs anything running, because the
**crossing** is the one thing this repository cannot check on its own —
[ADR 0003](docs/adr/0003-no-stack-of-its-own.md). It exits `78` when the sandbox
is absent, so "the sandbox is not here" is never reported as "tuzzy is broken".

> **Do not run it while `make smoke-credentials` is running.** Both are clients of
> the one identity the sandbox funds, and therefore of one nonce watermark. See §5.

### Commands

| Command | What it does |
|---|---|
| `make buy` | Decide whether to buy, and if so buy once. **This is the timer's command.** |
| `make take` | Hand out one credential, marked spent before it leaves |
| `make status` | What is held, and whether a purchase is due |
| `make test` | Unit tests — no chain, no containers |
| `make sandbox-e2e` | The one integration gate |

---

## 3. Running it

Tuzzy is a **CLI on a timer**, not a daemon. All state is in the pool file, so a
run derives everything it needs from disk and the clock — there is no in-memory
copy of the one thing that must not be lost, and nothing to supervise.

```cron
*/5 * * * *  cd /srv/tuzzy && make buy >> /var/log/tuzzy.log 2>&1
```

### Exit codes are the interface

The caller is a timer, not a person, and these distinguish the three things an
operator would do differently:

| Code | Meaning |
|---|---|
| `0` | Did what was asked — **including correctly deciding not to buy** |
| `1` | This stack is wrong: our config, or an answer that does not verify |
| `69` | A human must change something before this can work |
| `75` | Temporary; the next tick will do |

The `69`/`75` split is the one that earns its keep, and the reason is that
**payment is per attempt**: a covering claim rides with every packet and a refusal
does not refund it (connector ADR 0042). So a retry is a purchase.

| Refusal | Meaning | What tuzzy does |
|---|---|---|
| `T00` | the hop's rate is **stale** — its own poller fell behind | waits, on a lengthening backoff (`75`) |
| `F02` | the hop declares **no rate** for the crossing | stops (`69`) — config is immutable for that process's life, so retrying spends a claim per tick for nothing |
| `T04` | the converted amount exceeds the outgoing leg's `u64` | stops (`69`); send **less** |
| `R01` | the fee alone exceeds the converted amount | stops (`69`); send **more** |

`T04` and `R01` are opposite instructions and are never collapsed into one — the
connector reports them separately on purpose.

---

## 4. Configuration

All environment, because the invocation is the thing an operator edits.

| Variable | Default | Meaning |
|---|---|---|
| `TUZZY_CONNECTOR` | `http://127.0.0.1:3000` | The connector we hold a channel with |
| `TUZZY_KEYS_CONNECTOR` | = `TUZZY_CONNECTOR` | Where the epoch key is **free** — see below |
| `TUZZY_SEAL_TO` | unset | Where the envelope is opened, for a **forwarded** route |
| `TUZZY_ROUTE` | `g.anyone.credentials` | The paid route; `.keys` is derived from it |
| `TUZZY_PRICE_CEILING` | **required** | Refuse to pay above this, in our own base units |
| `TUZZY_LOW_WATER` | `20` | Buy when spendable credentials fall to this or below |
| `TUZZY_BUNDLE_SIZE` | `10` | Must match the issuer's — bundles are indivisible |
| `TUZZY_POOL` | `./data/pool.json` | The credential pool |
| `TUZZY_CHANNEL_STORE` | `~/.toon/channels.json` | **Do not delete.** See §5 |
| `TUZZY_SOCKS_PROXY` | unset | Required for a `.anyone` connector, refused otherwise |
| `TUZZY_CHAIN` / `TUZZY_RPC_URL` | unset | Our settlement chain and its RPC |

**There is no price setting, and that is deliberate.** The price is read from the
connector at the moment of purchase; bootstrapping is one `GET`, and a configured
price that disagrees with the node's is a 402 on every paid request. What
`TUZZY_PRICE_CEILING` expresses is different — a refusal to pay above a number,
not a belief about what the number is. It is honor-or-skip applied to our own
supplier, and there is no default because a wrong guess either blocks every
purchase or defeats the point of having one.

**Set the ceiling against the number you actually pay.** On a forwarded route the
price you are quoted is the hub's, which is its own price *plus* its fee *plus* its
spread — not the issuer's posted price. And do not calibrate it against the
sandbox: that hub's quote is set generously on purpose.

### The key document is free somewhere else

A buyer needs the epoch key before it can blind anything, so the issuing node
prices that route at **zero on its own edge**. Reaching it through someone else's
hub is a different matter — the hub prices it like any other route. So when you
buy through a hub, point `TUZZY_KEYS_CONNECTOR` straight at the issuing node:
tuzzy then fetches the key with a second client that has no channel and cannot
pay, which also proves the route really is free.

When you buy from the issuing node directly — the production shape, where its
`.anyone` address is the only way in — leave it unset.

---

## 5. State, in order of how much losing it costs

| State | Losing it costs |
|---|---|
| **Credential pool** | **Money, unrecoverably.** Bearer tokens; nobody can reissue them |
| **Channel store** | Every claim refused as a replay until resynced from the counterparty |
| `anon` sidecar data | Nothing. No hidden service, no key worth keeping |

**The pool is bearer material.** A credential is `(prepared, signature)` under one
epoch key, single-use, and unrecognisable to the issuer that signed it. It is
written atomically at mode `0600`, and **there is no backup path in this
repository on purpose** — a backed-up bearer token is two copies of the same
spendable thing, which is worse than losing one.

`take` therefore removes the credential and persists the removal *before*
returning it. A crash in between loses one credential; the alternative risks
presenting one serial twice, and a relay recording serials would read that as a
double-spend by the one crawler whose whole pitch is that it is honest.

**The channel store holds a nonce watermark that is not on chain.** The channel
*identity* can be recovered — the watermark is the counterparty's journal. A
client that forgets it re-signs at nonces the connector has already banked, and
every purchase is refused `F01 … nonce does not advance this channel's watermark
(replay)` until it resyncs. The client's own documentation puts it plainly: never
delete a channel store for a live channel.

**The pool is shallow on purpose, and its floor is a rate outage, not a refill.**
Buy little and often, because depth concentrates loss and burns more at an epoch
rollover — but deep enough that a `T00` backoff can afford to be slow, because
every retry during an outage is paid for.

Credentials die at their epoch's `not_after`. A purchase is refused when the epoch
would end before the bundle is worth buying: bundles are indivisible, so buying
`k` an hour before the cliff buys most of a bundle's worth of nothing.

---

## 6. Vocabulary

[`CONTEXT.md`](CONTEXT.md) is the glossary, and it is worth reading before the
code: three systems meet here and each has a word for something the others also
name. Terms already fixed by [anytoon's glossary][anytoon-context] or by the
connector's are not redefined — notably **rate**, **spread** and **segment**.

One collision to know about: anytoon defines **payer** as the identity it collects
*from*. Here it is us. Same channel, opposite sides.

[anyone]: https://www.anyone.io
[toon]: https://github.com/toon-protocol
[anytoon]: https://github.com/toon-protocol/anytoon
[anytoon-context]: https://github.com/toon-protocol/anytoon/blob/main/CONTEXT.md
