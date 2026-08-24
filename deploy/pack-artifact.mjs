/**
 * Packs a deployable artifact from an already-built working tree.
 *
 *   node deploy/pack-artifact.mjs [--out build/artifact.tar.gz]
 *
 * Why this exists: building on a small VPS means installing devDependencies
 * (TypeScript, Vite, ~425 MB) and burning minutes of CPU, with a real risk of
 * the OOM killer stopping the running site. Instead the build happens on a
 * GitHub runner and the server receives only what it cannot produce itself.
 *
 * What goes in (~1.5 MB gzipped):
 *   - compiled API (apps/api/dist) and Mini App (apps/miniapp/dist)
 *   - compiled shared contract (packages/shared/dist)
 *   - manifests + package-lock.json, so the server can `npm ci --omit=dev`
 *   - prisma schema/config, so the server can apply the schema
 *
 * What stays out: node_modules (installed on the server so native binaries
 * match its Node ABI), sources, tests, .map files, .d.ts files.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');

const outArgIndex = process.argv.indexOf('--out');
const outFile = path.resolve(
  repoRoot,
  outArgIndex !== -1 && process.argv[outArgIndex + 1]
    ? process.argv[outArgIndex + 1]
    : path.join('build', 'artifact.tar.gz'),
);

const stageDir = path.join(repoRoot, 'build', 'artifact-stage');

/** Build outputs that must exist, or the artifact would be useless. */
const REQUIRED_BUILD_OUTPUTS = [
  'apps/api/dist/server.js',
  'apps/miniapp/dist/index.html',
  'packages/shared/dist/index.js',
];

/**
 * Everything the server needs. Directories are copied recursively, files as-is.
 * `package.json` of every workspace is required: `npm ci` reads the whole
 * workspace graph and fails if a member referenced by package-lock is missing.
 */
const INCLUDE = [
  'package.json',
  'package-lock.json',
  'packages/shared/package.json',
  'packages/shared/dist',
  'apps/api/package.json',
  'apps/api/dist',
  'apps/api/prisma/schema.prisma',
  'apps/api/prisma/seed.ts',
  'apps/api/prisma.config.ts',
  'apps/api/scripts/webhook.ts',
  'apps/miniapp/package.json',
  'apps/miniapp/dist',
];

/** Dead weight at runtime: sourcemaps and type declarations. */
function isDroppable(filePath) {
  return (
    filePath.endsWith('.map') ||
    filePath.endsWith('.d.ts') ||
    filePath.endsWith('.d.mts') ||
    filePath.endsWith('.tsbuildinfo')
  );
}

function fail(message) {
  console.error(`\x1b[1;31mpack-artifact: ${message}\x1b[0m`);
  process.exit(1);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

// --- 1. verify the tree was actually built ---------------------------------
for (const relative of REQUIRED_BUILD_OUTPUTS) {
  if (!existsSync(path.join(repoRoot, relative))) {
    fail(`missing ${relative}. Run "npm run build" first.`);
  }
}

// --- 2. stage the payload --------------------------------------------------
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const relative of INCLUDE) {
  const source = path.join(repoRoot, relative);
  if (!existsSync(source)) fail(`missing ${relative}`);

  const target = path.join(stageDir, relative);
  mkdirSync(path.dirname(target), { recursive: true });

  if (statSync(source).isDirectory()) {
    cpSync(source, target, {
      recursive: true,
      filter: (src) => statSync(src).isDirectory() || !isDroppable(src),
    });
  } else {
    cpSync(source, target);
  }
}

// --- 3. record what this artifact is --------------------------------------
// The server reads this to report the deployed commit and to refuse an
// artifact built for a different Node major (native modules are ABI-bound).
const rootManifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);

function gitValue(args, fallback) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

const metadata = {
  name: rootManifest.name,
  version: rootManifest.version,
  commit: process.env.GITHUB_SHA ?? gitValue(['rev-parse', 'HEAD'], 'unknown'),
  commitShort:
    process.env.GITHUB_SHA?.slice(0, 7) ??
    gitValue(['rev-parse', '--short', 'HEAD'], 'unknown'),
  subject: gitValue(['log', '-1', '--pretty=%s'], ''),
  builtAt: new Date().toISOString(),
  builtBy: process.env.GITHUB_RUN_ID ? 'github-actions' : 'local',
  /** Node major used for the build. The server warns when it differs. */
  nodeMajor: process.versions.node.split('.')[0],
  requiredNode: rootManifest.engines?.node ?? null,
};

writeFileSync(
  path.join(stageDir, 'artifact.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
);

// --- 4. create the tarball ------------------------------------------------
mkdirSync(path.dirname(outFile), { recursive: true });
rmSync(outFile, { force: true });

// `tar` ships with Windows 10+, macOS and every Linux runner.
// --numeric-owner + --owner/--group: the archive must not carry the builder's
// uid/gid, otherwise extraction as another user can produce odd ownership.
try {
  execFileSync(
    'tar',
    [
      '--numeric-owner',
      '--owner=0',
      '--group=0',
      '-czf',
      outFile,
      '-C',
      stageDir,
      '.',
    ],
    { stdio: 'inherit' },
  );
} catch {
  fail('tar failed; is tar available on PATH?');
}

const rawSize = dirSize(stageDir);
const packedSize = statSync(outFile).size;
const sha256 = createHash('sha256')
  .update(readFileSync(outFile))
  .digest('hex');

writeFileSync(`${outFile}.sha256`, `${sha256}  ${path.basename(outFile)}\n`);

rmSync(stageDir, { recursive: true, force: true });

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);
console.log(`pack-artifact: ${path.relative(repoRoot, outFile)}`);
console.log(`  commit    ${metadata.commitShort}  ${metadata.subject}`);
console.log(`  node      ${metadata.nodeMajor}.x`);
console.log(`  contents  ${mb(rawSize)} MB -> ${mb(packedSize)} MB gzipped`);
console.log(`  sha256    ${sha256.slice(0, 16)}…`);
