import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { config } from '../config.js';
import { AppError } from '../errors.js';

/**
 * Deposit address derivation — public material only.
 *
 * The API holds a watch-only extended public key (an xpub of, by default,
 * `m/44'/60'/0'/0`) and derives child addresses from it. It therefore *cannot*
 * spend: `HDKey.fromExtendedKey(xpub).privateKey` is null, and BIP-32 makes
 * non-hardened public derivation possible while hardened derivation from a public
 * key is mathematically unavailable.
 *
 * This is the deliberate inverse of the system this replaces, which generated a
 * fresh mnemonic per wallet and stored both the mnemonic and the private key as
 * plaintext columns. Here the database holds an address and an index; a full
 * dump grants an attacker the ability to watch, and nothing else.
 *
 * Signing exists only in the separate sweep component, which is a later phase and
 * is the only thing that ever sees the mnemonic.
 */

let cachedAccount: HDKey | null = null;
let cachedXpub: string | null = null;

function accountKey(): HDKey {
  if (cachedAccount && cachedXpub === config.crypto.depositXpub) {
    return cachedAccount;
  }

  const xpub = config.crypto.depositXpub.trim();
  if (!xpub) {
    throw new AppError(
      'CRYPTO_PAYMENTS_DISABLED',
      'No deposit key is configured, so no address can be issued.',
    );
  }

  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(xpub);
  } catch {
    throw new AppError(
      'DEPOSIT_ADDRESS_UNAVAILABLE',
      'The configured deposit key could not be parsed.',
    );
  }

  // Defence in depth. `config.ts` already refuses an xprv at boot; if a private
  // key reaches this far anyway, refuse rather than quietly hold spend capability
  // in the web process.
  if (key.privateKey !== null) {
    throw new AppError(
      'DEPOSIT_ADDRESS_UNAVAILABLE',
      'The configured deposit key carries private material and was rejected.',
    );
  }

  cachedAccount = key;
  cachedXpub = config.crypto.depositXpub;
  return key;
}

/**
 * EVM address for a compressed secp256k1 public key.
 *
 * Keccak-256 of the 64-byte uncompressed point without its `0x04` prefix, last
 * 20 bytes. Node's built-in `crypto` only ships NIST SHA-3, which is a different
 * padding and yields different digests, hence `@noble/hashes`.
 */
function addressFromCompressedPublicKey(compressed: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  return `0x${Buffer.from(hash.subarray(-20)).toString('hex')}`;
}

/** Lowercase form used for storage and comparison. */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/**
 * EIP-55 checksummed form, for display.
 *
 * Wallets and explorers show mixed case, and a buyer comparing what the app shows
 * against what their wallet shows should not have to wonder about the difference.
 * Comparison always uses the lowercase form; this is presentation only.
 */
export function toChecksumAddress(address: string): string {
  const lower = normalizeAddress(address).replace(/^0x/, '');
  const hash = Buffer.from(keccak_256(Buffer.from(lower, 'ascii'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i]!;
    // Digits have no case; letters uppercase when the matching nibble is >= 8.
    out += parseInt(hash[i]!, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

export interface DerivedAddress {
  index: number;
  address: string;
  path: string;
}

/** Derives the address at one child index of the configured account. */
export function deriveDepositAddress(index: number): DerivedAddress {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
    throw new Error(`Derivation index out of range: ${index}`);
  }

  const child = accountKey().deriveChild(index);
  if (!child.publicKey) {
    throw new AppError(
      'DEPOSIT_ADDRESS_UNAVAILABLE',
      'Address derivation produced no public key.',
    );
  }

  return {
    index,
    address: normalizeAddress(addressFromCompressedPublicKey(child.publicKey)),
    path: `${config.crypto.derivationBasePath}/${index}`,
  };
}

/** Whether a usable watch-only key is configured. Used by /health and guards. */
export function isDerivationAvailable(): boolean {
  if (!config.crypto.depositXpub) return false;
  try {
    accountKey();
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the parsed key when config is swapped between tests. */
export function resetDerivationCache(): void {
  cachedAccount = null;
  cachedXpub = null;
}
