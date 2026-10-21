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
      // Broken tag: unterminated quote, missing '=', missing closing '>', etc.
      //
      // This span is now ONLY used to (a) find a short, stable key for "have we already
      // flagged this exact broken tag" and (b) decide where to resume scanning for more
      // `<pic` occurrences — it is NEVER used to delete/replace anything any more (see
      // planMessage/renderMalformedMarker: malformed handling only ever INSERTS a short
      // marker after the untouched original text, never replaces it). Still bounded to
      // a small span regardless of which branch is taken — review (2nd pass) finding 1
      // caught that the `nextLt` fallback below had NO bound at all, so a broken tag
      // followed by a long stretch of real narrative and then any later '<' (even a
      // genuine later tag far down the message) made `tag.raw` (and therefore the
      // dedup key) swallow all of that narrative. Capping every branch at BOUND avoids
      // that regardless of what used to (and no longer does) happen to the swallowed text.
      const BOUND = 300;
      const nextLt = text.indexOf('<', idx + 4);
      const nextGt = text.indexOf('>', idx + 4);
      let end;
      if (nextGt !== -1 && (nextLt === -1 || nextGt < nextLt) && nextGt - idx <= BOUND) {
        end = nextGt + 1; // include the stray '>' — the broken tag's apparent close
      } else if (nextLt !== -1 && nextLt - idx <= BOUND) {
        end = nextLt; // stop before whatever starts next (often a later real tag)
      } else {
        end = Math.min(idx + BOUND, text.length); // no boundary nearby (or too far): bounded cap only
      }
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

// Lowercased/trimmed but keeping single spaces (collapsing runs of whitespace to one
// space) — used only for the word-boundary-aware prefix fallback below, where we must
// be able to tell "a real space follows the alias" from "more letters follow it".
function normalizeSpaced(s) {
  return String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
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
      const spaced = normalizeSpaced(n);
      if (norm) flat.push({ norm, spaced, idx });
    }
  });
  flat.sort((a, b) => b.norm.length - a.norm.length);
  return flat;
}

/** Returns the registry index matched by `name`, or -1. Exact match (whitespace/case
 *  insensitive), or the token beginning with "<alias> " — a real word boundary, not just
 *  a longer prefix — for when the AI appends extra words instead of using the action
 *  field (e.g. "아드리안 (미소)"). Review caught a bug here: comparing on the
 *  whitespace-STRIPPED form let "Anna" match a registered alias "Ann" (no boundary at
 *  all, just a longer string with the same prefix) — fixed by requiring an actual space
 *  after the alias in the original (whitespace-collapsed, not stripped) text. */
export function findCharacterIndex(name, registry) {
  const token = normalizeName(name);
  if (!token) return -1;
  const flat = flatAliases(registry);
  for (const { norm, idx } of flat) {
    if (token === norm) return idx;
  }
  const spacedToken = normalizeSpaced(name);
  const bySpacedLengthDesc = flat.slice().sort((a, b) => b.spaced.length - a.spaced.length);
  for (const { spaced, idx } of bySpacedLengthDesc) {
    if (spaced && spacedToken.startsWith(spaced + ' ')) return idx;
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

/** Next image id for this message: p1, p2, … — stable/deterministic given how many
 *  ids already exist (so re-processing new tags on an edited message doesn't collide
 *  with ids already used by previously rendered images). */
// Review (2nd pass) finding 3: sequential ids derived only from a point-in-time
// snapshot of "ids already in this message" collide when two handlers (e.g.
// GENERATION_ENDED and MESSAGE_EDITED firing close together for the same message)
// each plan from their own snapshot before either has committed — both see "p1" as
// free and both allocate it, and whichever commits second overwrites the first's
// metadata record. backend.mjs now also serializes planning+commit per message (a
// per chatId+messageId lock), which is the primary fix for that specific race — this
// is defense in depth for it, and the only fix for the same two ids colliding across
// a worker restart (the in-memory lock doesn't survive one). Collision-resistant by
// default (time + random, not a small counter); tests inject a deterministic
// `idGenerator` (e.g. a simple counter) via planMessage's options so assertions on
// exact ids stay stable without the production path ever being sequential-from-snapshot.
function randomImageId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function nextImageId(existingIds, idGenerator) {
  const used = new Set(existingIds || []);
  const generate = idGenerator || randomImageId;
  let id = generate();
  let guard = 0;
  while (used.has(id) && guard++ < 1000) id = generate();
  return id;
}

export function renderSuccessMarker(id, imageUrl, summaryText) {
  return `![그림:${id}|${summarize(summaryText)}](${imageUrl})`;
}

// Keeps the human-readable summary free of characters that could ever confuse a regex
// that looks for the fixed `<pic-failed id="...">` / `<pic-skipped id="...">` sentinel
// that follows it (review finding: the previous design embedded the raw chars/prompt
// attribute text straight into the sentinel tag, and since a tag's `prompt="..."` value
// is allowed to contain a literal '>' — see scanTag, which only disallows '<' and '"'
// inside a value, not '>' — a prompt containing '>' would make the old
// `<pic-failed[^>]*>`-style regexes stop too early, breaking regenerate's replace AND
// the history strip-down). Fix: the sentinel tag now carries *only* an opaque id — all
// recoverable structured data (prompt/characterTags) lives in message metadata, which
// is where regenerate already reads it from — so the regex matching it can be a fixed,
// unambiguous string with no wildcard anywhere near a quote.
function markerSafeSummary(text) {
  return summarize(text, 60).replace(/"/g, '”').replace(/[<>]/g, '');
}

export function renderFailureMarker(id, tag, reason) {
  const summary = markerSafeSummary(tag.promptRaw || tag.charsRaw || tag.raw);
  const shown = summary ? ` · "${summary}"` : '';
  return `[⚠️ 그림 생성 실패(${reason || '오류'})${shown} · 패널에서 '다시 그리기'로 재시도 <pic-failed id="${id}">]`;
}

export function renderSkippedMarker(id, tag) {
  const summary = markerSafeSummary(tag.promptRaw || tag.charsRaw || tag.raw);
  const shown = summary ? ` · "${summary}"` : '';
  return `[한 답변당 그림 상한(2장)을 넘어 건너뜀${shown} · 패널에서 '다시 그리기'로 추가 생성 가능 <pic-skipped id="${id}">]`;
}

// Review (2nd pass) finding 1: malformed input must NEVER be removed or summarized —
// the previous version REPLACED the malformed span with a marker that re-summarized
// (and therefore truncated/destroyed) the original text. The fixed design never
// replaces anything for a malformed tag: this fixed, short marker is only ever
// INSERTED immediately *after* the untouched original text (see planMessage's
// `{mode:'insert', ...}` entries and backend.mjs's splice loop), so message length can
// only grow, never shrink, because of malformed-tag handling. No `tag` data is embedded
// (nothing to escape, nothing to summarize — the real text is right there, intact).
export const MALFORMED_MARKER_TEXT = ' [⚠️ 그림 태그 형식 오류 — 고치면 다시 시도됩니다]';
export function renderMalformedMarker() {
  return MALFORMED_MARKER_TEXT;
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
export function planMessage(content, { registry = [], maxImages = 2, existingImageIds = [], seenMalformed, idGenerator } = {}) {
  const tags = parseTags(content);
  const jobs = [];
  const skipped = [];
  const newlyMalformed = [];
  // markers: tagIndex -> { mode: 'replace' | 'insert', text }. 'replace' swaps the
  // original tag text out (success/failure/skip — the whole point of F5). 'insert'
  // (malformed tags only, review finding 1) keeps the original text and only ADDS a
  // short marker right after it, so malformed handling can never shrink the message.
  const markers = new Map();
  const seen = seenMalformed instanceof Set ? seenMalformed : new Set();
  const usedIds = existingImageIds.slice();
  let validCount = 0;
  tags.forEach((tag, i) => {
    if (tag.malformed) {
      if (!seen.has(tag.raw)) {
        markers.set(i, { mode: 'insert', text: renderMalformedMarker() });
        newlyMalformed.push({ tagIndex: i, raw: tag.raw });
      }
      return;
    }
    validCount++;
    const parsedChars = splitChars(tag.charsRaw);
    const { characterTags, extraFragments } = buildCharacterTags(parsedChars, registry);
    const prompt = assemblePrompt(tag.promptRaw, extraFragments);
    const id = nextImageId(usedIds, idGenerator);
    usedIds.push(id);
    if (validCount > maxImages) {
      markers.set(i, { mode: 'replace', text: renderSkippedMarker(id, tag) });
      skipped.push({ tagIndex: i, id, prompt, characterTags, summary: tag.promptRaw });
      return;
    }
    jobs.push({ tagIndex: i, id, prompt, characterTags, summary: tag.promptRaw });
  });
  return { tags, jobs, skipped, markers, newlyMalformed };
}

/** Splice `content` using parseTags-produced `tags` and a parallel marker map
 *  (tagIndex -> {mode:'replace'|'insert', text}); tags without an entry are left
 *  untouched. 'insert' keeps the original tag text and appends `text` right after it
 *  (never shrinks the message); 'replace' swaps the tag text out for `text`. */
export function applyMarkers(content, tags, replacements) {
  const text = String(content ?? '');
  let out = '';
  let last = 0;
  tags.forEach((tag, i) => {
    const original = text.slice(tag.start, tag.end);
    out += text.slice(last, tag.start);
    const entry = replacements.get(i);
    if (!entry) out += original;
    else if (entry.mode === 'insert') out += original + entry.text;
    else out += entry.text;
    last = tag.end;
  });
  out += text.slice(last);
  return out;
}

// ---------------------------------------------------------------- history placeholder rewrite

const RENDERED_IMG_RE = /!\[그림:[a-z0-9]+\|([^\]]*)\]\([^)]*\)/g;
// Anchored on the fixed `<pic-failed id="...">` / `<pic-skipped id="...">` tail (no
// chars/prompt attributes any more — see renderFailureMarker/renderSkippedMarker), so
// there's no wildcard adjacent to a quote that a prompt containing '>' could break.
const FAILED_RE = /\[⚠️ 그림 생성 실패\([^)]*\)[^[\]]*<pic-failed id="[a-z0-9]+">\]/g;
const SKIPPED_RE = /\[한 답변당 그림 상한\(2장\)을 넘어 건너뜀[^[\]]*<pic-skipped id="[a-z0-9]+">\]/g;
// Matches ONLY our small inserted annotation (MALFORMED_MARKER_TEXT) — the malformed
// `<pic ...>` text it was inserted after is deliberately left alone (it's not image
// markup, and the user/model being able to see exactly what they wrote is useful; only
// our own short annotation is redundant noise in history).
const MALFORMED_ANNOTATION_RE = new RegExp(MALFORMED_MARKER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

/** For prompt assembly over past turns: collapse any of our rendered/failure/skip
 *  markers down to a short `[그림: ...]` placeholder, and drop the small malformed-tag
 *  annotation, so image HTML/markdown is never fed back to the model (design §4, last
 *  bullet) while the user's own (malformed) tag text is never altered or removed.
 *
 * Review (2nd pass) finding 7: this must run regardless of the per-chat auto-generation
 * flag — only F1's instruction injection is conditional on it (see backend.mjs's
 * interceptor), not this cleanup. */
export function stripRenderedImages(content) {
  let s = String(content ?? '');
  s = s.replace(RENDERED_IMG_RE, (_, summary) => `[그림: ${summary}]`);
  s = s.replace(FAILED_RE, '[그림: 생성 실패]');
  s = s.replace(SKIPPED_RE, '[그림: 생략됨]');
  s = s.replace(MALFORMED_ANNOTATION_RE, '');
  return s;
}

/** Idempotency guard: true if `content` has no live `<pic ...>` tags left to process
 *  (i.e. parseTags would return nothing, or only tags already turned into markers by
 *  this same extension would remain — which parseTags never reports in the first place). */
export function hasLiveTags(content) {
  return parseTags(content).length > 0;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex matching the ONE marker occurrence for a given image id — either its rendered
 *  image, or its failed/skipped sentinel — for regenerate's in-place replace. Exported
 *  so backend.mjs doesn't hand-roll its own copy of this pattern (review finding: the
 *  old inline version in backend.mjs used a `[^>]*`-style wildcard next to an attribute
 *  value that could itself contain '>', which could fail to match and silently leave
 *  the stale marker in place while still reporting success). Single source of truth. */
export function markerRegexForId(id) {
  const idRe = escapeRegExp(id);
  return new RegExp(
    `!\\[그림:${idRe}\\|[^\\]]*\\]\\([^)]*\\)` +
    `|\\[[^[\\]]*<pic-(?:failed|skipped) id="${idRe}">\\]`,
  );
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

// Strips newlines/control characters and caps length before an alias is ever quoted
// into the system/user/assistant-role instruction message — review flagged that aliases
// (typed by the user into the registry panel, F4) went into that message verbatim, so a
// stray pasted newline (or a block of text someone fat-fingered into the name field)
// could inject extra lines into the instruction. Single-user tool, so this isn't an
// external-attacker threat model, but it's cheap, correct hygiene regardless.
function sanitizeAliasForInstruction(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // control chars incl. newlines -> space
    .replace(/"/g, '') // review (2nd pass): strip quotes too — the roster wraps every
    // alias in literal "..." for the AI, and an un-escaped embedded quote would break
    // that quoting (e.g. name `보라"장난꾼` rendered as `"보라"장난꾼"`, ambiguous).
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Enabled characters' alias lists, for the AI instruction (§2: list registered
 *  names so the AI uses them verbatim, any alias accepted regardless of chat language). */
export function instructionNameList(registry) {
  return (registry || []).filter((c) => c.enabled && c.names?.length)
    .map((c) => c.names.map(sanitizeAliasForInstruction).filter(Boolean).map((n) => `"${n}"`).join(' / '))
    .filter(Boolean);
}

export function buildInstructionText(registry) {
  const names = instructionNameList(registry);
  // Roster lines are presented as quoted data (each alias wrapped in literal quotes),
  // not as free-form instruction text, so a sanitized-but-still-plain-looking alias
  // can't be read as part of the instruction's own sentence structure.
  const roster = names.length
    ? `\n등장인물 목록(따옴표 안 글자 그대로 사용 가능, 아무 별칭이나 써도 됨):\n- ${names.join('\n- ')}`
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
  // Review finding 4: a late response from a SUPERSEDED load (e.g. the user closed the
  // panel and reopened it for a different card before the first load finished) used to
  // land in `view` regardless, so card A's registry could flash over — or silently
  // replace — card B's. `loadToken` fixes that: every open() mints a new token, and
  // loadAll() only commits its results if its own token is still the current one.
  let loadToken = 0;
  const pending = new Map();
  // view.chatId/characterId are the SNAPSHOT this panel's data actually belongs to
  // (captured once per open(), not the live, possibly-already-moved-on outer
  // chatId/characterId vars) — every write (save/toggle/regenerate) targets these, not
  // whatever card happens to be active by the time the write fires.
  const view = { settings: null, registry: [], auto: true, images: [], status: '', kind: '', busy: false, ready: false, chatId: null, characterId: null };

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

  async function loadAll(token, snapChatId, snapCharacterId) {
    const [s, r, a, i] = await Promise.all([
      request({ type: 'load_settings' }),
      snapCharacterId ? request({ type: 'load_registry', characterId: snapCharacterId }) : Promise.resolve({ ok: true, registry: [] }),
      request({ type: 'load_auto', chatId: snapChatId }),
      request({ type: 'list_images', chatId: snapChatId }),
    ]);
    if (!alive || token !== loadToken) return; // superseded by a newer open() — discard
    const allOk = s.ok && r.ok && a.ok && i.ok;
    if (s.ok) view.settings = s.settings;
    if (r.ok) view.registry = r.registry;
    if (a.ok) view.auto = a.auto;
    if (i.ok) view.images = i.images;
    view.ready = allOk;
    setStatus(allOk ? '' : (s.error || r.error || a.error || i.error || '일부 정보를 불러오지 못했습니다'), allOk ? '' : 'err');
    render();
  }

  async function saveSettings(patch) {
    if (!view.ready || view.busy) return;
    const token = loadToken;
    view.busy = true; render();
    const r = await request({ type: 'save_settings', settings: { ...view.settings, ...patch } });
    if (!alive || token !== loadToken) return;
    view.busy = false;
    if (r.ok) view.settings = r.settings;
    render();
    setStatus(r.ok ? '설정 저장됨' : (r.error || '실패'), r.ok ? 'ok' : 'err');
  }

  async function toggleAuto() {
    if (!view.ready || view.busy) return;
    const token = loadToken, targetChatId = view.chatId;
    view.busy = true; render();
    const r = await request({ type: 'set_auto', chatId: targetChatId, on: !view.auto });
    if (!alive || token !== loadToken) return;
    view.busy = false;
    if (r.ok) view.auto = r.auto;
    render();
  }

  async function saveRegistry(next) {
    if (!view.ready || view.busy || !view.characterId) return;
    const token = loadToken, targetCharacterId = view.characterId;
    view.busy = true; render();
    const r = await request({ type: 'save_registry', characterId: targetCharacterId, registry: next });
    if (!alive || token !== loadToken) return;
    view.busy = false;
    if (r.ok) view.registry = r.registry;
    render();
    setStatus(r.ok ? '등록부 저장됨' : (r.error || '실패'), r.ok ? 'ok' : 'err');
  }

  function addDraftCharacter() {
    // Review finding 3: this used to call saveRegistry() immediately with a brand-new
    // {names: [], ...} entry — but normalizeRegistry() (core.mjs) correctly drops any
    // entry with no names (an unnamed character can't ever be matched against), so the
    // "+ 인물 추가" button silently did nothing, and starting from an empty registry
    // there was no way to ever add a first character. Fix: the new row is purely local
    // view state until its own "저장" button is clicked with a non-empty name — it is
    // never round-tripped through save_registry (and thus never dropped) before that.
    if (!view.ready || view.busy) return;
    view.registry = [...view.registry, { names: [], appearance: '', enabled: true }];
    render();
  }

  async function regenerate(imageId, messageId) {
    if (!view.ready || view.busy) return;
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
    setStatus(r.ok ? '다시 그렸습니다' : (r.error || '실패'), r.ok ? 'ok' : 'err');
  }

  function settingsSection() {
    const s = view.settings || {};
    const dis = view.busy || !view.ready;
    const posSel = el('select', { disabled: dis, on: { change: (e) => saveSettings({ position: e.target.value }) } },
      ['start', 'end', 'depth'].map((p) => el('option', { value: p, selected: s.position === p, text: p === 'start' ? '맨 앞' : p === 'end' ? '맨 끝' : '깊이(최근 N번째 앞)' })));
    const depthInput = el('input', { type: 'text', inputmode: 'numeric', value: String(s.depth ?? 4), disabled: dis || s.position !== 'depth',
      on: { change: (e) => { const n = parseInt(e.target.value, 10); if (Number.isInteger(n) && n >= 0) saveSettings({ depth: n }); } } });
    const roleSel = el('select', { disabled: dis, on: { change: (e) => saveSettings({ role: e.target.value }) } },
      ['system', 'user', 'assistant'].map((r) => el('option', { value: r, selected: s.role === r, text: r })));
    const maxSel = el('select', { disabled: dis, on: { change: (e) => saveSettings({ maxImages: parseInt(e.target.value, 10) }) } },
      [1, 2].map((n) => el('option', { value: String(n), selected: s.maxImages === n, text: n + '장' })));
    return el('section', {},
      el('h4', { text: '⚙️ 설정 (계정 전체)' }),
      el('div', { class: 'lvil-row' }, el('span', {}, '지시 위치'), posSel, depthInput),
      el('div', { class: 'lvil-row' }, el('span', {}, '지시 역할'), roleSel),
      el('div', { class: 'lvil-row' }, el('span', {}, '답변당 최대 그림'), maxSel),
      el('div', { class: 'lvil-note', text: '이 채팅 자동 생성:' },
        el('button', { type: 'button', 'data-active': String(view.auto), disabled: view.busy || !view.ready, text: view.auto ? '켜짐 (끄기)' : '꺼짐 (켜기)',
          on: { click: toggleAuto } })));
  }

  function charRow(ch, idx, list) {
    const namesInput = el('input', { type: 'text', value: ch.names.join(', '), placeholder: '이름/별칭 (쉼표로 구분)' });
    const appearanceInput = el('textarea', { placeholder: '외형 프롬프트 (NAI 태그)' });
    appearanceInput.value = ch.appearance;
    const dis = view.busy || !view.ready;
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
    const rows = list.map((ch, i) => charRow(ch, i, list));
    const addBtn = el('button', { type: 'button', text: '+ 인물 추가', disabled: !view.ready || view.busy, on: { click: addDraftCharacter } });
    return el('section', {}, el('h4', { text: '👤 인물 외형 등록부 (이 카드의 모든 채팅과 공유)' }), ...rows, addBtn,
      el('div', { class: 'lvil-note', text: '등록부는 비어서 시작합니다. 여기서 추가한 인물만 이름 매칭에 쓰입니다.' }));
  }

  function imagesSection() {
    if (!view.images.length) {
      return el('section', {}, el('h4', { text: '🖼️ 이 채팅의 그림' }),
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
          : el('button', { type: 'button', disabled: view.busy || !view.ready, text: '다시 그리기', on: { click: () => regenerate(img.id, img.messageId) } }));
    });
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
    // Snapshot which card/chat this panel instance belongs to, and bump the load token
    // BEFORE clearing view state, so any in-flight loadAll() from a previous open() is
    // immediately recognized as stale once it resolves (review finding 4).
    const token = ++loadToken;
    const snapChatId = chatId, snapCharacterId = characterId;
    Object.assign(view, {
      settings: null, registry: [], auto: true, images: [], ready: false, busy: false,
      chatId: snapChatId, characterId: snapCharacterId, status: '불러오는 중…', kind: '',
    });
    render();
    await loadAll(token, snapChatId, snapCharacterId);
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
