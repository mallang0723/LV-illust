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

// ---------------------------------------------------------------- REGRESSION: review finding 3

test('REGRESSION: "+ 인물 추가" adds a local draft row (no backend call) and only saves once a name is typed', async () => {
  const h = harness(); // load_registry defaults to []
  const modal = await h.open();
  const addBtn = modal.root.find((n) => n.tagName === 'BUTTON' && n.textContent === '+ 인물 추가');
  assert.ok(addBtn);
  const framesBefore = h.frames.length;
  addBtn.click();
  await flush();
  // clicking "+ 인물 추가" must NOT call save_registry by itself (that's the bug: a
  // names:[] entry gets normalized away server-side, so the button did nothing)
  assert.equal(h.frames.slice(framesBefore).some((f) => f.type === 'save_registry'), false);
  // but a new editable row must now exist
  const nameInput = modal.root.find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === '이름/별칭 (쉼표로 구분)');
  assert.ok(nameInput, 'a new draft row with a name input must be rendered');
  // typing a name and clicking that row's own "저장" saves the FULL list with the new name
  nameInput.value = '아드리안';
  const rowSaveBtn = modal.root.find((n) => n.tagName === 'BUTTON' && n.textContent === '저장');
  assert.ok(rowSaveBtn);
  rowSaveBtn.click();
  await flush();
  const saved = h.frames.find((f) => f.type === 'save_registry');
  assert.ok(saved, 'save_registry must be sent once a name is entered and the row is saved');
  assert.deepEqual(saved.registry.map((c) => c.names), [['아드리안']]);
  h.stop();
});

test('REGRESSION: adding a second draft row after already saving one character still works from empty', async () => {
  // Reproduces "starting from an empty registry, nobody can ever be added" end to end:
  // empty -> add -> name it -> save -> (server echoes it back) -> add again -> name it -> save.
  let saved = [];
  const h = harness({
    reply: (p) => {
      if (p.type === 'load_registry') return { registry: saved };
      if (p.type === 'save_registry') { saved = p.registry.map((c, i) => ({ id: 'c' + i, enabled: true, appearance: '', ...c })); return { registry: saved }; }
      return undefined;
    },
  });
  const modal = await h.open();
  const addBtn = () => modal.root.find((n) => n.tagName === 'BUTTON' && n.textContent === '+ 인물 추가');
  addBtn().click();
  await flush();
  let nameInput = modal.root.find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === '이름/별칭 (쉼표로 구분)');
  nameInput.value = '아드리안';
  modal.root.find((n) => n.tagName === 'BUTTON' && n.textContent === '저장').click();
  await flush();
  assert.equal(saved.length, 1);
  h.stop();
});

// ---------------------------------------------------------------- REGRESSION: review finding 4

function manualHarness({ characterId = 'ch1' } = {}) {
  const pendingResolvers = []; // { requestId, type, resolve(payload) }
  let onBackend, onClick, modal = null;
  const ui = {
    registerInputBarAction: () => ({ setEnabled() {}, onClick: (f) => { onClick = f; return () => {}; }, destroy() {} }),
    showModal: () => { const dis = []; modal = { root: new N('div'), onDismiss: (f) => dis.push(f), dismiss: () => { dis.forEach((f) => f()); } }; return { root: modal.root, onDismiss: modal.onDismiss, dismiss: modal.dismiss }; },
  };
  let curChatId = 'c1', curCharacterId = characterId;
  const ctx = {
    ui,
    getActiveChat: () => ({ chatId: curChatId, characterId: curCharacterId }),
    events: { on: () => () => {} },
    state: { subscribe: () => () => {} },
    onBackendMessage: (f) => { onBackend = f; return () => {}; },
    sendToBackend: (p) => {
      pendingResolvers.push({
        requestId: p.requestId, type: p.type,
        resolve: (payload) => onBackend({ ok: true, ...payload, requestId: p.requestId, type: p.type }),
      });
    },
  };
  const stop = setup(ctx);
  return {
    stop,
    switchTo(chatId, characterId) { curChatId = chatId; curCharacterId = characterId; },
    async openOnce() { await flush(); onClick(); await flush(); return modal; },
    resolveAllPending(makePayload) {
      const batch = pendingResolvers.splice(0, pendingResolvers.length);
      for (const r of batch) r.resolve(makePayload(r.type));
    },
    // resolve only the OLDEST `n` still-pending requests (card A's original 4), leaving
    // whatever card B has sent since untouched/unresolved — so this test can prove the
    // stale answers don't win without also feeding them into card B's own legitimate load.
    resolveOldest(n, makePayload) {
      const batch = pendingResolvers.splice(0, n);
      for (const r of batch) r.resolve(makePayload(r.type));
    },
  };
}

test('REGRESSION: a late response from a SUPERSEDED load never overwrites the newer card\'s data', async () => {
  const h = manualHarness({ characterId: 'cardA' });
  const modalA = await h.openOnce(); // load for card A now in flight, unresolved
  // user closes and reopens for a different card before card A's load ever answers
  modalA.dismiss();
  h.switchTo('c2', 'cardB');
  const modalB = await h.openOnce(); // a second, newer load is now also in flight (4 more requests)
  // only card A's original (stale) 4 requests answer — card B's own requests are left
  // pending/unanswered, so any stale text appearing could only have come from A's leak
  h.resolveOldest(4, (type) => ({
    load_settings: { settings: { position: 'start', depth: 0, role: 'user', maxImages: 1 } },
    load_registry: { registry: [{ id: 'stale', names: ['카드A인물'], appearance: '', enabled: true }] },
    load_auto: { auto: false },
    list_images: { images: [] },
  }[type]));
  await flush();
  // the modal now showing must be card B's — stale card A text must not appear in it
  const staleText = modalB.root.find((n) => (n.textContent || '').includes('카드A인물'));
  assert.equal(staleText, null, 'a stale response from the superseded card A load must not render');
  // drain card B's still-pending requests so this test doesn't leave a real 20s
  // setTimeout alive in the background (request()'s default timeout)
  h.resolveAllPending(() => ({ settings: {}, registry: [], auto: true, images: [] }));
  h.stop();
});

test('REGRESSION: writes are disabled until the current card\'s load actually succeeds', async () => {
  const h = manualHarness();
  const modal = await h.openOnce(); // load in flight, nothing resolved yet
  const toggleBtn = modal.root.find((n) => n.tagName === 'BUTTON' && /켜짐|꺼짐/.test(n.textContent));
  assert.equal(toggleBtn.disabled, true, 'auto-toggle must be disabled before load completes');
  h.resolveAllPending(() => ({ settings: {}, registry: [], auto: true, images: [] }));
  h.stop();
});

// ---------------------------------------------------------------- REGRESSION: review (2nd pass) finding 6

test('REGRESSION (2nd pass, finding 6): an orphaned image shows status/reason only, never a regenerate button', async () => {
  const h = harness({
    reply: (p) => (p.type === 'list_images'
      ? { images: [
        { id: 'p1', messageId: 'm1', summary: 'ok one', imageUrl: 'u1', status: 'ok' },
        { id: 'p2', messageId: 'm1', summary: 'orphaned one', imageUrl: 'u2', status: 'orphan', reason: '메시지가 바뀌어 넣지 못함' },
      ] }
      : undefined),
  });
  const modal = await h.open();
  const regenButtons = [...modal.root.walk()].filter((n) => n.tagName === 'BUTTON' && n.textContent === '다시 그리기');
  assert.equal(regenButtons.length, 1, 'only the non-orphan image gets a regenerate button');
  const reasonText = modal.root.find((n) => (n.textContent || '').includes('메시지가 바뀌어 넣지 못함'));
  assert.ok(reasonText, 'the orphan\'s reason must still be shown');
  h.stop();
});
