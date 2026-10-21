// 삽화가 (개인용) / LV-Illust — built from src/ by scripts/build.mjs. Do not edit.
// 삽화가 (개인용) / LV-Illust — shared pure logic (backend + frontend). No host API calls in this file.
//
// Tag format (docs/DESIGN.md §3):
//   <pic chars="아드리안, 정수빈" prompt="장면 묘사 태그들">
//   <pic chars="아드리안: smirking, arms crossed; 정수빈: looking away" prompt="...">
// `chars` is optional (scene-only picture); `prompt` is required — a tag with neither
// a valid `chars=".."` / `prompt=".."` pair is malformed and never silently dropped.

export const IDENTIFIER = 'lv_illust';

// ---------------------------------------------------------------- tag parsing

const WS = /\s/;
const KEY_START = /[a-zA-Z_]/;
const KEY_CHAR = /[\w-]/;

// Hand-written scanner instead of a single greedy regex: a naive `<pic[^>]*>` match
// over-consumes when a broken tag's unterminated quote lets `[^>]*` swallow a *later*,
// genuinely well-formed tag's `>`. Scanning char-by-char lets us stop at the first thing
// that isn't `whitespace* key="value"` or the closing `>`, so a broken tag never eats
// a real one that follows it.
function scanTag(text, openIdx) {
  let i = openIdx + 4; // past '<pic'
  const attrs = {};
  for (;;) {
    while (i < text.length && WS.test(text[i])) i++;
    if (i >= text.length) return { ok: false };
    if (text[i] === '>') return { ok: true, end: i + 1, attrs };
    if (!KEY_START.test(text[i])) return { ok: false };
    let k = i + 1;
    while (k < text.length && KEY_CHAR.test(text[k])) k++;
    const key = text.slice(i, k);
    i = k;
    while (i < text.length && WS.test(text[i])) i++;
    if (text[i] !== '=') return { ok: false };
    i++;
    while (i < text.length && WS.test(text[i])) i++;
    if (text[i] !== '"') return { ok: false };
    i++;
    const vStart = i;
    while (i < text.length && text[i] !== '"' && text[i] !== '<') i++;
    if (text[i] !== '"') return { ok: false };
    attrs[key] = text.slice(vStart, i);
    i++; // past closing quote
  }
}

/**
 * Find every `<pic ...>` occurrence in `content` (well-formed tags, parsed; malformed
 * ones flagged) in document order, non-overlapping. Already-rendered markers
 * (`![그림:...]`, `<pic-failed ...>`, `<pic-skipped ...>`, `[그림 태그 형식 오류 ...]`)
 * never match (nothing there starts with `<pic` followed by whitespace/`>` — `pic-failed`
 * fails the boundary check), so re-running this on an already-processed message is a
 * no-op — satisfies "never re-process already-rendered images".
 */
export function parseTags(content) {
  const text = String(content ?? '');
  const out = [];
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf('<pic', searchFrom);
    if (idx === -1) break;
    const boundary = text[idx + 4];
    if (boundary !== undefined && boundary !== '>' && !WS.test(boundary)) {
      // e.g. "<pic-failed" — not our tag at all, keep scanning
      searchFrom = idx + 4;
      continue;
    }
    const scanned = scanTag(text, idx);
    if (scanned.ok) {
      const { attrs } = scanned;
      const hasChars = Object.prototype.hasOwnProperty.call(attrs, 'chars');
      const hasPrompt = Object.prototype.hasOwnProperty.call(attrs, 'prompt');
      out.push({
        start: idx,
        end: scanned.end,
        raw: text.slice(idx, scanned.end),
        malformed: !hasChars && !hasPrompt,
        charsRaw: hasChars ? attrs.chars : '',
        promptRaw: hasPrompt ? attrs.prompt : '',
      });
      searchFrom = scanned.end;
    } else {
      // Broken tag: unterminated quote, missing '=', missing closing '>', etc. Capture
      // through the next '<' (or end of string) so the original text stays recoverable
      // without runaway length, then keep scanning right after it.
      let end = text.indexOf('<', idx + 4);
      if (end === -1) end = text.length;
      end = Math.min(end, idx + 2000);
      out.push({ start: idx, end, raw: text.slice(idx, end), malformed: true, charsRaw: '', promptRaw: '' });
      searchFrom = end;
    }
  }
  return out;
}

// ---------------------------------------------------------------- chars field (§2/§3)

// "아드리안, 정수빈"                                   -> [{name:'아드리안'}, {name:'정수빈'}]
// "아드리안: smirking, arms crossed; 정수빈: looking away" -> [{name:'아드리안', action:'smirking, arms crossed'}, {name:'정수빈', action:'looking away'}]
export function splitChars(charsRaw) {
  const s = String(charsRaw ?? '').trim();
  if (!s) return [];
  if (s.includes(';') || s.includes(':')) {
    return s.split(';').map((part) => {
      const i = part.indexOf(':');
      if (i === -1) return { name: part.trim(), action: '' };
      return { name: part.slice(0, i).trim(), action: part.slice(i + 1).trim() };
    }).filter((c) => c.name);
  }
  return s.split(',').map((n) => ({ name: n.trim(), action: '' })).filter((c) => c.name);
}

export const MAX_CHARS_PER_TAG = 6;

// ---------------------------------------------------------------- name matching (§2)

export function normalizeName(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '').trim();
}

/**
 * registry: [{ id, names: string[], appearance: string, enabled: boolean }, ...]
 * Builds a flat (normalizedAlias, length, characterIndex) list sorted longest-alias-first,
 * so a token is matched against its longest fitting alias (§2: "긴 이름부터 맞춘다").
 */
function flatAliases(registry) {
  const flat = [];
  (registry || []).forEach((ch, idx) => {
    for (const n of ch.names || []) {
      const norm = normalizeName(n);
      if (norm) flat.push({ norm, idx });
    }
  });
  flat.sort((a, b) => b.norm.length - a.norm.length);
  return flat;
}

/** Returns the registry index matched by `name`, or -1. Exact match, or the token
 *  starting with "<alias> " (AI appended extra words instead of using the action field). */
export function findCharacterIndex(name, registry) {
  const token = normalizeName(name);
  if (!token) return -1;
  for (const { norm, idx } of flatAliases(registry)) {
    if (token === norm) return idx;
  }
  // fallback: token begins with an alias (word-ish prefix on the *original* spacing,
  // approximated by comparing the normalized prefix since normalizeName strips spaces)
  for (const { norm, idx } of flatAliases(registry)) {
    if (norm && token.startsWith(norm) && token.length > norm.length) return idx;
  }
  return -1;
}

// ---------------------------------------------------------------- prompt assembly (F3/F5)

/**
 * parsedChars: result of splitChars (already capped to MAX_CHARS_PER_TAG by caller).
 * registry: character registry array (see findCharacterIndex).
 * Returns:
 *  - characterTags: [{tags}] for NAI `parameters.characterTags` — ONLY matched+enabled
 *    characters (design §2: disabled characters match but contribute no appearance).
 *  - extraFragments: short "name: action" text for matched-but-disabled or unmatched
 *    names, appended to the base scene prompt so the action isn't silently discarded
 *    even though no character-prompt slot is used for them.
 */
export function buildCharacterTags(parsedChars, registry) {
  const characterTags = [];
  const extraFragments = [];
  for (const { name, action } of parsedChars.slice(0, MAX_CHARS_PER_TAG)) {
    const idx = findCharacterIndex(name, registry);
    if (idx === -1) {
      extraFragments.push(action ? `${name}: ${action}` : name);
      continue;
    }
    const ch = registry[idx];
    if (!ch.enabled) {
      extraFragments.push(action ? `${name}: ${action}` : name);
      continue;
    }
    const tags = [ch.appearance, action].filter(Boolean).join(', ');
    characterTags.push({ tags });
  }
  return { characterTags, extraFragments };
}

export function assemblePrompt(basePrompt, extraFragments) {
  const base = String(basePrompt ?? '').trim();
  const extra = (extraFragments || []).filter(Boolean).join(', ');
  return [base, extra].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------- markers (F2/F5)

export function summarize(text, max = 40) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  // keep markdown-unsafe characters out of the alt-text summary we embed in content
  s = s.replace(/[[\]()]/g, '');
  if (s.length > max) s = s.slice(0, max).trim() + '…';
  return s;
}

function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '”');
}

/** Next image id for this message: p1, p2, … — stable/deterministic given how many
 *  ids already exist (so re-processing new tags on an edited message doesn't collide
 *  with ids already used by previously rendered images). */
export function nextImageId(existingIds) {
  const used = new Set(existingIds || []);
  let n = 1;
  while (used.has('p' + n)) n++;
  return 'p' + n;
}

export function renderSuccessMarker(id, imageUrl, summaryText) {
  return `![그림:${id}|${summarize(summaryText)}](${imageUrl})`;
}

export function renderFailureMarker(id, tag, reason) {
  const chars = tag.charsRaw ? ` chars="${escapeAttr(tag.charsRaw)}"` : '';
  const prompt = tag.promptRaw ? ` prompt="${escapeAttr(tag.promptRaw)}"` : '';
  return `[⚠️ 그림 생성 실패(${reason || '오류'}) · 패널에서 '다시 그리기'로 재시도 <pic-failed id="${id}"${chars}${prompt}>]`;
}

export function renderSkippedMarker(id, tag) {
  const chars = tag.charsRaw ? ` chars="${escapeAttr(tag.charsRaw)}"` : '';
  const prompt = tag.promptRaw ? ` prompt="${escapeAttr(tag.promptRaw)}"` : '';
  return `[한 답변당 그림 상한(2장)을 넘어 건너뜀 · 패널에서 '다시 그리기'로 추가 생성 가능 <pic-skipped id="${id}"${chars}${prompt}>]`;
}

export function renderMalformedMarker(tag) {
  // Escape '<' (and the brackets summarize() already strips) so this marker can never
  // be re-discovered as a `<pic ...>` tag on the next pass (parseTags / handleMessageEdited
  // would otherwise re-wrap it every time the message is saved, growing without bound).
  const safe = summarize(tag.raw, 200).replace(/</g, '＜');
  return `[그림 태그 형식 오류 — 원본: ${safe}]`;
}

// ---------------------------------------------------------------- planning (F2)

/**
 * Decide what to do with every `<pic>` tag found in `content`, without doing any I/O.
 * Returns `{ tags, jobs, markers }`:
 *  - tags: parseTags(content) result (for splicing).
 *  - jobs: up to `maxImages` well-formed tags to actually generate, each
 *    `{ tagIndex, id, prompt, negativePrompt, characterTags }` (negativePrompt is left
 *    undefined here — the caller's default/preset negative prompt applies).
 *  - markers: Map<tagIndex, string> immediate replacement text for tags that do NOT
 *    need generation (malformed -> malformed marker, overflow valid tags -> skipped
 *    marker). Tags in `jobs` get their marker filled in later from the generation result.
 */
export function planMessage(content, { registry = [], maxImages = 2, existingImageIds = [] } = {}) {
  const tags = parseTags(content);
  const jobs = [];
  const skipped = [];
  const markers = new Map();
  const usedIds = existingImageIds.slice();
  let validCount = 0;
  tags.forEach((tag, i) => {
    if (tag.malformed) { markers.set(i, renderMalformedMarker(tag)); return; }
    validCount++;
    const parsedChars = splitChars(tag.charsRaw);
    const { characterTags, extraFragments } = buildCharacterTags(parsedChars, registry);
    const prompt = assemblePrompt(tag.promptRaw, extraFragments);
    const id = nextImageId(usedIds);
    usedIds.push(id);
    if (validCount > maxImages) {
      markers.set(i, renderSkippedMarker(id, tag));
      skipped.push({ tagIndex: i, id, prompt, characterTags, summary: tag.promptRaw });
      return;
    }
    jobs.push({ tagIndex: i, id, prompt, characterTags, summary: tag.promptRaw });
  });
  return { tags, jobs, skipped, markers };
}

/** Splice `content` using parseTags-produced `tags` and a parallel replacement map
 *  (tagIndex -> replacement string); tags without an entry are left untouched. */
export function applyMarkers(content, tags, replacements) {
  const text = String(content ?? '');
  let out = '';
  let last = 0;
  tags.forEach((tag, i) => {
    out += text.slice(last, tag.start);
    out += replacements.has(i) ? replacements.get(i) : text.slice(tag.start, tag.end);
    last = tag.end;
  });
  out += text.slice(last);
  return out;
}

// ---------------------------------------------------------------- history placeholder rewrite

const RENDERED_IMG_RE = /!\[그림:[a-z0-9]+\|([^\]]*)\]\([^)]*\)/g;
const FAILED_RE = /\[⚠️ 그림 생성 실패\([^)]*\)[^[\]]*<pic-failed[^>]*>\]/g;
const SKIPPED_RE = /\[한 답변당 그림 상한\(2장\)을 넘어 건너뜀[^[\]]*<pic-skipped[^>]*>\]/g;
const MALFORMED_RE = /\[그림 태그 형식 오류 — 원본: ([^\]]*)\]/g;

/** For prompt assembly over past turns: collapse any of our rendered/failure/skip/
 *  malformed markers down to a short `[그림: ...]` placeholder so image HTML/markdown
 *  and raw tag text are never fed back to the model (design §4, last bullet). */
export function stripRenderedImages(content) {
  let s = String(content ?? '');
  s = s.replace(RENDERED_IMG_RE, (_, summary) => `[그림: ${summary}]`);
  s = s.replace(FAILED_RE, '[그림: 생성 실패]');
  s = s.replace(SKIPPED_RE, '[그림: 생략됨]');
  s = s.replace(MALFORMED_RE, (_, raw) => `[그림: ${summarize(raw, 30)}]`);
  return s;
}

/** Idempotency guard: true if `content` has no live `<pic ...>` tags left to process
 *  (i.e. parseTags would return nothing, or only tags already turned into markers by
 *  this same extension would remain — which parseTags never reports in the first place). */
export function hasLiveTags(content) {
  return parseTags(content).length > 0;
}

// ---------------------------------------------------------------- F1 instruction injection

export const DEFAULT_SETTINGS = {
  position: 'depth', // 'start' | 'end' | 'depth'
  depth: 4,
  role: 'system',
  maxImages: 2,
};

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!['start', 'end', 'depth'].includes(s.position)) s.position = DEFAULT_SETTINGS.position;
  if (!['system', 'user', 'assistant'].includes(s.role)) s.role = DEFAULT_SETTINGS.role;
  s.depth = Number.isInteger(s.depth) && s.depth >= 0 ? s.depth : DEFAULT_SETTINGS.depth;
  s.maxImages = Number.isInteger(s.maxImages) && s.maxImages >= 1 && s.maxImages <= 2 ? s.maxImages : DEFAULT_SETTINGS.maxImages;
  return s;
}

/** Enabled characters' alias lists, for the AI instruction (§2: list registered
 *  names so the AI uses them verbatim, any alias accepted regardless of chat language). */
export function instructionNameList(registry) {
  return (registry || []).filter((c) => c.enabled && c.names?.length)
    .map((c) => c.names.filter(Boolean).join(' / '));
}

export function buildInstructionText(registry) {
  const names = instructionNameList(registry);
  const roster = names.length
    ? `\n등장인물 목록(아무 별칭이나 그대로 사용 가능):\n- ${names.join('\n- ')}`
    : '';
  return (
    '그림이 필요한 장면에서는 답변 중간에 다음 형식의 태그를 한 번 써라(최대 2개): ' +
    '<pic chars="이름1, 이름2" prompt="장면/구도/배경 묘사">. ' +
    '인물별 동작·표정이 필요하면 chars="이름1: 동작1; 이름2: 동작2" 형식을 써라. ' +
    '태그는 평문처럼 자연스럽게 섞어 써도 되고, 등장인물 목록에 없는 이름을 써도 된다.' +
    roster
  );
}

/**
 * Insert the instruction message into the assembled interceptor messages array.
 * `messages` is ordered oldest-first, ending with the most recent turn (standard
 * chat-history order) — see docs/API-NOTES.md for the source this assumption rests on.
 * `depth` counts back from the end (depth 0 = after the very last message).
 */
export function injectInstruction(messages, settings, registry) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const msg = { role: settings.role, content: buildInstructionText(registry) };
  if (settings.position === 'start') { list.unshift(msg); return list; }
  if (settings.position === 'end') { list.push(msg); return list; }
  const idx = Math.max(0, list.length - settings.depth);
  list.splice(idx, 0, msg);
  return list;
}

// ---------------------------------------------------------------- registry (F4) normalization

export function normalizeRegistry(raw) {
  const list = raw && Array.isArray(raw.characters) ? raw.characters : [];
  return list.map((c, i) => ({
    id: typeof c?.id === 'string' && c.id ? c.id : 'c' + i,
    names: Array.isArray(c?.names) ? c.names.filter((n) => typeof n === 'string' && n.trim()) : [],
    appearance: typeof c?.appearance === 'string' ? c.appearance : '',
    enabled: c?.enabled !== false,
  })).filter((c) => c.names.length > 0);
}


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
