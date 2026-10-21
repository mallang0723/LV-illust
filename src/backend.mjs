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

import {
  normalizeSettings, normalizeRegistry, planMessage,
  renderSuccessMarker, renderFailureMarker, stripRenderedImages, hasLiveTags,
  injectInstruction, markerRegexForId, IDENTIFIER,
} from './core.mjs';

const SETTINGS_PATH = 'settings.json';
const AUTO_VAR_KEY = 'lv_illust.auto';
const ORPHAN_VAR_KEY = 'lv_illust.orphans';
const MAX_ORPHANS = 20;
const MAX_SEEN_MALFORMED = 50;

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

// Serializes every spindle.imageGen.generateNative() call behind one promise chain,
// across concurrent GENERATION_ENDED/MESSAGE_EDITED handlers and panel regenerate
// requests alike — SharedNAI only has one generation slot (design §4 "동시 생성 1개").
let generateQueue = Promise.resolve();
function queuedCall(fn) {
  const result = generateQueue.then(fn, fn);
  generateQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Review (2nd pass) finding 5: `spindle.imageGen.generate()` only merges the
 * connection's own default parameters — it never touches Lumiverse's native main/style
 * (LoRA) preset or any card-level preset, so a user's chosen style preset is silently
 * skipped (contrary to DESIGN.md §0's "메인·그림체 프롬프트 ... 루미버스 기본 기능을
 * 쓴다" — this extension stores no style prompt of its own and expects Lumiverse's own
 * preset to apply). `spindle.imageGen.generateNative()` with `promptMode: 'custom'`
 * (== `skipParse: true`) instead routes through `generateSceneBackground()`
 * (`image-gen.service.ts:373`), which:
 *   - ALWAYS composes the active native LoRA/style preset's `base_tags` onto the
 *     prompt via `composeWithBaseTags` (`image-gen.service.ts:501-505`), and applies
 *     its LoRA layers (`:477-500`) — regardless of promptMode/skipParse. This is the
 *     "그림체 프리셋" the design calls for.
 *   - Under `promptMode:'custom'`, `resolveImagePrompt` (`:1488,1498`) returns
 *     `{prompt: input.prompt, negativePrompt: input.negativePrompt}` with NO `scene`
 *     key at all (no scene-analysis LLM call) — so the NAI-specific block that
 *     otherwise OVERWRITES `params.characterTags` from scene analysis
 *     (`:526-534`, guarded by `if (charTags.length > 0)`) never fires, because
 *     `Array.isArray(undefined?.character_appearances)` is false. Our own
 *     `parameters.characterTags`, merged in earlier via
 *     `{...connection.default_parameters, ...opts.parameters}` (`:424-426`), survives
 *     completely untouched. Confirmed by direct read of image-gen.service.ts (copy at
 *     .review/host/image-gen.service.ts); see docs/API-NOTES.md for the full citation
 *     and the chosen-path rationale.
 * Still only requires the `image_gen` permission (`worker-host-image-gen-api.ts:107-110`,
 * same gate as `generate()` — `requirePermission()` checks only `"image_gen"`).
 */
async function generateImage(api, { chatId, prompt, characterTags }) {
  const result = await queuedCall(() => api.imageGen.generateNative({
    chat_id: chatId,
    prompt,
    promptMode: 'custom',
    skipParse: true,
    parameters: { characterTags },
    includeDataUrl: false,
  }));
  // Review finding 4: the host can resolve `generate()`/`generateNative()`
  // successfully while persistence silently failed internally
  // (worker-host-image-gen-api.ts:180-206 catches that and still resolves); `imageId`/
  // `imageUrl` are optional on the DTO (api.d.ts:818-825). Treat a result with no
  // usable URL as a failure — never write `![그림:id|...](undefined)` into the message.
  if (!result || typeof result.imageUrl !== 'string' || !result.imageUrl) {
    throw new Error('이미지 URL을 받지 못함(생성 결과에 사용 가능한 그림 없음)');
  }
  return result;
}

/** Merge our namespaced key into a message's existing metadata bag without clobbering
 *  other extensions' keys (spindle_metadata is a single shared bag — see docs/API-NOTES.md). */
function mergeMetadata(existingMetadata, lvIllustData) {
  return { ...(existingMetadata || {}), [IDENTIFIER]: lvIllustData };
}

// Review finding 1 (round 1): a generated-but-homeless image (its message was
// edited/swiped/deleted out from under it while generation was in flight, so there's
// no live tag occurrence left to splice the result into) is never silently discarded —
// it's kept here, per chat, so the panel's image list can still show it to the user
// instead of it just vanishing. Free-tier chat variable storage, same tier as the
// auto-gen flag.
async function loadOrphans(api, chatId) {
  try {
    const has = await api.variables.chat.has(chatId, ORPHAN_VAR_KEY);
    if (!has) return [];
    const raw = await api.variables.chat.get(chatId, ORPHAN_VAR_KEY);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function pushOrphans(api, chatId, entries) {
  if (!entries.length) return;
  const existing = await loadOrphans(api, chatId);
  const next = [...existing, ...entries].slice(-MAX_ORPHANS);
  await api.variables.chat.set(chatId, ORPHAN_VAR_KEY, JSON.stringify(next));
}

// Review (2nd pass) finding 3: GENERATION_ENDED and MESSAGE_EDITED can fire close
// together for the SAME message (e.g. a generation finishes right as the user edits in
// a second tag). Each used to plan independently from its own snapshot — both could
// allocate "p1", and whichever committed second silently overwrote the first's
// metadata record. This serializes the ENTIRE plan -> generate -> commit sequence per
// (chatId, messageId); the planning step inside the lock always re-reads the live
// message, so a second invocation queued behind the first sees everything the first
// one already committed before it plans anything. (core.mjs's `nextImageId` is also
// collision-resistant by default now, as defense in depth for the case this in-memory
// lock can't cover — a worker restart mid-generation.)
const messageLocks = new Map();
function withMessageLock(key, fn) {
  const prev = messageLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  messageLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * Process one assistant message's `<pic>` tags: generate images for up to
 * `settings.maxImages` valid tags (concurrency 1 — SharedNAI limit), then splice
 * markers into the message and persist results in message metadata. Malformed tags
 * are never replaced — only ever annotated in place (see core.mjs planMessage).
 *
 * Serialized per (chatId, messageId) — see withMessageLock — and, within that lock,
 * plans from a FRESH read (never a snapshot the caller might have read earlier).
 *
 * Review finding 1 (round 1): after generation, the live message is re-fetched again
 * right before committing (a lock only keeps OUR OWN handlers from overlapping; the
 * user can still edit/swipe the message via the host during the multi-second
 * generation wait) — content is located by each tag's own verbatim raw text in that
 * CURRENT content, and nothing is written at all if the active swipe changed.
 *
 * Review finding 2 (round 2): the commit (`chat.updateMessage`) now happens BEFORE
 * `pushOrphans()`, not after — pushOrphans does its own read-modify-write RPC pair
 * (`variables.chat.get`/`set`), and awaiting that *between* the revalidating read and
 * the main commit reopened exactly the race finding 1 had just closed (an edit landing
 * in that window would be overwritten by the commit that follows). Orphan bookkeeping
 * is best-effort and now strictly follows the message commit, never precedes it.
 */
async function processMessageLocked(api, { chatId, messageId, registry, settings, idGenerator }) {
  return withMessageLock(`${chatId}::${messageId}`, () => processMessageInner(api, { chatId, messageId, registry, settings, idGenerator }));
}

async function processMessageInner(api, { chatId, messageId, registry, settings, idGenerator }) {
  const planList = await api.chat.getMessages(chatId);
  const message = planList.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') return { changed: false };
  if (!hasLiveTags(message.content)) return { changed: false };

  const existingIds = existingImageIds([message]);
  const seenMalformed = new Set(message.metadata?.[IDENTIFIER]?.malformedSeen || []);
  const { tags, jobs, skipped, markers } = planMessage(message.content, {
    registry, maxImages: settings.maxImages, existingImageIds: existingIds, seenMalformed, idGenerator,
  });
  const resultsById = {};
  const tagIndexToId = new Map();

  for (const s of skipped) {
    tagIndexToId.set(s.tagIndex, s.id);
    resultsById[s.id] = { status: 'skip', prompt: s.prompt, characterTags: s.characterTags, summary: s.summary };
  }

  for (const job of jobs) {
    tagIndexToId.set(job.tagIndex, job.id);
    try {
      const result = await generateImage(api, { chatId, prompt: job.prompt, characterTags: job.characterTags });
      markers.set(job.tagIndex, { mode: 'replace', text: renderSuccessMarker(job.id, result.imageUrl, job.summary) });
      resultsById[job.id] = {
        status: 'ok', prompt: job.prompt, characterTags: job.characterTags,
        imageId: result.imageId, imageUrl: result.imageUrl, summary: job.summary,
      };
    } catch (err) {
      const reason = String(err?.message || err || '오류').slice(0, 80);
      markers.set(job.tagIndex, { mode: 'replace', text: renderFailureMarker(job.id, tags[job.tagIndex], reason) });
      resultsById[job.id] = {
        status: 'fail', prompt: job.prompt, characterTags: job.characterTags,
        reason, summary: job.summary,
      };
    }
  }

  // --- everything above only decided *what* to do; everything below re-checks the
  // live message right before writing anything, and commits before any further RPCs. ---
  const freshList = await api.chat.getMessages(chatId);
  const fresh = freshList.find((m) => m.id === messageId);
  const swipeChanged = !fresh || (fresh.swipe_id ?? 0) !== (message.swipe_id ?? 0);
  if (swipeChanged) {
    const orphans = Object.entries(resultsById).map(([id, r]) => ({
      id, messageId, ts: Date.now(),
      reason: '메시지가 바뀌어(스와이프 변경/삭제) 넣지 못함', ...r,
    }));
    if (orphans.length) await pushOrphans(api, chatId, orphans);
    return { changed: false, orphaned: orphans.length };
  }

  let content = fresh.content;
  let cursor = 0;
  const placedImages = {};
  const placedMalformed = [];
  const orphanedNow = [];
  tags.forEach((tag, i) => {
    const entry = markers.get(i);
    if (!entry) return;
    let at = content.indexOf(tag.raw, cursor);
    if (at === -1) at = content.indexOf(tag.raw); // retry from the start: order may have shifted
    if (at === -1) {
      // the exact original tag text is gone from the current content (edited away
      // mid-generation) — never guess at a splice location. Only *generated* work
      // (jobs/skips) needs orphaning; a vanished malformed tag just needs nothing done.
      const id = tagIndexToId.get(i);
      if (id && resultsById[id]) {
        orphanedNow.push({ id, messageId, ts: Date.now(), reason: '그림 자리(태그)가 수정되어 넣지 못함', ...resultsById[id] });
      }
      return;
    }
    if (entry.mode === 'insert') {
      const insertAt = at + tag.raw.length;
      content = content.slice(0, insertAt) + entry.text + content.slice(insertAt);
      cursor = insertAt + entry.text.length;
      placedMalformed.push(tag.raw);
      return;
    }
    content = content.slice(0, at) + entry.text + content.slice(at + tag.raw.length);
    cursor = at + entry.text.length;
    const id = tagIndexToId.get(i);
    if (id && resultsById[id]) placedImages[id] = resultsById[id];
  });

  const noContentChange = content === fresh.content;
  const noNewImages = Object.keys(placedImages).length === 0;
  const noNewMalformed = placedMalformed.length === 0;
  if (noContentChange && noNewImages && noNewMalformed) {
    // nothing could be placed at all (everything orphaned/already-seen) — don't write
    // an otherwise-identical copy of content/metadata back over whatever is there now.
    if (orphanedNow.length) await pushOrphans(api, chatId, orphanedNow);
    return { changed: false, orphaned: orphanedNow.length };
  }

  const currentImages = fresh.metadata?.[IDENTIFIER]?.images || {};
  const currentSeenMalformed = fresh.metadata?.[IDENTIFIER]?.malformedSeen || [];
  await api.chat.updateMessage(chatId, messageId, {
    content,
    metadata: mergeMetadata(fresh.metadata, {
      images: { ...currentImages, ...placedImages },
      malformedSeen: [...currentSeenMalformed, ...placedMalformed].slice(-MAX_SEEN_MALFORMED),
    }),
  });
  // Orphan bookkeeping strictly AFTER the message commit (review finding 2) — never
  // between the revalidating read and the write.
  if (orphanedNow.length) await pushOrphans(api, chatId, orphanedNow);
  return { changed: true, content, orphaned: orphanedNow.length };
}

// `idGenerator` is a test-only hook (never passed in production — see start() below):
// core.mjs's nextImageId is collision-resistant (time+random) by default; tests inject
// a deterministic counter so assertions on exact ids stay readable and stable.
export function createService(api, { idGenerator } = {}) {
  async function handleGenerationEnded(payload) {
    if (!payload?.chatId || !payload?.messageId) return;
    const settings = await readSettings(api);
    if (!(await isAutoOn(api, payload.chatId, true))) return;
    const characterId = await characterIdForChat(api, payload.chatId);
    const registry = await loadRegistry(api, characterId);
    await processMessageLocked(api, { chatId: payload.chatId, messageId: payload.messageId, registry, settings, idGenerator });
  }

  async function handleMessageEdited(payload) {
    // MESSAGE_EDITED's payload shape is UNVERIFIED (see docs/API-NOTES.md) — only
    // `chatId` and `message.id` are trusted from it. Everything else (content,
    // metadata, is_user, role) is re-read through the normalized `getMessages` shape
    // inside processMessageInner, so a wrong guess about the raw payload's fields
    // can't silently clobber another extension's metadata or act on stale content.
    const chatId = payload?.chatId;
    const messageId = payload?.message?.id;
    if (!chatId || !messageId) return;
    const settings = await readSettings(api);
    if (!(await isAutoOn(api, chatId, true))) return;
    const characterId = await characterIdForChat(api, chatId);
    const registry = await loadRegistry(api, characterId);
    await processMessageLocked(api, { chatId, messageId, registry, settings, idGenerator });
  }

  function registerInterceptor() {
    return api.registerInterceptor(async (messages, context) => {
      // Review (2nd pass) finding 7: history cleanup (stripping rendered image
      // markup back down to a short placeholder) must run regardless of the per-chat
      // auto-generation flag — only F1's instruction injection is conditional on it.
      // Turning auto-gen off used to also stop cleanup, so a `<img>`-bearing message
      // kept getting fed back to the model verbatim once auto-gen was off.
      const cleaned = messages.map((m) => (
        typeof m.content === 'string' ? { ...m, content: stripRenderedImages(m.content) } : m
      ));
      const auto = await isAutoOn(api, context.chatId, true);
      if (!auto) return cleaned;
      const settings = await readSettings(api);
      let registry = [];
      try { registry = await loadRegistry(api, context.characterId); } catch { /* best-effort */ }
      return injectInstruction(cleaned, settings, registry);
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
        // Orphaned generations (review finding 1: produced but couldn't be spliced back
        // into any live message because it changed underneath them) — shown read-only
        // (review finding 6: never with a regenerate button — see frontend.mjs) so
        // nothing a generation actually produced is silently lost.
        const orphans = await loadOrphans(api, payload.chatId);
        for (const o of orphans) {
          out.push({ id: o.id, messageId: o.messageId, status: 'orphan', summary: o.summary, imageUrl: o.imageUrl, reason: o.reason });
        }
        return { images: out };
      }
      case 'load_auto':
        return { auto: await isAutoOn(api, payload.chatId, true) };
      case 'set_auto':
        await setAutoOn(api, payload.chatId, !!payload.on);
        return { auto: await isAutoOn(api, payload.chatId, true) };
      case 'regenerate': {
        if (!payload?.chatId || !payload?.messageId || !payload?.imageId) throw new Error('잘못된 요청');
        return withMessageLock(`${payload.chatId}::${payload.messageId}`, () => regenerateLocked(api, payload));
      }
      default:
        throw new Error('알 수 없는 요청');
    }
  }

  return { handleGenerationEnded, handleMessageEdited, registerInterceptor, runFrontendRequest };
}

// Serialized under the same per-message lock as processMessage — a panel regenerate
// and a fresh generation for the same message can no longer interleave their
// plan/commit either.
async function regenerateLocked(api, payload) {
  const messages = await api.chat.getMessages(payload.chatId);
  const message = messages.find((m) => m.id === payload.messageId);
  if (!message) throw new Error('메시지를 찾을 수 없습니다');
  const rec = message.metadata?.[IDENTIFIER]?.images?.[payload.imageId];
  if (!rec) throw new Error('다시 그릴 정보를 찾을 수 없습니다');
  const originalSwipeId = message.swipe_id ?? 0;

  let result;
  try {
    // Review finding 4: validate before touching anything — on failure (including an
    // unusable result), the existing marker/metadata for this image is left completely
    // untouched, so a working image is never replaced by a broken one.
    result = await generateImage(api, { chatId: payload.chatId, prompt: rec.prompt, characterTags: rec.characterTags });
  } catch (err) {
    throw new Error('다시 그리기 실패: ' + String(err?.message || err));
  }

  const freshList = await api.chat.getMessages(payload.chatId);
  const fresh = freshList.find((m) => m.id === payload.messageId);
  const updated = { ...rec, status: 'ok', imageId: result.imageId, imageUrl: result.imageUrl };
  if (!fresh || (fresh.swipe_id ?? 0) !== originalSwipeId) {
    await pushOrphans(api, payload.chatId, [{
      id: payload.imageId, messageId: payload.messageId, ts: Date.now(),
      reason: '메시지가 바뀌어(스와이프 변경/삭제) 넣지 못함', ...updated,
    }]);
    throw new Error('다시 그리는 동안 메시지가 바뀌어 반영하지 못했습니다. 그림은 보관되어 목록에서 볼 수 있습니다.');
  }
  const marker = renderSuccessMarker(payload.imageId, result.imageUrl, rec.summary);
  const re = markerRegexForId(payload.imageId);
  if (!re.test(fresh.content)) {
    await pushOrphans(api, payload.chatId, [{
      id: payload.imageId, messageId: payload.messageId, ts: Date.now(),
      reason: '그림 자리(태그)가 수정되어 넣지 못함', ...updated,
    }]);
    throw new Error('그림 자리를 찾지 못해 반영하지 못했습니다. 그림은 보관되어 목록에서 볼 수 있습니다.');
  }
  const newContent = fresh.content.replace(re, marker);
  const currentImages = { ...(fresh.metadata?.[IDENTIFIER]?.images || {}) };
  currentImages[payload.imageId] = updated;
  await api.chat.updateMessage(payload.chatId, message.id, {
    content: newContent,
    metadata: mergeMetadata(fresh.metadata, { ...(fresh.metadata?.[IDENTIFIER] || {}), images: currentImages }),
  });
  return { ok: true };
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
