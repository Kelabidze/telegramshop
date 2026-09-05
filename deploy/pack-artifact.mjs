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
 * What goes in (~100 MB gzipped):
 *   - compiled API (apps/api/dist) and Mini App (apps/miniapp/dist)
 *   - compiled shared contract (packages/shared/dist)
 *   - production node_modules, pre-installed by the runner (see PROD_DEPS_DIR)
 *   - manifests + package-lock.json, for reference and for the Prisma CLI
 *   - prisma schema/config, so the server can apply the schema
 *
 * What stays out: sources, tests, .map and .d.ts files. Maintenance entry
 * points (seed, webhook) are NOT shipped as .ts: they live in apps/api/src/cli
 * and arrive already compiled inside dist/, because tsx is a devDependency and
 * is absent from the production tree.
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
  // Maintenance entry points. Listed explicitly because nothing imports them:
  // if they ever fall out of the tsconfig `include`, tsc stays green and the
  // breakage only surfaces on the server as "Cannot find module".
  'apps/api/dist/cli/seed.js',
  'apps/api/dist/cli/seed-banners.js',
  'apps/api/dist/cli/webhook.js',
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
  'apps/api/prisma.config.ts',
  'apps/miniapp/package.json',
  'apps/miniapp/dist',
];

/**
 * Pre-installed production dependencies, produced by the CI step
 * "Install production dependencies for the artifact". Shipping them is what
 * lets the server avoid `npm ci` entirely: on a 1 GB VPS that command gets
 * OOM-killed while resolving ~13.8k files.
 *
 * The tradeoff is deliberate: better-sqlite3 contains a native binary bound to
 * one OS/arch/Node ABI, so this artifact is only valid for the platform it was
 * built on. deploy.sh refuses to install it when the Node major differs.
 */
const PROD_DEPS_DIR = path.join('build', 'prod-deps');

/** Dead weight at runtime: sourcemaps and type declarations. */
function isDroppable(filePath) {
  // Inside node_modules these files are load-bearing often enough (packages ship
  // .d.ts that their own runtime code references via require) that pruning them
  // is not worth the risk for the few MB saved.
  if (filePath.includes(`${path.sep}node_modules${path.sep}`)) return false;
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

// --- 2b. stage the pre-installed production dependencies -------------------
// Without these the server would have to run `npm ci`, which is what the OOM
// killer stops on this VPS.
const prodDeps = path.join(repoRoot, PROD_DEPS_DIR, 'node_modules');
if (!existsSync(prodDeps)) {
  fail(
    `missing ${PROD_DEPS_DIR}/node_modules.\n` +
      '  Build it the same way CI does:\n' +
      `    mkdir -p ${PROD_DEPS_DIR} && cp package.json package-lock.json ${PROD_DEPS_DIR}/\n` +
      `    (plus every workspace package.json) && npm ci --omit=dev --prefix ${PROD_DEPS_DIR}`,
  );
}

// `verbatimSymlinks` keeps npm's workspace links as links instead of following
// them. Left to dereference, cpSync would inline apps/api into
// node_modules/@shop/api and produce a recursive copy.
cpSync(prodDeps, path.join(stageDir, 'node_modules'), {
  recursive: true,
  verbatimSymlinks: true,
});

// npm links workspace members into node_modules/@shop/*. Those links point at
// the checkout on the runner, which does not exist on the server, so replace
// them with the real (already compiled) packages. Node resolves
// `@shop/shared` through this path at runtime.
const shopScope = path.join(stageDir, 'node_modules', '@shop');
rmSync(shopScope, { recursive: true, force: true });
mkdirSync(shopScope, { recursive: true });
for (const [name, source] of [
  ['shared', 'packages/shared'],
  ['api', 'apps/api'],
  ['miniapp', 'apps/miniapp'],
]) {
  const from = path.join(stageDir, source);
  if (!existsSync(from)) continue;
  cpSync(from, path.join(shopScope, name), { recursive: true });
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
  /**
   * Node major used for the build. Now that node_modules travel inside the
   * artifact, a mismatch is fatal rather than cosmetic: better-sqlite3's
   * compiled binary targets one ABI. deploy.sh refuses to install on a
   * different major.
   */
  nodeMajor: process.versions.node.split('.')[0],
  /** Same reasoning: the native binary is built for one OS and architecture. */
  platform: process.platform,
  arch: process.arch,
  /** Set once node_modules are bundled, so an old artifact is still readable. */
  bundledDependencies: true,
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
