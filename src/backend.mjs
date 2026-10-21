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

// Review finding 1: a generated-but-homeless image (its message was edited/swiped/
// deleted out from under it while generation was in flight, so there's no live tag
// occurrence left to splice the result into) is never silently discarded — it's kept
// here, per chat, so the panel's image list can still show it to the user instead of
// it just vanishing. Free-tier chat variable storage, same tier as the auto-gen flag.
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

/**
 * Process one assistant message's `<pic>` tags: generate images for up to
 * `settings.maxImages` valid tags (concurrency 1 — SharedNAI limit), then splice
 * markers into the message and persist results in message metadata.
 *
 * Review finding 1 (BLOCKER): the original version read `message` once at the top,
 * awaited generation (which can take many seconds), and then wrote `content`/`metadata`
 * computed from that STALE snapshot — silently reverting any edit, swipe, or another
 * extension's metadata write that happened during the wait. Fixed: `message` here is
 * only used to decide WHAT to generate (the plan); the actual write re-fetches the
 * CURRENT message right before saving, locates each tag by its own verbatim raw text
 * (not a stored offset, which the current content may no longer agree with) within the
 * CURRENT content, and refuses to touch anything if the message's active swipe changed
 * underneath it — in that case the generated image(s) are preserved as "orphans"
 * instead (see pushOrphans) rather than overwriting whatever the content/metadata
 * became in the meantime.
 */
async function processMessage(api, { chatId, message, registry, settings }) {
  if (!hasLiveTags(message.content)) return { changed: false };
  const existingIds = existingImageIds([message]);
  const { tags, jobs, skipped, markers } = planMessage(message.content, {
    registry, maxImages: settings.maxImages, existingImageIds: existingIds,
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
      const result = await queuedGenerate(api, {
        prompt: job.prompt,
        parameters: { characterTags: job.characterTags },
        owner_chat_id: chatId,
        includeDataUrl: false,
      });
      markers.set(job.tagIndex, renderSuccessMarker(job.id, result.imageUrl, job.summary));
      resultsById[job.id] = {
        status: 'ok', prompt: job.prompt, characterTags: job.characterTags,
        imageId: result.imageId, imageUrl: result.imageUrl, summary: job.summary,
      };
    } catch (err) {
      const reason = String(err?.message || err || '오류').slice(0, 80);
      markers.set(job.tagIndex, renderFailureMarker(job.id, tags[job.tagIndex], reason));
      resultsById[job.id] = {
        status: 'fail', prompt: job.prompt, characterTags: job.characterTags,
        reason, summary: job.summary,
      };
    }
  }

  // --- everything above only decided *what* to do; everything below re-checks the
  // live message right before writing anything. ---
  const freshList = await api.chat.getMessages(chatId);
  const fresh = freshList.find((m) => m.id === message.id);
  const swipeChanged = !fresh || (fresh.swipe_id ?? 0) !== (message.swipe_id ?? 0);
  if (swipeChanged) {
    const orphans = Object.entries(resultsById).map(([id, r]) => ({
      id, messageId: message.id, ts: Date.now(),
      reason: '메시지가 바뀌어(스와이프 변경/삭제) 넣지 못함', ...r,
    }));
    await pushOrphans(api, chatId, orphans);
    return { changed: false, orphaned: orphans.length };
  }

  let content = fresh.content;
  let cursor = 0;
  const placedImages = {};
  const orphanedNow = [];
  tags.forEach((tag, i) => {
    if (!markers.has(i)) return;
    const marker = markers.get(i);
    let at = content.indexOf(tag.raw, cursor);
    if (at === -1) at = content.indexOf(tag.raw); // retry from the start: order may have shifted
    const id = tagIndexToId.get(i);
    if (at === -1) {
      // the exact original tag text is gone from the current content (edited away
      // mid-generation) — never guess at a splice location.
      if (id && resultsById[id]) {
        orphanedNow.push({ id, messageId: message.id, ts: Date.now(), reason: '그림 자리(태그)가 수정되어 넣지 못함', ...resultsById[id] });
      }
      return;
    }
    content = content.slice(0, at) + marker + content.slice(at + tag.raw.length);
    cursor = at + marker.length;
    if (id && resultsById[id]) placedImages[id] = resultsById[id];
  });

  if (orphanedNow.length) await pushOrphans(api, chatId, orphanedNow);

  if (content === fresh.content && Object.keys(placedImages).length === 0) {
    // every generated image was orphaned (nothing left to splice in) — don't write an
    // otherwise-identical copy of content/metadata back over whatever is currently there.
    return { changed: false, orphaned: orphanedNow.length };
  }

  const currentImages = fresh.metadata?.[IDENTIFIER]?.images || {};
  await api.chat.updateMessage(chatId, message.id, {
    content,
    metadata: mergeMetadata(fresh.metadata, { ...currentImages, ...placedImages }),
  });
  return { changed: true, content, orphaned: orphanedNow.length };
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
        // Orphaned generations (review finding 1: produced but couldn't be spliced back
        // into any live message because it changed underneath them) — shown read-only
        // so nothing a generation actually produced is silently lost.
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
        const messages = await api.chat.getMessages(payload.chatId);
        const message = messages.find((m) => m.id === payload.messageId);
        if (!message) throw new Error('메시지를 찾을 수 없습니다');
        const rec = message.metadata?.[IDENTIFIER]?.images?.[payload.imageId];
        if (!rec) throw new Error('다시 그릴 정보를 찾을 수 없습니다');
        const originalSwipeId = message.swipe_id ?? 0;
        let result;
        try {
          result = await queuedGenerate(api, {
            prompt: rec.prompt, parameters: { characterTags: rec.characterTags },
            owner_chat_id: payload.chatId, includeDataUrl: false,
          });
        } catch (err) {
          throw new Error('다시 그리기 실패: ' + String(err?.message || err));
        }
        // Review finding 1 (same race as processMessage): re-fetch right before writing
        // instead of reusing the message read before the (possibly multi-second) await
        // above. Finding 6: locate the marker with the shared, opaque-id-only regex —
        // and if `.replace()` doesn't actually find it, that's a real failure, not a
        // silent no-op reported as success.
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
          content: newContent, metadata: mergeMetadata(fresh.metadata, currentImages),
        });
        return { ok: true };
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
