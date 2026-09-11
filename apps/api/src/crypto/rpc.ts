import { config } from '../config.js';

/**
 * Minimal BSC JSON-RPC client.
 *
 * Two properties matter more than features:
 *
 * 1. **Failover applies to every call.** Not just to block-number lookups. The
 *    exchanger this replaces exposed its primary provider directly for
 *    `getLogs` and `balanceOf`, so the endpoints carrying all of its real
 *    traffic had no fallback at all while the config claimed otherwise.
 *
 * 2. **Numbers are `bigint`.** Block numbers and token amounts both outgrow the
 *    safe integer range; hex in, bigint out, no `Number()` in between.
 *
 * No dependency: `fetch` is built in, and the surface used here is four methods.
 */

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface RpcBlockHeader {
  number: string;
  hash: string;
}

export interface RpcTransactionReceipt {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  /** '0x1' success, '0x0' reverted. */
  status: string;
}

export interface GetLogsFilter {
  address: string;
  fromBlock: bigint;
  toBlock: bigint;
  /** Positional topics; `null` means "any" in that slot. */
  topics: (string | null)[];
}

export class RpcError extends Error {
  readonly endpoint: string;

  constructor(message: string, endpoint: string) {
    super(message);
    this.name = 'RpcError';
    this.endpoint = endpoint;
  }
}

/** Hex quantity (`0x1a`) -> bigint. Rejects anything else. */
export function hexToBigInt(hex: string): bigint {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Malformed hex quantity: ${JSON.stringify(hex)}`);
  }
  return BigInt(hex);
}

export function bigIntToHex(value: bigint): string {
  if (value < 0n) throw new Error('Cannot encode a negative quantity');
  return `0x${value.toString(16)}`;
}

interface RpcStats {
  calls: number;
  failures: number;
  fallbackUses: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export class BscRpcClient {
  private readonly endpoints: string[];
  private readonly timeoutMs: number;
  private nextId = 1;
  /**
   * Which endpoint to try first.
   *
   * Sticky after a failover: retrying a known-dead endpoint on every single call
   * would pay its full timeout twice per call. It rotates back naturally the
   * next time the preferred one fails.
   */
  private preferred = 0;
  private readonly stats: RpcStats = {
    calls: 0,
    failures: 0,
    fallbackUses: 0,
    lastError: null,
    lastErrorAt: null,
  };

  constructor(endpoints: string[], timeoutMs = 10_000) {
    if (endpoints.length === 0) {
      throw new Error('At least one RPC endpoint is required');
    }
    this.endpoints = endpoints;
    this.timeoutMs = timeoutMs;
  }

  getStats(): Readonly<RpcStats> & { endpointCount: number; preferredIndex: number } {
    return { ...this.stats, endpointCount: this.endpoints.length, preferredIndex: this.preferred };
  }

  /**
   * One JSON-RPC call, tried against every endpoint in turn.
   *
   * A JSON-RPC *error object* is not retried on the next endpoint: it means the
   * node understood the request and refused it, so asking a second node the same
   * malformed question wastes a round trip and hides the real problem. Transport
   * failures and malformed responses do fail over.
   */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    this.stats.calls += 1;
    const order = this.endpointOrder();
    let lastError: Error | null = null;

    for (const index of order) {
      const endpoint = this.endpoints[index]!;
      try {
        const result = await this.callEndpoint<T>(endpoint, method, params);
        if (index !== this.preferred) {
          this.stats.fallbackUses += 1;
          this.preferred = index;
        }
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;
        this.stats.failures += 1;
        this.stats.lastError = `${method}: ${err.message}`;
        this.stats.lastErrorAt = new Date().toISOString();
        if (err instanceof RpcError) {
          // Node-level refusal: same answer everywhere, so stop here.
          throw err;
        }
      }
    }

    throw new Error(
      `All ${this.endpoints.length} RPC endpoint(s) failed for ${method}: ${lastError?.message ?? 'unknown error'}`,
    );
  }

  private endpointOrder(): number[] {
    const order = [this.preferred];
    for (let i = 0; i < this.endpoints.length; i += 1) {
      if (i !== this.preferred) order.push(i);
    }
    return order;
  }

  private async callEndpoint<T>(
    endpoint: string,
    method: string,
    params: unknown[],
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextId++,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Transport-level: worth trying the other endpoint.
        throw new Error(`HTTP ${response.status} from ${hostOf(endpoint)}`);
      }

      const body = (await response.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };

      if (body.error) {
        throw new RpcError(
          `${body.error.message ?? 'unknown RPC error'} (code ${body.error.code ?? '?'})`,
          hostOf(endpoint),
        );
      }
      if (body.result === undefined) {
        throw new Error(`Empty result from ${hostOf(endpoint)}`);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async getBlockNumber(): Promise<bigint> {
    return hexToBigInt(await this.call<string>('eth_blockNumber', []));
  }

  /**
   * The finalised head, or null when the endpoint cannot answer.
   *
   * BSC exposes the `finalized` tag and both configured endpoints serve it, so
   * this is the primary finality signal rather than a confirmation count. Null is
   * returned instead of throwing precisely so the caller can fall back to a
   * depth rule without treating "unknown" as "final".
   */
  async getFinalizedBlockNumber(): Promise<bigint | null> {
    try {
      const header = await this.call<RpcBlockHeader | null>(
        'eth_getBlockByNumber',
        ['finalized', false],
      );
      if (!header?.number) return null;
      return hexToBigInt(header.number);
    } catch {
      return null;
    }
  }

  async getBlockHash(blockNumber: bigint): Promise<string | null> {
    const header = await this.call<RpcBlockHeader | null>(
      'eth_getBlockByNumber',
      [bigIntToHex(blockNumber), false],
    );
    return header?.hash ?? null;
  }

  async getTransactionReceipt(txHash: string): Promise<RpcTransactionReceipt | null> {
    return this.call<RpcTransactionReceipt | null>('eth_getTransactionReceipt', [
      txHash,
    ]);
  }

  async getLogs(filter: GetLogsFilter): Promise<RpcLog[]> {
    return this.call<RpcLog[]>('eth_getLogs', [
      {
        address: filter.address,
        fromBlock: bigIntToHex(filter.fromBlock),
        toBlock: bigIntToHex(filter.toBlock),
        topics: filter.topics,
      },
    ]);
  }
}

/** Host only: an endpoint URL can carry an API key in its path. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'rpc';
  }
}

let cached: BscRpcClient | null = null;

/** Process-wide client, so the sticky endpoint preference is actually shared. */
export function getRpcClient(): BscRpcClient {
  cached ??= new BscRpcClient([...config.crypto.rpcUrls]);
  return cached;
}
