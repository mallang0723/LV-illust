// LV-AutoPic backend worker.
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
  normalizeSettings, normalizeRegistry, planMessage, applyMarkers,
  renderSuccessMarker, renderFailureMarker, stripRenderedImages, hasLiveTags,
  injectInstruction, IDENTIFIER,
} from './core.mjs';

const SETTINGS_PATH = 'settings.json';
const AUTO_VAR_KEY = 'lv_autopic.auto';

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
  // Scan rendered-image ids already present across the chat so new ids never collide,
  // even across different messages (ids only need to be unique within a message, but
  // keeping them globally distinct makes debugging/metadata lookups simpler).
  const ids = [];
  const re = /!\[그림:([a-z0-9]+)\|/g;
  for (const m of messages || []) {
    let mm;
    re.lastIndex = 0;
    while ((mm = re.exec(m?.content || ''))) ids.push(mm[1]);
  }
  return ids;
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
      const result = await api.imageGen.generate({
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
    const message = payload?.message;
    const chatId = payload?.chatId;
    if (!message || !chatId || message.is_user) return;
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
      return withInstruction.map((m) => ({ ...m, content: stripRenderedImages(m.content) }));
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
          const result = await api.imageGen.generate({
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
  offs.push(api.on('GENERATION_ENDED', (payload) => { service.handleGenerationEnded(payload).catch((e) => console.error('[lv_autopic]', e)); }));
  offs.push(api.on('MESSAGE_EDITED', (payload) => { service.handleMessageEdited(payload).catch((e) => console.error('[lv_autopic]', e)); }));
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
