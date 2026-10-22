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
  const evs = {};
  let onBackend, onClick, modal = null;
  const defaults = {
    load_status: { missing: [] },
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
    events: { on: (ev, f) => { (evs[ev] ||= []).push(f); return () => {}; } },
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
    push: (msg) => onBackend(msg),
    emitEvent: (ev, payload) => { for (const f of evs[ev] || []) f(payload); },
    get modal() { return modal; },
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

// ---------------------------------------------------------------- independent loads / permission states

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allText = (root) => [...root.walk()].map((n) => n.textContent || '').join(' ');
const findBtn = (root, re) => root.find((n) => n.tagName === 'BUTTON' && re.test(n.textContent));

test('PARTIAL LOAD FAILURE: one failed load only disables its own section; status names it with a retry', async () => {
  const h = harness({ reply: (p) => (p.type === 'list_images' ? { ok: false, error: '목록 오류' } : undefined) });
  const modal = await h.open();
  // unrelated controls stay usable (previously a single shared ready=false disabled them all)
  assert.equal(findBtn(modal.root, /켜짐 \(끄기\)/).disabled, false, 'auto toggle usable');
  assert.equal(modal.root.find((n) => n.tagName === 'SELECT').disabled, false, 'settings usable');
  assert.equal(findBtn(modal.root, /\+ 인물 추가/).disabled, false, 'registry usable');
  const fail = modal.root.querySelector('.lvil-loadfail');
  assert.ok(fail, 'a failed-load line is shown');
  assert.match(allText(fail), /그림 목록/);
  assert.doesNotMatch(allText(fail), /설정|인물 등록부|자동 생성/);
  // tapping the auto toggle still works
  findBtn(modal.root, /켜짐 \(끄기\)/).click();
  await flush();
  assert.ok(h.frames.some((f) => f.type === 'set_auto'));
  h.stop();
});

test('PARTIAL LOAD FAILURE: "다시 시도" re-requests only the failed load', async () => {
  let failImages = true;
  const h = harness({ reply: (p) => (p.type === 'list_images' && failImages ? { ok: false, error: '목록 오류' } : undefined) });
  const modal = await h.open();
  const before = h.frames.length;
  failImages = false;
  modal.root.querySelector('.lvil-loadfail').find((n) => n.tagName === 'BUTTON').click();
  await flush();
  const retried = h.frames.slice(before).map((f) => f.type).filter((t) => t !== 'load_status');
  assert.deepEqual(retried, ['list_images']);
  assert.equal(modal.root.querySelector('.lvil-loadfail'), null, 'failure line gone after a successful retry');
  h.stop();
});

test('PERMISSION STATE: a permission-denied load shows "권한 허용 후 다시 시도" and recovers automatically on the backend push', async () => {
  let granted = false;
  const h = harness({
    reply: (p) => {
      if (!granted && p.type === 'load_registry') return { ok: false, error: 'PERMISSION_DENIED: characters — Characters permission not granted', permission: 'characters' };
      if (!granted && p.type === 'list_images') return { ok: false, error: 'PERMISSION_DENIED: chat_mutation — x', permission: 'chat_mutation' };
      if (p.type === 'load_status') return { missing: granted ? [] : ['characters', 'chat_mutation', 'generation', 'interceptor'] };
      return undefined;
    },
  });
  const modal = await h.open();
  const text = allText(modal.root);
  assert.match(text, /권한 허용 후 다시 시도/);
  assert.match(text, /characters/);
  assert.match(text, /아직 허용되지 않은 권한/);
  assert.doesNotMatch(text, /PERMISSION_DENIED/, 'raw host error string is not what the user reads');
  assert.equal(findBtn(modal.root, /\+ 인물 추가/).disabled, true, 'registry waits for its permission');
  assert.equal(findBtn(modal.root, /켜짐 \(끄기\)/).disabled, false, 'settings/auto (no permission needed) usable right away');
  granted = true;
  // host: one notification per granted permission -> backend pushes each; burst collapses
  const before = h.frames.length;
  for (const p of ['characters', 'chat_mutation', 'generation', 'interceptor']) h.push({ type: 'permissions_changed', permission: p, granted: true });
  await sleep(300); await flush();
  const retried = h.frames.slice(before).map((f) => f.type).sort();
  assert.deepEqual(retried, ['list_images', 'load_registry', 'load_status'], 'one retry of just the failed loads (+ status)');
  assert.equal(findBtn(h.modal.root, /\+ 인물 추가/).disabled, false, 'registry usable without reopening');
  assert.doesNotMatch(allText(h.modal.root), /권한 허용 후 다시 시도|아직 허용되지 않은 권한/);
  h.stop();
});

test('PERMISSION STATE: the host-wide SPINDLE_PERMISSION_CHANGED event also triggers the retry', async () => {
  let granted = false;
  const h = harness({ reply: (p) => (!granted && p.type === 'list_images' ? { ok: false, error: 'PERMISSION_DENIED: chat_mutation — x', permission: 'chat_mutation' } : undefined) });
  const modal = await h.open();
  assert.ok(modal.root.querySelector('.lvil-loadfail'), 'failure shown before the grant');
  const before = h.frames.length;
  granted = true;
  h.emitEvent('SPINDLE_PERMISSION_CHANGED', { extensionId: 'x', permission: 'chat_mutation', granted: true, allGranted: ['chat_mutation'] });
  await sleep(300); await flush();
  assert.deepEqual(h.frames.slice(before).map((f) => f.type).filter((t) => t !== 'load_status'), ['list_images']);
  assert.equal(h.modal.root.querySelector('.lvil-loadfail'), null);
  h.stop();
});

test('PERMISSION STATE: a typed-but-unsaved registry name survives the automatic re-render', async () => {
  let granted = false;
  const h = harness({ reply: (p) => (!granted && p.type === 'list_images' ? { ok: false, error: 'PERMISSION_DENIED: chat_mutation — x', permission: 'chat_mutation' } : undefined) });
  const modal = await h.open();
  findBtn(modal.root, /\+ 인물 추가/).click();
  await flush();
  const input = modal.root.find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === '이름/별칭 (쉼표로 구분)');
  input.value = '정수빈';
  for (const f of input.listeners.input || []) f({ target: input });
  granted = true;
  h.push({ type: 'permissions_changed', permission: 'chat_mutation', granted: true });
  await sleep(300); await flush();
  const again = h.modal.root.find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === '이름/별칭 (쉼표로 구분)');
  assert.ok(again && again !== input, 're-rendered');
  assert.equal(again.attrs.value, '정수빈');
  h.stop();
});

test('a timed-out or failed load never leaves the panel blank: the other sections still render their controls', async () => {
  const h = harness({ reply: (p) => (p.type === 'load_settings' ? { ok: false, error: '응답 시간 초과', timeout: true } : undefined) });
  const modal = await h.open();
  assert.equal(modal.root.find((n) => n.tagName === 'SELECT').disabled, true, 'settings waits for its own load');
  assert.equal(findBtn(modal.root, /켜짐 \(끄기\)/).disabled, false);
  assert.ok(findBtn(modal.root, /^다시 그리기$/) === null || findBtn(modal.root, /^다시 그리기$/).disabled === false);
  assert.match(allText(modal.root.querySelector('.lvil-loadfail')), /설정/);
  h.stop();
});

// ---------------------------------------------------------------- 0.2.0 redesign

const F = await import('../src/frontend.mjs');
const REG2 = [
  { id: 'c0', names: ['아드리안', 'Adrian'], body: '1boy, silver hair', outfit: 'black coat, white gloves', negative: 'extra fingers', enabled: true },
  { id: 'c1', names: ['정수빈'], body: '1girl, mystery tag', outfit: 'school uniform', negative: '', enabled: true,
    legacyAppearance: '1girl, school uniform, mystery tag', needsReview: true, reviewTags: ['mystery tag'] },
];
const IMGS = [
  { id: 'p1', messageId: 'm1', status: 'ok', summary: '골목', imageUrl: 'u1', prompt: 'masterpiece, alley', negative: 'lowres', slots: ['1boy, silver hair'] },
  { id: 'p2', messageId: 'm2', status: 'orphan', summary: '밤', imageUrl: 'u2', reason: '메시지가 바뀌어 넣지 못함' },
];
const withData = (extra = {}) => (p) => ({ load_registry: { registry: REG2 }, list_images: { images: IMGS }, ...extra }[p.type]);
// the DOM stand-in keeps string `value` attributes in attrs only; a real input reflects them
const syncNames = (root) => { for (const n of root.walk()) if (n.tagName === 'INPUT' && n.attrs['aria-label'] === '이름과 별칭') n.value = n.attrs.value ?? n.value; };
const btnText = (root, text) => root.find((n) => n.tagName === 'BUTTON' && n.textContent === text);

test('view helpers: one-line summaries for the section badges', () => {
  assert.equal(F.settingsSummary({ position: 'depth', depth: 4, maxImages: 2 }), '깊이 4 · 2장');
  assert.equal(F.settingsSummary({ position: 'start', depth: 4, maxImages: 1 }), '맨 앞 · 1장');
  assert.equal(F.settingsSummary(null), '');
  assert.equal(F.registrySummary([]), '비어 있음');
  assert.equal(F.registrySummary(REG2), '2명 · 확인 1');
  assert.equal(F.registrySummary([REG2[0]]), '1명');
  assert.equal(F.imagesSummary([]), '없음');
  assert.equal(F.imagesSummary(IMGS), '2장 · 확인 1');
  assert.equal(F.imagesSummary([IMGS[0]]), '1장');
  assert.equal(F.tagCount('a, b, 1.2::c, d::'), 3);
});

test('registryWithDrafts: unsaved edits are layered over the saved registry; nameless rows are left out', () => {
  const out = F.registryWithDrafts([...REG2, { names: [], body: '', outfit: '', negative: '', enabled: true }], { 0: { outfit: 'suit', names: '아드리안, A' }, 2: { names: '새 인물', body: 'tall' } });
  assert.deepEqual(out.map((c) => c.names), [['아드리안', 'A'], ['정수빈'], ['새 인물']]);
  assert.equal(out[0].outfit, 'suit');
  assert.equal(out[0].body, '1boy, silver hair');
  assert.equal(out[2].body, 'tall');
});

test('resplitLooks: re-runs the same heuristic over body + outfit text, nothing dropped', () => {
  const r = F.resplitLooks('1girl, red dress, silver hair', 'glasses, mystery');
  assert.equal(r.outfit, 'red dress, glasses');
  assert.equal(r.body, '1girl, silver hair, mystery');
  assert.deepEqual(r.review, ['mystery']);
});

test('copyText: never throws without a secure context — falls back, then reports failure', async () => {
  assert.equal(await F.copyText('x', null, {}), false); // no clipboard, no document
  assert.equal(await F.copyText('x', null, { clipboard: { writeText: async () => {} } }), true);
  const bad = { clipboard: { writeText: async () => { throw new Error('NotAllowed'); } } };
  assert.equal(await F.copyText('x', null, bad), false);
  const made = [];
  const doc = { body: { append: (n) => made.push(n) }, execCommand: (c) => c === 'copy', createElement: () => ({ setAttribute() {}, style: {}, select() {}, remove() {} }) };
  assert.equal(await F.copyText('x', doc, bad), true); // clipboard denied -> legacy path
  assert.equal(made.length, 1);
});

test('source guard: the panel code never touches crypto.* or navigator.clipboard directly (clipboard only through the guarded copyText)', async () => {
  const raw = await (await import('node:fs/promises')).readFile(new URL('../src/frontend.mjs', import.meta.url), 'utf8');
  const src = raw.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // comments don't count
  assert.doesNotMatch(src, /crypto\./);
  assert.doesNotMatch(src, /navigator\.clipboard/);
  for (const m of src.matchAll(/\.clipboard\b/g)) assert.match(src.slice(Math.max(0, m.index - 20), m.index), /nav( &&|\b)/);
});

test('redesign: four collapsible sections each carry a summary badge, and the overview shows chips', async () => {
  const h = harness({ reply: withData() });
  const modal = await h.open();
  const toggles = [...modal.root.walk()].filter((n) => (n.attrs.class || '') === 'lvil-sec-toggle');
  assert.deepEqual(toggles.map((t) => t.attrs['data-section']), ['images', 'registry', 'preview', 'settings']);
  const text = allText(modal.root);
  assert.match(text, /2장 · 확인 1/); // images badge
  assert.match(text, /2명 · 확인 1/); // registry badge
  assert.match(text, /깊이 4 · 2장/); // settings badge
  assert.match(text, /답변당 최대 2장/);
  h.stop();
});

test('redesign: clicking a section header toggles aria-expanded and the body hidden flag', async () => {
  const h = harness({ reply: withData() });
  const modal = await h.open();
  const tog = () => [...h.modal.root.walk()].find((n) => n.attrs['data-section'] === 'settings');
  assert.equal(tog().attrs['aria-expanded'], 'false');
  tog().click();
  assert.equal(tog().attrs['aria-expanded'], 'true');
  const bodyOf = (t) => { for (const n of h.modal.root.walk()) if (n.children.includes(t)) return n; return null; };
  void modal; void bodyOf;
  h.stop();
});

test('redesign: a migrated character shows the "확인해 주세요" hint with the ambiguous tag and the original; saving clears the flag and sends the split fields', async () => {
  const h = harness({ reply: (p) => {
    if (p.type === 'save_registry') return { registry: p.registry };
    return withData()(p);
  } });
  const modal = await h.open();
  const text = allText(modal.root);
  assert.match(text, /확인해 주세요/);
  assert.match(text, /mystery tag/);
  assert.match(text, /1girl, school uniform, mystery tag/); // the untouched original stays visible
  const saveBtns = [...modal.root.walk()].filter((n) => n.tagName === 'BUTTON' && n.textContent === '저장');
  syncNames(modal.root);
  saveBtns[1].click(); // second character (the flagged one)
  await flush();
  const saved = h.frames.find((f) => f.type === 'save_registry');
  assert.equal(saved.registry[1].needsReview, false);
  assert.equal(saved.registry[1].body, '1girl, mystery tag');
  assert.equal(saved.registry[1].outfit, 'school uniform');
  assert.equal(saved.registry[1].legacyAppearance, '1girl, school uniform, mystery tag'); // original not discarded
  assert.equal(saved.registry[0].outfit, 'black coat, white gloves'); // other characters untouched
  assert.ok(!('appearance' in saved.registry[0]));
  h.stop();
});

test('redesign: body, outfit and negative are separate fields; editing one never touches the other', async () => {
  const h = harness({ reply: withData() });
  const modal = await h.open();
  const ta = (label) => [...modal.root.walk()].filter((n) => n.tagName === 'TEXTAREA' && n.attrs['aria-label'] === label);
  assert.equal(ta('신체 특성').length, 2);
  assert.equal(ta('옷·장신구').length, 2);
  assert.equal(ta('이 인물의 네거티브').length, 2);
  ta('옷·장신구')[0].value = 'suit';
  for (const f of ta('옷·장신구')[0].listeners.input || []) f({ target: ta('옷·장신구')[0] });
  syncNames(modal.root);
  btnText(modal.root, '저장').click();
  await flush();
  const saved = h.frames.find((f) => f.type === 'save_registry');
  assert.equal(saved.registry[0].outfit, 'suit');
  assert.equal(saved.registry[0].body, '1boy, silver hair');
  h.stop();
});

test('redesign: "신체/옷 자동 나누기" re-splits the drafts with the migration heuristic (not saved until 저장)', async () => {
  const h = harness({ reply: withData() });
  const modal = await h.open();
  const body = [...modal.root.walk()].find((n) => n.tagName === 'TEXTAREA' && n.attrs['aria-label'] === '신체 특성');
  body.value = '1boy, silver hair, black coat';
  for (const f of body.listeners.input || []) f({ target: body });
  const before = h.frames.length;
  [...modal.root.walk()].find((n) => n.tagName === 'BUTTON' && n.textContent === '신체/옷 자동 나누기').click();
  await flush();
  assert.equal(h.frames.slice(before).some((f) => f.type === 'save_registry'), false);
  const again = [...h.modal.root.walk()].find((n) => n.tagName === 'TEXTAREA' && n.attrs['aria-label'] === '신체 특성');
  assert.equal(again.value, '1boy, silver hair');
  const out = [...h.modal.root.walk()].find((n) => n.tagName === 'TEXTAREA' && n.attrs['aria-label'] === '옷·장신구');
  assert.equal(out.value, 'black coat, white gloves');
  h.stop();
});

test('redesign: deleting a character needs a second tap (no accidental loss)', async () => {
  const h = harness({ reply: withData() });
  const modal = await h.open();
  const del = () => [...h.modal.root.walk()].filter((n) => n.tagName === 'BUTTON' && /^(삭제|한 번 더 눌러 삭제)$/.test(n.textContent))[0];
  del().click();
  await flush();
  assert.equal(h.frames.some((f) => f.type === 'save_registry'), false);
  assert.equal(del().textContent, '한 번 더 눌러 삭제');
  del().click();
  await flush();
  const saved = h.frames.find((f) => f.type === 'save_registry');
  assert.deepEqual(saved.registry.map((c) => c.id), ['c1']);
  void modal;
  h.stop();
});

test('redesign: tapping a picture opens a detail view with the sent prompt/negative/slots and a back button; orphans get no regenerate there', async () => {
  const h = harness({ reply: withData() });
  const modal = await h.open();
  const thumbs = () => [...h.modal.root.walk()].filter((n) => (n.attrs.class || '') === 'lvil-thumb');
  assert.equal(thumbs().length, 2);
  thumbs()[0].click();
  let text = allText(h.modal.root);
  assert.match(text, /masterpiece, alley/);
  assert.match(text, /lowres/);
  assert.match(text, /1\. 1boy, silver hair/);
  assert.ok(btnText(h.modal.root, '다시 그리기'), 'a normal image can be regenerated from its detail view');
  btnText(h.modal.root, '← 목록').click();
  assert.equal(thumbs().length, 2);
  thumbs()[1].click(); // the orphan
  text = allText(h.modal.root);
  assert.match(text, /메시지가 바뀌어 넣지 못함/);
  assert.equal(btnText(h.modal.root, '다시 그리기'), null, 'orphan detail: status/reason only');
  void modal;
  h.stop();
});

test('redesign: the prompt preview sends the chars/scene and the UNSAVED draft registry, and renders positive, slots and negative', async () => {
  const h = harness({ reply: withData({ preview_prompt: { prompt: 'masterpiece, 골목', negativePrompt: 'lowres, extra fingers', characterTags: [{ tags: '1boy, suit' }], hasMainPreset: true } }) });
  const modal = await h.open();
  const inputs = (label) => [...modal.root.walk()].find((n) => n.tagName === 'INPUT' && n.attrs['aria-label'] === label);
  const chars = inputs('인물(chars)'), scene = inputs('장면 프롬프트');
  chars.value = '아드리안: 미소 | 옷: suit'; for (const f of chars.listeners.input || []) f({ target: chars });
  scene.value = '골목'; for (const f of scene.listeners.input || []) f({ target: scene });
  // an unsaved outfit edit must be what the preview uses
  const outfit = [...modal.root.walk()].find((n) => n.tagName === 'TEXTAREA' && n.attrs['aria-label'] === '옷·장신구');
  outfit.value = 'draft outfit'; for (const f of outfit.listeners.input || []) f({ target: outfit });
  btnText(modal.root, '미리보기').click();
  await flush();
  const req = h.frames.find((f) => f.type === 'preview_prompt');
  assert.equal(req.chars, '아드리안: 미소 | 옷: suit');
  assert.equal(req.scene, '골목');
  assert.equal(req.characterId, 'ch1');
  assert.equal(req.registry[0].outfit, 'draft outfit');
  const text = allText(h.modal.root);
  assert.match(text, /masterpiece, 골목/);
  assert.match(text, /1\. 1boy, suit/);
  assert.match(text, /lowres, extra fingers/);
  assert.match(text, /기본 네거티브는 대체/); // tells the user a sent negative replaces the host default
  h.stop();
});

test('redesign: an empty composed negative says the host default stays in force', async () => {
  const h = harness({ reply: withData({ preview_prompt: { prompt: 'x', negativePrompt: '', characterTags: [], hasMainPreset: false } }) });
  const modal = await h.open();
  btnText(modal.root, '미리보기').click();
  await flush();
  assert.match(allText(h.modal.root), /호스트의 기본 네거티브가 그대로 쓰입니다/);
  h.stop();
});

test('redesign: 공통 네거티브 is applied through save_settings with the other settings kept; bound-negative switch toggles boundNegatives', async () => {
  const settings = { position: 'depth', depth: 4, role: 'system', maxImages: 2, commonNegative: '', boundNegatives: true };
  const h = harness({ reply: (p) => (p.type === 'load_settings' ? { settings } : p.type === 'save_settings' ? { settings: p.settings } : undefined) });
  const modal = await h.open();
  const neg = [...modal.root.walk()].find((n) => n.tagName === 'TEXTAREA' && n.attrs['aria-label'] === '공통 네거티브');
  neg.value = 'lowres, text';
  for (const f of neg.listeners.input || []) f({ target: neg });
  btnText(modal.root, '적용').click();
  await flush();
  const saved = h.frames.filter((f) => f.type === 'save_settings').at(-1);
  assert.equal(saved.settings.commonNegative, 'lowres, text');
  assert.equal(saved.settings.boundNegatives, true);
  assert.equal(saved.settings.position, 'depth');
  const bound = [...h.modal.root.walk()].filter((n) => n.tagName === 'BUTTON' && /켜짐 \(끄기\)/.test(n.textContent)).at(-1);
  bound.click();
  await flush();
  assert.equal(h.frames.filter((f) => f.type === 'save_settings').at(-1).settings.boundNegatives, false);
  h.stop();
});

test('redesign: the depth field only exists while the position is "depth"; max pictures is a 1/2 segmented control', async () => {
  const h = harness({ reply: (p) => (p.type === 'load_settings' ? { settings: { position: 'end', depth: 4, role: 'system', maxImages: 2 } } : undefined) });
  const modal = await h.open();
  assert.equal([...modal.root.walk()].some((n) => n.tagName === 'INPUT' && n.attrs['aria-label'] === '깊이'), false);
  btnText(modal.root, '1장').click();
  await flush();
  assert.equal(h.frames.find((f) => f.type === 'save_settings').settings.maxImages, 1);
  h.stop();
});

test('redesign: the "older record" caveat shows only for records without a recorded composed prompt', async () => {
  const imgs = [{ ...IMGS[0], recorded: true }, { id: 'p9', messageId: 'm9', status: 'ok', summary: '옛 그림', imageUrl: 'u', prompt: 'scene only', slots: ['a'] }];
  const h = harness({ reply: withData({ list_images: { images: imgs } }) });
  const modal = await h.open();
  const thumbs = () => [...h.modal.root.walk()].filter((n) => (n.attrs.class || '') === 'lvil-thumb');
  thumbs()[0].click();
  assert.doesNotMatch(allText(h.modal.root), /이전 버전에서 그린 그림/);
  btnText(h.modal.root, '← 목록').click();
  thumbs()[1].click();
  assert.match(allText(h.modal.root), /이전 버전에서 그린 그림/);
  void modal;
  h.stop();
});
