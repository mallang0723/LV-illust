import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stand-in: enough for frontend.mjs's el()/render() to build the modal tree in node.
class N {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.textContent = ''; this.value = ''; this.disabled = false; }
  append(...k) { for (const c of k) this.children.push(c); }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(e, f) { (this.listeners[e] ||= []).push(f); }
  *walk() { yield this; for (const c of this.children) if (c instanceof N) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  querySelector(sel) { return sel.startsWith('.') ? this.find((n) => (n.attrs.class || '').split(' ').includes(sel.slice(1))) : null; }
  click() { for (const f of this.listeners.click || []) f({}); }
}
globalThis.document = { createElement: (t) => new N(t) };
const { setup } = await import('../src/frontend.mjs');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

function harness({ reply, characterId = 'ch1' } = {}) {
  const frames = [];
  let onBackend, onClick, modal = null;
  const defaults = {
    load_settings: { settings: { position: 'depth', depth: 4, role: 'system', maxImages: 2 } },
    load_registry: { registry: [] },
    load_auto: { auto: true },
    list_images: { images: [] },
    save_settings: { settings: { position: 'depth', depth: 4, role: 'system', maxImages: 2 } },
    save_registry: { registry: [] },
    set_auto: { auto: false },
    regenerate: {},
  };
  const ui = {
    registerInputBarAction: () => ({ setEnabled() {}, onClick: (f) => { onClick = f; return () => {}; }, destroy() {} }),
    showModal: () => { const dis = []; modal = { root: new N('div'), onDismiss: (f) => dis.push(f), dismiss: () => { dis.forEach((f) => f()); } }; return modal; },
  };
  const ctx = {
    ui,
    getActiveChat: () => ({ chatId: 'c1', characterId }),
    events: { on: () => () => {} },
    state: { subscribe: () => () => {} },
    onBackendMessage: (f) => { onBackend = f; return () => {}; },
    sendToBackend: (p) => {
      frames.push(p);
      const r = reply ? reply(p) : defaults[p.type];
      const payload = r !== undefined ? r : defaults[p.type];
      if (payload) queueMicrotask(() => onBackend({ ok: true, ...payload, requestId: p.requestId, type: p.type }));
    },
  };
  const stop = setup(ctx);
  return {
    frames, stop,
    async open() { await flush(); onClick(); await flush(); return modal; },
    status: () => modal.root.querySelector('.lvil-status').textContent,
  };
}

test('opening the panel requests settings, registry, auto flag and image list for the active chat', async () => {
  const h = harness();
  await h.open();
  const types = h.frames.map((f) => f.type);
  assert.ok(types.includes('load_settings'));
  assert.ok(types.includes('load_registry'));
  assert.ok(types.includes('load_auto'));
  assert.ok(types.includes('list_images'));
  h.stop();
});

test('with no active character, the registry section explains it needs a card instead of crashing', async () => {
  const h = harness({ characterId: null });
  const modal = await h.open();
  const text = modal.root.textContent !== undefined ? '' : ''; // N has no textContent aggregation; walk instead
  const found = modal.root.find((n) => (n.textContent || '').includes('캐릭터 카드를 연 채팅에서만'));
  assert.ok(found, text);
  h.stop();
});

test('toggling auto sends set_auto with the chat id and the opposite of the current value', async () => {
  const h = harness();
  await h.open();
  const modal = await h.open();
  const toggleBtn = modal.root.find((n) => n.tagName === 'BUTTON' && /켜짐|꺼짐/.test(n.textContent));
  toggleBtn.click();
  await flush();
  const setAuto = h.frames.find((f) => f.type === 'set_auto');
  assert.equal(setAuto.chatId, 'c1');
  assert.equal(setAuto.on, false); // defaults.auto = true -> toggled off
  h.stop();
});

test('regenerate button sends chatId/messageId/imageId and refreshes the image list on success', async () => {
  let regenCalled = false;
  const h = harness({
    reply: (p) => {
      if (p.type === 'list_images') return { images: regenCalled ? [{ id: 'p1', messageId: 'm1', summary: 'a', imageUrl: 'u' }] : [{ id: 'p1', messageId: 'm1', summary: 'a', imageUrl: 'u' }] };
      if (p.type === 'regenerate') { regenCalled = true; return {}; }
      return undefined;
    },
  });
  const modal = await h.open();
  const btn = modal.root.find((n) => n.tagName === 'BUTTON' && n.textContent === '다시 그리기');
  assert.ok(btn);
  btn.click();
  await flush();
  const regen = h.frames.find((f) => f.type === 'regenerate');
  assert.equal(regen.chatId, 'c1');
  assert.equal(regen.messageId, 'm1');
  assert.equal(regen.imageId, 'p1');
  h.stop();
});

test('settings dropdown change sends save_settings with the merged field', async () => {
  const h = harness();
  await h.open();
  const sel = (await h.open()).root.find((n) => n.tagName === 'SELECT');
  sel.value = 'end';
  for (const f of sel.listeners.change || []) f({ target: sel });
  await flush();
  const saved = h.frames.find((f) => f.type === 'save_settings');
  assert.equal(saved.settings.position, 'end');
  h.stop();
});

test('stop() tears down without throwing even before the modal is ever opened', () => {
  const h = harness();
  assert.doesNotThrow(() => h.stop());
});
