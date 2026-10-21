// Real-browser check that the "삽화가 설정" modal is actually tappable on a small touch
// screen (Firefox + Chromium, hasTouch, 360x460). Not part of `node --test` (needs a
// Playwright install); run manually:
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
//   FIREFOX_BIN=$HOME/.cache/ms-playwright/firefox-XXXX/firefox/firefox \
//   CHROMIUM_BIN=$HOME/.cache/ms-playwright/chromium-XXXX/chrome-linux64/chrome \
//   node test/e2e/modal.e2e.mjs
//
// The host's showModal() is re-created here from its observable DOM shape (fixed
// full-screen backdrop at z-index 10003 with a blur, a centered flex-column container
// with overflow hidden, a header with a close button, and a scrollable body holding the
// extension root). The backend is a fake in the page — no server, no real generation.
//
// Scenarios: (a) every load succeeds, (b) one load fails, (c) permissions are missing
// when the panel opens and are granted afterwards (host broadcasts
// SPINDLE_PERMISSION_CHANGED) — controls must become usable without reopening/restarting.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pwPath = process.env.PLAYWRIGHT_MODULE;
if (!pwPath) { console.error('set PLAYWRIGHT_MODULE'); process.exit(2); }
const { firefox, chromium } = await import(pwPath);
const frontendJs = await readFile(join(root, 'dist', 'frontend.js'), 'utf8');

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--lumiverse-bg:#1b1a22;--lumiverse-border:#444;--lumiverse-text:#eee;--lumiverse-text-dim:#aaa}
html,body{margin:0;background:#111;color:#eee;font-family:sans-serif;height:100%}
#bar{position:fixed;left:0;right:0;bottom:0;height:48px;background:#222;z-index:50;display:flex;align-items:center;padding:0 8px}
</style></head><body>
<div id="chat" style="padding:12px">chat…</div>
<div id="bar"></div>
<script type="module">
window.__frames = [];
window.__scn = { fail: {}, delay: 30 };
const evHandlers = {};
let backendHandler = null;
function showModal(opts) {
  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, { position: 'fixed', inset: '0', zIndex: '10003', background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' });
  const gutter = 40;
  const container = document.createElement('div');
  Object.assign(container.style, { width: Math.min(opts.width || 420, innerWidth - gutter) + 'px',
    maxHeight: Math.min(opts.maxHeight || 520, innerHeight - gutter) + 'px', background: 'var(--lumiverse-bg)',
    borderRadius: '12px', border: '1px solid var(--lumiverse-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' });
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
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) handle.dismiss(); });
  return handle;
}
const defaults = {
  load_settings: { settings: { position: 'depth', depth: 4, role: 'system', maxImages: 2 } },
  load_registry: { registry: [{ names: ['아드리안'], appearance: '1boy', enabled: true }] },
  load_auto: { auto: true },
  list_images: { images: [{ id: 'p1', messageId: 'm1', status: 'ok', summary: 'scene', imageUrl: '' }] },
  load_status: { permissions: { generation: true, interceptor: true, chat_mutation: true, characters: true, chats: true, image_gen: true }, missing: [] },
  save_settings: { settings: { position: 'end', depth: 4, role: 'system', maxImages: 2 } },
  save_registry: { registry: [{ names: ['아드리안'], appearance: '1boy', enabled: true }] },
  set_auto: { auto: false },
  regenerate: {},
};
const ctx = {
  ui: {
    registerInputBarAction(o) {
      const b = document.createElement('button'); b.id = 'action'; b.textContent = o.label; b.disabled = !o.enabled;
      document.getElementById('bar').append(b); const clicks = [];
      b.onclick = () => clicks.forEach((f) => f());
      return { setEnabled: (v) => { b.disabled = !v; }, onClick: (f) => { clicks.push(f); return () => {}; }, destroy: () => b.remove() };
    },
    showModal,
  },
  getActiveChat: () => ({ chatId: 'c1', characterId: 'ch1' }),
  events: { on: (ev, f) => { (evHandlers[ev] ||= []).push(f); return () => {}; } },
  state: { subscribe: () => () => {} },
  onBackendMessage: (f) => { backendHandler = f; return () => {}; },
  sendToBackend: (p) => {
    window.__frames.push(p);
    const fail = window.__scn.fail[p.type];
    const reply = fail ? { ok: false, error: fail, ...(fail.startsWith('PERMISSION_DENIED:') ? { permission: fail.split(/\\s+/)[1] } : {}) } : { ok: true, ...(defaults[p.type] || {}) };
    if (p.type === 'load_status' && window.__scn.missing) reply.missing = window.__scn.missing;
    setTimeout(() => backendHandler && backendHandler({ ...reply, requestId: p.requestId, type: p.type }), window.__scn.delay);
  },
};
// Mirrors the host: one notification per granted permission (spindle.routes.ts loops
// notifyPermissionChanged per permission) — delivered both as the backend worker's push
// ('permissions_changed', what backend.mjs sends from permissions.onChanged) and as the
// host-wide SPINDLE_PERMISSION_CHANGED ws event. ?via=backend|event|both picks which.
window.__grantAll = (allGranted, via = 'both') => {
  window.__scn.fail = {}; window.__scn.missing = [];
  for (const permission of allGranted) {
    const detail = { extensionId: 'x', permission, granted: true, allGranted };
    if (via !== 'event' && backendHandler) backendHandler({ type: 'permissions_changed', ...detail });
    if (via !== 'backend') for (const f of evHandlers.SPINDLE_PERMISSION_CHANGED || []) f(detail);
  }
};
const mod = await import('/frontend.js');
window.__stop = mod.setup(ctx);
window.__ready = true;
</script></body></html>`;

async function controlsReport(page) {
  return page.evaluate(() => {
    const out = [];
    for (const n of document.querySelectorAll('[data-spindle-modal] button, [data-spindle-modal] select, [data-spindle-modal] input, [data-spindle-modal] textarea')) {
      n.scrollIntoView({ block: 'center' });
      const r = n.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.push({ tag: n.tagName, text: (n.textContent || n.value || '').slice(0, 20), disabled: n.disabled, hitOk: !!hit && (hit === n || n.contains(hit)), pe: getComputedStyle(n).pointerEvents });
    }
    return out;
  });
}

const PERMS = ['image_gen', 'interceptor', 'chat_mutation', 'characters', 'chats', 'generation'];

async function run(browserType, name, opts = {}) {
  const browser = await browserType.launch(opts);
  const results = [];
  try {
    for (const scenario of ['a-all-ok', 'b-one-fails', 'c-perms-late-backend-push', 'c-perms-late-host-event']) {
      const context = await browser.newContext({ viewport: { width: 360, height: 460 }, hasTouch: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.route('http://lvil.test/**', (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === '/frontend.js') return route.fulfill({ contentType: 'text/javascript', body: frontendJs });
        return route.fulfill({ contentType: 'text/html', body: HTML });
      });
      await page.goto('http://lvil.test/');
      await page.waitForFunction(() => window.__ready);
      if (scenario === 'b-one-fails') await page.evaluate(() => { window.__scn.fail = { list_images: '이미지 목록 오류' }; });
      if (scenario.startsWith('c-')) {
        await page.evaluate(() => {
          window.__scn.fail = {
            list_images: 'PERMISSION_DENIED: chat_mutation — Chat mutation permission not granted',
            load_registry: 'PERMISSION_DENIED: characters — Characters permission not granted',
          };
          window.__scn.missing = ['generation', 'interceptor', 'chat_mutation', 'characters'];
        });
      }
      await page.tap('#action');
      await page.waitForSelector('.lvil');
      await page.waitForTimeout(400);
      const before = await controlsReport(page);
      const statusText = () => page.evaluate(() => [...document.querySelectorAll('.lvil-status, .lvil-loadfail, .lvil-perm, .lvil-sec-state')].map((n) => n.textContent).filter(Boolean).join(' | '));
      const statusBefore = await statusText();
      let after = null, statusAfter = null;
      if (scenario.startsWith('c-')) {
        const via = scenario.endsWith('backend-push') ? 'backend' : 'event';
        await page.evaluate(([p, v]) => window.__grantAll(p, v), [PERMS, via]);
        await page.waitForTimeout(700);
        after = await controlsReport(page);
        statusAfter = await statusText();
      }
      // Tap the auto toggle (settings section, needs only load_settings/load_auto) and
      // check a set_auto request actually leaves the page.
      const n0 = await page.evaluate(() => window.__frames.filter((f) => f.type === 'set_auto').length);
      const autoBtn = page.locator('.lvil button', { hasText: /켜짐 \(끄기\)|꺼짐 \(켜기\)/ }).first();
      let tapped = false;
      if (await autoBtn.count()) {
        await autoBtn.scrollIntoViewIfNeeded();
        try { await autoBtn.tap({ timeout: 1500 }); tapped = true; } catch { tapped = false; }
      }
      await page.waitForTimeout(200);
      const n1 = await page.evaluate(() => window.__frames.filter((f) => f.type === 'set_auto').length);
      // Host close button must also work.
      await page.tap('#host-close');
      const closed = (await page.locator('[data-spindle-modal]').count()) === 0;
      const summarize = (list) => list && ({ total: list.length, enabled: list.filter((c) => !c.disabled).length, enabledButNotHittable: list.filter((c) => !c.disabled && !c.hitOk).map((c) => c.text) });
      results.push({ browser: name, scenario, statusBefore, before: summarize(before), statusAfter, after: summarize(after), autoTapSent: tapped && n1 > n0, closed, errors });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

const all = [];
all.push(...await run(chromium, 'chromium', process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}));
all.push(...await run(firefox, 'firefox', process.env.FIREFOX_BIN ? { executablePath: process.env.FIREFOX_BIN } : {}));
console.log(JSON.stringify(all, null, 2));
const bad = all.filter((r) => r.errors.length || !r.closed || !r.autoTapSent
  || r.before.enabledButNotHittable.length || (r.after && r.after.enabledButNotHittable.length)
  || (r.scenario === 'b-one-fails' && !/그림 목록/.test(r.statusBefore))
  || (r.scenario.startsWith('c-') && (!/권한/.test(r.statusBefore) || r.after.enabled !== r.after.total || /불러오지 못한/.test(r.statusAfter))));
if (bad.length) console.error('FAILED:', bad.map((r) => r.browser + '/' + r.scenario).join(', '));
process.exit(bad.length ? 1 : 0);
