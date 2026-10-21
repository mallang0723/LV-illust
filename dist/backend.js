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

// 삽화가 (개인용) / LV-Illust backend worker.
//
// Owns every host-side effect: reading/writing the per-character registry
// (spindle.characters, permission "characters"), the per-user settings and
// per-chat auto-gen flag (spindle.storage / spindle.variables.chat — free tier),
// the F1 instruction interceptor (permission "interceptor"), image generation
// (spindle.imageGen, permission "image_gen") and writing results back into the
// chat (spindle.chat.*, permission "chat_mutation").
//
// All parsing / matching / prompt assembly / marker text lives in core.mjs —
// this file only sequences async calls around it.


const SETTINGS_PATH = 'settings.json';
const AUTO_VAR_KEY = 'lv_illust.auto';

function extToRegistry(character) {
  return normalizeRegistry(character?.extensions?.[IDENTIFIER]);
}

async function readSettings(api) {
  try {
    const raw = await api.storage.getJson(SETTINGS_PATH, { fallback: null });
    return normalizeSettings(raw);
  } catch {
    return normalizeSettings(undefined);
  }
}

async function writeSettings(api, settings) {
  await api.storage.setJson(SETTINGS_PATH, normalizeSettings(settings));
}

async function isAutoOn(api, chatId, defaultOn) {
  try {
    const has = await api.variables.chat.has(chatId, AUTO_VAR_KEY);
    if (!has) return defaultOn;
    const v = await api.variables.chat.get(chatId, AUTO_VAR_KEY);
    return v !== '0';
  } catch {
    return defaultOn;
  }
}

async function setAutoOn(api, chatId, on) {
  await api.variables.chat.set(chatId, AUTO_VAR_KEY, on ? '1' : '0');
}

async function loadRegistry(api, characterId) {
  if (!characterId) return [];
  const ch = await api.characters.get(characterId);
  return extToRegistry(ch);
}

/** Resolve the character card that owns a chat (permission: "chats"). Needed because
 *  neither GenerationEndedPayloadDTO nor ChatMessageDTO carries a character id — only
 *  ChatDTO.character_id does. */
async function characterIdForChat(api, chatId) {
  try {
    const chat = await api.chats.get(chatId);
    return chat?.character_id || undefined;
  } catch {
    return undefined;
  }
}

async function saveRegistry(api, characterId, registry) {
  await api.characters.update(characterId, { extensions: { [IDENTIFIER]: { characters: registry } } });
}

function existingImageIds(messages) {
  // Scan rendered-image ids already present (from content AND from metadata — a swipe's
  // *other* slot content isn't scanned, but its metadata.images keys still are, so a new
  // id never collides with and overwrites a different swipe's stored record) so new ids
  // never collide across the chat.
  const ids = [];
  const re = /!\[그림:([a-z0-9]+)\|/g;
  for (const m of messages || []) {
    let mm;
    re.lastIndex = 0;
    while ((mm = re.exec(m?.content || ''))) ids.push(mm[1]);
    const metaIds = m?.metadata?.[IDENTIFIER]?.images;
    if (metaIds) ids.push(...Object.keys(metaIds));
  }
  return ids;
}

// Serializes every spindle.imageGen.generate() call behind one promise chain, across
// concurrent GENERATION_ENDED/MESSAGE_EDITED handlers and panel regenerate requests
// alike — SharedNAI only has one generation slot (design §4 "동시 생성 1개").
let generateQueue = Promise.resolve();
function queuedGenerate(api, input) {
  const run = () => api.imageGen.generate(input);
  const result = generateQueue.then(run, run);
  generateQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Merge our namespaced key into a message's existing metadata bag without clobbering
 *  other extensions' keys (spindle_metadata is a single shared bag — see docs/API-NOTES.md). */
function mergeMetadata(existingMetadata, images) {
  return { ...(existingMetadata || {}), [IDENTIFIER]: { images } };
}

/**
 * Process one assistant message's `<pic>` tags: generate images for up to
 * `settings.maxImages` valid tags (concurrency 1 — SharedNAI limit), splice markers
 * into the message content, and persist results in message metadata.
 */
async function processMessage(api, { chatId, message, registry, settings }) {
  if (!hasLiveTags(message.content)) return { changed: false };
  const existingIds = existingImageIds([message]);
  const { tags, jobs, skipped, markers } = planMessage(message.content, {
    registry, maxImages: settings.maxImages, existingImageIds: existingIds,
  });
  const imageRecords = { ...(message.metadata?.[IDENTIFIER]?.images || {}) };

  // skipped (over the per-reply cap) still get a metadata record so the regenerate
  // panel can offer "다시 그리기" for them too, generating on demand.
  for (const s of skipped) {
    imageRecords[s.id] = { status: 'skip', prompt: s.prompt, characterTags: s.characterTags, summary: s.summary };
  }

  for (const job of jobs) {
    try {
      const result = await queuedGenerate(api, {
        prompt: job.prompt,
        parameters: { characterTags: job.characterTags },
        owner_chat_id: chatId,
        includeDataUrl: false,
      });
      markers.set(job.tagIndex, renderSuccessMarker(job.id, result.imageUrl, job.summary));
      imageRecords[job.id] = {
        status: 'ok', prompt: job.prompt, characterTags: job.characterTags,
        imageId: result.imageId, imageUrl: result.imageUrl, summary: job.summary,
      };
    } catch (err) {
      const reason = String(err?.message || err || '오류').slice(0, 80);
      markers.set(job.tagIndex, renderFailureMarker(job.id, tags[job.tagIndex], reason));
      imageRecords[job.id] = {
        status: 'fail', prompt: job.prompt, characterTags: job.characterTags,
        reason, summary: job.summary,
      };
    }
  }

  const newContent = applyMarkers(message.content, tags, markers);
  await api.chat.updateMessage(chatId, message.id, {
    content: newContent,
    metadata: mergeMetadata(message.metadata, imageRecords),
  });
  return { changed: true, content: newContent };
}

export function createService(api) {
  async function handleGenerationEnded(payload) {
    if (!payload?.chatId || !payload?.messageId) return;
    const settings = await readSettings(api);
    if (!(await isAutoOn(api, payload.chatId, true))) return;
    const messages = await api.chat.getMessages(payload.chatId);
    const message = messages.find((m) => m.id === payload.messageId);
    if (!message || message.role !== 'assistant') return;
    const characterId = await characterIdForChat(api, payload.chatId);
    const registry = await loadRegistry(api, characterId);
    await processMessage(api, { chatId: payload.chatId, message, registry, settings });
  }

  async function handleMessageEdited(payload) {
    // MESSAGE_EDITED's payload shape is UNVERIFIED (see docs/API-NOTES.md) — only
    // `chatId` and `message.id` are trusted from it. Everything else (content,
    // metadata, is_user) is re-read through the normalized `getMessages` shape, so a
    // wrong guess about the raw payload's fields can't silently clobber another
    // extension's metadata or act on stale content.
    const chatId = payload?.chatId;
    const messageId = payload?.message?.id;
    if (!chatId || !messageId) return;
    const messages = await api.chat.getMessages(chatId);
    const message = messages.find((m) => m.id === messageId);
    if (!message || message.role !== 'assistant') return;
    const settings = await readSettings(api);
    if (!(await isAutoOn(api, chatId, true))) return;
    const characterId = await characterIdForChat(api, chatId);
    const registry = await loadRegistry(api, characterId);
    await processMessage(api, { chatId, message, registry, settings });
  }

  function registerInterceptor() {
    return api.registerInterceptor(async (messages, context) => {
      const settings = await readSettings(api);
      let registry = [];
      try { registry = await loadRegistry(api, context.characterId); } catch { /* best-effort */ }
      const auto = await isAutoOn(api, context.chatId, true);
      if (!auto) return messages;
      const withInstruction = injectInstruction(messages, settings, registry);
      // content can be a string OR LlmMessagePartDTO[] (multimodal turns) — only rewrite
      // string content; stripRenderedImages(array) would stringify to "[object Object]".
      return withInstruction.map((m) => (
        typeof m.content === 'string' ? { ...m, content: stripRenderedImages(m.content) } : m
      ));
    });
  }

  async function runFrontendRequest(payload) {
    switch (payload.type) {
      case 'load_settings':
        return { settings: await readSettings(api) };
      case 'save_settings':
        await writeSettings(api, payload.settings);
        return { settings: await readSettings(api) };
      case 'load_registry':
        return { registry: await loadRegistry(api, payload.characterId) };
      case 'save_registry':
        await saveRegistry(api, payload.characterId, normalizeRegistry({ characters: payload.registry }));
        return { registry: await loadRegistry(api, payload.characterId) };
      case 'list_images': {
        const messages = await api.chat.getMessages(payload.chatId);
        const out = [];
        for (const m of messages || []) {
          const images = m.metadata?.[IDENTIFIER]?.images;
          if (!images) continue;
          for (const [id, rec] of Object.entries(images)) {
            out.push({ id, messageId: m.id, status: rec.status, summary: rec.summary, imageUrl: rec.imageUrl });
          }
        }
        return { images: out };
      }
      case 'load_auto':
        return { auto: await isAutoOn(api, payload.chatId, true) };
      case 'set_auto':
        await setAutoOn(api, payload.chatId, !!payload.on);
        return { auto: await isAutoOn(api, payload.chatId, true) };
      case 'regenerate': {
        const messages = await api.chat.getMessages(payload.chatId);
        const message = messages.find((m) => m.id === payload.messageId);
        if (!message) throw new Error('메시지를 찾을 수 없습니다');
        const rec = message.metadata?.[IDENTIFIER]?.images?.[payload.imageId];
        if (!rec) throw new Error('다시 그릴 정보를 찾을 수 없습니다');
        try {
          const result = await queuedGenerate(api, {
            prompt: rec.prompt, parameters: { characterTags: rec.characterTags },
            owner_chat_id: payload.chatId, includeDataUrl: false,
          });
          const marker = renderSuccessMarker(payload.imageId, result.imageUrl, rec.summary);
          const idRe = payload.imageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const newContent = message.content.replace(
            new RegExp(
              `!\\[그림:${idRe}\\|[^\\]]*\\]\\([^)]*\\)` + // previously rendered image
              `|\\[[^[\\]]*<pic-(?:failed|skipped) id="${idRe}"[^>]*>\\]`, // failed/skipped marker for this id
            ),
            marker,
          );
          const images = { ...(message.metadata?.[IDENTIFIER]?.images || {}) };
          images[payload.imageId] = { ...rec, status: 'ok', imageId: result.imageId, imageUrl: result.imageUrl };
          await api.chat.updateMessage(payload.chatId, message.id, {
            content: newContent, metadata: mergeMetadata(message.metadata, images),
          });
          return { ok: true };
        } catch (err) {
          throw new Error('다시 그리기 실패: ' + String(err?.message || err));
        }
      }
      default:
        throw new Error('알 수 없는 요청');
    }
  }

  return { handleGenerationEnded, handleMessageEdited, registerInterceptor, runFrontendRequest };
}

export function start(api) {
  const service = createService(api);
  const offs = [];
  offs.push(api.on('GENERATION_ENDED', (payload) => { service.handleGenerationEnded(payload).catch((e) => console.error('[lv_illust]', e)); }));
  offs.push(api.on('MESSAGE_EDITED', (payload) => { service.handleMessageEdited(payload).catch((e) => console.error('[lv_illust]', e)); }));
  offs.push(service.registerInterceptor());
  offs.push(api.onFrontendMessage(async (payload, userId, frontendSessionId) => {
    if (!payload || typeof payload.requestId !== 'string') return;
    let reply;
    try { reply = { ok: true, ...(await service.runFrontendRequest(payload)) }; }
    catch (e) { reply = { ok: false, error: String(e?.message || e) }; }
    api.sendToFrontend({ ...reply, requestId: payload.requestId, type: payload.type }, userId, frontendSessionId ? { frontendSessionId } : undefined);
  }));
  return () => { for (const off of offs) { try { off(); } catch { /* ignore */ } } };
}

if (typeof spindle !== 'undefined') start(spindle);
