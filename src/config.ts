/**
 * Everything tuzzy needs to know, from the environment.
 *
 * Env rather than a config file, and flags only where a run differs from the
 * last: this is a CLI on a timer, so the invocation is the thing an operator
 * edits, and a second file to keep in sync with the crawler's own deployment is
 * a second thing to get wrong.
 *
 * Note what is NOT here: a price. The price is read from the connector at the
 * moment of purchase (`client.price`), never configured -- bootstrapping is one
 * `GET`, and a configured price that disagrees with the node's is a 402 on every
 * paid request. `PRICE_CEILING_UNITS` is a different thing: a refusal to pay
 * above a number, not a belief about what the number is.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** The connector we hold a channel with. Our own edge, not the issuer's. */
  readonly connector: string;
  /**
   * Where the envelope is opened, for a route the connector forwards rather
   * than terminates. `undefined` when we buy from a node we peer with directly.
   */
  readonly sealTo: string | undefined;
  /**
   * Where the epoch key document is free.
   *
   * The issuing node prices it at zero on its OWN edge -- a buyer needs the key
   * before it can blind anything, so charging for it would make the protocol
   * undiscoverable. Reaching that node through someone else's hub is a different
   * matter: the hub prices the route like any other, so the cheap way to the key
   * is straight at the issuer, with no channel at all.
   *
   * Equal to `connector` when we buy from the issuing node directly -- which is
   * the production shape, where its `.anyone` address is the only way in.
   */
  readonly keysConnector: string;
  /** The chain the issuing node settles on. Only used to reach its free route. */
  readonly keysChain: 'evm' | 'solana' | undefined;
  readonly bundlesRoute: string;
  readonly keysRoute: string;
  readonly bundleSize: number;
  /** Base units of OUR OWN money. A purchase above this is refused, not paid. */
  readonly priceCeiling: bigint;
  readonly pool: string;
  readonly channelStore: string;
  readonly lowWater: number;
  readonly minEpochRemainingMs: number;
  readonly chain: 'evm' | 'solana' | undefined;
  readonly rpcUrl: string | undefined;
  readonly mnemonic: string | undefined;
  readonly evmPrivateKey: string | undefined;
  readonly deposit: bigint;
  readonly socksProxy: string | undefined;
  readonly timeoutMs: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} is not a number: ${raw}`);
  return parsed;
}

function big(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} is not an integer: ${raw}`);
  }
}

/**
 * A `.anyone` connector needs a SOCKS proxy and a clearnet one must not be given
 * a SOCKS proxy -- the client rejects the second as pointless misdirection -- so
 * the two are decided together rather than independently.
 */
function socksFor(connector: string): string | undefined {
  const proxy = process.env.TUZZY_SOCKS_PROXY;
  let host = '';
  try {
    host = new URL(connector).hostname;
  } catch {
    throw new Error(`TUZZY_CONNECTOR is not a URL: ${connector}`);
  }

  if (!host.endsWith('.anyone')) {
    if (proxy !== undefined && proxy !== '') {
      throw new Error(
        `TUZZY_SOCKS_PROXY is set but ${host} is not a hidden service. ` +
          'The client refuses a proxy it has no use for; unset one or the other.',
      );
    }
    return undefined;
  }

  if (proxy === undefined || proxy === '') {
    throw new Error(
      `${host} is a hidden service and needs a SOCKS5 proxy to reach at all. ` +
        'Set TUZZY_SOCKS_PROXY (e.g. "socks5h://127.0.0.1:9050").',
    );
  }
  // socks5h, not socks5: no local resolver resolves a `.anyone` name, so a
  // socks5:// proxy resolves locally, fails, and says nothing that explains why.
  if (!proxy.startsWith('socks5h://')) {
    throw new Error(`TUZZY_SOCKS_PROXY must be socks5h:// (the proxy must resolve the name): ${proxy}`);
  }
  return proxy;
}

export function fromEnv(): Config {
  const connector = process.env.TUZZY_CONNECTOR ?? 'http://127.0.0.1:3000';
  const bundlesRoute = process.env.TUZZY_ROUTE ?? 'g.anyone.credentials';
  const chain = process.env.TUZZY_CHAIN as Config['chain'];
  if (chain !== undefined && chain !== 'evm' && chain !== 'solana') {
    throw new Error(`TUZZY_CHAIN must be "evm" or "solana": ${chain}`);
  }
  const keysChain = (process.env.TUZZY_KEYS_CHAIN ?? process.env.TUZZY_CHAIN) as Config['chain'];
  if (keysChain !== undefined && keysChain !== 'evm' && keysChain !== 'solana') {
    throw new Error(`TUZZY_KEYS_CHAIN must be "evm" or "solana": ${keysChain}`);
  }

  return {
    connector,
    sealTo: process.env.TUZZY_SEAL_TO ?? undefined,
    // Defaults to the connector we pay: the direct case, where the issuing node
    // is the node we hold a channel with.
    keysConnector: process.env.TUZZY_KEYS_CONNECTOR ?? connector,
    keysChain,
    bundlesRoute,
    keysRoute: `${bundlesRoute}.keys`,
    bundleSize: num('TUZZY_BUNDLE_SIZE', 10),
    // No default. A ceiling is a commercial decision and a wrong guess here
    // either blocks every purchase or defeats the point of having one.
    priceCeiling: big('TUZZY_PRICE_CEILING', -1n),
    pool: process.env.TUZZY_POOL ?? join(process.cwd(), 'data', 'pool.json'),
    channelStore: process.env.TUZZY_CHANNEL_STORE ?? join(homedir(), '.toon', 'channels.json'),
    lowWater: num('TUZZY_LOW_WATER', 20),
    // Twice the longest plausible rate outage, so a purchase is never the thing
    // that discovers an epoch was about to roll.
    minEpochRemainingMs: num('TUZZY_MIN_EPOCH_REMAINING_MS', 2 * 3_600_000),
    chain,
    rpcUrl: process.env.TUZZY_RPC_URL ?? undefined,
    mnemonic: process.env.TUZZY_MNEMONIC ?? undefined,
    evmPrivateKey: process.env.TUZZY_EVM_PRIVATE_KEY ?? undefined,
    deposit: big('TUZZY_DEPOSIT', 10_000_000n),
    socksProxy: socksFor(connector),
    timeoutMs: num('TUZZY_TIMEOUT_MS', 60_000),
  };
}
