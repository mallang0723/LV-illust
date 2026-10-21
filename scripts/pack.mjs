// Build a reproducible release zip: release/lv_illust-<version>.zip containing
// spindle.json, dist/, README.md, README.en.md — nothing else (no src/, test/, docs/,
// .git/, private notes). Two runs from the same source produce byte-identical output:
// every file gets a fixed mtime and the archive is built with `zip -X` (strip extra
// fields/UID-GID) under a forced UTC timezone, from an explicit, sorted file list (not
// `-r` directory recursion, whose traversal order isn't guaranteed stable).
import { readFile, rm, mkdir, mkdtemp, cp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'spindle.json'), 'utf8'));
const version = manifest.version;
if (!version) throw new Error('spindle.json has no version');

// Fixed mtime for every packed file/dir, so the zip's DOS timestamps never depend on
// when `pack.mjs` happens to run.
const FIXED_TIME = new Date('2020-01-01T00:00:00Z');

const FILES = [
  'spindle.json',
  'README.md',
  'README.en.md',
  'dist/backend.js',
  'dist/frontend.js',
];

for (const f of FILES) {
  const p = join(root, f);
  try { await readFile(p); } catch { throw new Error(`pack.mjs: missing required file ${f} — run node scripts/build.mjs first?`); }
}

const releaseDir = join(root, 'release');
await mkdir(releaseDir, { recursive: true });
const outPath = join(releaseDir, `lv_illust-${version}.zip`);
await rm(outPath, { force: true });

const stage = await mkdtemp(join(tmpdir(), 'lv_illust-pack-'));
try {
  for (const f of FILES.sort()) {
    const dest = join(stage, f);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(root, f), dest);
    await utimes(dest, FIXED_TIME, FIXED_TIME);
  }
  await utimes(join(stage, 'dist'), FIXED_TIME, FIXED_TIME);

  // `-X`: no extra file attributes (UID/GID/extended timestamps) — the single biggest
  // source of non-reproducibility in zip output. `-D`: no directory entries. Forced
  // UTC timezone so the plain DOS timestamp zip still embeds doesn't vary by machine.
  execFileSync('zip', ['-X', '-D', '-q', outPath, ...FILES.sort()], { cwd: stage, env: { ...process.env, TZ: 'UTC' } });
} finally {
  await rm(stage, { recursive: true, force: true });
}

const bytes = await readFile(outPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({ ok: true, out: outPath, sizeBytes: bytes.length, sha256 }));
