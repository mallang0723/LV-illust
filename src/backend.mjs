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
  injectInstruction, markerRegexForId, buildFinalPrompt, composeScene, IDENTIFIER,
} from './core.mjs';

const SETTINGS_PATH = 'settings.json';
const AUTO_VAR_KEY = 'lv_illust.auto';
const ORPHAN_VAR_KEY = 'lv_illust.orphans';
const MAX_ORPHANS = 20;

// Only the logged-in frontend can POST gallery links. Persist automatic work per
// acting user, and serialize claims across all of that worker's frontend sessions.
// These operations never hold up illustration delivery or rewrite message metadata.
const galleryWorkers = new WeakMap();
function galleryWorker(api) {
  if (!galleryWorkers.has(api)) galleryWorkers.set(api, { tail: Promise.resolve(), leases: new Map(), seq: 0 });
  return galleryWorkers.get(api);
}
function galleryExclusive(api, fn) {
  const state = galleryWorker(api);
  const result = state.tail.then(fn, fn);
  state.tail = result.catch(() => {});
  return result;
}
const galleryQueuePath = (userId) => `gallery-pending-${encodeURIComponent(userId || 'installer')}.json`;
async function galleryPending(api, userId) {
  const value = await api.storage.getJson(galleryQueuePath(userId), { fallback: [] });
  return Array.isArray(value) ? value : [];
}
async function galleryTarget(api, chatId, userId) {
  const chat = await api.chats.get(chatId, withUser(userId));
  if (chat?.metadata?.group === true) return { characterId: null, reason: '그룹 채팅에서는 갤러리에 저장할 수 없습니다.' };
  if (!chat?.character_id) return { characterId: null, reason: '캐릭터가 없는 채팅에서는 갤러리에 저장할 수 없습니다.' };
  return { characterId: chat.character_id, reason: '' };
}
async function galleryItems(api, characterId, userId) {
  if (typeof api.characters.getGallery !== 'function') throw new Error('갤러리를 확인할 수 없습니다. 루미버스 업데이트가 필요합니다.');
  const items = await api.characters.getGallery(characterId, withUser(userId));
  if (!Array.isArray(items)) throw new Error('갤러리 목록을 확인하지 못했습니다.');
  return items;
}
function scheduleGallery(api, { chatId, imageId, settings, userId }) {
  if (!settings?.autoSaveGallery || typeof imageId !== 'string' || !imageId.trim()) return;
  void galleryExclusive(api, async () => {
    const target = await galleryTarget(api, chatId, userId);
    if (!target.characterId) return;
    const pending = await galleryPending(api, userId);
    if (!pending.some((p) => p.characterId === target.characterId && p.imageId === imageId)) {
      await api.storage.setJson(galleryQueuePath(userId), [...pending, { chatId, characterId: target.characterId, imageId }]);
    }
    api.sendToFrontend({ type: 'gallery_pending' }, withUser(userId));
  }).catch(() => {
    try { api.sendToFrontend({ type: 'gallery_error', error: '갤러리 자동 저장을 준비하지 못했습니다. 그림에서 직접 저장해 주세요.' }, withUser(userId)); } catch { /* delivery stays independent */ }
  });
}

async function prepareGallery(api, payload, userId) {
  const target = await galleryTarget(api, payload.chatId, userId);
  if (!target.characterId) throw new Error(target.reason);
  const imageId = payload.imageId;
  if (typeof imageId !== 'string' || !imageId.trim()) throw new Error('저장된 이미지 ID가 없습니다.');
  const pending = await galleryPending(api, userId);
  const queued = pending.some((p) => p.chatId === payload.chatId && p.characterId === target.characterId && p.imageId === imageId);
  if (!queued) {
    const messages = await api.chat.getMessages(payload.chatId);
    const records = (messages || []).flatMap((m) => Object.values(m.metadata?.[IDENTIFIER]?.images || {}));
    records.push(...await loadOrphans(api, payload.chatId));
    if (!records.some((r) => r.imageId === imageId)) throw new Error('이 채팅의 그림을 찾을 수 없습니다.');
  }
  const items = await galleryItems(api, target.characterId, userId);
  if (items.some((item) => item.image_id === imageId)) {
    await api.storage.setJson(galleryQueuePath(userId), pending.filter((p) => p.characterId !== target.characterId || p.imageId !== imageId));
    return { ...target, saved: true };
  }
  const state = galleryWorker(api);
  for (const [key, lease] of state.leases) if (lease.until <= Date.now()) state.leases.delete(key);
  const key = JSON.stringify([userId || '', target.characterId, imageId]);
  const lease = state.leases.get(key);
  if (lease && lease.until > Date.now()) throw new Error('다른 창에서 갤러리에 저장 중입니다. 잠시 후 다시 시도해 주세요.');
  const token = `gallery-${Date.now()}-${++state.seq}`;
  state.leases.set(key, { token, until: Date.now() + 60000 });
  return { ...target, imageId, token };
}

async function finishGallery(api, payload, userId) {
  const state = galleryWorker(api);
  const key = JSON.stringify([userId || '', payload.characterId, payload.imageId]);
  if (state.leases.get(key)?.token !== payload.token) return {};
  try {
    if (payload.saved) {
      const items = await galleryItems(api, payload.characterId, userId);
      if (!items.some((item) => item.image_id === payload.imageId)) throw new Error('갤러리 저장을 확인하지 못했습니다.');
      const pending = await galleryPending(api, userId);
      await api.storage.setJson(galleryQueuePath(userId), pending.filter((p) => p.characterId !== payload.characterId || p.imageId !== payload.imageId));
    }
    return {};
  } finally { state.leases.delete(key); }
}

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

// `userId` is threaded through every call whose host handler resolves the acting user
// via `resolveEffectiveUserId` (worker-host.ts:3430-3438): for a USER-scoped install the
// host ignores it and uses the installer; for an OPERATOR-scoped install (the default for
// both "Install from GitHub" and Import Local — spindle.routes.ts:197-199) the host
// THROWS "userId is required for operator-scoped extensions" when it is missing
// (characters.get/update: worker-host-content-api.ts:248-255; chats.get: :1049-1056;
// imageGen.generateNative: worker-host-image-gen-api.ts:223-227; getPromptPresets:
// :340-346). The acting user comes from the event handler's 2nd argument
// (worker-runtime.ts ~4626 `handler(msg.payload, msg.userId)`), the interceptor's
// `context.userId` (InterceptorContextDTO), or onFrontendMessage's 2nd argument.
function withUser(userId) {
  return typeof userId === 'string' && userId ? userId : undefined;
}

async function loadRegistry(api, characterId, userId) {
  if (!characterId) return [];
  const ch = await api.characters.get(characterId, withUser(userId));
  return extToRegistry(ch);
}

/** Resolve the character card that owns a chat (permission: "chats"). Needed because
 *  neither GenerationEndedPayloadDTO nor ChatMessageDTO carries a character id — only
 *  ChatDTO.character_id does. */
async function characterIdForChat(api, chatId, userId) {
  try {
    const chat = await api.chats.get(chatId, withUser(userId));
    return chat?.character_id || undefined;
  } catch {
    return undefined;
  }
}

async function saveRegistry(api, characterId, registry, userId) {
  await api.characters.update(characterId, { extensions: { [IDENTIFIER]: { characters: registry } } }, withUser(userId));
}

/** What the panel's detail view shows for an image record: the prompt text that was sent
 *  (the composed one when recorded, else the scene prompt of older records), its negative,
 *  and the NAI per-character slots. Pure read of stored metadata. */
function promptDetails(rec) {
  const out = {};
  const prompt = typeof rec.finalPrompt === 'string' && rec.finalPrompt ? rec.finalPrompt : (typeof rec.prompt === 'string' ? rec.prompt : '');
  if (prompt) out.prompt = prompt;
  if (typeof rec.finalPrompt === 'string' && rec.finalPrompt) out.recorded = true; // 0.2.0+ record: `prompt` is what was actually sent
  if (typeof rec.negativePrompt === 'string' && rec.negativePrompt) out.negative = rec.negativePrompt;
  const slots = Array.isArray(rec.characterTags) ? rec.characterTags.map((c) => String(c?.tags ?? '')).filter(Boolean) : [];
  if (slots.length) out.slots = slots;
  return out;
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
//
// Review (4th pass) finding 1: this queue needs the same kind of deadline as the
// per-message lock, for the same reason — a single hung generate() call would
// otherwise block every later queued generation (for ANY message) forever. Each
// queued call is raced against `GENERATE_TIMEOUT_MS` (5 min); whichever settles first
// is what the chain uses to unblock the NEXT queued call. On timeout, the race
// REJECTS, so the caller (`generateImage`) sees it as an ordinary generation failure —
// already handled by the existing try/catch in processMessageInner/regenerateLocked,
// which never writes a failure result without re-validating first. The late real
// result (if the hung call eventually resolves) is simply never awaited by anything —
// discarded, never written — because whoever was waiting on it has already moved on
// and recorded a failure/orphan instead.
const DEFAULT_GENERATE_TIMEOUT_MS = 5 * 60 * 1000;
let generateQueue = Promise.resolve();
function queuedCall(fn, generateTimeoutMs = DEFAULT_GENERATE_TIMEOUT_MS) {
  const run = () => raceGenerateDeadline(fn, generateTimeoutMs);
  const result = generateQueue.then(run, run);
  generateQueue = result.then(() => undefined, () => undefined);
  return result;
}

function raceGenerateDeadline(fn, generateTimeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`이미지 생성 요청이 ${generateTimeoutMs}ms 내에 끝나지 않아 대기열 진행을 위해 포기함`));
    }, generateTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve().then(fn), deadline]).finally(() => clearTimeout(timer));
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
async function fetchMainPreset(api, userId) {
  if (typeof api.imageGen.getPromptPresets !== 'function') return null; // optional on older hosts
  try {
    const result = await api.imageGen.getPromptPresets(withUser(userId));
    if (!result?.activeId || !Array.isArray(result.presets)) return null;
    const preset = result.presets.find((p) => p.id === result.activeId);
    return preset ? { prompt: preset.prompt, negativePrompt: preset.negativePrompt } : null;
  } catch {
    return null; // never block generation on this — scene prompt alone, same as before this fix
  }
}

async function generateImage(api, { chatId, prompt, characterTags, negatives, settings, mainPreset, generateTimeoutMs, userId }) {
  // 0.2.0: the negative prompt is composed here (preset negative + 공통 네거티브 + the scene
  // characters' own negatives, de-duplicated — see core.buildFinalPrompt). With
  // `boundNegatives` on, `skipParse` is left off so the HOST expands the card/persona-bound
  // negative tokens (image-gen.service.ts resolvePromptInput: expandCharacterPromptMacro is
  // skipped only under skipParse); `promptMode:'custom'` alone still keeps scene analysis
  // from overwriting our characterTags (resolveImagePrompt returns custom input as-is).
  const boundNegatives = settings?.boundNegatives !== false;
  const { prompt: finalPrompt, negativePrompt } = buildFinalPrompt(prompt, mainPreset, {
    commonNegative: settings?.commonNegative, characterNegatives: negatives, boundNegatives,
  });
  const uid = withUser(userId);
  const result = await queuedCall(() => api.imageGen.generateNative({
    chat_id: chatId,
    ...(uid ? { userId: uid } : {}),
    prompt: finalPrompt,
    ...(negativePrompt !== undefined ? { negativePrompt } : {}),
    promptMode: 'custom',
    ...(boundNegatives ? {} : { skipParse: true }),
    parameters: { characterTags },
    includeDataUrl: false,
  }), generateTimeoutMs);
  // Review finding 4: the host can resolve `generate()`/`generateNative()`
  // successfully while persistence silently failed internally
  // (worker-host-image-gen-api.ts:180-206 catches that and still resolves); `imageId`/
  // `imageUrl` are optional on the DTO (api.d.ts:818-825). Treat a result with no
  // usable URL as a failure — never write `![그림:id|...](undefined)` into the message.
  if (!result || typeof result.imageUrl !== 'string' || !result.imageUrl) {
    throw new Error('이미지 URL을 받지 못함(생성 결과에 사용 가능한 그림 없음)');
  }
  scheduleGallery(api, { chatId, imageId: result.imageId, settings, userId });
  return { ...result, composed: { prompt: finalPrompt, negativePrompt: negativePrompt || '' } };
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
// message forever. A fixed deadline (`lockTimeoutMs`, default 3 minutes) lets the NEXT
// queued operation proceed once it elapses.
//
// Review (4th pass) finding 1 (regression): the first version of (b) just raced the
// operation's promise against a timer and let the NEXT operation start as soon as
// either settled — but racing a promise never cancels the loser. The original
// (expired) operation kept running in the background and, having already passed its
// own revalidation checks before the deadline fired, still called `chat.updateMessage`
// later — overwriting whatever the SECOND (successful) operation had since committed:
// its image, the user's own intervening edits, and unrelated metadata. Reproduced:
// pause an operation right before its final read, let its deadline elapse, let a
// second operation for the same message run and commit, then resume the first — the
// first's write clobbered everything the second had just written.
//
// Fixed: every locked operation now receives an `isExpired()` function (see
// processMessageInner/regenerateLocked) and MUST check it immediately before every
// write (`chat.updateMessage`, `variables.chat.set` via pushOrphans) and abort without
// writing if it's already expired — in addition to the existing re-read-and-revalidate
// immediately before committing. This still cannot truly CANCEL a hung RPC the
// operation is awaiting *when* it expires (e.g. a stuck `generateNative` call) — the
// checks only stop the operation from writing once control returns to it — but it
// closes the actual data-loss hole: by the time an expired operation reaches a write,
// it now always finds out it's expired and bails out first.
const DEFAULT_LOCK_TIMEOUT_MS = 3 * 60 * 1000;
const messageLocks = new Map();

function raceWithDeadline(fn, key, lockTimeoutMs) {
  let timer;
  let expired = false;
  const isExpired = () => expired;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      console.error(`[lv_illust] message lock for "${key}" timed out after ${lockTimeoutMs}ms — releasing it for the next queued operation; this operation now aborts on its next write-point if it's still running, but can't be cancelled mid-flight`);
      resolve(undefined);
    }, lockTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref(); // never keep the process alive just for this
  });
  return Promise.race([Promise.resolve().then(() => fn(isExpired)), deadline]).finally(() => clearTimeout(timer));
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
async function processMessageLocked(api, { chatId, messageId, registry, settings, idGenerator, lockTimeoutMs, generateTimeoutMs, userId }) {
  return withMessageLock(
    `${chatId}::${messageId}`,
    (isExpired) => processMessageInner(api, { chatId, messageId, registry, settings, idGenerator, generateTimeoutMs, isExpired, userId }),
    lockTimeoutMs,
  );
}

async function processMessageInner(api, { chatId, messageId, registry, settings, idGenerator, generateTimeoutMs, isExpired = () => false, userId }) {
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
    resultsById[s.id] = { status: 'skip', prompt: s.prompt, characterTags: s.characterTags, negatives: s.negatives, summary: s.summary };
  }

  // Fetched once per message-processing pass (not per tag) — the active main preset
  // can't change mid-pass, and this avoids N redundant RPCs for an N-image reply.
  const mainPreset = jobs.length ? await fetchMainPreset(api, userId) : null;

  for (const job of jobs) {
    tagIndexToId.set(job.tagIndex, job.id);
    try {
      const result = await generateImage(api, { chatId, prompt: job.prompt, characterTags: job.characterTags, negatives: job.negatives, settings, mainPreset, generateTimeoutMs, userId });
      markers.set(job.tagIndex, { mode: 'replace', text: renderSuccessMarker(job.id, result.imageUrl, job.summary) });
      resultsById[job.id] = {
        status: 'ok', prompt: job.prompt, characterTags: job.characterTags,
        negatives: job.negatives, finalPrompt: result.composed.prompt, negativePrompt: result.composed.negativePrompt,
        imageId: result.imageId, imageUrl: result.imageUrl, summary: job.summary,
      };
    } catch (err) {
      const reason = String(err?.message || err || '오류').slice(0, 80);
      markers.set(job.tagIndex, { mode: 'replace', text: renderFailureMarker(job.id, tags[job.tagIndex], reason) });
      resultsById[job.id] = {
        status: 'fail', prompt: job.prompt, characterTags: job.characterTags, negatives: job.negatives,
        reason, summary: job.summary,
      };
    }
  }

  // --- everything above only decided *what* to do; everything below re-checks the
  // live message right before writing anything, and commits before any further RPCs. ---
  // Review (4th pass) finding 1: an expired (past its lock deadline) operation must
  // never write — checked immediately before every write point below, not just once.
  if (isExpired()) return { changed: false, expired: true };
  const freshList = await api.chat.getMessages(chatId);
  const fresh = freshList.find((m) => m.id === messageId);
  const swipeChanged = !fresh || (fresh.swipe_id ?? 0) !== (message.swipe_id ?? 0);
  if (swipeChanged) {
    const orphans = Object.entries(resultsById).map(([id, r]) => ({
      id, messageId, ts: Date.now(),
      reason: '메시지가 바뀌어(스와이프 변경/삭제) 넣지 못함', ...r,
    }));
    if (orphans.length && !isExpired()) await pushOrphans(api, chatId, orphans);
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
      // Review (4th pass) finding 2: malformed tags' `tag.raw` is now just a short,
      // fixed-length RELOCATION anchor (see core.mjs buildMalformedTag) — the actual
      // insertion point is always exactly 4 characters into wherever that anchor is
      // found (right after the literal "<pic" opener), never "after the whole anchor".
      // This was the one place still using the old `at + tag.raw.length` arithmetic,
      // which silently reintroduced the bug this fix exists to prevent (reproduced:
      // repeated writes at the backend/integration level even though core.mjs's own
      // parseTags/applyMarkers were already fully idempotent).
      const insertAt = at + 4;
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
    if (orphanedNow.length && !isExpired()) await pushOrphans(api, chatId, orphanedNow);
    return { changed: false, orphaned: orphanedNow.length };
  }

  // Last check immediately before the actual commit — this is the exact write the
  // reviewer's reproduction exploited (everything up to here can take arbitrarily long
  // via the generate loop's awaits, so the deadline may have already fired).
  if (isExpired()) return { changed: false, expired: true };
  const currentImages = fresh.metadata?.[IDENTIFIER]?.images || {};
  await api.chat.updateMessage(chatId, messageId, {
    content,
    metadata: mergeMetadata(fresh.metadata, { images: { ...currentImages, ...placedImages } }),
  });
  // Orphan bookkeeping strictly AFTER the message commit (review finding 2) — never
  // between the revalidating read and the write.
  if (orphanedNow.length && !isExpired()) await pushOrphans(api, chatId, orphanedNow);
  return { changed: true, content, orphaned: orphanedNow.length };
}

// `idGenerator` is a test-only hook (never passed in production — see start() below):
// core.mjs's nextImageId is collision-resistant (time+random) by default; tests inject
// a deterministic counter so assertions on exact ids stay readable and stable.
export function createService(api, { idGenerator, lockTimeoutMs, generateTimeoutMs } = {}) {
  async function handleGenerationEnded(payload, userId) {
    if (!payload?.chatId || !payload?.messageId) return;
    const settings = await readSettings(api);
    if (!(await isAutoOn(api, payload.chatId, true))) return;
    const characterId = await characterIdForChat(api, payload.chatId, userId);
    const registry = await loadRegistry(api, characterId, userId);
    await processMessageLocked(api, { chatId: payload.chatId, messageId: payload.messageId, registry, settings, idGenerator, lockTimeoutMs, generateTimeoutMs, userId });
  }

  async function handleMessageEdited(payload, userId) {
    // MESSAGE_EDITED's payload is `{ chatId, message }` where `message` is the host's
    // raw stored Message row (VERIFIED: chats.service.ts:2871 `updateMessage`, also
    // :2494, :2589, :2693 — see docs/API-NOTES.md). Only `chatId` and `message.id` are
    // used from it; content/metadata/role are re-read through the normalized
    // `getMessages` shape inside processMessageInner (the raw row carries `extra`, not
    // the split-out `metadata`), so nothing acts on a stale or differently-shaped copy.
    const chatId = payload?.chatId;
    const messageId = payload?.message?.id;
    if (!chatId || !messageId) return;
    const settings = await readSettings(api);
    if (!(await isAutoOn(api, chatId, true))) return;
    const characterId = await characterIdForChat(api, chatId, userId);
    const registry = await loadRegistry(api, characterId, userId);
    await processMessageLocked(api, { chatId, messageId, registry, settings, idGenerator, lockTimeoutMs, generateTimeoutMs, userId });
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
      const auto = await isAutoOn(api, context?.chatId, true);
      if (!auto) return cleaned;
      const settings = await readSettings(api);
      let registry = [];
      try { registry = await loadRegistry(api, context.characterId, context?.userId); } catch { /* best-effort */ }
      return injectInstruction(cleaned, settings, registry);
    });
  }

  async function runFrontendRequest(payload, userId) {
    switch (payload.type) {
      case 'load_gallery': {
        const target = await galleryTarget(api, payload.chatId, userId);
        const items = target.characterId ? await galleryItems(api, target.characterId, userId) : [];
        return { ...target, imageIds: items.map((item) => item.image_id) };
      }
      case 'gallery_pending':
        return galleryExclusive(api, async () => ({ jobs: await galleryPending(api, userId) }));
      case 'prepare_gallery':
        return galleryExclusive(api, () => prepareGallery(api, payload, userId));
      case 'finish_gallery':
        return galleryExclusive(api, () => finishGallery(api, payload, userId));
      case 'load_status':
        return { missing: await missingPermissions(api) };
      case 'load_settings':
        return { settings: await readSettings(api) };
      case 'save_settings':
        await writeSettings(api, payload.settings);
        return { settings: await readSettings(api) };
      case 'load_registry':
        return { registry: await loadRegistry(api, payload.characterId, userId) };
      case 'save_registry':
        await saveRegistry(api, payload.characterId, normalizeRegistry({ characters: payload.registry }), userId);
        return { registry: await loadRegistry(api, payload.characterId, userId) };
      case 'list_images': {
        const messages = await api.chat.getMessages(payload.chatId);
        const out = [];
        for (const m of messages || []) {
          const images = m.metadata?.[IDENTIFIER]?.images;
          if (!images) continue;
          for (const [id, rec] of Object.entries(images)) {
            out.push({ id, ...(rec.imageId ? { imageId: rec.imageId } : {}), messageId: m.id, status: rec.status, summary: rec.summary, imageUrl: rec.imageUrl, ...promptDetails(rec) });
          }
        }
        // Orphaned generations (review finding 1: produced but couldn't be spliced back
        // into any live message because it changed underneath them) — shown read-only
        // (review finding 6: never with a regenerate button — see frontend.mjs) so
        // nothing a generation actually produced is silently lost.
        const orphans = await loadOrphans(api, payload.chatId);
        for (const o of orphans) {
          out.push({ id: o.id, ...(o.imageId ? { imageId: o.imageId } : {}), messageId: o.messageId, status: 'orphan', summary: o.summary, imageUrl: o.imageUrl, reason: o.reason, ...promptDetails(o) });
        }
        return { images: out };
      }
      case 'preview_prompt': {
        // Read-only: composes what a tag WOULD send (no generation). `registry` may be the
        // panel's unsaved draft; otherwise the card's saved registry is used.
        const draft = Array.isArray(payload.registry) ? normalizeRegistry({ characters: payload.registry }) : null;
        const registry = draft || await loadRegistry(api, payload.characterId, userId);
        const settings = await readSettings(api);
        const mainPreset = await fetchMainPreset(api, userId);
        const r = composeScene({ chars: String(payload.chars ?? ''), scene: String(payload.scene ?? ''), registry, mainPreset, settings });
        return { ...r, hasMainPreset: !!mainPreset, boundNegatives: settings.boundNegatives };
      }
      case 'load_auto':
        return { auto: await isAutoOn(api, payload.chatId, true) };
      case 'set_auto':
        await setAutoOn(api, payload.chatId, !!payload.on);
        return { auto: await isAutoOn(api, payload.chatId, true) };
      case 'regenerate': {
        if (!payload?.chatId || !payload?.messageId || !payload?.imageId) throw new Error('잘못된 요청');
        return withMessageLock(
          `${payload.chatId}::${payload.messageId}`,
          (isExpired) => regenerateLocked(api, payload, isExpired, generateTimeoutMs, userId),
          lockTimeoutMs,
        );
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
async function regenerateLocked(api, payload, isExpired = () => false, generateTimeoutMs, userId) {
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
    const mainPreset = await fetchMainPreset(api, userId);
    const settings = await readSettings(api);
    result = await generateImage(api, { chatId: payload.chatId, prompt: rec.prompt, characterTags: rec.characterTags, negatives: rec.negatives, settings, mainPreset, generateTimeoutMs, userId });
  } catch (err) {
    throw new Error('다시 그리기 실패: ' + String(err?.message || err));
  }

  // Review (4th pass) finding 1: the generate() call above can take long enough for
  // this operation's own lock deadline to elapse while it was awaiting — check before
  // every write point below, not just once, same as processMessageInner.
  if (isExpired()) return { ok: false, expired: true };
  const freshList = await api.chat.getMessages(payload.chatId);
  const fresh = freshList.find((m) => m.id === payload.messageId);
  const updated = { ...rec, status: 'ok', imageId: result.imageId, imageUrl: result.imageUrl, finalPrompt: result.composed.prompt, negativePrompt: result.composed.negativePrompt };
  if (!fresh || (fresh.swipe_id ?? 0) !== originalSwipeId) {
    if (!isExpired()) {
      await pushOrphans(api, payload.chatId, [{
        id: payload.imageId, messageId: payload.messageId, ts: Date.now(),
        reason: '메시지가 바뀌어(스와이프 변경/삭제) 넣지 못함', ...updated,
      }]);
    }
    throw new Error('다시 그리는 동안 메시지가 바뀌어 반영하지 못했습니다. 그림은 보관되어 목록에서 볼 수 있습니다.');
  }
  const marker = renderSuccessMarker(payload.imageId, result.imageUrl, rec.summary);
  const re = markerRegexForId(payload.imageId);
  if (!re.test(fresh.content)) {
    if (!isExpired()) {
      await pushOrphans(api, payload.chatId, [{
        id: payload.imageId, messageId: payload.messageId, ts: Date.now(),
        reason: '그림 자리(태그)가 수정되어 넣지 못함', ...updated,
      }]);
    }
    throw new Error('그림 자리를 찾지 못해 반영하지 못했습니다. 그림은 보관되어 목록에서 볼 수 있습니다.');
  }
  // Last check immediately before the actual commit (same rationale as processMessageInner).
  if (isExpired()) return { ok: false, expired: true };
  const newContent = fresh.content.replace(re, marker);
  const currentImages = { ...(fresh.metadata?.[IDENTIFIER]?.images || {}) };
  currentImages[payload.imageId] = updated;
  await api.chat.updateMessage(payload.chatId, message.id, {
    content: newContent,
    metadata: mergeMetadata(fresh.metadata, { ...(fresh.metadata?.[IDENTIFIER] || {}), images: currentImages }),
  });
  return { ok: true };
}

// Every permission this extension's manifest declares (spindle.json). Used only to tell
// the panel which ones are still missing; the host remains the enforcer.
export const MANIFEST_PERMISSIONS = ['image_gen', 'interceptor', 'chat_mutation', 'characters', 'chats', 'generation'];

async function grantedPermissions(api) {
  const perms = api.permissions;
  if (typeof perms?.getGranted === 'function') {
    try {
      const list = await perms.getGranted();
      if (Array.isArray(list)) return list;
    } catch { /* fall through to the local cache */ }
  }
  if (typeof perms?.has === 'function') return MANIFEST_PERMISSIONS.filter((p) => { try { return perms.has(p); } catch { return false; } });
  return null; // unknown (very old host) — don't claim anything is missing
}

async function missingPermissions(api) {
  const granted = await grantedPermissions(api);
  if (!granted) return [];
  return MANIFEST_PERMISSIONS.filter((p) => !granted.includes(p));
}

/** Host permission errors are thrown as `PERMISSION_DENIED: <permission> — ...`
 *  (`PERMISSION_DENIED_PREFIX`, lumiverse-spindle-types api.d.ts:2359; e.g.
 *  worker-host.ts:3768-3769 for chat.getMessages, worker-host-content-api.ts:250-251 for
 *  characters.get). Returns the permission name, or null for any other error. */
export function permissionFromError(err) {
  const m = /PERMISSION_DENIED:\s*([a-z_]+)/.exec(String(err?.message || err || ''));
  return m ? m[1] : null;
}

/**
 * Permission-aware registration of the event subscriptions and the interceptor.
 *
 * Root cause this exists for: the host checks the `generation` permission ONCE, when
 * the worker's `subscribe_event` message arrives (worker-host.ts:2695-2715
 * `handleSubscribeEvent`: GENERATION_ENDED is in GENERATION_EVENTS, so without the
 * permission it logs "Generation permission required for event: GENERATION_ENDED",
 * posts `permission_denied` and returns — the subscription is simply dropped), and the
 * `interceptor` permission ONCE in `handleRegisterInterceptor` (worker-host.ts:2946-2956,
 * "Interceptor permission not granted"). Neither is ever retried by the host. An
 * extension that starts before its permissions are granted therefore never receives
 * GENERATION_ENDED and never injects its instruction until it is restarted.
 *
 * Granting a permission later does reach the running worker: the permissions route
 * (spindle.routes.ts:493-503) calls lifecycle.notifyPermissionChanged() once PER
 * permission (lifecycle.ts:144-163) -> WorkerHost.notifyPermissionChanged
 * (worker-host.ts:1510-1525) posts `{type:"permission_changed", permission, granted,
 * allGranted}`, which the runtime turns into `spindle.permissions.onChanged` handlers
 * AND `spindle.on("PERMISSION_CHANGED")` handlers (worker-runtime.ts:4914-4958 — both
 * fire for the same message, so only ONE of the two is used here).
 *
 * Re-subscribing has one trap: `spindle.on(event)` only posts `subscribe_event` to the
 * host when the worker-side handler Set for that event is first CREATED
 * (worker-runtime.ts:1669-1676). After a denied startup subscription the Set still
 * exists locally, so a second `on()` would just add a duplicate local handler and never
 * reach the host. Re-registration therefore always disposes the old registration first
 * (which deletes the empty Set and posts `unsubscribe_event` — a no-op on the host for a
 * never-installed subscription, worker-host.ts:2781-2787) and only then calls `on()`
 * again. `registerInterceptor` always posts a fresh registrationId and the host replaces
 * any previous one (worker-host.ts ~2970 `this.interceptorUnregister?.()`), but it is
 * disposed first too for symmetry.
 *
 * Idempotent: an entry is (re)registered only when it is not believed live, so the burst
 * of one permission_changed per granted permission never stacks registrations.
 */
export function createRegistrations(api, service) {
  const perms = api.permissions;
  const hasPerm = (p) => {
    if (!p) return true;
    if (typeof perms?.has !== 'function') return true; // no cache to consult — assume the host accepted it
    try { return perms.has(p) === true; } catch { return true; }
  };
  const onEvent = (handler) => (payload, userId) => { handler(payload, userId).catch((e) => console.error('[lv_illust]', e)); };
  const entries = [
    { name: 'GENERATION_ENDED', permission: 'generation', deniedOp: 'subscribe_event:GENERATION_ENDED',
      register: () => api.on('GENERATION_ENDED', onEvent(service.handleGenerationEnded)) },
    { name: 'MESSAGE_EDITED', permission: null, deniedOp: 'subscribe_event:MESSAGE_EDITED',
      register: () => api.on('MESSAGE_EDITED', onEvent(service.handleMessageEdited)) },
    { name: 'interceptor', permission: 'interceptor', deniedOp: 'registerInterceptor',
      register: () => service.registerInterceptor() },
  ].map((e) => ({ ...e, off: null, live: false, attempts: 0 }));

  function detach(e) {
    if (e.off) { try { e.off(); } catch { /* ignore */ } }
    e.off = null;
    e.live = false;
  }
  function attach(e) {
    detach(e); // see the trap above: dispose first, or the host never hears about it
    e.attempts++;
    try {
      const off = e.register();
      e.off = typeof off === 'function' ? off : null;
      // If the permission is missing right now the host drops this registration (and
      // says so via permission_denied) — remember to retry once it is granted.
      e.live = hasPerm(e.permission);
    } catch (err) {
      e.off = null; e.live = false;
      console.error(`[lv_illust] registering ${e.name} failed`, err);
    }
  }

  for (const e of entries) attach(e);

  // Direct signal from the host that a registration was dropped (worker-host.ts ~2708-2712
  // and ~2950-2955 post exactly these `operation` strings).
  let offDenied = () => {};
  if (typeof perms?.onDenied === 'function') {
    offDenied = perms.onDenied((detail) => {
      for (const e of entries) if (detail?.operation === e.deniedOp) e.live = false;
    }) || offDenied;
  }

  function onPermissionChanged(detail) {
    const all = Array.isArray(detail?.allGranted) ? detail.allGranted : null;
    const granted = (p) => (all ? all.includes(p) : hasPerm(p));
    for (const e of entries) {
      if (!e.permission) {
        if (!e.live) attach(e);
        continue;
      }
      if (granted(e.permission)) {
        if (!e.live) attach(e);
        if (all) e.live = true; // allGranted is authoritative (worker-runtime.ts:4921-4923)
      } else if (e.live) {
        detach(e); // revoked: stop acting on it; a later grant re-registers
      }
    }
    // Let an open panel retry whatever failed for lack of permission, without a reload.
    try {
      api.sendToFrontend({ type: 'permissions_changed', permission: detail?.permission, granted: detail?.granted, allGranted: all || undefined });
    } catch { /* no frontend connected */ }
  }

  let offChanged = () => {};
  if (typeof perms?.onChanged === 'function') offChanged = perms.onChanged(onPermissionChanged) || offChanged;
  else if (typeof api.on === 'function') offChanged = api.on('PERMISSION_CHANGED', onPermissionChanged) || offChanged;

  return {
    onPermissionChanged,
    state: () => Object.fromEntries(entries.map((e) => [e.name, { live: e.live, attempts: e.attempts, registered: !!e.off }])),
    dispose() {
      try { offChanged(); } catch { /* ignore */ }
      try { offDenied(); } catch { /* ignore */ }
      for (const e of entries) detach(e);
    },
  };
}

export function start(api) {
  const service = createService(api);
  const registrations = createRegistrations(api, service);
  const offFrontend = api.onFrontendMessage(async (payload, userId, frontendSessionId) => {
    if (!payload || typeof payload.requestId !== 'string') return;
    let reply;
    try { reply = { ok: true, ...(await service.runFrontendRequest(payload, userId)) }; }
    catch (e) {
      const permission = permissionFromError(e);
      reply = { ok: false, error: String(e?.message || e), ...(permission ? { permission } : {}) };
    }
    api.sendToFrontend({ ...reply, requestId: payload.requestId, type: payload.type }, userId, frontendSessionId ? { frontendSessionId } : undefined);
  });
  return () => {
    registrations.dispose();
    try { offFrontend(); } catch { /* ignore */ }
  };
}

if (typeof spindle !== 'undefined') start(spindle);
