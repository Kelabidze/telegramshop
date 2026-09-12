import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Rasterises the brand mark to the PNG iOS needs for a home-screen icon.
 *
 * Run once, by hand, when `logo/mark.svg` changes:
 *   node tools/build-apple-touch-icon.mjs
 *
 * iOS ignores `apple-touch-icon` unless it is a raster image at a real pixel size,
 * so an SVG cannot serve both purposes. The output is committed rather than built in
 * CI: it changes about as often as the logo does, and adding a rasteriser to the
 * dependency tree to regenerate a static 180x180 file on every deploy is not a
 * trade worth making.
 *
 * Uses whichever Chromium-based browser is installed rather than a package, for the
 * same reason. If none is found it says so and exits — the icon is optional, and a
 * broken build is worse than a missing home-screen icon.
 */

const SIZE = 180;
const REPO = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(REPO, 'apps/miniapp/src/assets/logo/mark.svg');
const TARGET = path.join(REPO, 'apps/miniapp/public/apple-touch-icon.png');

const CANDIDATES = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const browser = CANDIDATES.find((p) => p && existsSync(p));
if (!browser) {
  console.error('No Chromium-based browser found; cannot rasterise.');
  console.error('Install Chrome or Edge, or export the PNG by hand at 180x180.');
  process.exit(1);
}

const svg = readFileSync(SOURCE, 'utf8');
const work = mkdtempSync(path.join(tmpdir(), 'icon-'));

try {
  // The SVG is inlined into a page sized exactly to the icon. `display:block`
  // matters: an inline <svg> sits on the text baseline and leaves a few pixels of
  // gap at the bottom of the screenshot.
  const page = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
  svg{display:block;width:${SIZE}px;height:${SIZE}px}
</style>
${svg}`;
  const pageFile = path.join(work, 'icon.html');
  writeFileSync(pageFile, page, 'utf8');

  const shot = path.join(work, 'icon.png');
  execFileSync(
    browser,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      // No transparency: iOS composites the icon onto a white sheet, and the mark
      // carries its own dark plate anyway.
      `--screenshot=${shot}`,
      `--window-size=${SIZE},${SIZE}`,
      `--force-device-scale-factor=1`,
      pageFile,
    ],
    { stdio: 'pipe' },
  );

  const png = readFileSync(shot);
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('output is not a PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== SIZE || height !== SIZE) {
    throw new Error(`expected ${SIZE}x${SIZE}, produced ${width}x${height}`);
  }

  writeFileSync(TARGET, png);
  console.log(
    `wrote ${path.relative(REPO, TARGET)} — ${width}x${height}, ${(png.length / 1024).toFixed(1)} KB`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
