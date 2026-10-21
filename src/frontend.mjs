import { normalizeSettings, normalizeRegistry, IDENTIFIER } from './core.mjs';

// Frontend: input-bar action "삽화가 설정" -> host modal with settings (user-wide),
// the current card's registry (card-wide), the current chat's auto-gen toggle, and a
// list of this chat's generated images with a "다시 그리기" button each (F6).
// Free APIs only: registerInputBarAction, showModal, getActiveChat, events.on,
// state.subscribe. All writes go through the backend worker (sendToBackend/onBackendMessage).

const CSS = `
.lvil{--fg:var(--lumiverse-text,#e8e6ef);--dim:var(--lumiverse-text-muted,#9b98a8);--line:var(--lumiverse-border,rgba(127,127,127,.28));
--fill:var(--lumiverse-fill-subtle,rgba(127,127,127,.10));--acc:var(--lumiverse-primary,#ff836e);
color:var(--fg);font-size:14px;line-height:1.4;display:flex;flex-direction:column;gap:10px;padding:2px 0 8px;box-sizing:border-box}
.lvil *{box-sizing:border-box}
.lvil-status{font-size:12.5px;color:var(--dim);min-height:1.2em}
.lvil-status[data-kind=err]{color:var(--lumiverse-danger,#ef4444)}
.lvil-status[data-kind=ok]{color:var(--acc)}
.lvil section{border:1px solid var(--line);border-radius:10px;background:var(--fill);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.lvil h4{margin:0;font-size:13px;color:var(--dim)}
.lvil-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lvil button{font:inherit;font-size:13px;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 11px;min-height:32px;cursor:pointer}
.lvil button:hover:not(:disabled){border-color:var(--acc)}
.lvil button:disabled{opacity:.5;cursor:default}
.lvil button[data-active=true]{border-color:var(--acc);font-weight:600}
.lvil input[type=text],.lvil textarea,.lvil select{font:inherit;font-size:14px;color:var(--fg);background:var(--lumiverse-fill,rgba(0,0,0,.15));border:1px solid var(--line);border-radius:8px;padding:6px 8px;width:100%}
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
  const pending = new Map();
  const view = { settings: null, registry: [], auto: true, images: [], status: '', kind: '', busy: false };

  const action = ctx.ui.registerInputBarAction({ id: 'lv-illust', label: '삽화가 설정', iconSvg: ICON, enabled: false });

  function request(payload, ms = 20000) {
    const requestId = 'lvil-' + (++seq) + '-' + Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ ok: false, timeout: true, error: '응답 시간 초과' }); }, ms);
      pending.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
      ctx.sendToBackend({ ...payload, requestId });
    });
  }
  const offBackend = ctx.onBackendMessage((r) => {
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

  async function loadAll() {
    setStatus('불러오는 중…');
    const [s, r, a, i] = await Promise.all([
      request({ type: 'load_settings' }),
      characterId ? request({ type: 'load_registry', characterId }) : Promise.resolve({ ok: true, registry: [] }),
      request({ type: 'load_auto', chatId }),
      request({ type: 'list_images', chatId }),
    ]);
    if (!alive) return;
    if (s.ok) view.settings = s.settings;
    if (r.ok) view.registry = r.registry;
    if (a.ok) view.auto = a.auto;
    if (i.ok) view.images = i.images;
    setStatus('');
    render();
  }

  async function saveSettings(patch) {
    view.busy = true; render();
    const r = await request({ type: 'save_settings', settings: { ...view.settings, ...patch } });
    view.busy = false;
    if (r.ok) view.settings = r.settings;
    render();
    setStatus(r.ok ? '설정 저장됨' : (r.error || '실패'), r.ok ? 'ok' : 'err');
  }

  async function toggleAuto() {
    view.busy = true; render();
    const r = await request({ type: 'set_auto', chatId, on: !view.auto });
    view.busy = false;
    if (r.ok) view.auto = r.auto;
    render();
  }

  async function saveRegistry(next) {
    if (!characterId) return;
    view.busy = true; render();
    const r = await request({ type: 'save_registry', characterId, registry: next });
    view.busy = false;
    if (r.ok) view.registry = r.registry;
    render();
    setStatus(r.ok ? '등록부 저장됨' : (r.error || '실패'), r.ok ? 'ok' : 'err');
  }

  async function regenerate(imageId, messageId) {
    view.busy = true; render();
    const r = await request({ type: 'regenerate', chatId, messageId, imageId }, 60000);
    view.busy = false;
    if (r.ok) {
      const i = await request({ type: 'list_images', chatId });
      if (i.ok) view.images = i.images;
    }
    render();
    setStatus(r.ok ? '다시 그렸습니다' : (r.error || '실패'), r.ok ? 'ok' : 'err');
  }

  function settingsSection() {
    const s = view.settings || {};
    const posSel = el('select', { on: { change: (e) => saveSettings({ position: e.target.value }) } },
      ['start', 'end', 'depth'].map((p) => el('option', { value: p, selected: s.position === p, text: p === 'start' ? '맨 앞' : p === 'end' ? '맨 끝' : '깊이(최근 N번째 앞)' })));
    const depthInput = el('input', { type: 'text', inputmode: 'numeric', value: String(s.depth ?? 4), disabled: s.position !== 'depth',
      on: { change: (e) => { const n = parseInt(e.target.value, 10); if (Number.isInteger(n) && n >= 0) saveSettings({ depth: n }); } } });
    const roleSel = el('select', { on: { change: (e) => saveSettings({ role: e.target.value }) } },
      ['system', 'user', 'assistant'].map((r) => el('option', { value: r, selected: s.role === r, text: r })));
    const maxSel = el('select', { on: { change: (e) => saveSettings({ maxImages: parseInt(e.target.value, 10) }) } },
      [1, 2].map((n) => el('option', { value: String(n), selected: s.maxImages === n, text: n + '장' })));
    return el('section', {},
      el('h4', { text: '⚙️ 설정 (계정 전체)' }),
      el('div', { class: 'lvil-row' }, el('span', {}, '지시 위치'), posSel, depthInput),
      el('div', { class: 'lvil-row' }, el('span', {}, '지시 역할'), roleSel),
      el('div', { class: 'lvil-row' }, el('span', {}, '답변당 최대 그림'), maxSel),
      el('div', { class: 'lvil-note', text: '이 채팅 자동 생성:' },
        el('button', { type: 'button', 'data-active': String(view.auto), disabled: view.busy, text: view.auto ? '켜짐 (끄기)' : '꺼짐 (켜기)',
          on: { click: toggleAuto } })));
  }

  function charRow(ch, idx, list) {
    const namesInput = el('input', { type: 'text', value: ch.names.join(', '), placeholder: '이름/별칭 (쉼표로 구분)' });
    const appearanceInput = el('textarea', { placeholder: '외형 프롬프트 (NAI 태그)' });
    appearanceInput.value = ch.appearance;
    const enabledBtn = el('button', { type: 'button', 'data-active': String(ch.enabled), text: ch.enabled ? '켜짐' : '꺼짐',
      on: { click: () => { list[idx] = { ...ch, enabled: !ch.enabled }; saveRegistry(list); } } });
    const saveBtn = el('button', { type: 'button', text: '저장', on: { click: () => {
      const names = namesInput.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      if (!names.length) { setStatus('이름을 한 개 이상 입력해 주세요', 'err'); return; }
      list[idx] = { ...ch, names, appearance: appearanceInput.value };
      saveRegistry(list);
    } } });
    const delBtn = el('button', { type: 'button', text: '삭제', on: { click: () => {
      const next = list.slice(0, idx).concat(list.slice(idx + 1));
      saveRegistry(next);
    } } });
    return el('div', { class: 'lvil-char' }, namesInput, appearanceInput, el('div', { class: 'lvil-row' }, enabledBtn, saveBtn, delBtn));
  }

  function registrySection() {
    if (!characterId) return el('section', {}, el('h4', { text: '👤 인물 외형 등록부' }), el('div', { class: 'lvil-note', text: '캐릭터 카드를 연 채팅에서만 편집할 수 있습니다.' }));
    const list = view.registry.slice();
    const rows = list.map((ch, i) => charRow(ch, i, list));
    const addBtn = el('button', { type: 'button', text: '+ 인물 추가', on: { click: () => {
      saveRegistry([...list, { names: [], appearance: '', enabled: true }]);
    } } });
    return el('section', {}, el('h4', { text: '👤 인물 외형 등록부 (이 카드의 모든 채팅과 공유)' }), ...rows, addBtn,
      el('div', { class: 'lvil-note', text: '등록부는 비어서 시작합니다. 여기서 추가한 인물만 이름 매칭에 쓰입니다.' }));
  }

  function imagesSection() {
    if (!view.images.length) {
      return el('section', {}, el('h4', { text: '🖼️ 이 채팅의 그림' }),
        el('div', { class: 'lvil-note', text: '그림이 그려진 답변의 말풍선에서 직접 "다시 그리기"를 쓸 수도 있습니다.' }));
    }
    const rows = view.images.map((img) => el('div', { class: 'lvil-img' },
      el('img', { src: img.imageUrl || '', alt: '' }),
      el('div', { class: 'sum', text: img.summary || img.id }),
      el('button', { type: 'button', disabled: view.busy, text: '다시 그리기', on: { click: () => regenerate(img.id, img.messageId) } })));
    return el('section', {}, el('h4', { text: '🖼️ 이 채팅의 그림' }), ...rows);
  }

  function render() {
    if (!modal) return;
    const root = el('div', { class: 'lvil' },
      el('style', { text: CSS }),
      el('div', { class: 'lvil-status', 'data-kind': view.kind, role: 'status', text: view.status }),
      settingsSection(), registrySection(), imagesSection());
    modal.root.replaceChildren(root);
  }

  async function open() {
    await refreshActive();
    if (!chatId || modal) return;
    try { modal = ctx.ui.showModal({ title: '삽화가 (개인용)', width: 480, maxHeight: 720 }); } catch { return; }
    modal.root.style.overflowY = 'auto';
    modal.onDismiss(() => { modal = null; });
    render();
    await loadAll();
  }

  const offClick = action.onClick(() => { open(); });
  const offs = [];
  try { offs.push(ctx.events.on('CHAT_SWITCHED', () => { if (modal) modal.dismiss(); refreshActive(); })); } catch { /* optional */ }
  try { offs.push(ctx.state.subscribe('chat.active', () => refreshActive())); } catch { /* older host */ }
  refreshActive();

  return () => {
    alive = false;
    for (const f of offs) { try { f(); } catch { /* ignore */ } }
    try { offClick(); } catch { /* ignore */ }
    offBackend();
    if (modal) { try { modal.dismiss(); } catch { /* ignore */ } }
    pending.clear();
    action.destroy();
  };
}
