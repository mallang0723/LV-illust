import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// scripts/build.mjs concatenates core + frontend (and core + backend) into ONE module
// scope, so a top-level name declared in both files only fails when the bundle loads —
// each file passes its own tests. Re-create the bundle in memory (same strip rule as the
// build script) and load it.
const strip = (s) => s.replace(/^import [^;]+ from '\.\/[^']+';\n/gm, '');
const bundle = async (names) => (await Promise.all(names.map((n) => readFile(new URL(`../src/${n}.mjs`, import.meta.url), 'utf8')))).map(strip).join('\n');

for (const side of ['frontend', 'backend']) {
  test(`bundle: core + ${side} load as one module without duplicate top-level names`, async () => {
    const src = await bundle(['core', side]);
    const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
    assert.ok(typeof (side === 'frontend' ? mod.setup : mod.start) === 'function');
  });
}
