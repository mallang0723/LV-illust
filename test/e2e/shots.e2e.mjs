// Screenshot harness for the 삽화가 panel: stub host (dark + light CSS variable sets,
// showModal re-created from its observable DOM shape), fake in-page backend, no server,
// no real generation. Not part of `node --test` (needs Playwright):
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs FIREFOX_BIN=/path/to/firefox \
//   node test/e2e/shots.e2e.mjs <label> [outDir]
//
// <label> prefixes every file ("before" / "after"). Files: <label>-<width>-<theme>-<state>.png
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const label = process.argv[2] || 'shot';
const outDir = process.argv[3] || join(homedir(), 'chapssal', 'work', 'illust-ui');
const pwPath = process.env.PLAYWRIGHT_MODULE;
if (!pwPath) { console.error('set PLAYWRIGHT_MODULE'); process.exit(2); }
const { firefox } = await import(pwPath);
const frontendJs = await readFile(join(root, process.env.FRONTEND || 'dist/frontend.js'), 'utf8');
await mkdir(outDir, { recursive: true });

// host variable sets (names match what the host defines; surfaces are NOT pre-opaque)
const THEMES = {
  dark: '--lumiverse-bg:#1b1a22;--lumiverse-bg-deep:#121118;--lumiverse-text:#ebe8f2;--lumiverse-text-muted:#a29fb0;--lumiverse-border:rgba(255,255,255,.14);--lumiverse-fill:rgba(255,255,255,.07);--lumiverse-fill-subtle:rgba(255,255,255,.04);--lumiverse-fill-hover:rgba(255,255,255,.11);--lumiverse-primary:#ff836e;--lumiverse-primary-contrast:#1b1a22;--lumiverse-danger:#f0605a;color-scheme:dark',
  light: '--lumiverse-bg:#f7f5fb;--lumiverse-bg-deep:#e8e4f1;--lumiverse-text:#201c2e;--lumiverse-text-muted:#5d5870;--lumiverse-border:rgba(30,20,60,.18);--lumiverse-fill:rgba(30,20,60,.06);--lumiverse-fill-subtle:rgba(30,20,60,.035);--lumiverse-fill-hover:rgba(30,20,60,.1);--lumiverse-primary:#c8442f;--lumiverse-primary-contrast:#ffffff;--lumiverse-danger:#c62828;color-scheme:light',
};

const svg = (c1, c2, t) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><text x="16" y="108" font-size="26" fill="white" font-family="sans-serif">${t}</text></svg>`);

const FIX = {
  settings: { position: 'depth', depth: 4, role: 'system', maxImages: 2, commonNegative: 'lowres, text, watermark', boundNegatives: true },
  registry: [
    { id: 'c0', names: ['아드리안', 'Adrian'], enabled: true, appearance: '1boy, silver hair, blue eyes, tall, black coat, white gloves, silver ring',
      body: '1boy, silver hair, blue eyes, tall', outfit: 'black coat, white gloves, silver ring', negative: 'extra fingers' },
    { id: 'c1', names: ['정수빈'], enabled: true, appearance: '1girl, short brown hair, school uniform, glasses, red ribbon, mystery tag',
      body: '1girl, short brown hair, mystery tag', outfit: 'school uniform, glasses, red ribbon', negative: '',
      legacyAppearance: '1girl, short brown hair, school uniform, glasses, red ribbon, mystery tag', needsReview: true, reviewTags: ['mystery tag'] },
    { id: 'c2', names: ['마리'], enabled: false, appearance: '1girl, long black hair', body: '1girl, long black hair', outfit: '', negative: '' },
  ],
  images: [
    { id: 'p1', messageId: 'm1', status: 'ok', summary: '비 오는 골목에서 우산을 든 아드리안', imageUrl: svg('#4a6fa5', '#1b1a22', '골목'), prompt: 'masterpiece, rain, alley, umbrella', negative: 'lowres, text', characterTags: [{ tags: '1boy, silver hair, black coat' }] },
    { id: 'p2', messageId: 'm2', status: 'ok', summary: '교실 창가의 정수빈', imageUrl: svg('#c8826a', '#5a3b66', '교실'), prompt: 'classroom, window', negative: '', characterTags: [] },
    { id: 'p3', messageId: 'm2', status: 'fail', summary: '실패한 장면', imageUrl: '' },
    { id: 'p4', messageId: 'm3', status: 'orphan', summary: '밤하늘 아래 두 사람', imageUrl: svg('#222a55', '#0a0a18', '밤'), reason: '생성 중 메시지가 바뀌어 넣지 못함' },
  ],
};

const HTML = (theme) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{${THEMES[theme]}}
html,body{margin:0;background:var(--lumiverse-bg-deep);color:var(--lumiverse-text);font-family:system-ui,sans-serif;height:100%}
#bar{position:fixed;left:0;right:0;bottom:0;height:48px;background:var(--lumiverse-bg);z-index:50;display:flex;align-items:center;padding:0 8px}
#chat{padding:16px;line-height:1.6}
</style></head><body>
<div id="chat"><p>아드리안은 우산을 펼치고 골목으로 걸어 들어갔다.</p><p>…</p></div>
<div id="bar"></div>
<script type="module">
const FIX = ${JSON.stringify(FIX)};
window.__frames = [];
let backendHandler = null;
function showModal(opts) {
  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, { position: 'fixed', inset: '0', zIndex: '10003', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: innerHeight > 1500 ? 'flex-start' : 'center', justifyContent: 'center', paddingTop: innerHeight > 1500 ? '20px' : '0' });
  const container = document.createElement('div');
  Object.assign(container.style, { width: Math.min(opts.width || 420, innerWidth - 40) + 'px', maxHeight: (innerHeight - 40) + 'px',
    background: 'var(--lumiverse-bg)', color: 'var(--lumiverse-text)', borderRadius: '12px', border: '1px solid var(--lumiverse-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' });
  const header = document.createElement('div');
  Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px' });
  const h = document.createElement('h3'); h.textContent = opts.title || ''; h.style.margin = '0'; header.append(h);
  const close = document.createElement('button'); close.id = 'host-close'; close.textContent = 'x'; header.append(close);
  const body = document.createElement('div'); Object.assign(body.style, { padding: '16px', overflowY: 'auto', flex: '1' });
  const root = document.createElement('div'); root.setAttribute('data-spindle-modal', 'm1'); body.append(root);
  container.append(header, body); backdrop.append(container); document.body.append(backdrop);
  const dis = new Set(); let done = false;
  const handle = { root, dismiss() { if (done) return; done = true; backdrop.remove(); for (const f of dis) f(); }, onDismiss(f) { dis.add(f); return () => dis.delete(f); }, setTitle() {} };
  close.onclick = () => handle.dismiss();
  return handle;
}
const defaults = {
  load_settings: { settings: FIX.settings }, load_registry: { registry: FIX.registry }, load_auto: { auto: true },
  list_images: { images: FIX.images }, load_status: { missing: [] },
  save_settings: { settings: FIX.settings }, save_registry: { registry: FIX.registry }, set_auto: { auto: false }, regenerate: {},
  preview_prompt: { prompt: 'masterpiece, rain, alley', negativePrompt: 'lowres, text, watermark, extra fingers', characterTags: [{ tags: '1boy, silver hair, blue eyes, tall, black coat, white gloves' }] },
};
const ctx = {
  ui: { registerInputBarAction(o) {
      const b = document.createElement('button'); b.id = 'action'; b.textContent = o.label; b.disabled = !o.enabled; document.getElementById('bar').append(b);
      const clicks = []; b.onclick = () => clicks.forEach((f) => f());
      return { setEnabled: (v) => { b.disabled = !v; }, onClick: (f) => { clicks.push(f); return () => {}; }, destroy: () => b.remove() };
    }, showModal },
  getActiveChat: () => ({ chatId: 'c1', characterId: 'ch1' }),
  events: { on: () => () => {} }, state: { subscribe: () => () => {} },
  onBackendMessage: (f) => { backendHandler = f; return () => {}; },
  sendToBackend: (p) => { window.__frames.push(p); setTimeout(() => backendHandler && backendHandler({ ok: true, ...(defaults[p.type] || {}), requestId: p.requestId, type: p.type }), 20); },
};
const mod = await import('/frontend.js');
window.__stop = mod.setup(ctx);
window.__ready = true;
</script></body></html>`;

const SHOTS = [
  { width: 360, fold: 740, tall: 2400 },
  { width: 1280, fold: 860, tall: 2400 },
];
const STATES = (process.env.STATES || 'main').split(',');

const browser = await firefox.launch(process.env.FIREFOX_BIN ? { executablePath: process.env.FIREFOX_BIN } : {});
const written = [];
try {
  for (const theme of ['light', 'dark']) {
    for (const cfg of SHOTS) {
      for (const view of ['fold', 'full']) {
        const context = await browser.newContext({ viewport: { width: cfg.width, height: view === 'fold' ? cfg.fold : cfg.tall }, hasTouch: cfg.width < 600 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.route('http://lvil.test/**', (route) => {
          const u = new URL(route.request().url());
          if (u.pathname === '/frontend.js') return route.fulfill({ contentType: 'text/javascript', body: frontendJs });
          return route.fulfill({ contentType: 'text/html', body: HTML(theme) });
        });
        await page.goto('http://lvil.test/');
        await page.waitForFunction(() => window.__ready);
        await page.click('#action');
        await page.waitForSelector('[data-spindle-modal] *');
        await page.waitForTimeout(500);
        for (const state of STATES) {
          if (state !== 'main') {
            const ok = await page.evaluate(async (s) => (window.__state ? window.__state(s) : false), state).catch(() => false);
            void ok;
            // state steps are provided by the optional STATE_SCRIPT module (after-only)
            if (process.env.STATE_SCRIPT) { const mod = await import(process.env.STATE_SCRIPT); await mod.default(page, state); }
            await page.waitForTimeout(300);
          }
          const file = join(outDir, `${label}-${cfg.width}-${theme}-${state === 'main' ? '' : state + '-'}${view}.png`);
          if (view === 'full') await page.locator('[data-spindle-modal]').locator('xpath=../..').screenshot({ path: file });
          else await page.screenshot({ path: file });
          written.push(file);
        }
        if (errors.length) console.error('PAGE ERRORS', theme, cfg.width, errors);
        await context.close();
      }
    }
  }
} finally { await browser.close(); }
console.log(written.join('\n'));
