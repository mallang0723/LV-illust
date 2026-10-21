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
  injectInstruction, markerRegexForId, buildFinalPrompt, IDENTIFIER,
} from './core.mjs';

const SETTINGS_PATH = 'settings.json';
const AUTO_VAR_KEY = 'lv_illust.auto';
const ORPHAN_VAR_KEY = 'lv_illust.orphans';
const MAX_ORPHANS = 20;

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
 *
 * Review (3rd pass) finding 2: the above only restored the LoRA/style preset. The
 * user's active native MAIN prompt preset is still not applied by `generateNative()`
 * itself — `resolvePromptInput` (`image-gen.service.ts:1333`) resolves
 * `opts?.prompt ?? preset?.prompt ?? ...`, so our inline `prompt` (never null/undefined)
 * always wins and the preset's own prompt text is silently dropped entirely, not
 * composed. `skipParse:true` also skips `expandCharacterPromptMacro` (`:1336-1344`), so
 * even if we did forward the preset text as-is, any `{{character_prompt}}` /
 * `{{persona_prompt}}` tokens in it would reach the provider as literal text. Fixed:
 * `fetchMainPreset()` reads the user's active main preset via
 * `spindle.imageGen.getPromptPresets()` (gated by the same `image_gen` permission,
 * `worker-host-image-gen-api.ts:340-349` → `image-gen.service.ts:343-349`
 * `getMainImagePromptPresets`, filtered to `kind:'main'`/legacy-no-kind presets only);
 * `core.mjs`'s `buildFinalPrompt()` then explicitly composes `preset.prompt + scene
 * prompt` (macro tokens stripped, not expanded — our own registry/characterTags already
 * supply per-character appearance, so splicing in a bound character/persona snippet
 * too would duplicate it) and supplies the preset's own (cleaned) negative prompt only
 * when non-empty, to avoid doubling with the connection's own default negative. See
 * docs/API-NOTES.md for the full citation and composition rationale.
 */
async function fetchMainPreset(api) {
  if (typeof api.imageGen.getPromptPresets !== 'function') return null; // optional on older hosts
  try {
    const result = await api.imageGen.getPromptPresets();
    if (!result?.activeId || !Array.isArray(result.presets)) return null;
    const preset = result.presets.find((p) => p.id === result.activeId);
    return preset ? { prompt: preset.prompt, negativePrompt: preset.negativePrompt } : null;
  } catch {
    return null; // never block generation on this — scene prompt alone, same as before this fix
  }
}

async function generateImage(api, { chatId, prompt, characterTags, mainPreset }) {
  const { prompt: finalPrompt, negativePrompt } = buildFinalPrompt(prompt, mainPreset);
  const result = await queuedCall(() => api.imageGen.generateNative({
    chat_id: chatId,
    prompt: finalPrompt,
    ...(negativePrompt !== undefined ? { negativePrompt } : {}),
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
//
// Review (3rd pass) finding 3: two follow-up problems with the lock map itself.
//
// (a) Settled entries were never removed — `messageLocks.set()` had no matching
// `delete()`, so every distinct (chatId, messageId) ever processed left a permanent
// entry for the life of the worker, including messages with no `<pic>` tags at all
// (the lock is acquired before that check). Fixed: once an operation settles, its entry
// is deleted — but ONLY if it is still that key's current (most recently queued) entry.
// Deleting unconditionally would be wrong: if a second call already queued behind the
// first and installed its OWN entry for the same key, deleting on the first call's
// settlement would erase the SECOND call's tracking, letting a third call bypass the
// queue entirely and run concurrently with the second (reopening finding 3 round 2).
//
// (b) No deadline anywhere in the chain: a predecessor operation that hangs (a stuck
// RPC with no timeout of its own) blocks every later operation queued for that same
// message forever. Fixed: every operation is raced against a fixed deadline
// (`lockTimeoutMs`, default 3 minutes); whichever finishes first is what the NEXT
// queued operation sees as "done". If the deadline wins, this call's own effect is
// simply never awaited further (nothing it was about to write has been written yet in
// the common case, since processMessageInner's one and only write happens after every
// await it needs completes) and the key is freed for the next queued caller. This does
// NOT cancel the underlying operation (no cancellation primitive is plumbed through
// arbitrary host RPCs) — if it eventually completes after its result was already
// discarded, it could still perform its own write uncoordinated with whatever runs
// next; this residual risk is called out in docs/API-NOTES.md rather than silently
// assumed away.
const DEFAULT_LOCK_TIMEOUT_MS = 3 * 60 * 1000;
const messageLocks = new Map();

function raceWithDeadline(fn, key, lockTimeoutMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.error(`[lv_illust] message lock for "${key}" timed out after ${lockTimeoutMs}ms — releasing it for the next queued operation; this operation's own result (if it still completes later) is discarded and the message is left as-is`);
      resolve(undefined);
    }, lockTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref(); // never keep the process alive just for this
  });
  return Promise.race([Promise.resolve().then(fn), deadline]).finally(() => clearTimeout(timer));
}

function withMessageLock(key, fn, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const prev = messageLocks.get(key) || Promise.resolve();
  const run = prev.then(() => raceWithDeadline(fn, key, lockTimeoutMs), () => raceWithDeadline(fn, key, lockTimeoutMs));
  const settleForQueue = run.then(() => undefined, () => undefined);
  messageLocks.set(key, settleForQueue);
  settleForQueue.then(() => {
    if (messageLocks.get(key) === settleForQueue) messageLocks.delete(key);
  });
  return run;
}

/** Test-only accessor (not part of the extension's behavior) — lets tests assert the
 *  lock map doesn't grow without bound. */
export function _debugLockMapSize() {
  return messageLocks.size;
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
async function processMessageLocked(api, { chatId, messageId, registry, settings, idGenerator, lockTimeoutMs }) {
  return withMessageLock(`${chatId}::${messageId}`, () => processMessageInner(api, { chatId, messageId, registry, settings, idGenerator }), lockTimeoutMs);
}

async function processMessageInner(api, { chatId, messageId, registry, settings, idGenerator }) {
  const planList = await api.chat.getMessages(chatId);
  const message = planList.find((m) => m.id === messageId);
  if (!message || message.role !== 'assistant') return { changed: false };
  if (!hasLiveTags(message.content)) return { changed: false };

  const existingIds = existingImageIds([message]);
  const { tags, jobs, skipped, markers } = planMessage(message.content, {
    registry, maxImages: settings.maxImages, existingImageIds: existingIds, idGenerator,
  });
  const resultsById = {};
  const tagIndexToId = new Map();

  for (const s of skipped) {
    tagIndexToId.set(s.tagIndex, s.id);
    resultsById[s.id] = { status: 'skip', prompt: s.prompt, characterTags: s.characterTags, summary: s.summary };
  }

  // Fetched once per message-processing pass (not per tag) — the active main preset
  // can't change mid-pass, and this avoids N redundant RPCs for an N-image reply.
  const mainPreset = jobs.length ? await fetchMainPreset(api) : null;

  for (const job of jobs) {
    tagIndexToId.set(job.tagIndex, job.id);
    try {
      const result = await generateImage(api, { chatId, prompt: job.prompt, characterTags: job.characterTags, mainPreset });
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
  let placedMalformedCount = 0;
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
      placedMalformedCount++;
      return;
    }
    content = content.slice(0, at) + entry.text + content.slice(at + tag.raw.length);
    cursor = at + entry.text.length;
    const id = tagIndexToId.get(i);
    if (id && resultsById[id]) placedImages[id] = resultsById[id];
  });

  const noContentChange = content === fresh.content;
  const noNewImages = Object.keys(placedImages).length === 0;
  const noNewMalformed = placedMalformedCount === 0;
  if (noContentChange && noNewImages && noNewMalformed) {
    // nothing could be placed at all (everything orphaned/already-annotated) — don't
    // write an otherwise-identical copy of content/metadata back over what's there now.
    if (orphanedNow.length) await pushOrphans(api, chatId, orphanedNow);
    return { changed: false, orphaned: orphanedNow.length };
  }

  const currentImages = fresh.metadata?.[IDENTIFIER]?.images || {};
  await api.chat.updateMessage(chatId, messageId, {
    content,
    metadata: mergeMetadata(fresh.metadata, { images: { ...currentImages, ...placedImages } }),
  });
  // Orphan bookkeeping strictly AFTER the message commit (review finding 2) — never
  // between the revalidating read and the write.
  if (orphanedNow.length) await pushOrphans(api, chatId, orphanedNow);
  return { changed: true, content, orphaned: orphanedNow.length };
}

// `idGenerator` is a test-only hook (never passed in production — see start() below):
// core.mjs's nextImageId is collision-resistant (time+random) by default; tests inject
// a deterministic counter so assertions on exact ids stay readable and stable.
export function createService(api, { idGenerator, lockTimeoutMs } = {}) {
  async function handleGenerationEnded(payload) {
    if (!payload?.chatId || !payload?.messageId) return;
    const settings = await readSettings(api);
    if (!(await isAutoOn(api, payload.chatId, true))) return;
    const characterId = await characterIdForChat(api, payload.chatId);
    const registry = await loadRegistry(api, characterId);
    await processMessageLocked(api, { chatId: payload.chatId, messageId: payload.messageId, registry, settings, idGenerator, lockTimeoutMs });
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
    await processMessageLocked(api, { chatId, messageId, registry, settings, idGenerator, lockTimeoutMs });
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
        return withMessageLock(`${payload.chatId}::${payload.messageId}`, () => regenerateLocked(api, payload), lockTimeoutMs);
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
    const mainPreset = await fetchMainPreset(api);
    result = await generateImage(api, { chatId: payload.chatId, prompt: rec.prompt, characterTags: rec.characterTags, mainPreset });
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
