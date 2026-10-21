import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, start } from '../src/backend.mjs';

// Minimal fake Spindle `api` covering only what backend.mjs calls. Tracks every
// call in `calls` for assertions. No network, no real LLM/image-gen calls.
function fakeApi({ messages = {}, chats = {}, characters = {}, generateImpl } = {}) {
  const calls = [];
  const storage = {};
  const chatVars = {};
  let interceptorHandler;
  const onHandlers = {};
  const api = {
    on: (event, handler) => { (onHandlers[event] ||= []).push(handler); return () => {}; },
    registerInterceptor: (handler) => { interceptorHandler = handler; return () => {}; },
    onFrontendMessage: () => () => {},
    sendToFrontend: () => {},
    emit: (event, payload) => { for (const h of onHandlers[event] || []) h(payload); },
    runInterceptor: (msgs, ctx) => interceptorHandler(msgs, ctx),
    storage: {
      getJson: async (path, { fallback } = {}) => (path in storage ? storage[path] : fallback),
      setJson: async (path, value) => { storage[path] = value; calls.push(['storage.setJson', path, value]); },
    },
    variables: {
      chat: {
        has: async (chatId, key) => Object.prototype.hasOwnProperty.call(chatVars, chatId + ':' + key),
        get: async (chatId, key) => chatVars[chatId + ':' + key],
        set: async (chatId, key, value) => { chatVars[chatId + ':' + key] = value; calls.push(['var.set', chatId, key, value]); },
      },
    },
    chats: { get: async (chatId) => chats[chatId] || null },
    characters: {
      get: async (id) => characters[id] || null,
      update: async (id, input) => {
        calls.push(['characters.update', id, input]);
        characters[id] = { ...(characters[id] || { id }), extensions: { ...(characters[id]?.extensions || {}), ...input.extensions } };
        return characters[id];
      },
    },
    chat: {
      getMessages: async (chatId) => messages[chatId] || [],
      updateMessage: async (chatId, messageId, patch) => {
        calls.push(['updateMessage', chatId, messageId, patch]);
        const list = messages[chatId] || [];
        const m = list.find((x) => x.id === messageId);
        if (m) {
          if (patch.content !== undefined) m.content = patch.content;
          if (patch.metadata !== undefined) m.metadata = patch.metadata;
        }
      },
    },
    imageGen: {
      generate: async (input) => {
        calls.push(['imageGen.generate', input]);
        return generateImpl ? generateImpl(input) : { imageId: 'img1', imageUrl: 'https://img/1.png', model: 'nai', provider: 'novelai' };
      },
    },
  };
  return { api, calls, storage, chatVars };
}

function assistantMsg(id, content, metadata) {
  return { id, role: 'assistant', is_user: false, content, metadata };
}

// ---------------------------------------------------------------- GENERATION_ENDED: success

test('GENERATION_ENDED success: tag replaced with rendered image, metadata recorded', async () => {
  const msg = assistantMsg('m1', '장면: <pic chars="아드리안" prompt="골목">');
  const f = fakeApi({
    messages: { c1: [msg] },
    chats: { c1: { id: 'c1', character_id: 'char1' } },
    characters: { char1: { id: 'char1', extensions: { lv_illust: { characters: [
      { names: ['아드리안'], appearance: '1boy, silver hair', enabled: true },
    ] } } } },
  });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1', generationId: 'g1' });

  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(patch.content.startsWith('장면: ![그림:p1|골목]'));
  assert.equal(patch.metadata.lv_illust.images.p1.status, 'ok');
  assert.equal(patch.metadata.lv_illust.images.p1.imageUrl, 'https://img/1.png');

  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generate');
  assert.deepEqual(genInput.parameters.characterTags, [{ tags: '1boy, silver hair' }]);
  assert.equal(genInput.owner_chat_id, 'c1');
  assert.equal(genInput.includeDataUrl, false);
});

// ---------------------------------------------------------------- GENERATION_ENDED: failure

test('GENERATION_ENDED failure: visible failure marker, original tag info kept in metadata for regenerate', async () => {
  const msg = assistantMsg('m1', '<pic chars="아드리안" prompt="골목">');
  const f = fakeApi({
    messages: { c1: [msg] },
    chats: { c1: { id: 'c1', character_id: 'char1' } },
    generateImpl: () => { throw new Error('연결 실패'); },
  });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });

  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(patch.content.includes('⚠️ 그림 생성 실패'));
  assert.ok(patch.content.includes('pic-failed id="p1"'));
  assert.ok(patch.content.includes('prompt="골목"'));
  assert.equal(patch.metadata.lv_illust.images.p1.status, 'fail');
  // "아드리안" isn't in any registry here (no character/registry set up for this test),
  // so it passes through as an extra prompt fragment rather than a characterTags entry.
  assert.equal(patch.metadata.lv_illust.images.p1.prompt, '골목, 아드리안');
});

// ---------------------------------------------------------------- GENERATION_ENDED: no tags -> no-op

test('GENERATION_ENDED: message with no <pic> tag never calls updateMessage', async () => {
  const msg = assistantMsg('m1', '그냥 평범한 답변');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1', character_id: 'char1' } } });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  assert.equal(f.calls.find((c) => c[0] === 'updateMessage'), undefined);
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generate'), undefined);
});

// ---------------------------------------------------------------- auto-off per chat

test('auto-off: GENERATION_ENDED does nothing when the chat has turned auto-gen off', async () => {
  const msg = assistantMsg('m1', '<pic prompt="x">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await f.api.variables.chat.set('c1', 'lv_illust.auto', '0');
  f.calls.length = 0;
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generate'), undefined);
});

test('auto defaults on when the chat variable was never set', async () => {
  const msg = assistantMsg('m1', '<pic prompt="x">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  assert.ok(f.calls.find((c) => c[0] === 'imageGen.generate'));
});

// ---------------------------------------------------------------- MESSAGE_EDITED (new tags written in)

test('MESSAGE_EDITED: newly written tag is processed; already-rendered image is left alone', async () => {
  const content = '![그림:p1|이전](https://img/p1.png) 그리고 <pic prompt="새 장면">';
  const msg = assistantMsg('m1', content, { lv_illust: { images: { p1: { status: 'ok', prompt: '이전' } } } });
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await svc.handleMessageEdited({ chatId: 'c1', message: msg });

  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(patch.content.includes('![그림:p1|이전]')); // untouched
  assert.ok(patch.content.includes('![그림:p2|새 장면]')); // newly generated, new id avoids collision
  assert.ok(patch.metadata.lv_illust.images.p1); // old record preserved
  assert.ok(patch.metadata.lv_illust.images.p2); // new record added
});

test('MESSAGE_EDITED: ignored for user messages', async () => {
  const msg = { id: 'm1', role: 'user', is_user: true, content: '<pic prompt="x">' };
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await svc.handleMessageEdited({ chatId: 'c1', message: msg });
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generate'), undefined);
});

// ---------------------------------------------------------------- swipe/regenerate via GENERATION_ENDED

test('swipe/regenerate: a new assistant message/content from a swipe generation is processed the same way', async () => {
  const msg = assistantMsg('m2', '<pic prompt="스와이프 장면">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm2', generationType: 'swipe' });
  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(patch.content.includes('![그림:p1|스와이프 장면]'));
});

// ---------------------------------------------------------------- concurrency-1 queue

test('generation requests are serialized to concurrency 1 even across overlapping GENERATION_ENDED calls', async () => {
  const order = [];
  const gates = []; // one deferred per call, resolved manually to control interleaving
  const f = fakeApi({
    messages: {
      c1: [assistantMsg('m1', '<pic prompt="first">')],
      c2: [assistantMsg('m2', '<pic prompt="second">')],
    },
    chats: { c1: { id: 'c1' }, c2: { id: 'c2' } },
    generateImpl: (input) => new Promise((resolve) => {
      order.push('start:' + input.prompt);
      gates.push(() => { order.push('end:' + input.prompt); resolve({ imageId: 'i', imageUrl: 'u' }); });
    }),
  });
  const svc = createService(f.api);
  const p1 = svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const p2 = svc.handleGenerationEnded({ chatId: 'c2', messageId: 'm2' });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  // Only the first job has started — the second must wait for the queue, not run concurrently.
  assert.deepEqual(order, ['start:first']);
  gates[0]();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second']);
  gates[1]();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
});

// ---------------------------------------------------------------- interceptor: multimodal (array) content guard

test('interceptor: array-shaped message content (multimodal turn) is passed through untouched, not stringified', async () => {
  const f = fakeApi();
  const svc = createService(f.api);
  svc.registerInterceptor();
  const partContent = [{ type: 'text', text: 'hi' }, { type: 'image', data: 'xx', mime_type: 'image/png' }];
  const msgs = [{ role: 'user', content: partContent }];
  const out = await f.api.runInterceptor(msgs, { chatId: 'c1', characterId: null });
  const passed = out.find((m) => m.role === 'user');
  assert.equal(passed.content, partContent); // same reference, not String(partContent)
});

// ---------------------------------------------------------------- MESSAGE_EDITED re-fetches instead of trusting the raw payload

test('MESSAGE_EDITED: ignores a user-authored row even if the raw payload lacks is_user (re-fetched and re-checked via getMessages)', async () => {
  const msg = { id: 'm1', role: 'user', is_user: true, content: '<pic prompt="x">' };
  const f = fakeApi({ messages: { c1: [msg] } });
  const svc = createService(f.api);
  await svc.handleMessageEdited({ chatId: 'c1', message: { id: 'm1' } }); // minimal raw payload, no is_user/content
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generate'), undefined);
});

// ---------------------------------------------------------------- frontend requests: settings / registry / auto toggle

test('save_settings + load_settings round-trip through storage', async () => {
  const f = fakeApi();
  const svc = createService(f.api);
  await svc.runFrontendRequest({ type: 'save_settings', settings: { position: 'end', depth: 0, role: 'user', maxImages: 1 } });
  const { settings } = await svc.runFrontendRequest({ type: 'load_settings' });
  assert.deepEqual(settings, { position: 'end', depth: 0, role: 'user', maxImages: 1 });
});

test('save_registry + load_registry round-trip through character extensions, never pre-seeded', async () => {
  const f = fakeApi({ characters: { char1: { id: 'char1', extensions: {} } } });
  const svc = createService(f.api);
  const empty = await svc.runFrontendRequest({ type: 'load_registry', characterId: 'char1' });
  assert.deepEqual(empty.registry, []);
  await svc.runFrontendRequest({ type: 'save_registry', characterId: 'char1', registry: [{ names: ['아드리안'], appearance: 'x', enabled: true }] });
  const { registry } = await svc.runFrontendRequest({ type: 'load_registry', characterId: 'char1' });
  assert.equal(registry.length, 1);
  assert.equal(registry[0].names[0], '아드리안');
});

test('list_images: collects every recorded image across the chat\'s messages', async () => {
  const m1 = assistantMsg('m1', '![그림:p1|a](url1)', { lv_illust: { images: { p1: { status: 'ok', summary: 'a', imageUrl: 'url1' } } } });
  const m2 = assistantMsg('m2', 'no image here');
  const f = fakeApi({ messages: { c1: [m1, m2] } });
  const svc = createService(f.api);
  const { images } = await svc.runFrontendRequest({ type: 'list_images', chatId: 'c1' });
  assert.deepEqual(images, [{ id: 'p1', messageId: 'm1', status: 'ok', summary: 'a', imageUrl: 'url1' }]);
});

test('set_auto / load_auto round-trip per chat', async () => {
  const f = fakeApi();
  const svc = createService(f.api);
  assert.equal((await svc.runFrontendRequest({ type: 'load_auto', chatId: 'c1' })).auto, true);
  await svc.runFrontendRequest({ type: 'set_auto', chatId: 'c1', on: false });
  assert.equal((await svc.runFrontendRequest({ type: 'load_auto', chatId: 'c1' })).auto, false);
});

// ---------------------------------------------------------------- regenerate (F6)

test('regenerate: re-runs generation for a stored record and replaces the failure marker with a rendered image', async () => {
  const content = '[⚠️ 그림 생성 실패(오류) · 패널에서 \'다시 그리기\'로 재시도 <pic-failed id="p1" prompt="골목">]';
  const msg = assistantMsg('m1', content, { lv_illust: { images: { p1: { status: 'fail', prompt: '골목', characterTags: [], summary: '골목' } } } });
  const f = fakeApi({ messages: { c1: [msg] } });
  const svc = createService(f.api);
  const res = await svc.runFrontendRequest({ type: 'regenerate', chatId: 'c1', messageId: 'm1', imageId: 'p1' });
  assert.equal(res.ok, true);
  assert.ok(msg.content.includes('![그림:p1|골목]'));
  assert.equal(msg.metadata.lv_illust.images.p1.status, 'ok');
});

test('regenerate: missing record throws a clear error instead of silently doing nothing', async () => {
  const msg = assistantMsg('m1', 'no tags here');
  const f = fakeApi({ messages: { c1: [msg] } });
  const svc = createService(f.api);
  await assert.rejects(() => svc.runFrontendRequest({ type: 'regenerate', chatId: 'c1', messageId: 'm1', imageId: 'pX' }));
});

// ---------------------------------------------------------------- interceptor (F1): instruction injection + history rewrite

test('interceptor: injects instruction message and rewrites rendered images in history when auto is on', async () => {
  const f = fakeApi({ characters: { char1: { id: 'char1', extensions: { lv_illust: { characters: [
    { names: ['아드리안'], appearance: 'x', enabled: true },
  ] } } } } });
  const svc = createService(f.api);
  svc.registerInterceptor();
  const msgs = [
    { role: 'user', content: '안녕' },
    { role: 'assistant', content: '그림: ![그림:p1|요약](https://img/p1.png)' },
  ];
  const out = await f.api.runInterceptor(msgs, { chatId: 'c1', characterId: 'char1' });
  assert.ok(out.some((m) => m.content.includes('<pic')));
  assert.ok(out.some((m) => m.content.includes('[그림: 요약]')));
  assert.ok(!out.some((m) => m.content.includes('![그림:p1')));
});

test('interceptor: auto-off for the chat skips instruction injection entirely', async () => {
  const f = fakeApi();
  const svc = createService(f.api);
  svc.registerInterceptor();
  await f.api.variables.chat.set('c1', 'lv_illust.auto', '0');
  const msgs = [{ role: 'user', content: '안녕' }];
  const out = await f.api.runInterceptor(msgs, { chatId: 'c1', characterId: null });
  assert.deepEqual(out, msgs);
});

// ---------------------------------------------------------------- start() wiring smoke test

test('start(): wires GENERATION_ENDED, MESSAGE_EDITED, interceptor and frontend channel without throwing', () => {
  const f = fakeApi();
  const dispose = start(f.api);
  assert.equal(typeof dispose, 'function');
  dispose();
});
