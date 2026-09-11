import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * Address derivation and Transfer log parsing.
 *
 * Env is set before the local imports because `config.ts` reads `process.env` at
 * module load — the same pattern the other API test files use.
 *
 * The xpub below is derived from the publicly documented Hardhat/Foundry test
 * mnemonic ("test test … junk"). It is a watch-only key for a well-known throwaway
 * account, so committing it leaks nothing, and it lets the expected addresses be
 * hard-coded from a published source rather than from this implementation's own
 * output — a test that only compares the code against itself would pass even if
 * the derivation were wrong.
 */

// m/44'/60'/0'/0 of the Hardhat test mnemonic.
const TEST_XPUB =
  'xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4';

const EXPECTED_ADDRESSES = [
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
];

process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'silent';
process.env.CRYPTO_PAYMENTS_ENABLED = 'true';
process.env.CRYPTO_DEPOSIT_XPUB = TEST_XPUB;
process.env.CRYPTO_DERIVATION_BASE_PATH = "m/44'/60'/0'/0";
process.env.USDT_CONTRACT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

type AddressesModule = typeof import('./addresses.js');
type UsdtModule = typeof import('./usdt.js');
type RpcModule = typeof import('./rpc.js');

let addresses: AddressesModule;
let usdt: UsdtModule;
let rpc: RpcModule;

before(async () => {
  addresses = await import('./addresses.js');
  usdt = await import('./usdt.js');
  rpc = await import('./rpc.js');
});

describe('deposit address derivation', () => {
  it('matches the published addresses for a known key', () => {
    // Against an external source of truth, not against ourselves.
    for (const [index, expected] of EXPECTED_ADDRESSES.entries()) {
      assert.equal(addresses.deriveDepositAddress(index).address, expected);
    }
  });

  it('is deterministic: the same index always gives the same address', () => {
    for (const index of [0, 1, 7, 42, 1_000]) {
      const first = addresses.deriveDepositAddress(index);
      const second = addresses.deriveDepositAddress(index);
      assert.equal(first.address, second.address);
      assert.equal(first.path, second.path);
    }
  });

  it('gives every index a distinct address', () => {
    // One address per payment is what makes an incoming transfer attributable;
    // a collision would make two payments indistinguishable.
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const { address } = addresses.deriveDepositAddress(index);
      assert.ok(!seen.has(address), `duplicate address at index ${index}`);
      seen.add(address);
    }
  });

  it('records the full derivation path, for later signing', () => {
    assert.equal(addresses.deriveDepositAddress(5).path, "m/44'/60'/0'/0/5");
  });

  it('stores addresses lowercase and displays them checksummed', () => {
    const { address } = addresses.deriveDepositAddress(0);
    assert.equal(address, address.toLowerCase());

    // EIP-55 of the first Hardhat account, as every explorer renders it.
    assert.equal(
      addresses.toChecksumAddress(address),
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    );
    // Case is presentation only: the two must still be the same address.
    assert.equal(
      addresses.normalizeAddress(addresses.toChecksumAddress(address)),
      address,
    );
  });

  it('refuses an index outside the non-hardened range', () => {
    assert.throws(() => addresses.deriveDepositAddress(-1), /out of range/);
    assert.throws(() => addresses.deriveDepositAddress(1.5), /out of range/);
    assert.throws(() => addresses.deriveDepositAddress(2 ** 31), /out of range/);
  });

  it('reports the configured key as usable', () => {
    assert.equal(addresses.isDerivationAvailable(), true);
  });
});

describe('BEP20 Transfer log parsing', () => {
  const CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
  const TO = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const FROM = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

  function log(overrides: Record<string, unknown> = {}) {
    return {
      address: CONTRACT,
      topics: [
        usdt.TRANSFER_TOPIC,
        usdt.addressToTopic(FROM),
        usdt.addressToTopic(TO),
      ],
      // 15 USDT = 15 × 10^18 wei, as a 32-byte word.
      data: `0x${(15n * 10n ** 18n).toString(16).padStart(64, '0')}`,
      blockNumber: '0x1e8480',
      blockHash: `0x${'ab'.repeat(32)}`,
      transactionHash: `0x${'cd'.repeat(32)}`,
      logIndex: '0x3',
      ...overrides,
    };
  }

  it('computes the documented Transfer event signature', () => {
    // keccak256("Transfer(address,address,uint256)") — the canonical ERC20 topic0.
    assert.equal(
      usdt.TRANSFER_TOPIC,
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );
  });

  it('decodes every field of a well-formed log', () => {
    const parsed = usdt.parseTransferLog(log());
    assert.ok(parsed);
    assert.equal(parsed.from, FROM);
    assert.equal(parsed.to, TO);
    assert.equal(parsed.amountWei, 15n * 10n ** 18n);
    assert.equal(parsed.blockNumber, 2_000_000n);
    assert.equal(parsed.logIndex, 3);
    assert.equal(parsed.txHash, `0x${'cd'.repeat(32)}`);
    assert.equal(parsed.blockHash, `0x${'ab'.repeat(32)}`);
  });

  it('uses BigInt, so an amount past 2^53 survives intact', () => {
    // 12_345_678.9 USDT — well beyond what a JS number holds exactly.
    const huge = 12_345_678_900_000_000_000_000_000n;
    const parsed = usdt.parseTransferLog(
      log({ data: `0x${huge.toString(16).padStart(64, '0')}` }),
    );
    assert.equal(parsed?.amountWei, huge);
  });

  it('rejects a log from a different contract', () => {
    // The server-side filter should prevent this; the check is the last gate
    // before an amount becomes money.
    assert.equal(usdt.parseTransferLog(log({ address: `0x${'11'.repeat(20)}` })), null);
  });

  it('rejects a different event with the right shape', () => {
    assert.equal(
      usdt.parseTransferLog(log({ topics: [`0x${'99'.repeat(32)}`, usdt.addressToTopic(FROM), usdt.addressToTopic(TO)] })),
      null,
    );
  });

  it('rejects a log marked removed by the node', () => {
    // `removed: true` means the block left the canonical chain.
    assert.equal(usdt.parseTransferLog(log({ removed: true })), null);
  });

  it('rejects zero-value transfers, which settle nothing', () => {
    assert.equal(usdt.parseTransferLog(log({ data: `0x${'0'.repeat(64)}` })), null);
  });

  it('rejects malformed hashes and quantities rather than guessing', () => {
    assert.equal(usdt.parseTransferLog(log({ transactionHash: '0xshort' })), null);
    assert.equal(usdt.parseTransferLog(log({ blockHash: 'nonsense' })), null);
    assert.equal(usdt.parseTransferLog(log({ blockNumber: 'not-hex' })), null);
    assert.equal(usdt.parseTransferLog(log({ data: '0xzz' })), null);
    assert.equal(usdt.parseTransferLog(log({ topics: [usdt.TRANSFER_TOPIC] })), null);
  });

  it('filters server-side on contract, event and destination', () => {
    const filter = usdt.transferToAddressFilter(TO, 100n, 200n);
    assert.equal(filter.address, CONTRACT);
    assert.equal(filter.fromBlock, 100n);
    assert.equal(filter.toBlock, 200n);
    // topic0 pins the event, topic1 (`from`) stays open, topic2 pins the
    // destination. Without topic2 the query returns every USDT transfer on BSC.
    assert.equal(filter.topics[0], usdt.TRANSFER_TOPIC);
    assert.equal(filter.topics[1], null);
    assert.equal(filter.topics[2], usdt.addressToTopic(TO));
  });

  it('pads an address into a 32-byte topic', () => {
    const topic = usdt.addressToTopic(TO);
    assert.equal(topic.length, 66);
    assert.ok(topic.endsWith(TO.slice(2)));
    assert.equal(topic.slice(0, 26), `0x${'0'.repeat(24)}`);
  });
});

describe('hex encoding', () => {
  it('decodes hex quantities as BigInt', () => {
    assert.equal(rpc.hexToBigInt('0x0'), 0n);
    assert.equal(rpc.hexToBigInt('0x1e8480'), 2_000_000n);
    // A block height that would lose precision as a float.
    assert.equal(
      rpc.hexToBigInt('0x20000000000001'),
      9_007_199_254_740_993n,
    );
  });

  it('rejects malformed quantities', () => {
    for (const bad of ['', '0x', '123', '0xzz', 'null']) {
      assert.throws(() => rpc.hexToBigInt(bad), /Malformed hex quantity/);
    }
  });

  it('round-trips through hex', () => {
    for (const value of [0n, 1n, 255n, 2_000_000n, 10n ** 20n]) {
      assert.equal(rpc.hexToBigInt(rpc.bigIntToHex(value)), value);
    }
  });
});

/**
 * RPC failover, against a local HTTP server rather than the real chain.
 *
 * A live-network test would be non-deterministic and would fail offline — and it
 * could not force a primary failure, which is the only thing worth asserting
 * here. The predecessor system's one blockchain test hit mainnet and never
 * exercised its fallback at all.
 */
describe('RPC failover', () => {
  let servers: { url: string; close: () => Promise<void>; hits: () => number }[] = [];

  async function startServer(
    handler: (body: { method: string; id: number }) => {
      status?: number;
      payload?: unknown;
    },
  ) {
    const { createServer } = await import('node:http');
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw) as { method: string; id: number };
        const { status = 200, payload } = handler(body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload ?? {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const entry = {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      hits: () => hits,
    };
    servers.push(entry);
    return entry;
  }

  after(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });

  it('falls back to the second endpoint when the first is unreachable', async () => {
    const good = await startServer((body) => ({
      payload: { jsonrpc: '2.0', id: body.id, result: '0x1e8480' },
    }));
    // Port 1 on loopback refuses immediately: a transport failure, not a refusal
    // by a working node.
    const client = new rpc.BscRpcClient(['http://127.0.0.1:1', good.url], 2_000);

    assert.equal(await client.getBlockNumber(), 2_000_000n);
    assert.equal(good.hits(), 1);
    assert.equal(client.getStats().fallbackUses, 1);
  });

  it('applies failover to getLogs, not only to block numbers', async () => {
    // The specific defect this replaces: the predecessor exposed its primary
    // provider directly for getLogs, so the call carrying all real traffic had no
    // fallback while the config claimed otherwise.
    const good = await startServer((body) => ({
      payload: { jsonrpc: '2.0', id: body.id, result: [] },
    }));
    const client = new rpc.BscRpcClient(['http://127.0.0.1:1', good.url], 2_000);

    const logs = await client.getLogs({
      address: `0x${'55'.repeat(20)}`,
      fromBlock: 1n,
      toBlock: 2n,
      topics: [],
    });
    assert.deepEqual(logs, []);
    assert.equal(good.hits(), 1);
  });

  it('fails over on an HTTP error status', async () => {
    const bad = await startServer(() => ({ status: 503 }));
    const good = await startServer((body) => ({
      payload: { jsonrpc: '2.0', id: body.id, result: '0x10' },
    }));
    const client = new rpc.BscRpcClient([bad.url, good.url], 2_000);

    assert.equal(await client.getBlockNumber(), 16n);
    assert.equal(bad.hits(), 1);
    assert.equal(good.hits(), 1);
  });

  it('does not retry a JSON-RPC error on the next endpoint', async () => {
    // A node-level refusal means the request itself is wrong: asking a second
    // node the same malformed question wastes a round trip and hides the cause.
    const refusing = await startServer((body) => ({
      payload: {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: 'query returned more than 10000 results' },
      },
    }));
    const other = await startServer((body) => ({
      payload: { jsonrpc: '2.0', id: body.id, result: [] },
    }));
    const client = new rpc.BscRpcClient([refusing.url, other.url], 2_000);

    await assert.rejects(
      () => client.getLogs({ address: '0x1', fromBlock: 1n, toBlock: 2n, topics: [] }),
      /more than 10000 results/,
    );
    assert.equal(other.hits(), 0, 'must not have retried elsewhere');
  });

  it('throws once every endpoint has failed', async () => {
    const client = new rpc.BscRpcClient(
      ['http://127.0.0.1:1', 'http://127.0.0.1:2'],
      1_000,
    );
    await assert.rejects(() => client.getBlockNumber(), /All 2 RPC endpoint\(s\) failed/);
    assert.ok(client.getStats().failures >= 2);
  });

  it('treats an unavailable finalized tag as unknown, never as final', async () => {
    // The safety property behind the whole finality design: "I cannot tell" must
    // not be reported as "settled".
    const noTag = await startServer((body) => ({
      payload: {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'the method is not available' },
      },
    }));
    const client = new rpc.BscRpcClient([noTag.url], 2_000);
    assert.equal(await client.getFinalizedBlockNumber(), null);
  });

  it('keeps API keys out of error messages by reporting host only', async () => {
    const client = new rpc.BscRpcClient(
      ['http://127.0.0.1:1/v2/super-secret-api-key'],
      1_000,
    );
    await assert.rejects(
      () => client.getBlockNumber(),
      (error: Error) => {
        assert.ok(
          !error.message.includes('super-secret-api-key'),
          `error leaked the key: ${error.message}`,
        );
        return true;
      },
    );
  });

  it('refuses to be constructed without an endpoint', () => {
    assert.throws(() => new rpc.BscRpcClient([]), /At least one RPC endpoint/);
  });
});
