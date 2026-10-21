import { normalizeSettings, normalizeRegistry, IDENTIFIER } from './core.mjs';

// Frontend: input-bar action "삽화가 설정" -> host modal with settings (user-wide),
// the current card's registry (card-wide), the current chat's auto-gen toggle, and a
// list of this chat's generated images with a "다시 그리기" button each (F6).
// Free APIs only: registerInputBarAction, showModal, getActiveChat, events.on,
// state.subscribe. All writes go through the backend worker (sendToBackend/onBackendMessage).
//
// Each of the four loads (settings / auto flag / registry / image list) is independent:
// a failing one only disables its OWN section's controls, is named in the status line
// with a "다시 시도" button, and — when it failed for lack of a permission — is retried
// automatically as soon as the host reports a permission change (backend push
// `permissions_changed`, or the host-wide SPINDLE_PERMISSION_CHANGED event). Previously a
// single failed load set one shared `ready=false` that disabled every control in the
// panel, which on a phone looked like a window where nothing could be tapped.

// section -> backend request type, and the Korean label used in the status line
const LOADS = {
  settings: { type: 'load_settings', label: '설정' },
  auto: { type: 'load_auto', label: '자동 생성 상태' },
  registry: { type: 'load_registry', label: '인물 등록부' },
  images: { type: 'list_images', label: '그림 목록' },
};
const SECTION_NAMES = Object.keys(LOADS);
const PERMISSION_LABELS = {
  generation: '생성 이벤트(generation)',
  interceptor: '프롬프트 끼워 넣기(interceptor)',
  chat_mutation: '메시지 읽기·수정(chat_mutation)',
  characters: '캐릭터 카드(characters)',
  chats: '채팅 정보(chats)',
  image_gen: '그림 생성(image_gen)',
};
const permLabel = (p) => PERMISSION_LABELS[p] || p;

const CSS = `
.lvil{--fg:var(--lumiverse-text,#e8e6ef);--dim:var(--lumiverse-text-muted,#9b98a8);--line:var(--lumiverse-border,rgba(127,127,127,.28));
--fill:var(--lumiverse-fill-subtle,rgba(127,127,127,.10));--acc:var(--lumiverse-primary,#ff836e);
color:var(--fg);font-size:14px;line-height:1.4;display:flex;flex-direction:column;gap:10px;padding:2px 0 8px;box-sizing:border-box}
.lvil *{box-sizing:border-box}
.lvil-status{font-size:12.5px;color:var(--dim);min-height:1.2em}
.lvil-status[data-kind=err],.lvil-loadfail,.lvil-sec-state[data-state=error],.lvil-sec-state[data-state=perm]{color:var(--lumiverse-danger,#ef4444)}
.lvil-status[data-kind=ok]{color:var(--acc)}
.lvil-loadfail,.lvil-perm{font-size:12.5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lvil-perm{color:var(--dim)}
.lvil-sec-state{font-size:12px;color:var(--dim);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lvil section{border:1px solid var(--line);border-radius:10px;background:var(--fill);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.lvil h4{margin:0;font-size:13px;color:var(--dim)}
.lvil-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lvil button{font:inherit;font-size:13px;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 11px;min-height:34px;cursor:pointer;touch-action:manipulation}
.lvil button:hover:not(:disabled){border-color:var(--acc)}
.lvil button:disabled{opacity:.5;cursor:default}
.lvil button[data-active=true]{border-color:var(--acc);font-weight:600}
.lvil input[type=text],.lvil textarea,.lvil select{font:inherit;font-size:16px;color:var(--fg);background:var(--lumiverse-fill,rgba(0,0,0,.15));border:1px solid var(--line);border-radius:8px;padding:6px 8px;width:100%;touch-action:manipulation}
.lvil-row>select,.lvil-row>input{flex:1 1 120px;width:auto;min-width:0}
.lvil textarea{min-height:48px;resize:vertical}
.lvil-char{border-top:1px dashed var(--line);padding-top:8px;display:flex;flex-direction:column;gap:4px}
.lvil-note{font-size:12px;color:var(--dim)}
.lvil-imglist{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}
.lvil-img{display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:6px}
.lvil-img img{width:48px;height:48px;object-fit:cover;border-radius:6px;background:#0003}
.lvil-img .sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
`;

const ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
}

export function setup(ctx) {
  let alive = true, modal = null, chatId = null, characterId = null, seq = 0;
  // Review finding 4: a late response from a SUPERSEDED load (e.g. the user closed the
  // panel and reopened it for a different card before the first load finished) used to
  // land in `view` regardless, so card A's registry could flash over — or silently
  // replace — card B's. `loadToken` fixes that: every open() mints a new token, and a
  // load only commits its results if its own token is still the current one.
  let loadToken = 0;
  const pending = new Map();
  const timers = new Set();
  // view.chatId/characterId are the SNAPSHOT this panel's data actually belongs to
  // (captured once per open(), not the live, possibly-already-moved-on outer
  // chatId/characterId vars) — every write (save/toggle/regenerate) targets these, not
  // whatever card happens to be active by the time the write fires.
  const freshLoads = () => Object.fromEntries(SECTION_NAMES.map((n) => [n, { state: 'idle', error: '', permission: '' }]));
  const view = {
    settings: null, registry: [], auto: true, images: [], status: '', kind: '', busy: false,
    loads: freshLoads(), missing: [], drafts: {}, chatId: null, characterId: null,
  };

  const action = ctx.ui.registerInputBarAction({ id: 'lv-illust', label: '삽화가 설정', iconSvg: ICON, enabled: false });

  function request(payload, ms = 20000) {
    const requestId = 'lvil-' + (++seq) + '-' + Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { timers.delete(timer); pending.delete(requestId); resolve({ ok: false, timeout: true, error: '응답 시간 초과' }); }, ms);
      timers.add(timer);
      pending.set(requestId, (r) => { clearTimeout(timer); timers.delete(timer); resolve(r); });
      try { ctx.sendToBackend({ ...payload, requestId }); }
      catch (e) { clearTimeout(timer); timers.delete(timer); pending.delete(requestId); resolve({ ok: false, error: String(e?.message || e) }); }
    });
  }
  const offBackend = ctx.onBackendMessage((r) => {
    if (r && r.type === 'permissions_changed' && !r.requestId) { onPermissionsChanged(); return; }
    const fn = r && pending.get(r.requestId);
    if (!fn) return;
    pending.delete(r.requestId);
    fn(r);
  });

  async function refreshActive() {
    let cur = null;
    try { cur = ctx.getActiveChat(); } catch { cur = null; }
    chatId = cur?.chatId || null; characterId = cur?.characterId || null;
    action.setEnabled(!!chatId);
  }

  function setStatus(text, kind = '') { view.status = text; view.kind = kind; const s = modal?.root.querySelector('.lvil-status'); if (s) { s.textContent = text; s.dataset.kind = kind; } }

  const sectionOk = (name) => view.loads[name].state === 'ok';
  const failedSections = () => SECTION_NAMES.filter((n) => ['error', 'perm'].includes(view.loads[n].state));

  function requestFor(name, snapChatId, snapCharacterId) {
    if (name === 'registry') {
      return snapCharacterId ? request({ type: 'load_registry', characterId: snapCharacterId }) : Promise.resolve({ ok: true, registry: [] });
    }
    if (name === 'settings') return request({ type: 'load_settings' });
    return request({ type: LOADS[name].type, chatId: snapChatId });
  }

  async function loadSection(name, token) {
    const ld = view.loads[name];
    if (ld.state === 'loading') return;
    Object.assign(ld, { state: 'loading', error: '', permission: '' });
    render();
    const r = await requestFor(name, view.chatId, view.characterId);
    if (!alive || token !== loadToken) return; // superseded by a newer open() — discard
    if (r.ok) {
      if (name === 'settings') view.settings = r.settings;
      if (name === 'registry') { view.registry = Array.isArray(r.registry) ? r.registry : []; view.drafts = {}; }
      if (name === 'auto') view.auto = r.auto;
      if (name === 'images') view.images = Array.isArray(r.images) ? r.images : [];
      Object.assign(ld, { state: 'ok', error: '', permission: '' });
    } else {
      Object.assign(ld, { state: r.permission ? 'perm' : 'error', error: r.error || '불러오지 못함', permission: r.permission || '' });
    }
    render();
  }

  async function loadStatus(token) {
    const r = await request({ type: 'load_status' });
    if (!alive || token !== loadToken) return;
    view.missing = r.ok && Array.isArray(r.missing) ? r.missing : [];
    render();
  }

  // Loads every section independently (in parallel) — one slow or failing load never
  // holds back the others. The status request goes last so its order never matters.
  async function loadSections(token, names) {
    await Promise.all([...names.map((n) => loadSection(n, token)), loadStatus(token)]);
  }

  function retryFailed() {
    if (!modal) return;
    const names = failedSections();
    loadSections(loadToken, names);
  }

  // A burst of host notifications (one per granted permission) collapses into one retry.
  let permTimer = null;
  function onPermissionsChanged() {
    if (!alive || !modal) return;
    if (permTimer) clearTimeout(permTimer);
    permTimer = setTimeout(() => { permTimer = null; retryFailed(); }, 250);
  }

  async function saveSettings(patch) {
    if (!sectionOk('settings') || view.busy) return;
    const token = loadToken;
    view.busy = true; render();
    const r = await request({ type: 'save_settings', settings: { ...view.settings, ...patch } });
    if (!alive || token !== loadToken) return;
    view.busy = false;
    if (r.ok) view.settings = r.settings;
    render();
    setStatus(r.ok ? '설정 저장됨' : failText(r), r.ok ? 'ok' : 'err');
  }

  async function toggleAuto() {
    if (!sectionOk('auto') || view.busy) return;
    const token = loadToken, targetChatId = view.chatId;
    view.busy = true; render();
    const r = await request({ type: 'set_auto', chatId: targetChatId, on: !view.auto });
    if (!alive || token !== loadToken) return;
    view.busy = false;
    if (r.ok) view.auto = r.auto;
    render();
    if (!r.ok) setStatus(failText(r), 'err');
  }

  async function saveRegistry(next) {
    if (!sectionOk('registry') || view.busy || !view.characterId) return;
    const token = loadToken, targetCharacterId = view.characterId;
    view.busy = true; render();
    const r = await request({ type: 'save_registry', characterId: targetCharacterId, registry: next });
    if (!alive || token !== loadToken) return;
    view.busy = false;
    if (r.ok) { view.registry = r.registry; view.drafts = {}; }
    render();
    setStatus(r.ok ? '등록부 저장됨' : failText(r), r.ok ? 'ok' : 'err');
  }

  function addDraftCharacter() {
    // Review finding 3: this used to call saveRegistry() immediately with a brand-new
    // {names: [], ...} entry — but normalizeRegistry() (core.mjs) correctly drops any
    // entry with no names (an unnamed character can't ever be matched against), so the
    // "+ 인물 추가" button silently did nothing, and starting from an empty registry
    // there was no way to ever add a first character. Fix: the new row is purely local
    // view state until its own "저장" button is clicked with a non-empty name — it is
    // never round-tripped through save_registry (and thus never dropped) before that.
    if (!sectionOk('registry') || view.busy) return;
    view.registry = [...view.registry, { names: [], appearance: '', enabled: true }];
    render();
  }

  async function regenerate(imageId, messageId) {
    if (!sectionOk('images') || view.busy) return;
    const token = loadToken, targetChatId = view.chatId;
    view.busy = true; render();
    const r = await request({ type: 'regenerate', chatId: targetChatId, messageId, imageId }, 60000);
    if (!alive || token !== loadToken) return;
    view.busy = false;
    if (r.ok) {
      const i = await request({ type: 'list_images', chatId: targetChatId });
      if (alive && token === loadToken && i.ok) view.images = i.images;
    }
    render();
    setStatus(r.ok ? '다시 그렸습니다' : failText(r), r.ok ? 'ok' : 'err');
  }

  function failText(r) {
    if (r?.permission) return `권한 허용 후 다시 시도: ${permLabel(r.permission)} 권한이 필요합니다`;
    return r?.error || '실패';
  }

  // Per-section state line: nothing when loaded, otherwise loading / error / permission
  // text with its own retry button (never blocked by `busy`).
  function sectionState(name) {
    const ld = view.loads[name];
    if (ld.state === 'ok' || ld.state === 'idle') return null;
    if (ld.state === 'loading') return el('div', { class: 'lvil-sec-state', 'data-state': 'loading', text: '불러오는 중…' });
    const text = ld.state === 'perm'
      ? `권한 허용 후 다시 시도 — ${permLabel(ld.permission)} 권한이 필요합니다 (허용되면 자동으로 다시 불러옵니다)`
      : `불러오지 못함: ${ld.error}`;
    return el('div', { class: 'lvil-sec-state', 'data-state': ld.state },
      el('span', { text }),
      el('button', { type: 'button', class: 'lvil-retry', text: '다시 시도', on: { click: () => loadSections(loadToken, [name]) } }));
  }

  function settingsSection() {
    const s = view.settings || {};
    const dis = view.busy || !sectionOk('settings');
    const autoDis = view.busy || !sectionOk('auto');
    const posSel = el('select', { disabled: dis, 'aria-label': '지시 위치', on: { change: (e) => saveSettings({ position: e.target.value }) } },
      ['start', 'end', 'depth'].map((p) => el('option', { value: p, selected: s.position === p, text: p === 'start' ? '맨 앞' : p === 'end' ? '맨 끝' : '깊이(최근 N번째 앞)' })));
    const depthInput = el('input', { type: 'text', inputmode: 'numeric', 'aria-label': '깊이', value: String(s.depth ?? 4), disabled: dis || s.position !== 'depth',
      on: { change: (e) => { const n = parseInt(e.target.value, 10); if (Number.isInteger(n) && n >= 0) saveSettings({ depth: n }); } } });
    const roleSel = el('select', { disabled: dis, 'aria-label': '지시 역할', on: { change: (e) => saveSettings({ role: e.target.value }) } },
      ['system', 'user', 'assistant'].map((r) => el('option', { value: r, selected: s.role === r, text: r })));
    const maxSel = el('select', { disabled: dis, 'aria-label': '답변당 최대 그림', on: { change: (e) => saveSettings({ maxImages: parseInt(e.target.value, 10) }) } },
      [1, 2].map((n) => el('option', { value: String(n), selected: s.maxImages === n, text: n + '장' })));
    return el('section', {},
      el('h4', { text: '⚙️ 설정 (계정 전체)' }),
      sectionState('settings'),
      el('div', { class: 'lvil-row' }, el('span', {}, '지시 위치'), posSel, depthInput),
      el('div', { class: 'lvil-row' }, el('span', {}, '지시 역할'), roleSel),
      el('div', { class: 'lvil-row' }, el('span', {}, '답변당 최대 그림'), maxSel),
      sectionState('auto'),
      el('div', { class: 'lvil-note', text: '이 채팅 자동 생성:' },
        el('button', { type: 'button', 'data-active': String(view.auto), disabled: autoDis, text: view.auto ? '켜짐 (끄기)' : '꺼짐 (켜기)',
          on: { click: toggleAuto } })));
  }

  function charRow(ch, idx, list) {
    // Typed-but-unsaved text lives in view.drafts so a re-render (e.g. the automatic
    // retry after a permission grant, or another section finishing its load) never
    // wipes what the user is in the middle of typing.
    const draft = view.drafts[idx] || {};
    const dis = view.busy || !sectionOk('registry');
    const namesInput = el('input', { type: 'text', value: draft.names ?? ch.names.join(', '), placeholder: '이름/별칭 (쉼표로 구분)', disabled: dis,
      on: { input: (e) => { (view.drafts[idx] ||= {}).names = e.target.value; } } });
    const appearanceInput = el('textarea', { placeholder: '외형 프롬프트 (NAI 태그)', disabled: dis,
      on: { input: (e) => { (view.drafts[idx] ||= {}).appearance = e.target.value; } } });
    appearanceInput.value = draft.appearance ?? ch.appearance;
    const enabledBtn = el('button', { type: 'button', 'data-active': String(ch.enabled), disabled: dis, text: ch.enabled ? '켜짐' : '꺼짐',
      on: { click: () => { list[idx] = { ...ch, enabled: !ch.enabled }; saveRegistry(list); } } });
    const saveBtn = el('button', { type: 'button', disabled: dis, text: '저장', on: { click: () => {
      const names = namesInput.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      if (!names.length) { setStatus('이름을 한 개 이상 입력해 주세요', 'err'); return; }
      list[idx] = { ...ch, names, appearance: appearanceInput.value };
      saveRegistry(list);
    } } });
    const delBtn = el('button', { type: 'button', disabled: dis, text: '삭제', on: { click: () => {
      const next = list.slice(0, idx).concat(list.slice(idx + 1));
      saveRegistry(next);
    } } });
    return el('div', { class: 'lvil-char' }, namesInput, appearanceInput, el('div', { class: 'lvil-row' }, enabledBtn, saveBtn, delBtn));
  }

  function registrySection() {
    if (!view.characterId) return el('section', {}, el('h4', { text: '👤 인물 외형 등록부' }), el('div', { class: 'lvil-note', text: '캐릭터 카드를 연 채팅에서만 편집할 수 있습니다.' }));
    const list = view.registry.slice();
    const ok = sectionOk('registry');
    const rows = ok ? list.map((ch, i) => charRow(ch, i, list)) : [];
    const addBtn = el('button', { type: 'button', text: '+ 인물 추가', disabled: !ok || view.busy, on: { click: addDraftCharacter } });
    return el('section', {}, el('h4', { text: '👤 인물 외형 등록부 (이 카드의 모든 채팅과 공유)' }), sectionState('registry'), ...rows, addBtn,
      el('div', { class: 'lvil-note', text: '등록부는 비어서 시작합니다. 여기서 추가한 인물만 이름 매칭에 쓰입니다.' }));
  }

  function imagesSection() {
    const state = sectionState('images');
    if (!view.images.length) {
      return el('section', {}, el('h4', { text: '🖼️ 이 채팅의 그림' }), state,
        el('div', { class: 'lvil-note', text: '그림이 그려진 답변의 말풍선에서 직접 "다시 그리기"를 쓸 수도 있습니다.' }));
    }
    const rows = view.images.map((img) => {
      const isOrphan = img.status === 'orphan';
      // Review (2nd pass) finding 6: an orphan has no live message/tag to splice a
      // regeneration into (that's exactly what made it an orphan) — a "다시 그리기"
      // button on it either fails immediately (no metadata record under that id any
      // more) or, worse, targets an unrelated surviving record that happens to share
      // the id (finding 3's duplicate-id case). Status/reason only, never a button.
      return el('div', { class: 'lvil-img' },
        el('img', { src: img.imageUrl || '', alt: '' }),
        el('div', { class: 'sum', text: img.summary || img.id }),
        isOrphan
          ? el('span', { class: 'lvil-note', text: img.reason || '넣지 못함' })
          : el('button', { type: 'button', disabled: view.busy || !sectionOk('images'), text: '다시 그리기', on: { click: () => regenerate(img.id, img.messageId) } }));
    });
    return el('section', {}, el('h4', { text: '🖼️ 이 채팅의 그림' }), state, ...rows);
  }

  // Status area: transient messages (saved / failed) + which loads failed, with one
  // retry button for all of them + which declared permissions are still missing.
  function statusArea() {
    const failed = failedSections();
    const failLine = failed.length
      ? el('div', { class: 'lvil-loadfail', role: 'alert' },
        el('span', { text: '불러오지 못한 항목: ' + failed.map((n) => LOADS[n].label + (view.loads[n].state === 'perm' ? '(권한 필요)' : '')).join(', ') }),
        el('button', { type: 'button', class: 'lvil-retry', text: '다시 시도', on: { click: retryFailed } }))
      : null;
    const permLine = view.missing.length
      ? el('div', { class: 'lvil-perm', text: '아직 허용되지 않은 권한: ' + view.missing.map(permLabel).join(', ')
        + ' — 확장 설정에서 허용하면 다시 시작하지 않아도 자동으로 다시 시도합니다.' })
      : null;
    return [el('div', { class: 'lvil-status', 'data-kind': view.kind, role: 'status', text: view.status }), failLine, permLine];
  }

  function render() {
    if (!modal) return;
    const root = el('div', { class: 'lvil' },
      el('style', { text: CSS }),
      ...statusArea(),
      settingsSection(), registrySection(), imagesSection());
    modal.root.replaceChildren(root);
  }

  async function open() {
    await refreshActive();
    if (!chatId || modal) return;
    try { modal = ctx.ui.showModal({ title: '삽화가 (개인용)', width: 480, maxHeight: 720 }); } catch { return; }
    modal.root.style.overflowY = 'auto';
    modal.onDismiss(() => { modal = null; });
    // Snapshot which card/chat this panel instance belongs to, and bump the load token
    // BEFORE clearing view state, so any in-flight load from a previous open() is
    // immediately recognized as stale once it resolves (review finding 4).
    const token = ++loadToken;
    Object.assign(view, {
      settings: null, registry: [], auto: true, images: [], busy: false,
      loads: freshLoads(), missing: [], drafts: {},
      chatId, characterId, status: '', kind: '',
    });
    render();
    await loadSections(token, SECTION_NAMES);
  }

  const offClick = action.onClick(() => { open(); });
  const offs = [];
  try { offs.push(ctx.events.on('CHAT_SWITCHED', () => { if (modal) modal.dismiss(); refreshActive(); })); } catch { /* optional */ }
  try { offs.push(ctx.state.subscribe('chat.active', () => refreshActive())); } catch { /* older host */ }
  // Host-wide broadcast (loader.ts routes any ws event name through events.on); not
  // scoped to this extension, so it only ever triggers "retry what failed".
  try { offs.push(ctx.events.on('SPINDLE_PERMISSION_CHANGED', () => onPermissionsChanged())); } catch { /* optional */ }
  refreshActive();

  return () => {
    alive = false;
    for (const f of offs) { try { f(); } catch { /* ignore */ } }
    try { offClick(); } catch { /* ignore */ }
    offBackend();
    if (modal) { try { modal.dismiss(); } catch { /* ignore */ } }
    if (permTimer) clearTimeout(permTimer);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    pending.clear();
    action.destroy();
  };
}
