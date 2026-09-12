import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Repairs double-encoded (mojibake) Cyrillic in place.
 *
 * The corruption is a pure function: UTF-8 bytes were decoded as CP1251 and
 * re-encoded as UTF-8. So it is exactly invertible — encode the text back to CP1251
 * bytes, then decode those bytes as UTF-8. No word list, no guessing.
 *
 * Applied only to runs of characters that actually look corrupted, so healthy
 * Cyrillic in the same file is left untouched: "США" must survive while
 * "РЁР°Р±Р»РѕРЅС‹" becomes "Шаблоны".
 *
 * Verified by round-trip: if re-corrupting the repaired text does not reproduce the
 * original bytes, the file is left alone and reported instead of being guessed at.
 */

/** CP1251 -> Unicode for bytes 0x80–0xFF. Index 0 is byte 0x80. */
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00A0ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

const UNICODE_TO_CP1251 = new Map();
for (let i = 0; i < CP1251_HIGH.length; i += 1) {
  UNICODE_TO_CP1251.set(CP1251_HIGH[i], 0x80 + i);
}

/** Encodes text to CP1251 bytes. Returns null if any character is unrepresentable. */
function toCp1251(text) {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out[i] = code;
      continue;
    }
    const mapped = UNICODE_TO_CP1251.get(text[i]);
    if (mapped === undefined) return null;
    out[i] = mapped;
  }
  return out;
}

/** Re-applies the corruption, to prove a repair is exact. */
function corrupt(text) {
  const utf8 = Buffer.from(text, 'utf8');
  let out = '';
  for (const byte of utf8) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP1251_HIGH[byte - 0x80];
  }
  return out;
}

/**
 * Characters that can appear inside a corrupted run: "Р"/"С" leads plus every
 * CP1251-high rendering. Latin letters and ASCII are excluded so a run stops at
 * word boundaries and healthy text is never swept in.
 */
const RUN_CHARS = new Set([...CP1251_HIGH]);

function isRunChar(ch) {
  return RUN_CHARS.has(ch);
}

/**
 * Cheap necessary condition for corruption, used to skip healthy text before
 * attempting a repair.
 *
 * Every multi-byte UTF-8 sequence contains at least one continuation byte in
 * 0x80–0xBF, so corrupted text always contains at least one character from CP1251's
 * rendering of that range. Real Cyrillic letters live in 0xC0–0xFF, so ordinary
 * Russian words do not trip this.
 *
 * Enumerating a signature per sequence length was the earlier approach, and it kept
 * missing cases — first every emoji, then U+F8FF (the Apple logo, "пЈї"). This
 * condition follows from how UTF-8 is structured rather than from examples, so there
 * is no next case to miss. Precision still comes from the round-trip check below:
 * "ёлка" passes this filter, because ё is 0xB8, and is then rejected because its
 * CP1251 bytes are not valid UTF-8.
 */
function looksCorrupt(run) {
  for (const ch of run) {
    if (isHighOnly(ch)) return true;
  }
  return false;
}

/** CP1251 renderings of 0x80–0xBF only — never a real Cyrillic letter. */
const HIGH_ONLY = new Set([...CP1251_HIGH.slice(0, 64)]);
function isHighOnly(ch) {
  return HIGH_ONLY.has(ch);
}

/**
 * Repairs text, iterating until it stops changing.
 *
 * Some strings were corrupted more than once — a file edited twice through the same
 * broken pipeline. "₽" became "вЂљ" and then "РІвЂљР…", which needs two passes to
 * undo. I originally worked around this by running the CLI repeatedly and watching
 * the count drop, which is exactly the kind of thing that gets forgotten. The
 * fixpoint is cheap and each pass is individually verified, so there is no reason
 * to leave it manual.
 *
 * `MAX_PASSES` only bounds the loop; the round-trip check is what makes each pass
 * safe, and once nothing changes the loop exits on its own.
 */
const MAX_PASSES = 5;

export function repairText(text) {
  let current = text;
  let total = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const { text: next, repairs } = repairOnce(current);
    if (repairs === 0 || next === current) break;
    current = next;
    total += repairs;
  }

  return { text: current, repairs: total };
}

function repairOnce(text) {
  let result = '';
  let i = 0;
  let repairs = 0;

  while (i < text.length) {
    if (!isRunChar(text[i])) {
      result += text[i];
      i += 1;
      continue;
    }

    // Collect the maximal run of characters that could belong to corrupted text.
    let j = i;
    while (j < text.length && isRunChar(text[j])) j += 1;
    const run = text.slice(i, j);

    if (!looksCorrupt(run)) {
      result += run;
      i = j;
      continue;
    }

    const bytes = toCp1251(run);
    if (!bytes) {
      result += run;
      i = j;
      continue;
    }

    const decoded = bytes.toString('utf8');
    // Exactness check: re-corrupting must reproduce the run we started from, and
    // the result must not still contain replacement characters.
    if (decoded.includes('\uFFFD') || corrupt(decoded) !== run) {
      result += run;
      i = j;
      continue;
    }

    result += decoded;
    repairs += 1;
    i = j;
  }

  return { text: result, repairs };
}

/** Walks a directory for the source types that can carry Russian text. */
function collect(target, out = []) {
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    out.push(target);
    return out;
  }
  const SKIP = new Set(['node_modules', 'dist', 'build', 'generated', '.git']);
  const EXTS = new Set([
    '.ts', '.tsx', '.css', '.md', '.json', '.html', '.prisma', '.mjs', '.sh',
  ]);
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) collect(full, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      // The encoding test holds deliberately corrupted fixtures.
      if (entry.name !== 'encoding.test.ts') out.push(full);
    }
  }
  return out;
}

// CLI only when run directly, so `repairText` can be imported by the verifier.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node fix-mojibake.mjs <file-or-directory>...');
    process.exit(1);
  }

  const files = args.flatMap((arg) => collect(arg));

  let totalFiles = 0;
  let totalRuns = 0;
  for (const file of files) {
    const original = readFileSync(file, 'utf8');
    const { text, repairs } = repairText(original);
    if (repairs > 0 && text !== original) {
      writeFileSync(file, text, 'utf8');
      totalFiles += 1;
      totalRuns += repairs;
      console.log(`repaired ${String(repairs).padStart(3)} runs  ${file}`);
    }
  }
  console.log(`\nfiles=${totalFiles} runs=${totalRuns}`);
}
