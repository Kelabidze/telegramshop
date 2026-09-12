import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Guards against double-encoded (mojibake) Cyrillic in source files.
 *
 * How it happened, and why a test is the right guard: editing a UTF-8 file with a
 * tool that reads it as CP1251 and writes it back as UTF-8 turns "Шаблоны" into
 * "РЁР°Р±Р»РѕРЅС‹". On Windows the default PowerShell pipeline does exactly that, so
 * one careless bulk edit silently corrupted 11 files and 150 lines — and the damage
 * only surfaced later, in the staff UI, as unreadable product and category names.
 *
 * Nothing else catches it. TypeScript sees valid strings, tests that do not assert
 * on Russian text pass, and a reviewer scanning a diff sees plausible-looking
 * Cyrillic. This test fails the build instead.
 */

// apps/api/src -> apps/api -> apps -> repo root. Three levels, not two: with two
// this resolved to `apps/`, every scan root missed, and the test passed while the
// tree was corrupt. Asserted below so the mistake cannot come back silently.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ROOTS = ['apps', 'packages', 'docs'];
const EXTS = new Set(['.ts', '.tsx', '.css', '.md', '.json', '.html', '.prisma']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'generated', '.git']);

/**
 * CP1251, for bytes 0x80–0xFF. Index 0 is byte 0x80.
 *
 * Detection is by round-trip rather than by pattern: encode a candidate back to
 * CP1251 bytes and see whether those bytes are valid UTF-8 that re-corrupts to
 * exactly what we started with. That is the inverse of how the damage happens, so it
 * needs no list of signatures.
 *
 * Pattern matching was tried first and kept missing cases — every emoji, then U+F8FF
 * (the Apple logo, "пЈї") — while also flagging real words: "США" is С+Ш+А, and any
 * rule loose enough to catch the corruption also caught that.
 */
const CP1251 =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00A0ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

const TO_CP1251 = new Map<string, number>();
for (let i = 0; i < CP1251.length; i += 1) TO_CP1251.set(CP1251[i]!, 0x80 + i);

/** Characters CP1251 uses for continuation bytes 0x80–0xBF. */
const CONTINUATION = new Set([...CP1251.slice(0, 64)]);

/** Re-applies the corruption: UTF-8 bytes rendered through CP1251. */
function corrupt(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP1251[byte - 0x80];
  }
  return out;
}

/** Encodes to CP1251 bytes, or null if some character has no CP1251 byte. */
function toCp1251(text: string): Buffer | null {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out[i] = code;
      continue;
    }
    const mapped = TO_CP1251.get(text[i]!);
    if (mapped === undefined) return null;
    out[i] = mapped;
  }
  return out;
}

function isRunChar(ch: string): boolean {
  return TO_CP1251.has(ch);
}

/**
 * Finds a run of text that is double-encoded.
 *
 * A run qualifies only when it survives the round-trip, which is what stops healthy
 * Russian from being reported: "ёлка" contains ё (0xB8) so it reaches the check, but
 * its CP1251 bytes are not valid UTF-8 and it is rejected.
 */
function findMojibake(text: string): { sample: string } | null {
  let i = 0;
  while (i < text.length) {
    if (!isRunChar(text[i]!)) {
      i += 1;
      continue;
    }

    let j = i;
    while (j < text.length && isRunChar(text[j]!)) j += 1;
    const run = text.slice(i, j);

    // A multi-byte sequence always leaves a continuation byte behind, so a run
    // without one cannot be corrupted text.
    if ([...run].some((ch) => CONTINUATION.has(ch))) {
      const bytes = toCp1251(run);
      if (bytes) {
        const decoded = bytes.toString('utf8');
        if (!decoded.includes('\uFFFD') && corrupt(decoded) === run) {
          return { sample: text.slice(Math.max(0, i - 20), j + 10) };
        }
      }
    }

    i = j;
  }
  return null;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (EXTS.has(path.extname(entry.name))) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  for (const root of ROOTS) {
    const full = path.join(REPO_ROOT, root);
    try {
      if (statSync(full).isDirectory()) walk(full);
    } catch {
      /* absent root */
    }
  }
  return out;
}

describe('source encoding', () => {
  it('actually scans the repository', () => {
    // A guard that silently scans nothing passes forever. A wrong REPO_ROOT did
    // exactly that here, so the file count and a couple of known paths are asserted.
    const files = sourceFiles();
    assert.ok(
      files.length > 100,
      `expected to scan the whole repo, found only ${files.length} files — REPO_ROOT is probably wrong (${REPO_ROOT})`,
    );

    const relative = files.map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/'));
    for (const expected of [
      'apps/api/src/cli/seed.ts',
      'apps/miniapp/src/App.tsx',
      'apps/miniapp/src/styles.css',
      'packages/shared/src/base-price.ts',
    ]) {
      assert.ok(relative.includes(expected), `scan is missing ${expected}`);
    }
  });

  it('contains no double-encoded Cyrillic, emoji or punctuation', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      // This test file necessarily contains the signatures it looks for.
      if (path.basename(file) === 'encoding.test.ts') continue;

      const hit = findMojibake(readFileSync(file, 'utf8'));
      if (hit) {
        offenders.push(
          `${path.relative(REPO_ROOT, file)} — ${JSON.stringify(hit.sample)}`,
        );
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Double-encoded text found. A UTF-8 file was read as CP1251 and written back ` +
        `as UTF-8 — on Windows, PowerShell's default Get-Content/Set-Content pipeline ` +
        `does this. Repair with:\n  node fix-mojibake.mjs <file>...\n\n` +
        offenders.join('\n'),
    );
  });

  it('does not flag legitimate Russian text', () => {
    // Words that reach the round-trip check and must come back clean. The ё/№/±/µ
    // entries are the interesting ones: they live in the CP1251 high range, so a
    // pattern-based detector either misses corruption or condemns these.
    for (const healthy of [
      'США',
      'СБП',
      'Карта · СБП',
      'Подарочные карты',
      'Шаблоны',
      'Курсы',
      'Инструменты',
      'Всё для абуза',
      'ёлка',
      'ёж',
      'приём',
      'ещё раз',
      'Режим управления',
      'Оплата получена. Заказ №A7F3C1',
      'Курс 87.67 ₽ за USDT',
      '± 5 %',
      '© OCHKISK ZONE',
      'Оплата — получена',
      '«Курсы»',
      '🎨 🎓 🛠',
      '',
      'Смотреть всё',
      'Сейчас в ZONE',
    ]) {
      assert.equal(
        findMojibake(healthy),
        null,
        `false positive on healthy text: ${healthy}`,
      );
    }
  });

  it('does detect the corruption it is meant to catch', () => {
    // The real corrupted forms from the incident, one per UTF-8 length.
    for (const broken of [
      'РЁР°Р±Р»РѕРЅС‹', // Шаблоны — 2-byte
      'РљСѓСЂСЃС‹', // Курсы
      'РџРѕРґР°СЂРѕС‡РЅС‹Рµ РєР°СЂС‚С‹', // Подарочные карты
      'В«Р’СЃС‘ РґР»СЏ Р°Р±СѓР·Р°В»', // «Всё для абуза»
      'рџЋЁ', // 🎨 — 4-byte
      'пЈї', // U+F8FF Apple logo — 3-byte, missed by the first detector
      'вЂ”', // — em dash
      'РІвЂљР…', // ₽ corrupted twice over
    ]) {
      assert.ok(
        findMojibake(broken) !== null,
        `failed to detect corruption: ${broken}`,
      );
    }
  });
});
