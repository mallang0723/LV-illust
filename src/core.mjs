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

// ---------------------------------------------------------------- tag lists + body/outfit split (0.2.0)

// A character's looks are two separate tag groups: 신체 특성 (`body`: hair, eyes, skin,
// build, species features ...) and 옷·장신구 (`outfit`: clothes, shoes, jewelry, glasses,
// hats, worn/held items). Records saved before 0.2.0 only have one combined `appearance`
// string; normalizeRegistry() migrates those with the conservative keyword heuristic below.

const TAG_SEPARATORS = new Set([',', '，', '、', '\n', '\r']);

/** Splits a comma-separated tag list into trimmed, non-empty tags. Commas inside
 *  `()`/`[]`/`{}` or inside a NovelAI `weight::a, b::` group do NOT split, so weighted
 *  groups stay in one piece. Joining the result with ", " loses no tag. */
export function splitTagList(text) {
  const s = String(text ?? '');
  const out = [];
  let depth = 0, weighted = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ':' && s[i + 1] === ':') { weighted = !weighted; cur += '::'; i++; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && !weighted && TAG_SEPARATORS.has(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

export function joinTagList(tags) {
  return (tags || []).map((t) => String(t ?? '').trim()).filter(Boolean).join(', ');
}

/** Case-insensitive, whitespace-insensitive de-duplication of comma-separated tag
 *  fragments, keeping first-seen order and original spelling. */
export function dedupeTags(fragments) {
  const seen = new Set();
  const out = [];
  for (const frag of fragments || []) {
    for (const tag of splitTagList(frag)) {
      const key = tag.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

// Keyword lists (exported so they can be reviewed and reported). Latin words match on
// word boundaries with an optional plural; Korean words match as substrings (1-syllable
// words only as a whole whitespace-separated token, to avoid matching inside other words).
// A tag counts as outfit only when it has an outfit keyword and NO body keyword; a tag
// with a body keyword and no outfit keyword is body; a tag with both, or with neither,
// or with an AMBIGUOUS keyword is *unsure*: it goes to body and is flagged for review.
export const OUTFIT_PRIORITY = [
  'hair ornament', 'hair ribbon', 'hair bow', 'hair clip', 'hairclip', 'hairpin', 'hair pin', 'hairband', 'hair band',
  'hair tie', 'hair flower', 'hair stick', 'hair accessory', 'hair accessories', 'hair scrunchie', 'hair bell', 'hair bobbles', 'hair beads',
  'off shoulder', 'eyewear', 'eyepatch',
  '머리띠', '머리핀', '머리끈', '귀걸이', '안경', '안대',
];
export const OUTFIT_WORDS = [
  'dress', 'shirt', 't-shirt', 'tshirt', 'blouse', 'sweater', 'hoodie', 'jacket', 'coat', 'cardigan', 'vest', 'uniform', 'school uniform',
  'suit', 'tuxedo', 'tie', 'necktie', 'bowtie', 'skirt', 'miniskirt', 'pants', 'jeans', 'shorts', 'trousers', 'leggings', 'thighhighs',
  'thigh highs', 'kneehighs', 'stockings', 'pantyhose', 'tights', 'socks', 'shoes', 'boot', 'boots', 'sneakers', 'heels', 'high heels',
  'sandals', 'loafers', 'gloves', 'glove', 'hat', 'cap', 'beret', 'hood', 'helmet', 'crown', 'tiara', 'ribbon', 'bow', 'scarf', 'shawl',
  'cape', 'cloak', 'apron', 'kimono', 'yukata', 'hanbok', 'robe', 'armor', 'armour', 'bikini', 'swimsuit', 'leotard', 'lingerie', 'bra',
  'panties', 'underwear', 'sleeves', 'collar', 'choker', 'necklace', 'pendant', 'earrings', 'ring', 'bracelet', 'bangle', 'anklet', 'belt',
  'watch', 'glasses', 'sunglasses', 'monocle', 'mask', 'headband', 'scrunchie', 'headphones', 'headset', 'bag', 'backpack', 'umbrella', 'cane',
  'corset', 'bodysuit', 'pajamas', 'jersey', 'maid headdress', 'wristband', 'harness', 'piercing', 'clothes', 'clothing', 'outfit', 'attire',
  'costume', 'garment', 'sword', 'katana', 'wearing', 'dressed',
  '옷', '셔츠', '블라우스', '니트', '스웨터', '후드', '재킷', '자켓', '코트', '가디건', '조끼', '정장', '교복', '유니폼', '드레스', '원피스',
  '치마', '스커트', '바지', '청바지', '반바지', '레깅스', '스타킹', '양말', '신발', '구두', '부츠', '운동화', '샌들', '슬리퍼', '장갑', '모자',
  '비니', '베레모', '선글라스', '목걸이', '반지', '팔찌', '발찌', '시계', '벨트', '넥타이', '스카프', '머플러', '목도리', '망토', '케이프',
  '앞치마', '기모노', '한복', '로브', '갑옷', '비키니', '수영복', '속옷', '리본', '마스크', '가방', '우산', '지팡이', '초커', '왕관', '티아라', '가면',
];
export const BODY_WORDS = [
  'hair', 'eye', 'pupil', 'iris', 'skin', 'tan', 'tanned', 'pale', 'complexion', 'muscular', 'muscle', 'slim', 'slender', 'thin', 'skinny',
  'fat', 'chubby', 'plump', 'curvy', 'petite', 'tall', 'athletic', 'abs', 'toned', 'build', 'body', 'figure', 'height', 'breast', 'bust',
  'chest', 'thigh', 'hip', 'waist', 'shoulders', 'scar', 'scarred', 'freckle', 'mole', 'birthmark', 'tattoo', 'fang', 'tooth', 'teeth',
  'tail', 'horn', 'wing', 'ear', 'elf', 'demon', 'vampire', 'catgirl', 'cat girl', 'furry', 'ahoge', 'bangs', 'ponytail', 'twintails',
  'twin tails', 'braid', 'bob cut', 'sidelocks', 'blonde', 'brunette', 'redhead', 'heterochromia',
  'girl', 'boy', 'man', 'woman', 'male', 'female', '1girl', '1boy', '2girls', '2boys', 'solo', 'young', 'mature', 'adult', 'teen', 'teenage',
  'child', 'old', 'elderly', 'youthful',
  '머리카락', '머리', '눈동자', '피부', '체형', '근육', '흉터', '주근깨', '얼굴', '가슴', '허벅지', '꼬리', '날개', '나이', '머릿결', '곱슬', '생머리',
  '단발', '장발', '포니테일', '쌍꼬리', '땋은',
];
export const BODY_WORDS_SINGLE_SYLLABLE = ['눈', '귀', '키', '몸', '뿔', '점'];
export const AMBIGUOUS_WORDS = [
  'bare shoulders', 'bare legs', 'bare arms', 'bare feet', 'barefoot', 'naked', 'nude', 'topless', 'bottomless', 'midriff', 'navel',
  'cleavage', 'underboob', 'sideboob', 'see-through', '맨발', '알몸', '맨몸',
];

function wordRegex(list) {
  const latin = list.filter((w) => /^[\x00-\x7f]+$/.test(w)).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ ]'));
  const hangul = list.filter((w) => !/^[\x00-\x7f]+$/.test(w)).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = [];
  if (latin.length) parts.push(`(?<![a-z0-9])(?:${latin.join('|')})(?:e?s)?(?![a-z0-9])`);
  if (hangul.length) parts.push(`(?:${hangul.join('|')})`);
  return new RegExp(parts.join('|'), 'i');
}
const RE_PRIORITY = wordRegex(OUTFIT_PRIORITY);
const RE_OUTFIT = wordRegex(OUTFIT_WORDS);
const RE_BODY = wordRegex(BODY_WORDS);
const RE_AMBIGUOUS = wordRegex(AMBIGUOUS_WORDS);

function coreOfTag(tag) {
  return String(tag)
    .replace(/^\s*-?\d*\.?\d+::/, '').replace(/::\s*$/, '') // NAI weight wrapper
    .replace(/:\s*-?\d*\.?\d+\s*\)?$/, '')                   // (tag:1.2)
    .replace(/[(){}[\]]/g, ' ')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function classifyAtom(atom) {
  if (!atom) return 'unsure';
  if (RE_PRIORITY.test(atom)) return 'outfit';
  if (RE_AMBIGUOUS.test(atom)) return 'unsure';
  const koSingle = atom.split(' ').some((tok) => BODY_WORDS_SINGLE_SYLLABLE.includes(tok));
  const body = RE_BODY.test(atom) || koSingle;
  const outfit = RE_OUTFIT.test(atom);
  if (body && outfit) return 'unsure';
  if (body) return 'body';
  if (outfit) return 'outfit';
  return 'unsure';
}

/** 'body' | 'outfit' | 'unsure' for ONE tag (a weighted group with several inner tags
 *  is 'body'/'outfit' only when every inner tag agrees). */
export function classifyTag(tag) {
  const parts = coreOfTag(tag).split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return 'unsure';
  const kinds = parts.map(classifyAtom);
  return kinds.every((k) => k === kinds[0]) ? kinds[0] : 'unsure';
}

/** Splits a combined appearance string: `{ body, outfit, review }` where each is an
 *  array of the ORIGINAL tags (nothing is dropped or rewritten) and `review` lists
 *  the unsure tags — which are ALSO in `body`. */
export function splitAppearance(text) {
  const body = [], outfit = [], review = [];
  for (const tag of splitTagList(text)) {
    const kind = classifyTag(tag);
    if (kind === 'outfit') outfit.push(tag);
    else { body.push(tag); if (kind === 'unsure') review.push(tag); }
  }
  return { body, outfit, review };
}

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

// Per-scene outfit override inside a chars entry: "이름: 동작 | 옷: black suit, red tie"
// (also `outfit:` / `옷=`). The `|`-separated part starting with 옷/outfit replaces the
// character's SAVED outfit for this one picture only (body tags are never touched); with
// no such part the saved outfit is used. Everything else stays the free-text action.
const OUTFIT_PART_RE = /^\s*(?:옷|outfit)\s*[:=：]\s*/i;
export function splitAction(action) {
  const parts = String(action ?? '').split('|');
  const rest = [];
  let outfit = null;
  for (const part of parts) {
    if (OUTFIT_PART_RE.test(part)) outfit = part.replace(OUTFIT_PART_RE, '').trim();
    else if (part.trim()) rest.push(part.trim());
  }
  return { action: rest.join(', '), outfit: outfit || null };
}

/** body / outfit of a registry record; a record that still only has the legacy combined
 *  `appearance` (not normalized) counts entirely as body, so older callers keep working. */
export function looksOf(ch) {
  const hasSplit = typeof ch?.body === 'string' || typeof ch?.outfit === 'string';
  if (hasSplit) return { body: ch.body || '', outfit: ch.outfit || '' };
  return { body: typeof ch?.appearance === 'string' ? ch.appearance : '', outfit: '' };
}

/**
 * parsedChars: result of splitChars (already capped to MAX_CHARS_PER_TAG by caller).
 * registry: character registry array (see findCharacterIndex).
 * Returns:
 *  - characterTags: [{tags}] for NAI `parameters.characterTags` — ONLY matched+enabled
 *    characters (design §2: disabled characters match but contribute no appearance).
 *    Tags are ordered: 신체 특성 (body), then 옷·장신구 (the scene's `옷:` override if the
 *    tag gave one, else the saved outfit), then the scene action.
 *  - negatives: those same characters' own negative tag lists (the host can only take
 *    ONE global negative, so the caller merges these into it — see buildFinalPrompt).
 *  - extraFragments: short "name: action" text for matched-but-disabled or unmatched
 *    names, appended to the base scene prompt so the action isn't silently discarded
 *    even though no character-prompt slot is used for them.
 */
export function buildCharacterTags(parsedChars, registry) {
  const characterTags = [];
  const negatives = [];
  const extraFragments = [];
  for (const { name, action } of parsedChars.slice(0, MAX_CHARS_PER_TAG)) {
    const { action: actionText, outfit: outfitOverride } = splitAction(action);
    const idx = findCharacterIndex(name, registry);
    const asFragment = () => {
      const detail = [actionText, outfitOverride].filter(Boolean).join(', ');
      extraFragments.push(detail ? `${name}: ${detail}` : name);
    };
    if (idx === -1) { asFragment(); continue; }
    const ch = registry[idx];
    if (!ch.enabled) { asFragment(); continue; }
    const looks = looksOf(ch);
    const outfit = outfitOverride ?? looks.outfit;
    const tags = [looks.body, outfit, actionText].filter(Boolean).join(', ');
    characterTags.push({ tags });
    if (typeof ch.negative === 'string' && ch.negative.trim()) negatives.push(ch.negative.trim());
  }
  return { characterTags, extraFragments, negatives };
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
const BOUND_POSITIVE_RE = /\{\{\s*(?:character|persona)_prompt\s*\}\}/gi;
const BOUND_NEGATIVE_RE = /\{\{\s*(?:character|persona)_negative_prompt\s*\}\}/gi;

/**
 * 0.2.0 — the final negative prompt is composed in this order, then de-duplicated
 * (case-insensitive, per comma-separated tag, first spelling wins):
 *   1. the active main preset's negative (cleaned),
 *   2. `commonNegative` (the extension's own 공통 네거티브 setting),
 *   3. the negatives of the characters that appear in the scene (`characterNegatives`).
 * It is sent explicitly whenever it is non-empty (so the host can never fall back to a raw
 * preset negative with unresolved macros); when everything is empty it is `undefined`
 * and the caller omits the field, leaving the host/provider default in force.
 *
 * Card- and persona-bound negatives ({{character_negative_prompt}} /
 * {{persona_negative_prompt}} in the preset): the host resolves the bindings, and only when
 * the request is NOT sent with `skipParse` (image-gen.service.ts resolvePromptInput). Spindle
 * exposes neither the bound presets nor the bindings, so we cannot resolve them ourselves.
 * With `opts.boundNegatives === true` those two tokens are therefore left in the negative for
 * the host to expand (the caller must then omit `skipParse`); otherwise they are stripped.
 * Bound POSITIVES ({{character_prompt}} / {{persona_prompt}}) are always stripped: the
 * registry's body/outfit tags already supply the character's looks, so splicing a bound
 * snippet in as well would duplicate it.
 */
export function buildFinalPrompt(scenePrompt, mainPreset, opts = {}) {
  const presetPositive = mainPreset?.prompt ? String(mainPreset.prompt).replace(BOUND_POSITIVE_RE, '') : '';
  const prompt = joinPromptParts([presetPositive, scenePrompt]);
  let presetNegative = mainPreset?.negativePrompt ? String(mainPreset.negativePrompt) : '';
  presetNegative = opts.boundNegatives === true ? presetNegative : presetNegative.replace(BOUND_NEGATIVE_RE, '');
  const negative = dedupeTags([
    joinPromptParts([presetNegative]), // same leading/trailing-comma cleanup as the positive side
    opts.commonNegative,
    ...(opts.characterNegatives || []),
  ]).join(', ');
  return { prompt, negativePrompt: negative || undefined };
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
    const { characterTags, extraFragments, negatives } = buildCharacterTags(parsedChars, registry);
    const prompt = assemblePrompt(tag.promptRaw, extraFragments);
    const id = nextImageId(usedIds, idGenerator);
    usedIds.push(id);
    if (validCount > maxImages) {
      markers.set(i, { mode: 'replace', text: renderSkippedMarker(id, tag) });
      skipped.push({ tagIndex: i, id, prompt, characterTags, negatives, summary: tag.promptRaw });
      return;
    }
    jobs.push({ tagIndex: i, id, prompt, characterTags, negatives, summary: tag.promptRaw });
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

export const MAX_NEGATIVE_LEN = 2000;
export const DEFAULT_SETTINGS = {
  position: 'depth', // 'start' | 'end' | 'depth'
  depth: 4,
  role: 'system',
  maxImages: 2,
  commonNegative: '', // 공통 네거티브: added to every picture's negative prompt (0.2.0)
  boundNegatives: true, // let the host append the card/persona-bound negative (see buildFinalPrompt)
  autoSaveGallery: false,
};

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!['start', 'end', 'depth'].includes(s.position)) s.position = DEFAULT_SETTINGS.position;
  if (!['system', 'user', 'assistant'].includes(s.role)) s.role = DEFAULT_SETTINGS.role;
  s.depth = Number.isInteger(s.depth) && s.depth >= 0 ? s.depth : DEFAULT_SETTINGS.depth;
  s.maxImages = Number.isInteger(s.maxImages) && s.maxImages >= 1 && s.maxImages <= 2 ? s.maxImages : DEFAULT_SETTINGS.maxImages;
  s.commonNegative = typeof s.commonNegative === 'string' ? s.commonNegative.replace(/\s+/g, ' ').trim().slice(0, MAX_NEGATIVE_LEN) : '';
  s.boundNegatives = s.boundNegatives !== false;
  s.autoSaveGallery = s.autoSaveGallery === true;
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
    '그 장면에서만 옷이 저장된 옷과 다르면 동작 뒤에 | 옷: 옷·장신구 를 덧붙여라(예: chars="이름1: 동작1 | 옷: black suit, red tie"). 안 쓰면 저장된 옷이 쓰인다. ' +
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

/**
 * Registry record shape (0.2.0):
 *   { id, names[], body, outfit, negative, enabled, legacyAppearance?, needsReview?, reviewTags? }
 * Records saved by 0.1.x have a single combined `appearance` string and none of
 * `body`/`outfit`: those are split ONCE here (idempotent — a record that already has a
 * `body` or `outfit` key is never re-split). Nothing is lost: every original tag lands in
 * `body` or `outfit`, and the untouched original string is kept as `legacyAppearance`
 * (the panel can restore it). Ambiguous tags go to `body`, are listed in `reviewTags`
 * and set `needsReview` until the user confirms the character in the panel.
 */
export function normalizeRegistry(raw) {
  const list = raw && Array.isArray(raw.characters) ? raw.characters : [];
  const out = list.map((c, i) => {
    const names = Array.isArray(c?.names) ? c.names.filter((n) => typeof n === 'string' && n.trim()) : [];
    const rec = {
      id: typeof c?.id === 'string' && c.id ? c.id : '',
      names,
      body: '', outfit: '',
      negative: typeof c?.negative === 'string' ? c.negative.replace(/\s+/g, ' ').trim().slice(0, MAX_NEGATIVE_LEN) : '',
      enabled: c?.enabled !== false,
    };
    const hasSplit = typeof c?.body === 'string' || typeof c?.outfit === 'string';
    if (hasSplit) {
      rec.body = typeof c.body === 'string' ? c.body : '';
      rec.outfit = typeof c.outfit === 'string' ? c.outfit : '';
      if (typeof c.legacyAppearance === 'string' && c.legacyAppearance.trim()) rec.legacyAppearance = c.legacyAppearance;
      const tags = Array.isArray(c.reviewTags) ? c.reviewTags.filter((t) => typeof t === 'string' && t.trim()) : [];
      if (c.needsReview === true) { rec.needsReview = true; rec.reviewTags = tags; }
    } else if (typeof c?.appearance === 'string' && c.appearance.trim()) {
      const sp = splitAppearance(c.appearance);
      rec.body = joinTagList(sp.body);
      rec.outfit = joinTagList(sp.outfit);
      rec.legacyAppearance = c.appearance;
      if (sp.review.length) { rec.needsReview = true; rec.reviewTags = sp.review; }
    }
    return rec;
  }).filter((c) => c.names.length > 0);
  // ids: keep stored ones, give the rest the first free "cN" (a deleted row's number is
  // never handed to a new character that way)
  const used = new Set(out.map((c) => c.id).filter(Boolean));
  let n = 0;
  for (const c of out) {
    if (c.id) continue;
    while (used.has('c' + n)) n++;
    c.id = 'c' + n; used.add(c.id);
  }
  return out;
}

// ---------------------------------------------------------------- prompt preview (0.2.0)

/** Pure, I/O-free version of what a `<pic chars=".." prompt="..">` tag turns into: the
 *  scene prompt, the NAI per-character tag slots and the composed negative. Used by the
 *  panel's prompt preview — it never generates anything. */
export function composeScene({ chars = '', scene = '', registry = [], mainPreset = null, settings = {} } = {}) {
  const { characterTags, extraFragments, negatives } = buildCharacterTags(splitChars(chars), registry);
  const { prompt, negativePrompt } = buildFinalPrompt(assemblePrompt(scene, extraFragments), mainPreset, {
    commonNegative: settings.commonNegative,
    characterNegatives: negatives,
    boundNegatives: settings.boundNegatives !== false,
  });
  return { prompt, negativePrompt: negativePrompt || '', characterTags, extraFragments };
}
