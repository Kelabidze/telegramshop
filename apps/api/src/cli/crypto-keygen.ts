import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * Generates the deposit key material, or derives the watch-only half of an
 * existing mnemonic.
 *
 *   npm run crypto:keygen -w @shop/api            # new mnemonic + xpub
 *   npm run crypto:keygen -w @shop/api -- --xpub  # xpub only, from stdin
 *
 * Deliberate properties:
 *
 *  - **Nothing is written to disk.** No file, no database, no log. The mnemonic
 *    exists in this process's memory and in the terminal scrollback, and that is
 *    all — so there is no artifact to forget about later.
 *  - **The two halves are printed separately**, with only the xpub marked as the
 *    value that belongs in the API's environment. Copying the wrong one into
 *    `api.env` would give the web process the ability to spend, which the config
 *    loader then refuses at boot; this makes the distinction hard to miss in the
 *    first place.
 *  - **Run it on a machine you trust**, not on the production server over SSH: a
 *    mnemonic in a server's scrollback or shell history is a mnemonic in a backup.
 *
 * The mnemonic is needed only by the (future) sweep component. Until sweeping
 * exists, the correct place for it is an offline password manager — the shop can
 * take payments with the xpub alone.
 */

const HARDENED_ACCOUNT_PATH = "m/44'/60'/0'/0";

function box(title: string, lines: string[]): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  for (const line of lines) console.log(line);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  const xpubOnly = process.argv.includes('--xpub');

  let mnemonic: string;
  if (xpubOnly) {
    console.log('Paste the mnemonic, then press Ctrl+D (Ctrl+Z on Windows):');
    mnemonic = await readStdin();
    if (!validateMnemonic(mnemonic, wordlist)) {
      console.error('\nThat is not a valid BIP-39 mnemonic.');
      process.exitCode = 1;
      return;
    }
  } else {
    // 256 bits -> 24 words. More than the 12-word minimum because this single
    // phrase is the only thing standing between a backup leak and the float.
    mnemonic = generateMnemonic(wordlist, 256);
  }

  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  const xpub = root.derive(HARDENED_ACCOUNT_PATH).publicExtendedKey;

  // Sanity check the watch-only half before telling anyone to rely on it.
  const watchOnly = HDKey.fromExtendedKey(xpub);
  if (watchOnly.privateKey !== null) {
    console.error('\nRefusing to print: the derived key carries private material.');
    process.exitCode = 1;
    return;
  }

  if (!xpubOnly) {
    box('SECRET — the mnemonic', [
      '',
      mnemonic,
      '',
      'This is the ONLY thing that can move the funds. It is not stored anywhere:',
      'not in the database, not in a file, not in any log. Write it down now.',
      '',
      'Where it belongs:   an offline password manager, or paper.',
      'Where it does NOT:  api.env, the repository, a chat, a server\'s shell history.',
      '',
      'The shop takes payments WITHOUT it — only the future sweep component needs it.',
    ]);
  }

  box('PUBLIC — for the server', [
    '',
    `CRYPTO_DEPOSIT_XPUB="${xpub}"`,
    `CRYPTO_DERIVATION_BASE_PATH="${HARDENED_ACCOUNT_PATH}"`,
    '',
    'Safe to paste into api.env. It derives addresses and cannot spend.',
  ]);

  /*
   * Show the first few addresses so the operator can verify the same key in a
   * wallet before sending anyone's money to it.
   *
   * Derived here rather than through `crypto/addresses.ts`, because that module
   * reads the key from `config`, which is frozen at import time — this tool is the
   * thing that produces the key, so it has nothing to read yet. The address
   * calculation itself is shared: `addressFromPublicKey` below is the same
   * keccak-of-uncompressed-point rule, and `chain.test.ts` pins that rule against
   * published vectors, so the two cannot silently diverge.
   */
  box('First deposit addresses', [
    '',
    ...[0, 1, 2].map((index) => {
      const child = watchOnly.deriveChild(index);
      if (!child.publicKey) throw new Error(`No public key at index ${index}`);
      return `  ${HARDENED_ACCOUNT_PATH}/${index}  ${addressFromPublicKey(child.publicKey)}`;
    }),
    '',
    'Import the mnemonic into a wallet and check it shows these same addresses',
    'BEFORE taking real payments. A mismatch means funds would be unrecoverable.',
  ]);

  console.log('');
}

/** keccak256 of the uncompressed point, last 20 bytes. Standard EVM address. */
function addressFromPublicKey(compressed: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  return `0x${Buffer.from(hash.subarray(-20)).toString('hex')}`;
}

await main();
