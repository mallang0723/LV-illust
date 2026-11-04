import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/backend.mjs';
import { normalizeSettings } from '../src/core.mjs';
import { postGalleryLink } from '../src/frontend.mjs';

function galleryHarness({ auto = false, chat = { character_id: 'character', metadata: {} }, imageId = 'image', failure } = {}) {
  const stored = { 'settings.json': { autoSaveGallery: auto } };
  const messages = [{ id: 'message', role: 'assistant', content: '<pic prompt="forest">' }];
  const gallery = [], pushes = [], users = [];
  const api = {
    storage: {
      getJson: async (path, { fallback } = {}) => structuredClone(stored[path] ?? fallback),
      setJson: async (path, value) => {
        if (failure === 'storage' && path.startsWith('gallery-')) throw Error('disk');
        stored[path] = structuredClone(value);
      },
    },
    variables: { chat: { has: async () => false, get: async () => '', set: async () => {} } },
    chats: { get: async (id, user) => { users.push(user); if (failure === 'chat') throw Error('lookup'); return chat; } },
    characters: {
      get: async () => ({}),
      getGallery: async (id, user) => { users.push(user); if (failure === 'gallery') throw Error('denied'); return gallery; },
    },
    chat: { getMessages: async () => messages, updateMessage: async (chatId, id, patch) => Object.assign(messages[0], patch) },
    imageGen: { generateNative: async () => ({ imageId, imageUrl: '/api/v1/images/image' }) },
    sendToFrontend: (payload, user) => pushes.push({ ...payload, user }),
  };
  const service = createService(api, { idGenerator: () => 'p1' });
  const request = (payload, user = 'user-a') => service.runFrontendRequest(payload, user);
  const generate = () => service.handleGenerationEnded({ chatId: 'chat', messageId: 'message' }, 'user-a');
  return { api, stored, messages, gallery, pushes, users, request, generate };
}

test('gallery opt-in defaults OFF and accepts only boolean true', () => {
  for (const value of [undefined, false, 'true', 1, null]) assert.equal(normalizeSettings({ autoSaveGallery: value }).autoSaveGallery, false);
  assert.equal(normalizeSettings({ autoSaveGallery: true }).autoSaveGallery, true);
});

test('auto-save OFF delivers illustration without queued work', async () => {
  const h = galleryHarness();
  await h.generate();
  assert.match(h.messages[0].content, /!\[그림:/);
  assert.deepEqual((await h.request({ type: 'gallery_pending' })).jobs, []);
  assert.equal(h.pushes.length, 0);
});

test('auto-save ON queues a generated image, survives service restart, and isolates users', async () => {
  const h = galleryHarness({ auto: true });
  await h.generate();
  const expected = [{ chatId: 'chat', characterId: 'character', imageId: 'image' }];
  assert.deepEqual((await h.request({ type: 'gallery_pending' })).jobs, expected);
  assert.deepEqual((await h.request({ type: 'gallery_pending' }, 'user-b')).jobs, []);
  const restarted = createService(h.api);
  assert.deepEqual((await restarted.runFrontendRequest({ type: 'gallery_pending' }, 'user-a')).jobs, expected);
  assert.ok(h.pushes.some((p) => p.type === 'gallery_pending' && p.user === 'user-a'));
  assert.ok(h.users.every((user) => user === 'user-a'));
});

test('auto-save also covers regenerate and exposes actual image IDs to the panel', async () => {
  const h = galleryHarness({ auto: true });
  await h.generate();
  h.api.imageGen.generateNative = async () => ({ imageId: 'regenerated', imageUrl: '/api/v1/images/regenerated' });
  await h.request({ type: 'regenerate', chatId: 'chat', messageId: 'message', imageId: 'p1' });
  const pending = (await h.request({ type: 'gallery_pending' })).jobs;
  assert.deepEqual(pending.map((p) => p.imageId), ['image', 'regenerated']);
  const { images } = await h.request({ type: 'list_images', chatId: 'chat' });
  assert.equal(images[0].imageId, 'regenerated');
  assert.equal(images[0].id, 'p1');
});

for (const [name, chat] of [
  ['no character', { character_id: null }],
  ['group with representative character', { character_id: 'character', metadata: { group: true } }],
]) {
  test(`${name}: explains unavailable state and never queues or claims a link`, async () => {
    const h = galleryHarness({ auto: true, chat });
    await h.generate();
    assert.deepEqual((await h.request({ type: 'gallery_pending' })).jobs, []);
    const state = await h.request({ type: 'load_gallery', chatId: 'chat' });
    assert.equal(state.characterId, null);
    assert.match(state.reason, /저장할 수 없습니다/);
    await assert.rejects(h.request({ type: 'prepare_gallery', chatId: 'chat', imageId: 'image' }), /저장할 수 없습니다/);
  });
}

test('URL-only generation delivers normally without gallery work', async () => {
  const h = galleryHarness({ auto: true, imageId: '' });
  await h.generate();
  assert.match(h.messages[0].content, /!\[그림:/);
  assert.deepEqual((await h.request({ type: 'gallery_pending' })).jobs, []);
});

for (const failure of ['storage', 'chat', 'gallery']) {
  test(`gallery ${failure} failure cannot break illustration delivery`, async () => {
    const h = galleryHarness({ auto: true, failure });
    await h.generate();
    await h.request({ type: 'gallery_pending' });
    assert.match(h.messages[0].content, /!\[그림:/);
    assert.equal(h.messages[0].metadata.lv_illust.images.p1.status, 'ok');
    if (failure === 'gallery') await assert.rejects(h.request({ type: 'prepare_gallery', chatId: 'chat', imageId: 'image' }), /denied/);
    else assert.ok(h.pushes.some((p) => p.type === 'gallery_error'));
  });
}

test('gallery I/O can hang without holding up message delivery', async () => {
  const h = galleryHarness({ auto: true });
  let release;
  h.api.storage.setJson = () => new Promise((resolve) => { release = resolve; });
  await h.generate();
  assert.equal(h.messages[0].metadata.lv_illust.images.p1.status, 'ok');
  release();
  await h.request({ type: 'gallery_pending' });
});

test('existing gallery link is deduped and removes pending work', async () => {
  const h = galleryHarness({ auto: true });
  await h.generate();
  h.gallery.push({ image_id: 'image' });
  const claim = await h.request({ type: 'prepare_gallery', chatId: 'chat', imageId: 'image' });
  assert.equal(claim.saved, true);
  assert.equal(claim.token, undefined);
  assert.deepEqual((await h.request({ type: 'gallery_pending' })).jobs, []);
});

test('concurrent claims are serialized, failure releases claim, success is verified and deduped', async () => {
  const h = galleryHarness({ auto: true });
  await h.generate();
  const payload = { type: 'prepare_gallery', chatId: 'chat', imageId: 'image' };
  const results = await Promise.allSettled([h.request(payload), h.request(payload)]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  let claim = results[0].value;
  await h.request({ type: 'finish_gallery', ...claim, saved: false });
  assert.equal((await h.request({ type: 'gallery_pending' })).jobs.length, 1);
  claim = await h.request(payload);
  await assert.rejects(h.request({ type: 'finish_gallery', ...claim, saved: true }), /확인하지 못했습니다/);
  claim = await h.request(payload);
  h.gallery.push({ image_id: 'image' });
  await h.request({ type: 'finish_gallery', ...claim, saved: true });
  assert.deepEqual((await h.request({ type: 'gallery_pending' })).jobs, []);
  assert.equal((await h.request(payload)).saved, true);
});

test('manual save accepts recorded images and orphans, rejects unrelated IDs', async () => {
  const h = galleryHarness();
  await h.generate();
  assert.ok((await h.request({ type: 'prepare_gallery', chatId: 'chat', imageId: 'image' })).token);
  h.api.variables.chat.has = async () => true;
  h.api.variables.chat.get = async () => JSON.stringify([{ imageId: 'orphan' }]);
  assert.ok((await h.request({ type: 'prepare_gallery', chatId: 'chat', imageId: 'orphan' })).token);
  await assert.rejects(h.request({ type: 'prepare_gallery', chatId: 'chat', imageId: 'unknown' }), /찾을 수 없습니다/);
});

test('REST link uses encoded same-origin path, session cookies, and image_id', async () => {
  await postGalleryLink('card/a', 'image', { fetchImpl: async (url, options) => {
    assert.equal(url, '/api/v1/characters/card%2Fa/gallery/link');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'include');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { image_id: 'image' });
    return { ok: true };
  } });
});
for (const status of [401, 403, 404, 500]) {
  test(`REST ${status} produces a Korean error`, async () => {
    await assert.rejects(postGalleryLink('card', 'image', { fetchImpl: async () => ({ ok: false, status }) }), new RegExp(`갤러리 저장 실패.*${status}`));
  });
}
test('REST network failure produces a Korean error', async () => {
  await assert.rejects(postGalleryLink('card', 'image', { fetchImpl: async () => { throw Error('offline'); } }), /서버에 연결하지 못했습니다/);
});
