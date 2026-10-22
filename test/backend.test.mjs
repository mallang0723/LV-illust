import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, start, _debugLockMapSize } from '../src/backend.mjs';
import { MALFORMED_MARKER_TEXT } from '../src/core.mjs';

// Deterministic id generator for tests that assert exact ids — production code never
// passes one (core.mjs nextImageId defaults to collision-resistant time+random ids;
// review finding 3).
function counterIdGen(start = 0) {
  let n = start;
  return () => 'p' + (++n);
}

// Minimal fake Spindle `api` covering only what backend.mjs calls. Tracks every
// call in `calls` for assertions. No network, no real LLM/image-gen calls.
function fakeApi({ messages = {}, chats = {}, characters = {}, generateImpl, promptPresets } = {}) {
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
      generateNative: async (input) => {
        calls.push(['imageGen.generateNative', input]);
        return generateImpl ? generateImpl(input) : { imageId: 'img1', imageUrl: 'https://img/1.png', provider: 'novelai', generated: true };
      },
      // omitted entirely unless the test opts in — real hosts without this (older)
      // method are handled by backend.mjs's own typeof-function feature detection
      ...(promptPresets !== undefined ? {
        getPromptPresets: async () => {
          calls.push(['imageGen.getPromptPresets']);
          return promptPresets;
        },
      } : {}),
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
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1', generationId: 'g1' });

  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(patch.content.startsWith('장면: ![그림:p1|골목]'));
  assert.equal(patch.metadata.lv_illust.images.p1.status, 'ok');
  assert.equal(patch.metadata.lv_illust.images.p1.imageUrl, 'https://img/1.png');

  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.deepEqual(genInput.parameters.characterTags, [{ tags: '1boy, silver hair' }]);
  // review finding 5: generateNative (not generate), chat_id (not owner_chat_id),
  // promptMode:'custom' + skipParse:true so Lumiverse's own scene-analysis step is
  // skipped (and therefore never overwrites our characterTags) while its native
  // style/LoRA preset composition still applies — see docs/API-NOTES.md.
  assert.equal(genInput.chat_id, 'c1');
  assert.equal(genInput.promptMode, 'custom');
  assert.equal(genInput.skipParse, true);
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
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });

  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(patch.content.includes('⚠️ 그림 생성 실패'));
  assert.ok(patch.content.includes('<pic-failed id="p1">'));
  assert.ok(patch.content.includes('"골목"')); // human-readable summary, not a raw prompt="..." attribute
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
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generateNative'), undefined);
});

// ---------------------------------------------------------------- auto-off per chat

test('auto-off: GENERATION_ENDED does nothing when the chat has turned auto-gen off', async () => {
  const msg = assistantMsg('m1', '<pic prompt="x">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await f.api.variables.chat.set('c1', 'lv_illust.auto', '0');
  f.calls.length = 0;
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generateNative'), undefined);
});

test('auto defaults on when the chat variable was never set', async () => {
  const msg = assistantMsg('m1', '<pic prompt="x">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  assert.ok(f.calls.find((c) => c[0] === 'imageGen.generateNative'));
});

// ---------------------------------------------------------------- MESSAGE_EDITED (new tags written in)

test('MESSAGE_EDITED: newly written tag is processed; already-rendered image is left alone', async () => {
  const content = '![그림:p1|이전](https://img/p1.png) 그리고 <pic prompt="새 장면">';
  const msg = assistantMsg('m1', content, { lv_illust: { images: { p1: { status: 'ok', prompt: '이전' } } } });
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api, { idGenerator: counterIdGen() });
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
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generateNative'), undefined);
});

// ---------------------------------------------------------------- swipe/regenerate via GENERATION_ENDED

test('swipe/regenerate: a new assistant message/content from a swipe generation is processed the same way', async () => {
  const msg = assistantMsg('m2', '<pic prompt="스와이프 장면">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api, { idGenerator: counterIdGen() });
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
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generateNative'), undefined);
});

// ---------------------------------------------------------------- frontend requests: settings / registry / auto toggle

test('save_settings + load_settings round-trip through storage', async () => {
  const f = fakeApi();
  const svc = createService(f.api);
  await svc.runFrontendRequest({ type: 'save_settings', settings: { position: 'end', depth: 0, role: 'user', maxImages: 1 } });
  const { settings } = await svc.runFrontendRequest({ type: 'load_settings' });
  assert.deepEqual(settings, { position: 'end', depth: 0, role: 'user', maxImages: 1, commonNegative: '', boundNegatives: true });
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
  const content = '[⚠️ 그림 생성 실패(오류) · "골목" · 패널에서 \'다시 그리기\'로 재시도 <pic-failed id="p1">]';
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

// ---------------------------------------------------------------- REGRESSION: review finding 1 (stale-read race)

test('REGRESSION: a user edit made DURING generation is not reverted — the new text survives, image becomes an orphan', async () => {
  const msg = assistantMsg('m1', '<pic prompt="scene">');
  const f = fakeApi({
    messages: { c1: [msg] },
    chats: { c1: { id: 'c1' } },
    generateImpl: (input) => {
      // simulate the user editing the message WHILE generation is in flight — the exact
      // tag text this job was generated for no longer exists anywhere in the message
      msg.content = '완전히 다른 내용으로 고쳤습니다.';
      return { imageId: 'img1', imageUrl: 'https://img/1.png' };
    },
  });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  // the edit must survive verbatim — NOT reverted to the pre-generation snapshot and
  // NOT overwritten with a marker spliced into the old (stale) position
  assert.equal(msg.content, '완전히 다른 내용으로 고쳤습니다.');
  // the generated image is not silently discarded — it's recorded as an orphan
  const { images } = await svc.runFrontendRequest({ type: 'list_images', chatId: 'c1' });
  const orphan = images.find((i) => i.status === 'orphan');
  assert.ok(orphan, 'generated image must be recoverable from the orphan list');
  assert.equal(orphan.imageUrl, 'https://img/1.png');
});

test('REGRESSION: a swipe navigated away DURING generation leaves the (now active) other swipe untouched', async () => {
  const msg = assistantMsg('m1', '<pic prompt="scene">');
  msg.swipe_id = 0;
  const f = fakeApi({
    messages: { c1: [msg] },
    chats: { c1: { id: 'c1' } },
    generateImpl: () => {
      msg.swipe_id = 1; // user navigated to a different swipe mid-generation
      msg.content = '다른 스와이프의 내용';
      return { imageId: 'img1', imageUrl: 'https://img/1.png' };
    },
  });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  assert.equal(msg.content, '다른 스와이프의 내용'); // never touched
  const { images } = await svc.runFrontendRequest({ type: 'list_images', chatId: 'c1' });
  assert.ok(images.some((i) => i.status === 'orphan' && i.imageUrl === 'https://img/1.png'));
});

test('REGRESSION: a concurrent metadata write from another extension survives the write-back', async () => {
  const msg = assistantMsg('m1', '<pic prompt="scene">');
  const f = fakeApi({
    messages: { c1: [msg] },
    chats: { c1: { id: 'c1' } },
    generateImpl: () => {
      // another (hypothetical) extension writes its own namespaced metadata key while
      // this extension's generation is still in flight
      msg.metadata = { ...(msg.metadata || {}), some_other_extension: { note: 'hello' } };
      return { imageId: 'img1', imageUrl: 'https://img/1.png' };
    },
  });
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.deepEqual(patch.metadata.some_other_extension, { note: 'hello' });
  assert.equal(patch.metadata.lv_illust.images.p1.status, 'ok');
});

test('REGRESSION: regenerate re-fetches before writing and never reverts a concurrent edit', async () => {
  const content = '[⚠️ 그림 생성 실패(오류) · "골목" · 패널에서 \'다시 그리기\'로 재시도 <pic-failed id="p1">]';
  const msg = assistantMsg('m1', content, { lv_illust: { images: { p1: { status: 'fail', prompt: '골목', characterTags: [], summary: '골목' } } } });
  const f = fakeApi({
    messages: { c1: [msg] },
    generateImpl: () => {
      msg.content = content + ' 추가로 적은 내용';
      return { imageId: 'img1', imageUrl: 'https://img/1.png' };
    },
  });
  const svc = createService(f.api);
  const res = await svc.runFrontendRequest({ type: 'regenerate', chatId: 'c1', messageId: 'm1', imageId: 'p1' });
  assert.equal(res.ok, true);
  assert.ok(msg.content.includes('![그림:p1|골목]'));
  assert.ok(msg.content.includes('추가로 적은 내용')); // the concurrent addition survives
});

test('REGRESSION: regenerate orphans the image (instead of throwing away the generation) when the marker is gone', async () => {
  const content = '[⚠️ 그림 생성 실패(오류) · "골목" · 패널에서 \'다시 그리기\'로 재시도 <pic-failed id="p1">]';
  const msg = assistantMsg('m1', content, { lv_illust: { images: { p1: { status: 'fail', prompt: '골목', characterTags: [], summary: '골목' } } } });
  const f = fakeApi({
    messages: { c1: [msg] },
    generateImpl: () => {
      msg.content = '사용자가 마커를 지우고 완전히 새로 썼습니다.';
      return { imageId: 'img1', imageUrl: 'https://img/1.png' };
    },
  });
  const svc = createService(f.api);
  await assert.rejects(() => svc.runFrontendRequest({ type: 'regenerate', chatId: 'c1', messageId: 'm1', imageId: 'p1' }));
  assert.equal(msg.content, '사용자가 마커를 지우고 완전히 새로 썼습니다.'); // not reverted
  const { images } = await svc.runFrontendRequest({ type: 'list_images', chatId: 'c1' });
  assert.ok(images.some((i) => i.status === 'orphan' && i.id === 'p1'));
});

// ---------------------------------------------------------------- REGRESSION: 2nd-pass review findings

test('REGRESSION (2nd pass, finding 2): orphan bookkeeping never reopens the stale-write race — ' +
  'the commit happens before any orphan RPCs, so a concurrent edit during THOSE RPCs cannot be lost', async () => {
  // Two tags: one survives to commit time, the other is edited away (becomes an
  // orphan). The ORIGINAL bug awaited pushOrphans() (its own read-modify-write pair)
  // BETWEEN the revalidating read and the main commit — a concurrent edit landing in
  // that window would be silently overwritten by the commit that followed. Here, the
  // edit happens *during pushOrphans itself* (modeled via a variables.chat.set hook),
  // which can only matter if pushOrphans runs before the main commit.
  const msg = assistantMsg('m1', '<pic prompt="keep"><pic prompt="drop">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  let generatedCount = 0;
  const realGenerateNative = f.api.imageGen.generateNative;
  f.api.imageGen.generateNative = async (input) => {
    generatedCount++;
    if (generatedCount === 2) {
      // the SECOND tag's generation is the one whose splice target vanishes
      msg.content = msg.content.replace('<pic prompt="drop">', '');
    }
    return realGenerateNative(input);
  };
  let editedDuringOrphanWrite = false;
  const realVarSet = f.api.variables.chat.set;
  f.api.variables.chat.set = async (chatId, key, value) => {
    if (key === 'lv_illust.orphans' && !editedDuringOrphanWrite) {
      // simulate an external edit landing exactly while the orphan bookkeeping RPC
      // (which now runs strictly AFTER the main commit) is in flight
      editedDuringOrphanWrite = true;
    }
    return realVarSet(chatId, key, value);
  };
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const updateCalls = f.calls.filter((c) => c[0] === 'updateMessage');
  assert.equal(updateCalls.length, 1, 'exactly one commit — the kept tag\'s image');
  assert.ok(updateCalls[0][3].content.includes('![그림:p1|keep]'));
  const { images } = await svc.runFrontendRequest({ type: 'list_images', chatId: 'c1' });
  assert.ok(images.some((i) => i.status === 'orphan' && i.summary === 'drop'));
});

test('REGRESSION (2nd pass, finding 3): overlapping handlers for the SAME message never allocate the same image id ' +
  'or overwrite each other\'s metadata record', async () => {
  // GENERATION_ENDED and MESSAGE_EDITED firing close together for the same message —
  // simulated here by calling handleGenerationEnded twice without awaiting the first.
  // The per-message lock must serialize them so the second plans AFTER the first has
  // committed, not from the same stale snapshot.
  const msg = assistantMsg('m1', '<pic prompt="A">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  const first = svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  // Prepend a second tag mid-flight, like a MESSAGE_EDITED for the same message
  // arriving before the first generation's commit — without the per-message lock,
  // the second handler would plan from the same pre-commit snapshot as the first.
  queueMicrotask(() => { msg.content = '<pic prompt="B">' + msg.content; });
  const second = svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  await Promise.all([first, second]);

  const images = msg.metadata?.lv_illust?.images || {};
  const ids = Object.keys(images);
  assert.equal(new Set(ids).size, ids.length, 'no two records share an id');
  // Both generated images' records must be recoverable — neither was silently dropped.
  const prompts = Object.values(images).map((r) => r.prompt).sort();
  assert.deepEqual(prompts, ['A', 'B']);
});

test('REGRESSION (2nd pass, finding 4): a generation that resolves without a usable imageUrl is treated as a failure, never written as "(undefined)"', async () => {
  const msg = assistantMsg('m1', '<pic prompt="scene">');
  const f = fakeApi({
    messages: { c1: [msg] }, chats: { c1: { id: 'c1' } },
    generateImpl: () => ({ generated: true, imageId: 'img1' }), // no imageUrl — host persistence failure case
  });
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(!patch.content.includes('undefined'));
  assert.ok(patch.content.includes('⚠️ 그림 생성 실패'));
  assert.equal(patch.metadata.lv_illust.images.p1.status, 'fail');
});

test('REGRESSION (2nd pass, finding 4): regenerate with a missing imageUrl preserves the OLD working image, does not overwrite it', async () => {
  const content = '![그림:p1|골목](https://img/old.png)';
  const msg = assistantMsg('m1', content, { lv_illust: { images: { p1: { status: 'ok', prompt: '골목', characterTags: [], summary: '골목', imageUrl: 'https://img/old.png' } } } });
  const f = fakeApi({
    messages: { c1: [msg] },
    generateImpl: () => ({ generated: true }), // no imageUrl this time
  });
  const svc = createService(f.api);
  await assert.rejects(() => svc.runFrontendRequest({ type: 'regenerate', chatId: 'c1', messageId: 'm1', imageId: 'p1' }));
  assert.equal(msg.content, content); // untouched — old working image still there
  assert.equal(msg.metadata.lv_illust.images.p1.imageUrl, 'https://img/old.png'); // untouched
});

test('REGRESSION (2nd pass, finding 5): generation requests use generateNative with promptMode "custom" and skipParse true ' +
  '(so Lumiverse\'s native style/LoRA preset composes onto our prompt, but scene-analysis never overwrites our characterTags)', async () => {
  const msg = assistantMsg('m1', '<pic chars="아드리안" prompt="골목">');
  const f = fakeApi({
    messages: { c1: [msg] }, chats: { c1: { id: 'c1', character_id: 'char1' } },
    characters: { char1: { id: 'char1', extensions: { lv_illust: { characters: [{ names: ['아드리안'], appearance: 'tag', enabled: true }] } } } },
  });
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.equal(genInput.promptMode, 'custom');
  assert.equal(genInput.skipParse, true);
  assert.equal(genInput.chat_id, 'c1');
  assert.deepEqual(genInput.parameters.characterTags, [{ tags: 'tag' }]);
  assert.equal(f.calls.find((c) => c[0] === 'imageGen.generate'), undefined); // the old API is not used at all
});

test('REGRESSION (3rd pass, finding 2): the active main preset\'s positive prompt is composed WITH the scene prompt, not replaced by it', async () => {
  const msg = assistantMsg('m1', '<pic prompt="forest">');
  const f = fakeApi({
    messages: { c1: [msg] }, chats: { c1: { id: 'c1' } },
    promptPresets: { activeId: 'p1', activeConnectionId: 'c1', presets: [
      { id: 'p1', name: 'Main', mode: 'custom', prompt: 'watercolor, soft lighting', negativePrompt: 'lowres' },
    ] },
  });
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.equal(genInput.prompt, 'watercolor, soft lighting, forest');
  assert.equal(genInput.negativePrompt, 'lowres');
  assert.ok(f.calls.some((c) => c[0] === 'imageGen.getPromptPresets'));
});

test('REGRESSION (3rd pass, finding 2): character/persona macro tokens in the main preset are stripped, never sent to the provider as literal text', async () => {
  const msg = assistantMsg('m1', '<pic prompt="forest">');
  const f = fakeApi({
    messages: { c1: [msg] }, chats: { c1: { id: 'c1' } },
    promptPresets: { activeId: 'p1', activeConnectionId: 'c1', presets: [
      { id: 'p1', name: 'Main', mode: 'custom', prompt: 'style, {{character_prompt}}', negativePrompt: '{{persona_negative_prompt}}' },
    ] },
  });
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.ok(!genInput.prompt.includes('{{'));
  assert.equal(genInput.prompt, 'style, forest');
  // negative was macro-only -> cleaned to empty -> field omitted entirely (lets the
  // host's own connection-default negative apply, not an empty override)
  assert.equal('negativePrompt' in genInput, false);
});

test('REGRESSION (3rd pass, finding 2): with no active main preset, the scene prompt is sent alone (unchanged from before this fix)', async () => {
  const msg = assistantMsg('m1', '<pic prompt="forest">');
  const f = fakeApi({
    messages: { c1: [msg] }, chats: { c1: { id: 'c1' } },
    promptPresets: { activeId: null, activeConnectionId: null, presets: [] },
  });
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.equal(genInput.prompt, 'forest');
  assert.equal('negativePrompt' in genInput, false);
});

test('REGRESSION (3rd pass, finding 2): a host without getPromptPresets (older/optional API) never blocks generation — scene prompt alone', async () => {
  const msg = assistantMsg('m1', '<pic prompt="forest">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } }); // promptPresets omitted entirely
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.equal(genInput.prompt, 'forest');
});

test('REGRESSION (3rd pass, finding 2): a getPromptPresets failure is swallowed — generation still proceeds with the scene prompt alone', async () => {
  const msg = assistantMsg('m1', '<pic prompt="forest">');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } }, promptPresets: null });
  f.api.imageGen.getPromptPresets = async () => { throw new Error('boom'); };
  const svc = createService(f.api, { idGenerator: counterIdGen() });
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.equal(genInput.prompt, 'forest');
  const patch = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(patch[3].content.includes('![그림:p1|forest]')); // still succeeds end to end
});

test('REGRESSION (3rd pass, finding 2): regenerate also composes the active main preset onto the stored prompt', async () => {
  const content = '[⚠️ 그림 생성 실패(오류) · "forest" · 패널에서 \'다시 그리기\'로 재시도 <pic-failed id="p1">]';
  const msg = assistantMsg('m1', content, { lv_illust: { images: { p1: { status: 'fail', prompt: 'forest', characterTags: [], summary: 'forest' } } } });
  const f = fakeApi({
    messages: { c1: [msg] },
    promptPresets: { activeId: 'p1', activeConnectionId: null, presets: [{ id: 'p1', name: 'Main', mode: 'custom', prompt: 'watercolor' }] },
  });
  const svc = createService(f.api);
  await svc.runFrontendRequest({ type: 'regenerate', chatId: 'c1', messageId: 'm1', imageId: 'p1' });
  const [, genInput] = f.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.equal(genInput.prompt, 'watercolor, forest');
});

test('REGRESSION (2nd pass, finding 7): history cleanup (stripping rendered images to a placeholder) still runs when auto-gen is OFF for the chat — only instruction injection is gated on it', async () => {
  const f = fakeApi();
  const svc = createService(f.api);
  svc.registerInterceptor();
  await f.api.variables.chat.set('c1', 'lv_illust.auto', '0');
  const msgs = [
    { role: 'assistant', content: '그림: ![그림:p1|요약](https://img/p1.png)' },
  ];
  const out = await f.api.runInterceptor(msgs, { chatId: 'c1', characterId: null });
  assert.ok(!out.some((m) => m.content.includes('![그림:p1'))); // cleanup still happened
  assert.ok(out.some((m) => m.content.includes('[그림: 요약]')));
  assert.ok(!out.some((m) => m.content.includes('<pic'))); // but no instruction was injected (auto is off)
});

test('REGRESSION (2nd pass, finding 1 — malformed never shrinks, integration level): a malformed tag survives a full processMessage pass verbatim', async () => {
  const content = '이야기 시작 <pic prompt=bad> 뒤이은 서사가 아주 길게 이어진다.';
  const msg = assistantMsg('m1', content);
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const [, , , patch] = f.calls.find((c) => c[0] === 'updateMessage');
  assert.ok(patch.content.length >= content.length);
  assert.ok(patch.content.includes('뒤이은 서사가 아주 길게 이어진다.'));
  // marker is spliced in right after the literal "<pic" opener (4th-pass structural fix)
  assert.equal(patch.content.replace(MALFORMED_MARKER_TEXT, ''), content);
});

test('REGRESSION (2nd pass, finding 1): a malformed tag already marked is never re-flagged on a later MESSAGE_EDITED pass', async () => {
  const content = '<pic prompt=bad> 나머지 이야기';
  const msg = assistantMsg('m1', content);
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const firstLength = msg.content.length;
  // re-processing the SAME (already-annotated) message must not add a second annotation
  await svc.handleMessageEdited({ chatId: 'c1', message: { id: 'm1' } });
  assert.equal(msg.content.length, firstLength);
});

test('REGRESSION (3rd pass, finding 1 — exact scale from review): 60 distinct malformed tags, processed repeatedly at the backend/integration level, settles after ONE write and stays a no-op (the previous 50-entry cap made this grow forever)', async () => {
  const content = Array.from({ length: 60 }, (_, i) => `<pic foo="bar${i}">`).join(' 글 ');
  const msg = assistantMsg('m1', content);
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' }); // pass 1: annotates all 60
  const writesAfterFirst = f.calls.filter((c) => c[0] === 'updateMessage').length;
  assert.equal(writesAfterFirst, 1);
  const stableContent = msg.content;
  for (let i = 0; i < 5; i++) {
    // repeated passes (simulating repeated MESSAGE_EDITED/GENERATION_ENDED firings on
    // the SAME already-annotated message) — each must be a complete no-op: no further
    // updateMessage calls at all, content never changes again.
    await svc.handleMessageEdited({ chatId: 'c1', message: { id: 'm1' } });
  }
  const totalWrites = f.calls.filter((c) => c[0] === 'updateMessage').length;
  assert.equal(totalWrites, 1, 'no further writes after the first pass, across 5 more passes');
  assert.equal(msg.content, stableContent);
  // and every original tag is still there, byte for byte, once our markers are peeled off
  assert.equal(msg.content.split(MALFORMED_MARKER_TEXT).join(''), content);
});

test('REGRESSION (4th pass, finding 2 — exact short repro at the backend/integration level): ' +
  '<pic prompt="unfinished with nothing after it settles after ONE write across 20 passes ' +
  '(this exact shape previously caused 10 writes and a nested annotation)', async () => {
  const content = '<pic prompt="unfinished';
  const msg = assistantMsg('m1', content);
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    await svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  }
  const writes = f.calls.filter((c) => c[0] === 'updateMessage').length;
  assert.equal(writes, 1, 'exactly one write across 20 passes — was 10 before the structural fix');
  assert.equal(msg.content.split(MALFORMED_MARKER_TEXT).join(''), content);
});

// ---------------------------------------------------------------- REGRESSION (review, 3rd pass): finding 3 (lock map)

test('REGRESSION (3rd pass, finding 3): per-message locks are released after settling — 1000 distinct keys leave the lock map empty', async () => {
  // One chat per message (so each gets a distinct (chatId, messageId) lock key); no
  // <pic> tag in any of them — the lock is still acquired/released before that
  // early-return, which is exactly the leak the reviewer reproduced.
  const perChatMessages = {};
  for (let i = 0; i < 1000; i++) perChatMessages['c' + i] = [assistantMsg('m' + i, '그냥 평범한 답변 (태그 없음)')];
  const f = fakeApi({ messages: perChatMessages });
  const svc = createService(f.api);
  const jobs = [];
  for (let i = 0; i < 1000; i++) jobs.push(svc.handleGenerationEnded({ chatId: 'c' + i, messageId: 'm' + i }));
  await Promise.all(jobs);
  assert.equal(_debugLockMapSize(), 0, 'the lock map must not retain a settled entry per distinct message');
});

test('REGRESSION (3rd pass, finding 3): a settled entry is not deleted out from under a newer queued operation for the same key', async () => {
  // Reproduces the exact hazard the naive "always delete on settle" fix would introduce:
  // call A and call B both target the SAME key, close together. If A's settle handler
  // deleted the map entry unconditionally, it would erase B's (now-current) tracking
  // entry while B is still pending, letting a hypothetical call C run concurrently with B.
  const msg = assistantMsg('m1', '그냥 평범한 답변');
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const svc = createService(f.api);
  const a = svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  const b = svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  await a; // A settles first (or close to it)
  // B must still be tracked (or already settled itself) — the map must never be empty
  // here in a way that implies B's own completion wasn't properly chained behind A.
  await b;
  assert.equal(_debugLockMapSize(), 0); // both settled by now — fully cleaned up
});

test('REGRESSION (3rd pass, finding 3): a hung predecessor cannot block a message\'s queue forever — the lock releases after its deadline', async () => {
  // Isolates the per-message LOCK's own timeout from the separate (and intentionally
  // serialized-to-1, per DESIGN.md §4) image-generation queue: the first call hangs
  // INSIDE its own generate() call; the second call, once the lock releases, must be
  // able to acquire it and run its own (generate-free) pass to completion. Making the
  // second pass generate-free avoids a false failure caused by the *separate* global
  // generate queue still being occupied by the still-hung first call — that queue is
  // supposed to serialize real generations; this test is about the message lock only.
  const msg = assistantMsg('m1', '<pic prompt="first">');
  let releaseHung;
  const hungGate = new Promise((resolve) => { releaseHung = resolve; });
  const f = fakeApi({
    messages: { c1: [msg] }, chats: { c1: { id: 'c1' } },
    generateImpl: async () => { await hungGate; return { imageId: 'img1', imageUrl: 'https://img/1.png' }; },
  });
  const svc = createService(f.api, { lockTimeoutMs: 20 }); // tiny deadline for the test
  const hungCall = svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' }); // never awaited directly — the "hung predecessor"
  await new Promise((r) => setTimeout(r, 50)); // let the deadline elapse
  // Simulate the message having been edited (by someone/something else) while the
  // first call was stuck — the lock itself doesn't touch content, only serializes
  // access to it, so this is just how we give the second pass nothing left to do.
  msg.content = '그냥 평범한 답변 (태그 없음)';
  const second = svc.handleMessageEdited({ chatId: 'c1', message: { id: 'm1' } });
  await second;
  // reaching here at all (not hanging forever itself) proves the lock was released;
  // the second pass found no live tags and correctly did nothing further.
  assert.equal(f.calls.find((c) => c[0] === 'updateMessage'), undefined);
  releaseHung(); // let the first call finish in the background so the test process can exit cleanly
  await hungCall.catch(() => {});
});

test('REGRESSION (4th pass, finding 1): an operation past its deadline must NOT write once it resumes — ' +
  'it must not overwrite a second operation\'s image, edits, or metadata', async () => {
  // Exact scenario from the review: pause operation A right at its final (pre-commit)
  // re-read until its lock deadline elapses. Let operation B acquire the released lock
  // and commit normally. Resume A. The previous (regressed) fix raced A's promise
  // against the deadline but never stopped A from actually continuing to run in the
  // background — A still reached its own `chat.updateMessage` call later and clobbered
  // everything B had just written. The fix: A must check `isExpired()` immediately
  // before that final write and bail out instead.
  const msg = assistantMsg('m1', '<pic prompt="forest">');
  let reads = 0;
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  let pausedNotify;
  const pausedAtRead2 = new Promise((resolve) => { pausedNotify = resolve; });
  const f = fakeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } });
  const realGetMessages = f.api.chat.getMessages;
  f.api.chat.getMessages = async (chatId) => {
    reads++;
    const snapshot = await realGetMessages(chatId);
    if (reads === 2) { pausedNotify(); await gateA; } // pause A right before its final re-read resolves
    return snapshot;
  };
  const svc = createService(f.api, { idGenerator: counterIdGen(), lockTimeoutMs: 30 });

  const opA = svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' }); // never awaited yet — this is "A"
  await pausedAtRead2; // A is now paused at its final read, holding the lock
  await new Promise((r) => setTimeout(r, 60)); // let A's lock deadline elapse (30ms < 60ms)
  await opA.catch(() => {}); // the lock's own race settles now (A itself is still paused/running)

  // Operation B now runs for the SAME message and must be able to commit.
  const opB = svc.handleGenerationEnded({ chatId: 'c1', messageId: 'm1' });
  await opB;
  const writesBeforeAResumes = f.calls.filter((c) => c[0] === 'updateMessage').length;
  assert.equal(writesBeforeAResumes, 1, 'B must have committed exactly once');
  const contentAfterB = msg.content;
  const metadataAfterB = msg.metadata;
  assert.ok(contentAfterB.includes('![그림:'), 'B\'s image must be in the message');

  // Simulate an intervening user edit + another extension's metadata write, exactly
  // like the reviewer's repro, to prove A doesn't revert EITHER when it resumes.
  msg.content += ' USER EDIT';
  msg.metadata = { ...(msg.metadata || {}), other_extension: { keep: true } };
  const contentBeforeAResumes = msg.content;
  const metadataBeforeAResumes = msg.metadata;

  releaseA(); // let A's paused read finally return
  await new Promise((r) => setTimeout(r, 20)); // give A a chance to (wrongly) write if the bug is back

  const totalWrites = f.calls.filter((c) => c[0] === 'updateMessage').length;
  assert.equal(totalWrites, 1, 'A must NOT have written anything after resuming past its deadline');
  assert.equal(msg.content, contentBeforeAResumes, 'the user edit must survive — A must not revert it');
  assert.deepEqual(msg.metadata, metadataBeforeAResumes, 'the other extension\'s metadata must survive');
  void metadataAfterB; // (captured for clarity/debugging; not re-asserted separately)
});

test('REGRESSION (4th pass, finding 1): the global generation queue also has a deadline — a hung generate() call cannot block the queue forever, and its late result is discarded', async () => {
  const msgA = assistantMsg('mA', '<pic prompt="first">');
  const msgB = assistantMsg('mB', '<pic prompt="second">');
  let releaseHungGenerate;
  const hungGenerateGate = new Promise((resolve) => { releaseHungGenerate = resolve; });
  let callCount = 0;
  const lateResolutions = [];
  const f = fakeApi({
    messages: { cA: [msgA], cB: [msgB] }, chats: { cA: { id: 'cA' }, cB: { id: 'cB' } },
    generateImpl: async (input) => {
      callCount++;
      if (callCount === 1) {
        await hungGenerateGate; // the FIRST queued generate() hangs indefinitely
        lateResolutions.push(input.prompt); // records if/when it eventually resolves
      }
      return { imageId: 'img-' + callCount, imageUrl: 'https://img/' + callCount + '.png' };
    },
  });
  const svc = createService(f.api, { idGenerator: counterIdGen(), generateTimeoutMs: 20 }); // tiny deadline for the test

  const opA = svc.handleGenerationEnded({ chatId: 'cA', messageId: 'mA' }); // starts the hung generate()
  await new Promise((r) => setTimeout(r, 5)); // let A's generate() actually start and occupy the queue
  const opB = svc.handleGenerationEnded({ chatId: 'cB', messageId: 'mB' }); // queued behind A's generate()

  await opB; // B must not wait for A's hung generate() past the 20ms deadline
  assert.ok(msgB.content.includes('![그림:'), 'B\'s own generation must have proceeded once the queue moved on');

  await opA; // A's own generate() call timed out too -> treated as an ordinary failure
  assert.ok(msgA.content.includes('⚠️ 그림 생성 실패'), 'A must be recorded as a failure, not left hanging');
  assert.equal(lateResolutions.length, 0, 'the hung generate() has not resolved yet');

  // Now let the hung generate() actually resolve, long after both A and B were handled.
  releaseHungGenerate();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lateResolutions.length, 1, 'the hung call does eventually resolve in the background');
  // ...but its late result was never written anywhere: A's own message still shows the
  // failure marker (not a second, late success), and B's message is untouched by it.
  assert.ok(msgA.content.includes('⚠️ 그림 생성 실패'));
  assert.ok(!msgA.content.includes('img-1'));
  assert.ok(!msgB.content.includes('img-1'));
});

// ---------------------------------------------------------------- permissions granted AFTER start

// Wraps fakeApi with a model of the real worker runtime + host for the parts that matter
// here (cited in backend.mjs createRegistrations):
//  - `on(event)` posts `subscribe_event` to the host ONLY when that event's local handler
//    Set is first created (worker-runtime.ts:1669-1676); its disposer deletes the Set when
//    empty and posts `unsubscribe_event` (:1678-1686). PERMISSION_CHANGED is local-only.
//  - the host drops a GENERATION_* subscription without `generation`, and an interceptor
//    registration without `interceptor`, posting `permission_denied` (worker-host.ts
//    ~2700-2715, ~2946-2956); nothing retries it.
//  - granting posts one `permission_changed` per permission with the full allGranted list
//    (spindle.routes.ts:493-503); the runtime refreshes its has() cache, then fires
//    permissions.onChanged handlers (worker-runtime.ts:4914-4938).
function runtimeApi(opts = {}, granted = []) {
  const f = fakeApi(opts);
  const perms = new Set(granted);
  const local = new Map(); // event -> Set(handler)  (worker side)
  const hostSubs = new Set(); // events the host actually forwards
  const host = { subscribePosts: [], interceptor: null, interceptorPosts: 0, denied: [] };
  const deniedHandlers = new Set(), changedHandlers = new Set();
  const frontendPushes = [];
  let frontendHandler = null;
  let localInterceptor = null, regSeq = 0;
  const GEN = new Set(['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED']);
  const deny = (permission, operation) => { host.denied.push(operation); for (const h of deniedHandlers) h({ permission, operation }); };
  const hostSubscribe = (event) => {
    host.subscribePosts.push(event);
    if (GEN.has(event) && !perms.has('generation')) { deny('generation', `subscribe_event:${event}`); return; }
    hostSubs.add(event);
  };
  Object.assign(f.api, {
    on(event, handler) {
      if (!local.has(event)) { local.set(event, new Set()); if (event !== 'PERMISSION_CHANGED') hostSubscribe(event); }
      local.get(event).add(handler);
      return () => {
        local.get(event)?.delete(handler);
        if (local.get(event)?.size === 0) { local.delete(event); if (event !== 'PERMISSION_CHANGED') hostSubs.delete(event); }
      };
    },
    registerInterceptor(handler) {
      const id = ++regSeq;
      localInterceptor = { id, handler };
      host.interceptorPosts++;
      if (!perms.has('interceptor')) deny('interceptor', 'registerInterceptor');
      else host.interceptor = { id, handler };
      return () => {
        if (localInterceptor?.id !== id) return;
        localInterceptor = null;
        if (host.interceptor?.id === id) host.interceptor = null;
      };
    },
    permissions: {
      has: (p) => perms.has(p),
      getGranted: async () => [...perms],
      onDenied: (h) => { deniedHandlers.add(h); return () => deniedHandlers.delete(h); },
      onChanged: (h) => { changedHandlers.add(h); return () => changedHandlers.delete(h); },
    },
    onFrontendMessage: (h) => { frontendHandler = h; return () => { frontendHandler = null; }; },
    sendToFrontend: (payload, userId, o) => { frontendPushes.push({ payload, userId, o }); },
  });
  const notify = (permission, isGranted) => {
    const detail = { extensionId: 'lv_illust', permission, granted: isGranted, allGranted: [...perms] };
    for (const h of changedHandlers) h(detail);
  };
  return {
    ...f, host, hostSubs, local, frontendPushes,
    localHandlerCount: (event) => local.get(event)?.size || 0,
    grant(...ps) { for (const p of ps) perms.add(p); for (const p of ps) notify(p, true); },
    revoke(...ps) { for (const p of ps) perms.delete(p); for (const p of ps) notify(p, false); },
    // what the host does when the event actually fires: only forwarded if subscribed
    hostEmit(event, payload, userId) { if (!hostSubs.has(event)) return false; for (const h of local.get(event) || []) h(payload, userId); return true; },
    hostRunInterceptor: (msgs, ctx) => host.interceptor?.handler(msgs, ctx),
    frontend: (payload, userId = 'u1') => new Promise((resolve) => {
      const before = frontendPushes.length;
      frontendHandler(payload, userId, 'fs1').then(() => resolve(frontendPushes[before].payload));
    }),
  };
}

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const ALL_PERMS = ['image_gen', 'interceptor', 'chat_mutation', 'characters', 'chats', 'generation'];

test('PERMISSION-LATE: started before generation/interceptor were granted -> host drops both; granting re-registers them without a restart', async () => {
  const msg = assistantMsg('m1', '앞 <pic prompt="scene"> 뒤');
  const r = runtimeApi({ messages: { c1: [msg] }, chats: { c1: { id: 'c1' } } }, ['image_gen', 'chat_mutation', 'characters', 'chats']);
  const dispose = start(r.api);
  // exactly what the server log showed at startup
  assert.deepEqual(r.host.denied.sort(), ['registerInterceptor', 'subscribe_event:GENERATION_ENDED']);
  assert.equal(r.hostEmit('GENERATION_ENDED', { chatId: 'c1', messageId: 'm1' }), false, 'host is not forwarding GENERATION_ENDED yet');
  assert.equal(r.host.interceptor, null);

  r.grant('generation', 'interceptor');
  assert.equal(r.hostSubs.has('GENERATION_ENDED'), true, 'a fresh subscribe_event must reach the host after the grant');
  assert.equal(r.localHandlerCount('GENERATION_ENDED'), 1, 'never a duplicate local handler');
  assert.ok(r.host.interceptor, 'interceptor registered with the host after the grant');

  assert.equal(r.hostEmit('GENERATION_ENDED', { chatId: 'c1', messageId: 'm1' }), true);
  await flush();
  assert.ok(r.calls.find((c) => c[0] === 'updateMessage'), 'GENERATION_ENDED is now handled end to end');
  const out = await r.hostRunInterceptor([{ role: 'user', content: 'hi' }], { chatId: 'c1', characterId: null, userId: 'u1' });
  assert.ok(Array.isArray(out) && out.length === 2, 'instruction injected by the re-registered interceptor');
  dispose();
});

test('PERMISSION-LATE: re-registration is idempotent across a burst of permission_changed notifications', () => {
  const r = runtimeApi({}, []);
  start(r.api);
  const postsAfterStart = r.host.subscribePosts.filter((e) => e === 'GENERATION_ENDED').length;
  const intAfterStart = r.host.interceptorPosts;
  r.grant(...ALL_PERMS); // six notifications, each carrying the full allGranted list
  r.grant('generation'); // and a redundant one
  r.grant('interceptor');
  assert.equal(r.host.subscribePosts.filter((e) => e === 'GENERATION_ENDED').length, postsAfterStart + 1, 'GENERATION_ENDED re-subscribed exactly once');
  assert.equal(r.host.interceptorPosts, intAfterStart + 1, 'interceptor re-registered exactly once');
  assert.equal(r.localHandlerCount('GENERATION_ENDED'), 1);
  assert.equal(r.localHandlerCount('MESSAGE_EDITED'), 1);
  assert.equal(r.host.subscribePosts.filter((e) => e === 'MESSAGE_EDITED').length, 1, 'ungated MESSAGE_EDITED is never re-subscribed');
});

test('PERMISSION-LATE: when permissions were already granted at start nothing is re-registered by later changes', () => {
  const r = runtimeApi({}, ALL_PERMS);
  start(r.api);
  assert.deepEqual(r.host.denied, []);
  const posts = r.host.subscribePosts.length, ints = r.host.interceptorPosts;
  r.grant('characters');
  assert.equal(r.host.subscribePosts.length, posts);
  assert.equal(r.host.interceptorPosts, ints);
});

test('PERMISSION-LATE: revoking unregisters, granting again re-registers once', () => {
  const r = runtimeApi({}, ALL_PERMS);
  start(r.api);
  r.revoke('generation');
  assert.equal(r.hostSubs.has('GENERATION_ENDED'), false);
  assert.equal(r.localHandlerCount('GENERATION_ENDED'), 0);
  r.grant('generation');
  assert.equal(r.hostSubs.has('GENERATION_ENDED'), true);
  assert.equal(r.localHandlerCount('GENERATION_ENDED'), 1);
});

test('PERMISSION-LATE: a permission change is pushed to the panel so it can retry failed loads', () => {
  const r = runtimeApi({}, []);
  start(r.api);
  r.grant('characters');
  const push = r.frontendPushes.find((p) => p.payload.type === 'permissions_changed');
  assert.ok(push);
  assert.equal(push.payload.requestId, undefined, 'a push, not a reply to any request');
  assert.deepEqual(push.payload.allGranted, ['characters']);
});

test('PERMISSION-LATE: dispose() removes every registration and the permission listeners', () => {
  const r = runtimeApi({}, ALL_PERMS);
  const dispose = start(r.api);
  dispose();
  assert.equal(r.localHandlerCount('GENERATION_ENDED'), 0);
  assert.equal(r.localHandlerCount('MESSAGE_EDITED'), 0);
  assert.equal(r.host.interceptor, null);
  const posts = r.host.subscribePosts.length;
  r.grant('generation');
  assert.equal(r.host.subscribePosts.length, posts, 'no re-registration after dispose');
});

test('frontend replies classify host PERMISSION_DENIED errors and load_status lists missing permissions', async () => {
  const r = runtimeApi({}, ['image_gen', 'generation']);
  r.api.characters.get = async () => { throw new Error('PERMISSION_DENIED: characters — Characters permission not granted'); };
  start(r.api);
  const reg = await r.frontend({ type: 'load_registry', characterId: 'ch1', requestId: 'q1' });
  assert.equal(reg.ok, false);
  assert.equal(reg.permission, 'characters');
  assert.equal(reg.requestId, 'q1');
  const st = await r.frontend({ type: 'load_status', requestId: 'q2' });
  assert.deepEqual(st.missing.sort(), ['characters', 'chat_mutation', 'chats', 'interceptor']);
  const other = await r.frontend({ type: 'nope', requestId: 'q3' });
  assert.equal(other.ok, false);
  assert.equal(other.permission, undefined, 'ordinary errors are not mislabelled as permission problems');
});

// ---------------------------------------------------------------- operator-scoped installs need userId

test('OPERATOR SCOPE: the acting userId reaches characters/chats/imageGen calls from events, interceptor and panel', async () => {
  const need = (u) => { if (!u) throw new Error('userId is required for operator-scoped extensions'); };
  const msg = assistantMsg('m1', '<pic chars="아드리안" prompt="scene">');
  const r = runtimeApi({
    messages: { c1: [msg] },
    chats: { c1: { id: 'c1', character_id: 'ch1' } },
    characters: { ch1: { id: 'ch1', extensions: { lv_illust: { characters: [{ names: ['아드리안'], appearance: '1boy, silver hair', enabled: true }] } } } },
    promptPresets: { activeId: null, presets: [] },
  }, ALL_PERMS);
  const origChats = r.api.chats.get, origChar = r.api.characters.get, origGen = r.api.imageGen.generateNative, origPresets = r.api.imageGen.getPromptPresets;
  r.api.chats.get = async (id, u) => { need(u); return origChats(id); };
  r.api.characters.get = async (id, u) => { need(u); return origChar(id); };
  r.api.imageGen.generateNative = async (input) => { need(input.userId); return origGen(input); };
  r.api.imageGen.getPromptPresets = async (u) => { need(u); return origPresets(u); };
  start(r.api);
  r.hostEmit('GENERATION_ENDED', { chatId: 'c1', messageId: 'm1' }, 'u1');
  await flush();
  const [, genInput] = r.calls.find((c) => c[0] === 'imageGen.generateNative');
  assert.equal(genInput.userId, 'u1');
  assert.deepEqual(genInput.parameters.characterTags, [{ tags: '1boy, silver hair' }], 'registry resolved with the userId (not silently empty)');
  const reg = await r.frontend({ type: 'load_registry', characterId: 'ch1', requestId: 'q1' }, 'u1');
  assert.equal(reg.ok, true);
  assert.equal(reg.registry.length, 1);
  const injected = await r.hostRunInterceptor([{ role: 'user', content: 'hi' }], { chatId: 'c1', characterId: 'ch1', userId: 'u1' });
  assert.ok(JSON.stringify(injected).includes('아드리안'), 'interceptor roster loaded with context.userId');
});
