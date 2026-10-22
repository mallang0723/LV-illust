import { normalizeSettings, normalizeRegistry, IDENTIFIER, splitTagList, splitAppearance, joinTagList, dedupeTags, MAX_NEGATIVE_LEN } from './core.mjs';

// Frontend: input-bar action "삽화가 설정" -> host modal. 0.2.0 layout: an overview card
// (status line, chips, this chat's auto switch) above four collapsible sections, each with
// a one-line summary badge so a phone shows what is inside without opening it:
//   그림 (gallery tiles -> detail view with the prompt that was sent),
//   인물 (cards: names / 신체 특성 / 옷·장신구 / 네거티브),
//   프롬프트 미리보기 (what a <pic> tag would send, nothing is generated),
//   설정 (instruction placement, max pictures, 공통 네거티브, bound negatives).
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
//
// Section bodies are always rendered and only hidden with the `hidden` attribute, so a
// collapsed section keeps its draft text and its controls stay addressable.

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
const STATUS_PILL = { fail: '실패', skip: '건너뜀', orphan: '넣지 못함' };
const POSITION_LABEL = { start: '맨 앞', end: '맨 끝', depth: '깊이' };
const PREVIEW_BOUND_NEG_RE = /\{\{\s*(?:character|persona)_negative_prompt\s*\}\}/i;

// ---- pure view helpers (exported for tests) ---------------------------------------

export const tagCount = (text) => splitTagList(text).length;

export function settingsSummary(s) {
  if (!s) return '';
  const where = s.position === 'depth' ? `깊이 ${s.depth}` : POSITION_LABEL[s.position] || s.position;
  return `${where} · ${s.maxImages}장`;
}

export function registrySummary(list) {
  const n = (list || []).filter((c) => (c.names || []).length).length;
  const review = (list || []).filter((c) => c.needsReview).length;
  if (!n) return '비어 있음';
  return review ? `${n}명 · 확인 ${review}` : `${n}명`;
}

export function imagesSummary(list) {
  const total = (list || []).length;
  if (!total) return '없음';
  const bad = list.filter((i) => i.status && i.status !== 'ok').length;
  return bad ? `${total}장 · 확인 ${bad}` : `${total}장`;
}

/** Merge unsaved per-row drafts over the saved registry (what the preview should use). */
export function registryWithDrafts(registry, drafts) {
  return (registry || []).map((ch, i) => {
    const d = drafts?.[i] || {};
    const names = d.names != null ? String(d.names).split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : ch.names;
    return { ...ch, names, body: d.body ?? ch.body ?? '', outfit: d.outfit ?? ch.outfit ?? '', negative: d.negative ?? ch.negative ?? '' };
  }).filter((c) => c.names.length);
}

/** Re-split a character's body+outfit text with the same heuristic the migration uses. */
export function resplitLooks(body, outfit) {
  const sp = splitAppearance(dedupeTags([body, outfit]).join(', '));
  return { body: joinTagList(sp.body), outfit: joinTagList(sp.outfit), review: sp.review };
}

/** Clipboard copy that never assumes a secure context (phone http access): returns
 *  true/false, never throws. */
export async function copyText(text, doc = typeof document !== 'undefined' ? document : null, nav = typeof navigator !== 'undefined' ? navigator : null) {
  try {
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    if (doc && typeof doc.execCommand === 'function' && doc.body) {
      const ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      doc.body.append(ta); ta.select();
      const ok = doc.execCommand('copy');
      ta.remove();
      return !!ok;
    }
  } catch { /* ignore */ }
  return false;
}

const CSS = `
.lvil{--fg:var(--lumiverse-text,#e8e6ef);--dim:var(--lumiverse-text-muted,var(--lumiverse-text-dim,#9b98a8));--line:var(--lumiverse-border,rgba(127,127,127,.3));
--bg:var(--lumiverse-bg,#1b1a22);--deep:var(--lumiverse-bg-deep,var(--lumiverse-bg,#121118));
--card:color-mix(in srgb,var(--bg) 91%,var(--fg) 9%);--field:color-mix(in srgb,var(--deep) 72%,var(--bg));
--hover:var(--lumiverse-fill-hover,rgba(127,127,127,.16));--acc:var(--lumiverse-primary,#ff836e);--accfg:var(--lumiverse-primary-contrast,#fff);
--bad:var(--lumiverse-danger,#e5534b);--good:var(--lumiverse-success,#2e9e5b);
color:var(--fg);font-size:15px;line-height:1.45;display:flex;flex-direction:column;gap:12px;padding:0 0 8px;box-sizing:border-box;min-width:0}
.lvil *{box-sizing:border-box}
.lvil [hidden]{display:none!important}
.lvil button{font:inherit;font-size:15px;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px;min-height:44px;cursor:pointer;touch-action:manipulation}
.lvil button:hover:not(:disabled){background:var(--hover);border-color:var(--acc)}
.lvil button:focus-visible,.lvil input:focus-visible,.lvil textarea:focus-visible,.lvil select:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.lvil button:disabled{opacity:.5;cursor:default}
.lvil button[data-variant=primary]{background:var(--acc);border-color:var(--acc);color:var(--accfg);font-weight:600}
.lvil button[data-variant=danger]{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 55%,var(--line))}
.lvil button[data-variant=danger][data-armed=true]{background:var(--bad);color:#fff;border-color:var(--bad)}
.lvil button[data-active=true]:not([data-variant]){border-color:var(--acc);font-weight:600}
.lvil input[type=text],.lvil textarea,.lvil select{font:inherit;font-size:16px;color:var(--fg);background:var(--field);border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%;min-height:44px;touch-action:manipulation}
.lvil textarea{min-height:76px;resize:vertical;line-height:1.4}
.lvil select{appearance:auto}
.lvil-head{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:10px;display:flex;flex-direction:column;gap:10px;border-top:3px solid var(--acc)}
.lvil-chips{display:flex;flex-wrap:wrap;gap:6px}
.lvil-chip{font-size:13px;line-height:1.2;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:5px 10px;background:var(--field);white-space:nowrap}
.lvil-chip[data-tone=warn]{color:var(--acc);border-color:var(--acc)}
.lvil-autorow{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.lvil-autorow b{font-weight:600}
.lvil-switch{display:inline-flex;align-items:center;gap:10px;border-radius:999px!important;padding:6px 16px 6px 8px!important}
.lvil-switch::before{content:"";width:34px;height:20px;border-radius:999px;background:var(--line);box-shadow:inset 0 0 0 1px var(--line);transition:background .15s}
.lvil-switch[data-active=true]::before{background:var(--acc)}
.lvil-status{font-size:15px;color:var(--dim);min-height:1.4em;display:flex;gap:8px;align-items:flex-start}
.lvil-status:empty{display:none}
.lvil-status::before{content:"";flex:none;width:9px;height:9px;margin-top:.45em;border-radius:50%;background:var(--dim)}
.lvil-status[data-kind=ok]{color:var(--fg)}.lvil-status[data-kind=ok]::before{background:var(--good)}
.lvil-status[data-kind=err]{color:var(--bad)}.lvil-status[data-kind=err]::before{background:var(--bad)}
.lvil-loadfail,.lvil-perm,.lvil-sec-state{font-size:15px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lvil-loadfail,.lvil-sec-state[data-state=error],.lvil-sec-state[data-state=perm]{color:var(--bad)}
.lvil-perm,.lvil-sec-state{color:var(--dim)}
.lvil-sec{border:1px solid var(--line);border-radius:14px;background:var(--card);overflow:hidden}
.lvil .lvil-sec-toggle{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;border:0;border-radius:0;background:transparent;padding:10px 14px;min-height:52px}
.lvil-sec-title{font-weight:700;font-size:16px}
.lvil-sec-end{display:flex;align-items:center;gap:8px;min-width:0}
.lvil-sec-badge{font-size:13px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:3px 10px;white-space:nowrap;background:var(--field)}
.lvil-chev{font-size:20px;line-height:1;color:var(--dim);transition:transform .15s}
.lvil-sec-toggle[aria-expanded=true] .lvil-chev{transform:rotate(90deg)}
.lvil-sec-body{display:flex;flex-direction:column;gap:12px;padding:2px 10px 12px;border-top:1px solid var(--line)}
.lvil-note{font-size:14px;color:var(--dim);line-height:1.45}
.lvil-hint{font-size:14px;color:var(--dim);margin-top:-6px}
.lvil-field{display:flex;flex-direction:column;gap:6px}
.lvil-field>label,.lvil-label{font-size:15px;font-weight:600}
.lvil-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lvil-row>select,.lvil-row>input{flex:1 1 130px;width:auto;min-width:0}
.lvil-seg{display:flex;gap:6px}
.lvil-seg button{flex:1}
.lvil-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:8px}
.lvil-tile{display:flex;flex-direction:column;gap:6px;min-width:0}
.lvil .lvil-thumb{position:relative;display:block;width:100%;aspect-ratio:4/3;padding:0;overflow:hidden;border-radius:10px;background:var(--field)}
.lvil-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.lvil-noimg{display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-size:13px;color:var(--dim)}
.lvil-pill{position:absolute;left:6px;top:6px;font-size:13px;line-height:1;padding:4px 8px;border-radius:999px;background:var(--bad);color:#fff}
.lvil-pill[data-kind=skip]{background:var(--dim)}
.lvil-cap{font-size:13px;color:var(--dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.lvil-reason{font-size:13px;color:var(--dim)}
.lvil-detail{display:flex;flex-direction:column;gap:12px}
.lvil-detail img{width:100%;height:auto;max-height:60vh;object-fit:contain;border-radius:10px;background:var(--field)}
.lvil-block{display:flex;flex-direction:column;gap:6px}
.lvil-pre{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--field);font:15px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}
.lvil-blockhead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.lvil-char{border:1px solid var(--line);border-radius:12px;background:var(--field);overflow:hidden}
.lvil .lvil-char-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;border:0;border-radius:0;background:transparent;padding:8px 12px;min-height:52px}
.lvil-char-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.lvil-char-meta{font-size:13px;color:var(--dim);white-space:nowrap}
.lvil-char-body{display:flex;flex-direction:column;gap:12px;padding:4px 10px 12px;border-top:1px solid var(--line)}
.lvil-review{border:1px solid var(--acc);border-radius:10px;padding:10px 12px;font-size:15px;display:flex;flex-direction:column;gap:8px}
.lvil-review code{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--field);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere}
.lvil-legacy{font-size:13px;color:var(--dim);display:flex;flex-direction:column;gap:6px}
.lvil-chiprow{display:flex;flex-wrap:wrap;gap:6px}
.lvil .lvil-chiprow button{min-height:44px;border-radius:999px;font-size:15px;padding:6px 12px}
@media (prefers-reduced-motion:reduce){.lvil *{transition:none!important}}
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
  // Which sections are expanded survives close/reopen within the session.
  const openSections = { images: true, registry: true, preview: false, settings: false };
  const view = {
    settings: null, registry: [], auto: true, images: [], status: '', kind: '', busy: false,
    loads: freshLoads(), missing: [], drafts: {}, chatId: null, characterId: null,
    openChars: {}, armedDelete: -1, detailId: null,
    previewDraft: { chars: '', scene: '' }, preview: null, negativeDraft: null,
  };

  const action = ctx.ui.registerInputBarAction({ id: 'lv-illust', label: '삽화가 설정', iconSvg: ICON, enabled: false });

  function request(payload, ms = 20000) {
    // No UUID helper here on purpose: it is undefined on plain-http phone access.
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
      if (name === 'settings') { view.settings = r.settings; view.negativeDraft = null; }
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
    if (r.ok) { view.settings = r.settings; view.negativeDraft = null; }
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
    if (r.ok) { view.registry = r.registry; view.drafts = {}; view.armedDelete = -1; }
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
    view.registry = [...view.registry, { names: [], body: '', outfit: '', negative: '', enabled: true }];
    view.openChars['n' + (view.registry.length - 1)] = true;
    openSections.registry = true;
    render();
  }

  async function regenerate(imageId, messageId) {
    if (!sectionOk('images') || view.busy) return;
    const token = loadToken, targetChatId = view.chatId;
    view.busy = true; render();
    setStatus('다시 그리는 중… (최대 1분)', '');
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

  async function runPreview() {
    if (view.busy) return;
    const token = loadToken;
    const { chars, scene } = view.previewDraft;
    view.preview = { busy: true };
    render();
    const r = await request({
      type: 'preview_prompt', characterId: view.characterId, chars, scene,
      registry: sectionOk('registry') ? registryWithDrafts(view.registry, view.drafts) : undefined,
    });
    if (!alive || token !== loadToken) return;
    view.preview = r.ok ? { result: r } : { error: failText(r) };
    render();
  }

  async function copy(text, what) {
    const ok = await copyText(text);
    setStatus(ok ? `${what} 복사됨` : '복사하지 못했습니다 — 글자를 길게 눌러 직접 선택해 주세요', ok ? 'ok' : 'err');
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

  // ---- layout pieces ----

  function section(key, title, badge, ...kids) {
    const open = openSections[key];
    const body = el('div', { class: 'lvil-sec-body', hidden: !open }, ...kids);
    const toggle = el('button', { type: 'button', class: 'lvil-sec-toggle', 'aria-expanded': String(open), 'data-section': key,
      on: { click: () => { openSections[key] = !openSections[key]; render(); } } },
      el('span', { class: 'lvil-sec-title', text: title }),
      el('span', { class: 'lvil-sec-end' }, badge ? el('span', { class: 'lvil-sec-badge', text: badge }) : null, el('span', { class: 'lvil-chev', 'aria-hidden': 'true', text: '›' })));
    return el('section', { class: 'lvil-sec' }, toggle, body);
  }

  function field(label, control, hint) {
    return el('div', { class: 'lvil-field' }, el('label', { text: label }), control, hint ? el('div', { class: 'lvil-hint', text: hint }) : null);
  }

  function headCard() {
    const s = view.settings;
    const autoDis = view.busy || !sectionOk('auto');
    const chips = [
      s ? el('span', { class: 'lvil-chip', text: `답변당 최대 ${s.maxImages}장` }) : null,
      sectionOk('registry') && view.characterId ? el('span', { class: 'lvil-chip', text: `인물 ${registrySummary(view.registry)}`, 'data-tone': view.registry.some((c) => c.needsReview) ? 'warn' : null }) : null,
      sectionOk('images') ? el('span', { class: 'lvil-chip', text: `그림 ${imagesSummary(view.images)}` }) : null,
    ];
    return el('div', { class: 'lvil-head' },
      el('div', { class: 'lvil-autorow' },
        el('b', { text: '이 채팅 자동 생성' }),
        el('button', { type: 'button', class: 'lvil-switch', role: 'switch', 'aria-checked': String(view.auto), 'data-active': String(view.auto), disabled: autoDis,
          text: view.auto ? '켜짐 (끄기)' : '꺼짐 (켜기)', on: { click: toggleAuto } })),
      sectionState('auto'),
      el('div', { class: 'lvil-chips' }, ...chips),
      ...statusArea());
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

  // ---- 그림 ----

  function imagesSection() {
    const state = sectionState('images');
    const regenBtn = (img) => el('button', { type: 'button', disabled: view.busy || !sectionOk('images'), text: '다시 그리기', on: { click: () => regenerate(img.id, img.messageId) } });
    let content;
    if (!view.images.length) {
      content = el('div', { class: 'lvil-note', text: '아직 이 채팅에서 그려진 그림이 없습니다. 그림이 그려진 답변의 말풍선에서 직접 "다시 그리기"를 쓸 수도 있습니다.' });
    } else {
      content = el('div', { class: 'lvil-grid' }, ...view.images.map((img) => {
        const isOrphan = img.status === 'orphan';
        const pill = STATUS_PILL[img.status];
        const thumb = el('button', { type: 'button', class: 'lvil-thumb', 'aria-label': `그림 자세히 보기: ${img.summary || img.id}`,
          on: { click: () => { view.detailId = img.id; render(); } } },
        img.imageUrl ? el('img', { src: img.imageUrl, alt: '', loading: 'lazy' }) : el('span', { class: 'lvil-noimg', text: '이미지 없음' }),
        pill ? el('span', { class: 'lvil-pill', 'data-kind': img.status === 'skip' ? 'skip' : 'bad', text: pill }) : null);
        // Review (2nd pass) finding 6: an orphan has no live message/tag to splice a
        // regeneration into (that's exactly what made it an orphan) — a "다시 그리기"
        // button on it either fails immediately (no metadata record under that id any
        // more) or, worse, targets an unrelated surviving record that happens to share
        // the id (finding 3's duplicate-id case). Status/reason only, never a button.
        return el('div', { class: 'lvil-tile' }, thumb,
          el('div', { class: 'lvil-cap', text: img.summary || img.id }),
          isOrphan ? el('span', { class: 'lvil-reason', text: img.reason || '넣지 못함' }) : regenBtn(img));
      }));
    }
    return section('images', '🖼️ 그림', sectionOk('images') ? imagesSummary(view.images) : '', state, content);
  }

  function detailView(img) {
    const isOrphan = img.status === 'orphan';
    const block = (title, text, what) => el('div', { class: 'lvil-block' },
      el('div', { class: 'lvil-blockhead' }, el('span', { class: 'lvil-label', text: title }),
        text ? el('button', { type: 'button', text: '복사', 'aria-label': `${title} 복사`, on: { click: () => copy(text, what) } }) : null),
      el('pre', { class: 'lvil-pre', text: text || '(기록 없음)' }));
    return el('div', { class: 'lvil-detail' },
      el('div', { class: 'lvil-row' },
        el('button', { type: 'button', class: 'lvil-back', text: '← 목록', on: { click: () => { view.detailId = null; render(); } } }),
        STATUS_PILL[img.status] ? el('span', { class: 'lvil-chip', text: STATUS_PILL[img.status] }) : null),
      img.imageUrl ? el('img', { src: img.imageUrl, alt: img.summary || '그림' }) : el('div', { class: 'lvil-noimg', text: '이미지 없음' }),
      el('div', { text: img.summary || img.id }),
      isOrphan ? el('div', { class: 'lvil-reason', text: img.reason || '넣지 못함' }) : null,
      block('보낸 프롬프트', img.prompt, '프롬프트'),
      block('네거티브 프롬프트', img.negative, '네거티브'),
      (img.slots || []).length ? el('div', { class: 'lvil-block' }, el('span', { class: 'lvil-label', text: '인물 칸 (NAI 캐릭터 프롬프트)' }),
        ...img.slots.map((t, i) => el('pre', { class: 'lvil-pre', text: `${i + 1}. ${t}` }))) : null,
      img.negative || (img.slots || []).length ? null : el('div', { class: 'lvil-note', text: '이전 버전에서 그린 그림은 장면 프롬프트만 기록되어 있습니다.' }),
      isOrphan ? null : el('button', { type: 'button', 'data-variant': 'primary', disabled: view.busy || !sectionOk('images'), text: '다시 그리기', on: { click: () => regenerate(img.id, img.messageId) } }));
  }

  // ---- 인물 ----

  function charRow(ch, idx, list) {
    // Typed-but-unsaved text lives in view.drafts so a re-render (e.g. the automatic
    // retry after a permission grant, or another section finishing its load) never
    // wipes what the user is in the middle of typing.
    const draft = view.drafts[idx] || {};
    const dis = view.busy || !sectionOk('registry');
    const key = ch.id || 'n' + idx;
    const open = view.openChars[key] ?? (!!ch.needsReview || !ch.id);
    const setDraft = (field) => (e) => { (view.drafts[idx] ||= {})[field] = e.target.value; };
    const namesInput = el('input', { type: 'text', value: draft.names ?? ch.names.join(', '), placeholder: '이름/별칭 (쉼표로 구분)', disabled: dis, 'aria-label': '이름과 별칭',
      on: { input: setDraft('names') } });
    const area = (field, placeholder, label, rows) => {
      const t = el('textarea', { placeholder, disabled: dis, 'aria-label': label, rows, on: { input: setDraft(field) } });
      t.value = draft[field] ?? ch[field] ?? '';
      return t;
    };
    const bodyInput = area('body', '예: 1girl, silver hair, blue eyes, tall', '신체 특성', 3);
    const outfitInput = area('outfit', '예: black coat, white gloves, glasses', '옷·장신구', 3);
    const negInput = area('negative', '예: extra fingers (선택)', '이 인물의 네거티브', 2);
    const enabledBtn = el('button', { type: 'button', 'data-active': String(ch.enabled), disabled: dis, text: ch.enabled ? '켜짐' : '꺼짐',
      on: { click: () => { list[idx] = { ...ch, enabled: !ch.enabled }; saveRegistry(list); } } });
    const saveBtn = el('button', { type: 'button', 'data-variant': 'primary', disabled: dis, text: '저장', on: { click: () => {
      const names = namesInput.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      if (!names.length) { setStatus('이름을 한 개 이상 입력해 주세요', 'err'); return; }
      // saving is the user's confirmation of a migrated split: clear the review flag
      list[idx] = { ...ch, names, body: bodyInput.value, outfit: outfitInput.value, negative: negInput.value, needsReview: false, reviewTags: [] };
      saveRegistry(list);
    } } });
    const armed = view.armedDelete === idx;
    const delBtn = el('button', { type: 'button', 'data-variant': 'danger', 'data-armed': String(armed), disabled: dis, text: armed ? '한 번 더 눌러 삭제' : '삭제', on: { click: () => {
      if (!armed) {
        view.armedDelete = idx; render();
        const t = setTimeout(() => { timers.delete(t); if (view.armedDelete === idx) { view.armedDelete = -1; render(); } }, 4000);
        timers.add(t);
        return;
      }
      saveRegistry(list.slice(0, idx).concat(list.slice(idx + 1)));
    } } });
    const resplitBtn = el('button', { type: 'button', disabled: dis, text: '신체/옷 자동 나누기', on: { click: () => {
      const r = resplitLooks(bodyInput.value, outfitInput.value);
      const d = (view.drafts[idx] ||= {});
      d.body = r.body; d.outfit = r.outfit;
      render();
      setStatus(r.review.length ? `나누었습니다. 애매한 태그는 신체 칸에 두었습니다: ${r.review.join(', ')}` : '나누었습니다. 저장하면 반영됩니다', 'ok');
    } } });
    const review = ch.needsReview ? el('div', { class: 'lvil-review', role: 'note' },
      el('b', { text: '확인해 주세요' }),
      el('span', { text: '예전 형식(합친 목록)에서 신체 특성과 옷·장신구를 자동으로 나눴습니다. 맞는 칸에 있는지 봐 주세요.' }),
      (ch.reviewTags || []).length ? el('span', {}, '분류가 애매해 신체 칸에 둔 태그: ', ...ch.reviewTags.flatMap((t, i) => [i ? ' ' : null, el('code', { text: t })])) : null,
      el('div', { class: 'lvil-note', text: '아래 "저장"을 누르면 확인한 것으로 보고 이 안내가 사라집니다.' })) : null;
    const legacy = ch.legacyAppearance ? el('div', { class: 'lvil-legacy' },
      el('span', { text: '나누기 전 원본(합친 목록):' }),
      el('pre', { class: 'lvil-pre', text: ch.legacyAppearance }),
      el('button', { type: 'button', disabled: dis, text: '원본으로 되돌리기 (신체 칸에 모두)', on: { click: () => {
        const d = (view.drafts[idx] ||= {});
        d.body = ch.legacyAppearance; d.outfit = '';
        render();
        setStatus('원본을 신체 칸으로 되돌렸습니다. 저장하면 반영됩니다', 'ok');
      } } })) : null;
    const toggle = el('button', { type: 'button', class: 'lvil-char-toggle', 'aria-expanded': String(open),
      on: { click: () => { view.openChars[key] = !open; render(); } } },
    el('span', { class: 'lvil-char-name', text: ch.names.length ? ch.names.join(', ') : '새 인물' }),
    el('span', { class: 'lvil-char-meta', text: [ch.enabled ? null : '꺼짐', `신체 ${tagCount(ch.body)} · 옷 ${tagCount(ch.outfit)}`, ch.needsReview ? '확인 필요' : null].filter(Boolean).join(' · ') }));
    return el('div', { class: 'lvil-char' }, toggle,
      el('div', { class: 'lvil-char-body', hidden: !open },
        review,
        field('이름·별칭', namesInput),
        field('신체 특성', bodyInput, '머리·눈·피부·체형·종족 특징·흉터 등'),
        field('옷·장신구', outfitInput, '장면마다 바꾸려면 chars에 "이름: 동작 | 옷: 새 옷"으로 쓰면 그 그림에만 적용됩니다. 안 쓰면 여기 저장된 옷을 씁니다.'),
        field('이 인물의 네거티브', negInput, '이 인물이 나오는 그림의 네거티브에만 합쳐집니다(호스트는 인물별 네거티브 칸이 없어 하나로 합칩니다).'),
        legacy,
        el('div', { class: 'lvil-row' }, saveBtn, enabledBtn, resplitBtn, delBtn)));
  }

  function registrySection() {
    if (!view.characterId) return section('registry', '👤 인물', '', el('div', { class: 'lvil-note', text: '캐릭터 카드를 연 채팅에서만 편집할 수 있습니다.' }));
    const list = view.registry.slice();
    const ok = sectionOk('registry');
    const rows = ok ? list.map((ch, i) => charRow(ch, i, list)) : [];
    const addBtn = el('button', { type: 'button', text: '+ 인물 추가', disabled: !ok || view.busy, on: { click: addDraftCharacter } });
    return section('registry', '👤 인물', ok ? registrySummary(view.registry) : '', sectionState('registry'), ...rows, addBtn,
      el('div', { class: 'lvil-note', text: '이 카드의 모든 채팅이 같은 등록부를 씁니다. 등록부는 비어서 시작하며, 여기서 추가한 인물만 이름 매칭에 쓰입니다. 그림 프롬프트에는 신체 특성 다음에 옷·장신구가 이어 붙습니다.' }));
  }

  // ---- 프롬프트 미리보기 ----

  function previewSection() {
    const draft = view.previewDraft;
    const names = (view.registry || []).flatMap((c) => (c.names || []).slice(0, 1));
    const charsInput = el('input', { type: 'text', value: draft.chars, placeholder: '예: 아드리안: 미소 | 옷: black suit', 'aria-label': '인물(chars)',
      on: { input: (e) => { view.previewDraft.chars = e.target.value; } } });
    const sceneInput = el('input', { type: 'text', value: draft.scene, placeholder: '예: 비 오는 골목, 밤', 'aria-label': '장면 프롬프트',
      on: { input: (e) => { view.previewDraft.scene = e.target.value; } } });
    const chips = names.length ? el('div', { class: 'lvil-chiprow' }, ...names.map((n) => el('button', { type: 'button', text: n, 'aria-label': `${n} 넣기`,
      on: { click: () => { const cur = view.previewDraft.chars.trim(); view.previewDraft.chars = cur ? cur + ', ' + n : n; render(); } } }))) : null;
    const p = view.preview;
    let out = null;
    if (p?.busy) out = el('div', { class: 'lvil-sec-state', text: '만드는 중…' });
    else if (p?.error) out = el('div', { class: 'lvil-sec-state', 'data-state': 'error', text: p.error });
    else if (p?.result) {
      const r = p.result;
      const neg = r.negativePrompt || '';
      out = el('div', { class: 'lvil-detail' },
        el('div', { class: 'lvil-block' }, el('span', { class: 'lvil-label', text: '긍정 프롬프트' }), el('pre', { class: 'lvil-pre', text: r.prompt || '(비어 있음)' }),
          r.hasMainPreset ? null : el('div', { class: 'lvil-note', text: '활성 메인 프롬프트 프리셋을 읽지 못했거나 없어서 장면 프롬프트만 보입니다.' })),
        (r.characterTags || []).length ? el('div', { class: 'lvil-block' }, el('span', { class: 'lvil-label', text: '인물 칸 (신체 → 옷 → 동작 순)' }),
          ...r.characterTags.map((c, i) => el('pre', { class: 'lvil-pre', text: `${i + 1}. ${c.tags}` }))) : null,
        el('div', { class: 'lvil-block' }, el('span', { class: 'lvil-label', text: '네거티브 프롬프트' }), el('pre', { class: 'lvil-pre', text: neg || '(비어 있음)' }),
          el('div', { class: 'lvil-note', text: neg
            ? (PREVIEW_BOUND_NEG_RE.test(neg) ? '{{…_negative_prompt}} 자리는 호스트가 카드·페르소나에 연결된 네거티브로 바꿔 넣습니다(없으면 빈칸). 값을 보내므로 호스트(NovelAI)의 기본 네거티브는 대체됩니다.' : '이 값을 보내므로 호스트(NovelAI)의 기본 네거티브는 대체됩니다. 기본 목록을 유지하려면 설정의 공통 네거티브에 직접 붙여 넣으세요.')
            : '비어 있어서 보내지 않습니다. 호스트의 기본 네거티브가 그대로 쓰입니다.' })));
    }
    return section('preview', '🔍 프롬프트 미리보기', '',
      el('div', { class: 'lvil-note', text: '<pic> 태그가 어떤 프롬프트가 되는지 미리 봅니다. 그림은 그리지 않습니다. 저장 전에 고친 인물 칸도 반영됩니다.' }),
      field('인물 (chars)', charsInput), chips, field('장면 (prompt)', sceneInput),
      el('button', { type: 'button', 'data-variant': 'primary', disabled: view.busy || !!p?.busy, text: '미리보기', on: { click: runPreview } }),
      out);
  }

  // ---- 설정 ----

  function settingsSection() {
    const s = view.settings || {};
    const dis = view.busy || !sectionOk('settings');
    const posSel = el('select', { disabled: dis, 'aria-label': '지시 위치', on: { change: (e) => saveSettings({ position: e.target.value }) } },
      ['start', 'end', 'depth'].map((p) => el('option', { value: p, selected: s.position === p, text: p === 'start' ? '맨 앞' : p === 'end' ? '맨 끝' : '깊이(최근 N번째 앞)' })));
    const depthInput = s.position === 'depth' ? el('input', { type: 'text', inputmode: 'numeric', 'aria-label': '깊이', value: String(s.depth ?? 4), disabled: dis,
      on: { change: (e) => { const n = parseInt(e.target.value, 10); if (Number.isInteger(n) && n >= 0) saveSettings({ depth: n }); } } }) : null;
    const roleSel = el('select', { disabled: dis, 'aria-label': '지시 역할', on: { change: (e) => saveSettings({ role: e.target.value }) } },
      ['system', 'user', 'assistant'].map((r) => el('option', { value: r, selected: s.role === r, text: r })));
    const maxSeg = el('div', { class: 'lvil-seg', role: 'group', 'aria-label': '답변당 최대 그림' },
      [1, 2].map((n) => el('button', { type: 'button', disabled: dis, 'data-active': String(s.maxImages === n), 'aria-pressed': String(s.maxImages === n), text: n + '장',
        on: { click: () => { if (s.maxImages !== n) saveSettings({ maxImages: n }); } } })));
    const negDraft = view.negativeDraft ?? s.commonNegative ?? '';
    const negInput = el('textarea', { placeholder: '예: lowres, text, watermark', disabled: dis, 'aria-label': '공통 네거티브', rows: 3, maxlength: MAX_NEGATIVE_LEN,
      on: { input: (e) => { view.negativeDraft = e.target.value; } } });
    negInput.value = negDraft;
    const negApply = el('button', { type: 'button', disabled: dis, text: '적용', on: { click: () => saveSettings({ commonNegative: negInput.value }) } });
    const boundBtn = el('button', { type: 'button', class: 'lvil-switch', role: 'switch', 'aria-checked': String(s.boundNegatives !== false), 'data-active': String(s.boundNegatives !== false), disabled: dis,
      text: s.boundNegatives !== false ? '켜짐 (끄기)' : '꺼짐 (켜기)', on: { click: () => saveSettings({ boundNegatives: s.boundNegatives === false }) } });
    return section('settings', '⚙️ 설정 (계정 전체)', sectionOk('settings') ? settingsSummary(view.settings) : '',
      sectionState('settings'),
      field('AI 지시문 위치', el('div', { class: 'lvil-row' }, posSel, depthInput), '답변을 쓰기 전에 AI에게 "그림 태그를 써라"는 지시를 끼워 넣는 자리입니다.'),
      field('지시 역할', roleSel),
      field('답변당 최대 그림', maxSeg),
      field('공통 네거티브', el('div', { class: 'lvil-row' }, negInput, negApply),
        '모든 그림의 네거티브에 더해집니다. 값이 있으면 호스트(NovelAI)의 기본 네거티브는 대체되니, 기본 목록이 필요하면 직접 붙여 넣으세요. 비우고 인물·프리셋 네거티브도 없으면 호스트 기본이 그대로 쓰입니다.'),
      field('카드·페르소나 연결 네거티브 넣기', boundBtn,
        '메인 프롬프트 프리셋의 {{character_negative_prompt}}·{{persona_negative_prompt}} 자리를 호스트가 채우게 합니다. 끄면 그 자리는 빼고 보냅니다.'));
  }

  function render() {
    if (!modal) return;
    const img = view.detailId ? view.images.find((i) => i.id === view.detailId) : null;
    if (view.detailId && !img) view.detailId = null;
    const root = el('div', { class: 'lvil' },
      el('style', { text: CSS }),
      headCard(),
      img ? detailView(img) : [imagesSection(), registrySection(), previewSection(), settingsSection()]);
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
      openChars: {}, armedDelete: -1, detailId: null, preview: null, negativeDraft: null,
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
