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

// Review (4th pass) finding 2: the previous (3rd pass) fix computed a "malformed span"
// heuristically (nearest '>', else nearest '<', else a 300-char bound) and checked for
// our marker text immediately *after* that computed span. That still broke for
// `<pic prompt="unfinished` + nothing closing: `scanTag`'s own unterminated-value scan
// only stops at `"` or `<` — neither appears in our marker text — so on the SECOND
// parse, the "unterminated value" scan read straight through the previously-inserted
// marker as if it were more of the (still-unterminated) attribute value, which moved
// where the span was computed to "end" on every pass, so the annotated-marker check
// (looking right at that ever-shifting position) never found the marker that was
// actually sitting further back — reproduced: 10 writes, a second marker nested inside
// the first. Fixed structurally instead of heuristically: the marker is now inserted
// immediately after the literal 4-character `<pic` opener itself (before ANY of the
// tag's own attribute text), and it starts with a character — `⟦`, see
// MALFORMED_MARKER_TEXT below — that is neither whitespace nor `>`. That means the very
// first check below (`boundary = text[idx+4]`) rejects this `<pic` occurrence as "not a
// tag opener" on every later parse, for the exact same reason `<pic-failed` already
// was rejected — `scanTag` (and therefore the unterminated-value-scanning that caused
// the bug) is never even invoked on it again. No span, no bound, no heuristic: a
// malformed tag returned by this function is *always* one that has not been annotated
// yet, because an annotated one can no longer be recognized as a `<pic` tag at all.
//
// The anchor text used for *relocation* (finding a malformed tag again in possibly-
// changed content before splicing — see backend.mjs) is now just a short, fixed-length
// prefix starting at the tag; it carries no significance beyond "a reasonably unique
// search key" and is never used to decide where content ends or where the marker goes
// (that's always exactly 4 characters into wherever the anchor is found).
const MALFORMED_ANCHOR_LEN = 32;

function buildMalformedTag(text, idx) {
  const raw = text.slice(idx, Math.min(idx + MALFORMED_ANCHOR_LEN, text.length));
  return { start: idx, end: idx + 4, raw, malformed: true, charsRaw: '', promptRaw: '' };
}

/**
 * Find every `<pic ...>` occurrence in `content` (well-formed tags, parsed; malformed
 * ones flagged) in document order, non-overlapping. Already-rendered markers
 * (`![그림:...]`, `<pic-failed ...>`, `<pic-skipped ...>`) and already-annotated
 * malformed tags never start a new match of their own — nothing there starts with
 * `<pic` followed by whitespace/`>` — so re-running this on an already-processed
 * message is a no-op — satisfies "never re-process already-rendered images", and a
 * malformed tag this function returns is *always* new (never already annotated; see
 * above).
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
      // e.g. "<pic-failed", or an already-annotated malformed tag (our marker's first
      // character is deliberately neither whitespace nor '>') — not our tag, skip it.
      searchFrom = idx + 4;
      continue;
    }
    const scanned = scanTag(text, idx);
    if (scanned.ok) {
      const { attrs } = scanned;
      const hasChars = Object.prototype.hasOwnProperty.call(attrs, 'chars');
      const hasPrompt = Object.prototype.hasOwnProperty.call(attrs, 'prompt');
      if (!hasChars && !hasPrompt) {
        const tag = buildMalformedTag(text, idx);
        out.push(tag);
        searchFrom = tag.end;
        continue;
      }
      out.push({
        start: idx, end: scanned.end, raw: text.slice(idx, scanned.end), malformed: false,
        charsRaw: hasChars ? attrs.chars : '', promptRaw: hasPrompt ? attrs.prompt : '',
      });
      searchFrom = scanned.end;
    } else {
      // Broken tag: unterminated quote, missing '=', missing closing '>', etc.
      const tag = buildMalformedTag(text, idx);
      out.push(tag);
      searchFrom = tag.end;
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

// ---------------------------------------------------------------- main preset composition (F5, review finding 2 round 3)

// Lumiverse's `{{character_prompt}}`/`{{character_negative_prompt}}` and
// `{{persona_prompt}}`/`{{persona_negative_prompt}}` macros splice in a card-bound (or
// persona-bound) preset snippet — but that substitution only happens when the host's
// OWN prompt-resolution path runs (`image-gen.service.ts` `expandCharacterPromptMacro`),
// which we deliberately bypass via `skipParse:true` (so our already-exact scene prompt
// isn't re-parsed). If we naively concatenated the active main preset's text as-is, any
// of these four tokens in it would reach the provider as literal `{{...}}` text instead
// of being expanded or removed. Since our own per-character registry (F3) already
// supplies appearance text via `characterTags`, the correct behavior is to drop these
// tokens entirely rather than try to expand them ourselves — stripped, not substituted.
// Token names/regex verified against `image-gen.service.ts` `substituteCharacterPromptMacro`
// (~1380-1392) and `substitutePersonaPromptMacro` (~1402-1412): case-insensitive,
// tolerant of internal whitespace.
const CHAR_PERSONA_MACRO_RE = /\{\{\s*(?:character|persona)_(?:negative_)?prompt\s*\}\}/gi;
export function stripCharacterPersonaMacros(text) {
  return String(text ?? '').replace(CHAR_PERSONA_MACRO_RE, '');
}

/** Joins non-empty prompt fragments with ", ", trimming each fragment's own leading/
 *  trailing commas and whitespace first so stripping a macro token (which can leave
 *  "a, , b" or ", b" behind) never produces a doubled or stray leading separator. */
export function joinPromptParts(parts) {
  return (parts || [])
    .map((p) => String(p ?? '').trim())
    .map((p) => p.replace(/^[,\s]+|[,\s]+$/g, ''))
    .filter(Boolean)
    .join(', ');
}

/**
 * Compose the final request prompt/negativePrompt from the tag's scene prompt and the
 * user's active native main image-prompt preset (if any) — review (3rd pass) finding 2:
 * `imageGen.generateNative()` with an inline `prompt` REPLACES the active preset's own
 * prompt rather than composing with it (`image-gen.service.ts:1333`: `opts?.prompt ??
 * preset?.prompt ?? ...` — our prompt always wins the `??` chain since it's never
 * null/undefined), so the DESIGN.md §4 "main prompt + tag prompt" contract has to be
 * assembled explicitly here instead of relying on the host to do it.
 *
 * `mainPreset` is `{ prompt, negativePrompt } | null` — the active preset fetched via
 * `spindle.imageGen.getPromptPresets()` (see backend.mjs `fetchMainPreset`), or `null`
 * if there is none / it couldn't be fetched (scene prompt alone, unchanged from before
 * this fix — never blocks generation).
 *
 * Negative prompt: when the cleaned preset negative is non-empty, it's returned
 * explicitly (single source — never combined with the connection's own default
 * negative, avoiding a doubled-up negative prompt). When there's nothing to contribute
 * (no preset, or an empty/macro-only negative), `negativePrompt` is `undefined` so the
 * caller can omit the field entirely and let the host's own connection-default
 * fallback apply exactly as it did before this fix.
 */
export function buildFinalPrompt(scenePrompt, mainPreset) {
  const presetPositive = mainPreset?.prompt ? stripCharacterPersonaMacros(mainPreset.prompt) : '';
  const prompt = joinPromptParts([presetPositive, scenePrompt]);
  const rawNegative = mainPreset?.negativePrompt ? stripCharacterPersonaMacros(mainPreset.negativePrompt) : '';
  const cleanedNegative = joinPromptParts([rawNegative]); // same leading/trailing-comma cleanup as the positive side
  return { prompt, negativePrompt: cleanedNegative || undefined };
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
// INSERTED immediately *after* the literal `<pic` opener (see planMessage's
// `{mode:'insert', ...}` entries and backend.mjs's splice loop — always exactly 4
// characters into wherever the tag's anchor is found), so message length can only
// grow, never shrink, because of malformed-tag handling. No `tag` data is embedded
// (nothing to escape, nothing to summarize — the real text is right there, intact).
//
// Review (4th pass) finding 2: this text must start with a character that is neither
// whitespace nor '>' — `parseTags`'s boundary check (`boundary = text[idx+4]`) relies
// on that to recognize an annotated tag as "not a `<pic` opener" on every later parse,
// without needing to locate or compare against this marker at all (see buildMalformedTag
// above). A leading space here would defeat that: whitespace right after `<pic` still
// passes the boundary check as "maybe our tag", so `scanTag` would run again and the
// bug this marker exists to prevent would resurface. `⟦`/`⟧` (not `<`/`>`) are used so
// the marker itself can never be mistaken for tag syntax either.
export const MALFORMED_MARKER_TEXT = '⟦삽화가: 그림 태그 형식 오류 — 고치면 다시 시도됩니다⟧';
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
export function planMessage(content, { registry = [], maxImages = 2, existingImageIds = [], idGenerator } = {}) {
  const tags = parseTags(content);
  const jobs = [];
  const skipped = [];
  // markers: tagIndex -> { mode: 'replace' | 'insert', text }. 'replace' swaps the
  // original tag text out (success/failure/skip — the whole point of F5). 'insert'
  // (malformed tags only, review finding 1) keeps the original text and only ADDS a
  // short marker right after it, so malformed handling can never shrink the message.
  const markers = new Map();
  const usedIds = existingImageIds.slice();
  let validCount = 0;
  tags.forEach((tag, i) => {
    if (tag.malformed) {
      // Review (4th pass) finding 2: parseTags structurally never returns an
      // already-annotated malformed tag (see buildMalformedTag) — an annotated
      // occurrence can no longer even be recognized as a `<pic` tag, so it's filtered
      // out before parseTags ever reaches the point of flagging it malformed. Every
      // malformed tag reaching here is therefore guaranteed to need a new marker.
      markers.set(i, { mode: 'insert', text: renderMalformedMarker() });
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
  return { tags, jobs, skipped, markers };
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
