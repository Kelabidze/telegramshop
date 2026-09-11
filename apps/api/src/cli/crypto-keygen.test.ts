import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The key generator and the server must agree on what an address is.
 *
 * They compute addresses in two places: `crypto/addresses.ts` reads the xpub from
 * `config`, while `cli/crypto-keygen.ts` cannot вЂ” it is the thing producing the
 * key, so there is nothing configured yet. Two implementations of the same rule is
 * a real risk, and the failure mode is the worst one available: the operator
 * verifies the printed addresses against their wallet, the server then derives
 * different ones, and buyers pay into addresses nobody holds the key for.
 *
 * So this runs the generator as a subprocess and re-derives the same addresses
 * through the server's own module.
 */

// This file lives in src/cli, so the package root is two levels up.
const apiRoot = path.resolve(import.meta.dirname, '..', '..');

describe('crypto:keygen', () => {
  it('prints addresses the server derives identically', () => {
    const output = execFileSync(
      'npx',
      ['tsx', 'src/cli/crypto-keygen.ts'],
      {
        cwd: apiRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      },
    );

    const xpub = /CRYPTO_DEPOSIT_XPUB="(xpub[0-9a-zA-Z]+)"/.exec(output)?.[1];
    assert.ok(xpub, `no xpub in output:\n${output}`);

    const printed = [...output.matchAll(/\/0\/(\d)\s+(0x[0-9a-f]{40})/g)].map(
      (match) => ({ index: Number(match[1]), address: match[2]! }),
    );
    assert.equal(printed.length, 3, 'expected three sample addresses');

    /*
     * Re-derive through the server's module in a subprocess, so the `config` it
     * reads at import time sees this xpub.
     *
     * A temp script file rather than `tsx -e`: the inline form goes through the
     * shell on Windows, which mangles the quoting.
     */
    // `.mts`, because a temp file outside the workspace has no package.json to
    // mark it as ESM and top-level await would be rejected as CJS.
    const scriptPath = path.join(mkdtempSync(path.join(tmpdir(), 'keygen-check-')), 'check.mts');
    // A file URL, not a Windows path: dynamic import rejects `C:\...` as an
    // unsupported URL scheme.
    const moduleUrl = pathToFileURL(
      path.join(apiRoot, 'src/crypto/addresses.ts'),
    ).href;
    writeFileSync(
      scriptPath,
      [
        `const m = await import(${JSON.stringify(moduleUrl)});`,
        `console.log([0,1,2].map((i) => m.deriveDepositAddress(i).address).join(','));`,
      ].join('\n'),
      'utf8',
    );

    const check = execFileSync('npx', ['tsx', scriptPath], {
      cwd: apiRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        CRYPTO_PAYMENTS_ENABLED: 'true',
        CRYPTO_DEPOSIT_XPUB: xpub,
        LOG_LEVEL: 'silent',
      },
    });

    const serverAddresses = check.trim().split('\n').at(-1)!.split(',');
    for (const { index, address } of printed) {
      assert.equal(
        serverAddresses[index],
        address,
        `index ${index}: keygen printed ${address}, server derives ${serverAddresses[index]}`,
      );
    }
  });

  it('never prints private key material alongside the public half', () => {
    const output = execFileSync('npx', ['tsx', 'src/cli/crypto-keygen.ts'], {
      cwd: apiRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    // An xprv in this output would be a private key printed as if it were the
    // value to paste into api.env.
    assert.ok(!output.includes('xprv'), 'output contains an extended private key');
    // And the env line must carry the watch-only key, not the mnemonic.
    const envLine = /CRYPTO_DEPOSIT_XPUB="([^"]*)"/.exec(output)?.[1] ?? '';
    assert.ok(envLine.startsWith('xpub'), `env value is not an xpub: ${envLine.slice(0, 8)}`);
    assert.ok(
      envLine.split(/\s+/).length === 1,
      'the env value looks like a phrase rather than a key',
    );
  });
});
