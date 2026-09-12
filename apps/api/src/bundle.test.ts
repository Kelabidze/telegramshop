import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Guards the built Mini App bundle.
 *
 * These are the failures that only appear in a browser, after a deploy: a missing
 * favicon, an asset that was renamed and now 404s, mojibake in a user-visible
 * string, a debug line that reached production. Each is cheap to assert against the
 * emitted files and expensive to notice by eye across seven screens and five widths.
 *
 * Skipped when `dist/` is absent so a plain `npm test` on a clean checkout still
 * passes; CI builds before testing.
 */

const MINIAPP = path.resolve(import.meta.dirname, '..', '..', 'miniapp');
const DIST = path.join(MINIAPP, 'dist');

function bundleFiles(ext: string): string[] {
  const dir = path.join(DIST, 'assets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));
}

function readBundle(ext: string): string {
  return bundleFiles(ext)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

const built = existsSync(DIST);
const describeBuilt = built ? describe : describe.skip;

describeBuilt('miniapp bundle', () => {
  it('emits the favicon at the fixed path index.html references', () => {
    const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const referenced = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]!);

    for (const href of referenced) {
      // Only local, root-relative references are ours to satisfy.
      if (!href.startsWith('/')) continue;
      const onDisk = path.join(DIST, href.slice(1));
      assert.ok(
        existsSync(onDisk),
        `index.html references ${href} but ${onDisk} was not emitted — that is a 404 on every cold start`,
      );
    }

    assert.ok(
      referenced.some((h) => h.endsWith('favicon.svg')),
      'the favicon should be referenced',
    );
  });

  it('inlines or emits every imported brand asset', () => {
    const js = readBundle('.js');

    // Each illustration and icon is imported by `assets/index.ts`. Vite either
    // inlines a small SVG as a data URI or emits a file; both are fine, but the
    // count must match or an import was silently dropped.
    const inlined = [...js.matchAll(/data:image\/svg\+xml/g)].length;
    const emitted = readdirSync(DIST, { recursive: true }).filter((f) =>
      String(f).endsWith('.svg'),
    ).length;

    // 5 empty states + 8 category icons + mark + tentacle = 15 imported,
    // plus favicon.svg copied from public/.
    assert.ok(
      inlined + emitted >= 15,
      `expected at least 15 brand assets in the bundle, found ${inlined} inlined and ${emitted} emitted`,
    );
  });

  it('ships no references to files that were not emitted', () => {
    const css = readBundle('.css');
    // `url(...)` targets in CSS, excluding data URIs.
    const urls = [...css.matchAll(/url\((?!['"]?data:)['"]?([^'")]+)['"]?\)/g)].map(
      (m) => m[1]!,
    );
    for (const url of urls) {
      if (url.startsWith('http')) continue;
      const rel = url.replace(/^\//, '').replace(/^\.\//, '');
      assert.ok(
        existsSync(path.join(DIST, rel)),
        `CSS references ${url}, which was not emitted`,
      );
    }
  });

  it('contains no double-encoded text', () => {
    // Checked on the artefact as well as the source: a stale cached chunk or a bad
    // build step would not show up in `src`.
    //
    // Round-trip, not pattern matching. A two-character rule flagged
    // "Загружаем товар…" here, because "р" followed by "…" is a legitimate pair —
    // detection has to prove the bytes actually decode as re-encoded UTF-8.
    const CP1251 =
      'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00A0ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї°±Ііґµ¶·ё№є»јЅѕї' +
      'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
    const toByte = new Map<string, number>();
    for (let i = 0; i < CP1251.length; i += 1) toByte.set(CP1251[i]!, 0x80 + i);
    const continuation = new Set([...CP1251.slice(0, 64)]);

    const recorrupt = (s: string): string => {
      let out = '';
      for (const byte of Buffer.from(s, 'utf8')) {
        out += byte < 0x80 ? String.fromCharCode(byte) : CP1251[byte - 0x80];
      }
      return out;
    };

    for (const ext of ['.js', '.css']) {
      const text = readBundle(ext);
      let i = 0;
      while (i < text.length) {
        if (!toByte.has(text[i]!)) {
          i += 1;
          continue;
        }
        let j = i;
        while (j < text.length && toByte.has(text[j]!)) j += 1;
        const run = text.slice(i, j);

        if ([...run].some((c) => continuation.has(c))) {
          const bytes = Buffer.from([...run].map((c) => toByte.get(c)!));
          const decoded = bytes.toString('utf8');
          if (!decoded.includes('\uFFFD') && recorrupt(decoded) === run) {
            assert.fail(
              `double-encoded text in the ${ext} bundle: ${JSON.stringify(run)} ` +
                `should be ${JSON.stringify(decoded)}`,
            );
          }
        }
        i = j;
      }
    }
  });

  it('leaks no absolute developer paths', () => {
    // A Windows path in a shipped string means a local filename reached the UI.
    const js = readBundle('.js');
    for (const pattern of [/[A-Za-z]:\\\\Users\\\\/i, /\/home\/[a-z]+\//i]) {
      const hit = pattern.exec(js);
      assert.equal(
        hit,
        null,
        `developer path in the bundle: ${hit?.[0] ?? ''}`,
      );
    }
  });

  it('keeps the payment rate source server-side', () => {
    // The Rapira endpoint is fetched by the API. Its appearance in the client would
    // mean the browser is quoting rates, which no order may be priced from.
    const js = readBundle('.js');
    assert.equal(js.includes('api.rapira.net'), false);
    assert.equal(js.includes('askPrice'), false);
  });

  it('declares a dark colour scheme so no screen can flash white', () => {
    const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
    assert.match(html, /name="color-scheme"\s+content="dark"/);
    assert.match(html, /#08070[cC]/, 'the page background must be the brand black');
  });

  it('sizes banners from the artwork rather than a fixed ratio', () => {
    // Production holds 1279x720 and 1080x720 banners while the standard is
    // 1280x360. A hard-coded ratio would crop them by 44% and 55%.
    const css = readBundle('.css');
    assert.match(css, /--banner-ratio/, 'banner frames must be data-driven');
    assert.match(css, /aspect-ratio:\s*var\(--banner-ratio/);
  });
});
