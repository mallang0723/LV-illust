// Concatenate src/*.mjs into self-contained ES modules in dist/ (no dependencies, no bundler).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const strip = (s) => s.replace(/^import [^;]+ from '\.\/[^']+';\n/gm, '');
const bundle = async (names) => (await Promise.all(names.map((n) => readFile(`src/${n}.mjs`, 'utf8')))).map(strip).join('\n');
await mkdir('dist', { recursive: true });
const head = '// 삽화가 (개인용) / LV-Illust — built from src/ by scripts/build.mjs. Do not edit.\n';
await writeFile('dist/backend.js', head + await bundle(['core', 'backend']));
await writeFile('dist/frontend.js', head + await bundle(['core', 'frontend']));
console.log(JSON.stringify({ ok: true, artifacts: ['dist/backend.js', 'dist/frontend.js'] }));
