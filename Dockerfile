# tuzzy — buys Anyone Protocol circuit credentials over TOON, in USDC.
#
# WHY THIS FILE EXISTS. tuzzy is operated by whoever operates the crawler, and
# asking that operator for a Node checkout is asking them to adopt a second
# toolchain beside the one they already keep alive. The image makes the three
# commands `docker run` arguments:
#
#   docker run --rm -v tuzzy-data:/data -e TUZZY_... ghcr.io/toon-protocol/tuzzy buy
#   docker run --rm -v tuzzy-data:/data              ghcr.io/toon-protocol/tuzzy take
#
# ── /data IS THE VALUABLE THING, NOT THE IMAGE ───────────────────────────────
# The image is disposable and interchangeable with any other build of the same
# tag. The volume is neither, and it holds two things with different failure
# modes:
#
#   pool.json      Bearer material. Credentials are single-use tokens that the
#                  issuer that signed them cannot recognise, so nobody can
#                  reissue one. Losing this file loses money. NO POOL IS EVER
#                  BAKED IN -- see .dockerignore, which denies the whole context
#                  and then allows three paths back.
#   channels.json  A nonce watermark that is NOT on chain. A fresh store against
#                  a live channel re-signs at nonces the connector has already
#                  banked, and every purchase comes back `F01 ... nonce does not
#                  advance this channel's watermark (replay)` until it resyncs.
#
# BOTH DEFAULT ONTO THE ONE VOLUME, deliberately. An image invites "just delete
# the container and start again", and the reflex is only survivable if there is
# a single thing to keep and it is obvious. Two volumes, or a channel store left
# on the container's own filesystem, is the same mistake with a slower fuse.
#
# ── No build step ────────────────────────────────────────────────────────────
# Node 24 strips the types itself, so `src/` ships as TypeScript and is what
# runs. There is no tsconfig in this repository and there must not be one: a
# compile step here would be a second artifact to keep honest for no gain.

# -- Stage 1: the production dependency closure -------------------------------
FROM node:24-alpine AS deps

WORKDIR /app

# Manifests only, so a change under src/ reuses this layer.
COPY package.json package-lock.json ./
# --omit=dev: the test runner is node's own and the tests do not ship.
# --ignore-scripts: nothing in this closure declares a lifecycle script, and an
# install that suddenly wants to run one is a change worth failing on.
RUN npm ci --omit=dev --ignore-scripts

# Strip what only a compiler or a human reads. Files only, never directory
# names: `test/` and `examples/` are real, resolvable source inside some
# packages, so pruning by directory breaks module resolution at boot instead of
# at build time.
RUN find node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
      -o -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete

# The closure is meant to be pure JavaScript -- no native binding anywhere, which
# is what makes one image work on amd64 and arm64 alike. Fail the build if that
# stops being true rather than shipping an image that boots on one arch only.
RUN if find node_modules -name '*.node' -print -quit | grep -q .; then \
      echo "ERROR: a native module entered the runtime closure:" >&2; \
      find node_modules -name '*.node' >&2; \
      exit 1; \
    fi

# -- Stage 2: runtime ---------------------------------------------------------
FROM node:24-alpine

WORKDIR /app

# `node` (uid 1000) comes with the base image. tuzzy runs as it and owns nothing
# under /app: a process that holds bearer material has no business being able to
# rewrite the code that spends it.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# THE ONE VOLUME. Created here, owned by `node` and 0700, because docker seeds a
# fresh named volume from the image's directory -- ownership and mode included.
# Without this a new volume arrives root-owned and the first `buy` dies on write;
# with it, the directory that holds bearer material is unreadable to anyone else
# in the container. The pool file itself is written 0600 by src/pool.ts.
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data

# Both paths on that volume. Overriding either to point off /data is how state
# gets lost -- see the header.
ENV NODE_ENV=production \
    TUZZY_POOL=/data/pool.json \
    TUZZY_CHANNEL_STORE=/data/channels.json

# Declared so `docker run` without `-v` still keeps the state somewhere rather
# than in a layer that dies with the container. An anonymous volume is not a
# plan, though: name it, because a name is what survives `docker rm`.
VOLUME ["/data"]

# `tuzzy` is the bin package.json already declares. The symlink resolves to a
# `.ts` path, which is what tells node to strip types, and it is made while still
# root because /usr/local/bin is not the unprivileged user's to write.
RUN ln -s /app/src/tuzzy.ts /usr/local/bin/tuzzy

USER node

# The container's argument list is the CLI's: `docker run ... tuzzy buy` runs
# `tuzzy buy`.
ENTRYPOINT ["tuzzy"]
# `status` reads the pool and nothing else -- no config, no network. It is the
# one command that is safe as a default, and it is how you check a mount.
CMD ["status"]
