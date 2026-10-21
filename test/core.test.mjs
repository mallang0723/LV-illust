import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core.mjs';

// ---------------------------------------------------------------- tag parsing

test('parseTags: finds a well-formed tag with chars + prompt', () => {
  const content = '그 순간 <pic chars="아드리안, 정수빈" prompt="골목, 저녁"> 둘이 마주쳤다.';
  const tags = C.parseTags(content);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].malformed, false);
  assert.equal(tags[0].charsRaw, '아드리안, 정수빈');
  assert.equal(tags[0].promptRaw, '골목, 저녁');
  assert.equal(content.slice(tags[0].start, tags[0].end), tags[0].raw);
});

test('parseTags: Korean text inside quotes is preserved verbatim', () => {
  const tags = C.parseTags('<pic chars="한글 이름" prompt="한글 묘사, 쉼표 포함">');
  assert.equal(tags[0].charsRaw, '한글 이름');
  assert.equal(tags[0].promptRaw, '한글 묘사, 쉼표 포함');
});

test('parseTags: tag with only prompt (scene-only picture) is valid, not malformed', () => {
  const tags = C.parseTags('<pic prompt="빈 골목">');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].malformed, false);
  assert.equal(tags[0].charsRaw, '');
});

test('parseTags: tag with neither chars nor prompt is malformed', () => {
  const tags = C.parseTags('<pic foo="bar">');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].malformed, true);
});

test('parseTags: unterminated tag (missing closing >) is malformed, original text recoverable', () => {
  const content = '앞 <pic chars="아드리안" prompt="끝나지 않음 다음 문장이 이어짐';
  const tags = C.parseTags(content);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].malformed, true);
  assert.ok(tags[0].raw.includes('아드리안'));
});

test('parseTags: unterminated tag stops at the next < so later valid tags still parse', () => {
  const content = '<pic chars="broken prompt="x <pic chars="a" prompt="b">';
  const tags = C.parseTags(content);
  assert.equal(tags.length, 2);
  assert.equal(tags[0].malformed, true);
  assert.equal(tags[1].malformed, false);
  assert.equal(tags[1].charsRaw, 'a');
});

test('parseTags: multiple valid tags in order', () => {
  const tags = C.parseTags('<pic chars="a" prompt="1"> middle <pic chars="b" prompt="2">');
  assert.equal(tags.length, 2);
  assert.equal(tags[0].promptRaw, '1');
  assert.equal(tags[1].promptRaw, '2');
});

test('parseTags: no tags returns empty array', () => {
  assert.deepEqual(C.parseTags('그냥 평범한 답변입니다.'), []);
});

test('parseTags: rendered/failed/skipped/malformed markers never re-match (idempotency)', () => {
  const rendered = '![그림:p1|골목 장면](https://example/img.png)';
  const failed = C.renderFailureMarker('p1', { charsRaw: 'a', promptRaw: 'b' }, '연결 오류');
  const skipped = C.renderSkippedMarker('p2', { charsRaw: 'a', promptRaw: 'b' });
  const malformed = C.renderMalformedMarker({ raw: '<pic foo="bar">' });
  const malformedUnterminated = C.renderMalformedMarker({ raw: '<pic chars="broken, no closing quote' });
  for (const s of [rendered, failed, skipped, malformed, malformedUnterminated]) {
    assert.deepEqual(C.parseTags(s), [], s);
  }
});

test('renderMalformedMarker: never embeds a literal "<" (would re-match as a live tag on the next pass)', () => {
  const marker = C.renderMalformedMarker({ raw: '<pic foo="bar">' });
  assert.ok(!marker.includes('<'));
  assert.ok(marker.includes('＜pic'));
});

// ---------------------------------------------------------------- splitChars

test('splitChars: plain comma-separated name list', () => {
  assert.deepEqual(C.splitChars('아드리안, 정수빈'), [
    { name: '아드리안', action: '' }, { name: '정수빈', action: '' },
  ]);
});

test('splitChars: per-character actions with semicolons and internal commas', () => {
  assert.deepEqual(C.splitChars('아드리안: smirking, arms crossed; 정수빈: looking away'), [
    { name: '아드리안', action: 'smirking, arms crossed' },
    { name: '정수빈', action: 'looking away' },
  ]);
});

test('splitChars: single character with action, no semicolon', () => {
  assert.deepEqual(C.splitChars('아드리안: smiling'), [{ name: '아드리안', action: 'smiling' }]);
});

test('splitChars: empty/whitespace input', () => {
  assert.deepEqual(C.splitChars(''), []);
  assert.deepEqual(C.splitChars('   '), []);
  assert.deepEqual(C.splitChars(undefined), []);
});

test('splitChars: stray empty entries are dropped', () => {
  assert.deepEqual(C.splitChars('아드리안,, 정수빈,'), [
    { name: '아드리안', action: '' }, { name: '정수빈', action: '' },
  ]);
});

// ---------------------------------------------------------------- name matching

const REGISTRY = [
  { id: 'c0', names: ['아드리안', 'Adrian', '아드리안 폰 아이젠베르크', 'Adrian von Eisenberg', '마에스트로'], appearance: '1boy, silver hair', enabled: true },
  { id: 'c1', names: ['정수빈', 'Su-bin'], appearance: '1girl, short hair', enabled: false },
];

test('findCharacterIndex: case/whitespace-insensitive alias match', () => {
  assert.equal(C.findCharacterIndex('adrian', REGISTRY), 0);
  assert.equal(C.findCharacterIndex('  ADRIAN  ', REGISTRY), 0);
  assert.equal(C.findCharacterIndex('마 에 스 트 로', REGISTRY), 0);
});

test('findCharacterIndex: longest alias matched over a shorter one that is its prefix', () => {
  assert.equal(C.findCharacterIndex('아드리안 폰 아이젠베르크', REGISTRY), 0);
  assert.equal(C.findCharacterIndex('Adrian von Eisenberg', REGISTRY), 0);
});

test('findCharacterIndex: unregistered name returns -1', () => {
  assert.equal(C.findCharacterIndex('모르는사람', REGISTRY), -1);
});

test('findCharacterIndex: disabled character still matches (does not return -1)', () => {
  assert.equal(C.findCharacterIndex('정수빈', REGISTRY), 1);
});

// ---------------------------------------------------------------- prompt assembly

test('buildCharacterTags: enabled matched character gets appearance+action in characterTags', () => {
  const parsed = C.splitChars('아드리안: smirking');
  const { characterTags, extraFragments } = C.buildCharacterTags(parsed, REGISTRY);
  assert.deepEqual(characterTags, [{ tags: '1boy, silver hair, smirking' }]);
  assert.deepEqual(extraFragments, []);
});

test('buildCharacterTags: disabled matched character contributes no characterTags entry, action kept as extra fragment', () => {
  const parsed = C.splitChars('정수빈: looking away');
  const { characterTags, extraFragments } = C.buildCharacterTags(parsed, REGISTRY);
  assert.deepEqual(characterTags, []);
  assert.deepEqual(extraFragments, ['정수빈: looking away']);
});

test('buildCharacterTags: unregistered name passes through as extra fragment, not characterTags', () => {
  const parsed = C.splitChars('모르는사람');
  const { characterTags, extraFragments } = C.buildCharacterTags(parsed, REGISTRY);
  assert.deepEqual(characterTags, []);
  assert.deepEqual(extraFragments, ['모르는사람']);
});

test('buildCharacterTags: mixed registered+unregistered, max 6 enforced', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ name: 'x' + i, action: '' }));
  const { characterTags, extraFragments } = C.buildCharacterTags(many, []);
  assert.equal(characterTags.length + extraFragments.length, 6);
});

test('assemblePrompt: base + extra fragments joined, empty parts dropped', () => {
  assert.equal(C.assemblePrompt('골목, 저녁', ['모르는사람', '정수빈: looking away']), '골목, 저녁, 모르는사람, 정수빈: looking away');
  assert.equal(C.assemblePrompt('골목', []), '골목');
  assert.equal(C.assemblePrompt('', []), '');
});

// ---------------------------------------------------------------- planning (F2: max images, markers)

test('planMessage: single valid tag produces one job, no markers', () => {
  const content = '<pic chars="아드리안" prompt="골목">';
  const { tags, jobs, markers } = C.planMessage(content, { registry: REGISTRY, maxImages: 2 });
  assert.equal(tags.length, 1);
  assert.equal(jobs.length, 1);
  assert.equal(markers.size, 0);
  assert.equal(jobs[0].prompt, '골목');
  assert.deepEqual(jobs[0].characterTags, [{ tags: '1boy, silver hair' }]);
});

test('planMessage: max 2 images — 3rd+ valid tag gets a skipped marker, not a job', () => {
  const content = '<pic prompt="1"><pic prompt="2"><pic prompt="3">';
  const { jobs, skipped, markers } = C.planMessage(content, { registry: [], maxImages: 2 });
  assert.equal(jobs.length, 2);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].tagIndex, 2);
  assert.equal(markers.size, 1);
  const [[idx, text]] = [...markers.entries()];
  assert.equal(idx, 2);
  assert.ok(text.includes('상한'));
  assert.ok(text.includes('prompt="3"'));
  assert.ok(text.includes(`id="${skipped[0].id}"`));
});

test('planMessage: malformed tag always gets a marker, never a job, never counted toward the limit', () => {
  const content = '<pic foo="bar"><pic prompt="1"><pic prompt="2">';
  const { jobs, markers } = C.planMessage(content, { registry: [], maxImages: 2 });
  assert.equal(jobs.length, 2); // both real tags still get generated
  assert.equal(markers.size, 1);
  assert.ok([...markers.values()][0].includes('형식 오류'));
});

test('planMessage: image ids are unique and avoid existingImageIds', () => {
  const content = '<pic prompt="1"><pic prompt="2">';
  const { jobs } = C.planMessage(content, { registry: [], maxImages: 2, existingImageIds: ['p1'] });
  assert.deepEqual(jobs.map((j) => j.id), ['p2', 'p3']);
});

// ---------------------------------------------------------------- applyMarkers (splicing)

test('applyMarkers: replaces only tags with an entry in the map, preserves surrounding text', () => {
  const content = 'A <pic prompt="1"> B <pic prompt="2"> C';
  const tags = C.parseTags(content);
  const out = C.applyMarkers(content, tags, new Map([[0, '[IMG1]']]));
  assert.equal(out, 'A [IMG1] B <pic prompt="2"> C');
});

test('applyMarkers: replacing both tags produces exact splice with no drift', () => {
  const content = 'A <pic prompt="1"> B <pic prompt="2"> C';
  const tags = C.parseTags(content);
  const out = C.applyMarkers(content, tags, new Map([[0, '[X]'], [1, '[Y]']]));
  assert.equal(out, 'A [X] B [Y] C');
});

test('full pipeline: plan -> generate (simulated) -> apply markers for a 3-tag message with one malformed', () => {
  const content = '<pic chars="아드리안" prompt="1"><pic foo="bad"><pic prompt="2"><pic prompt="3">';
  const { tags, jobs, markers } = C.planMessage(content, { registry: REGISTRY, maxImages: 2 });
  // jobs[0] (tag 0) and jobs[1] (tag 2) get generated; tag 1 malformed; tag 3 skipped (3rd valid)
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].tagIndex, 0);
  assert.equal(jobs[1].tagIndex, 2);
  for (const job of jobs) markers.set(job.tagIndex, C.renderSuccessMarker(job.id, 'https://img/' + job.id, job.summary));
  const out = C.applyMarkers(content, tags, markers);
  assert.ok(out.includes('![그림:p1|1]'));
  assert.ok(out.includes('형식 오류'));
  assert.ok(out.includes('![그림:p2|2]'));
  assert.ok(out.includes('상한'));
});

// ---------------------------------------------------------------- history placeholder rewrite

test('stripRenderedImages: converts a rendered image into a short placeholder', () => {
  const content = '그는 웃었다. ![그림:p1|골목에서 마주친 아드리안](https://img/p1.png) 그리고 떠났다.';
  const out = C.stripRenderedImages(content);
  assert.equal(out, '그는 웃었다. [그림: 골목에서 마주친 아드리안] 그리고 떠났다.');
});

test('stripRenderedImages: converts failure/skip/malformed markers too', () => {
  const failed = C.renderFailureMarker('p1', { charsRaw: 'a', promptRaw: 'b', raw: '<pic prompt="b">' }, '시간 초과');
  const skipped = C.renderSkippedMarker('p2', { charsRaw: 'a', promptRaw: 'b' });
  const bad = C.renderMalformedMarker({ raw: '<pic broken' });
  assert.equal(C.stripRenderedImages(failed), '[그림: 생성 실패]');
  assert.equal(C.stripRenderedImages(skipped), '[그림: 생략됨]');
  assert.ok(C.stripRenderedImages(bad).startsWith('[그림: '));
});

test('stripRenderedImages: idempotent — running twice is the same as running once', () => {
  const content = '![그림:p1|요약](https://img/p1.png)';
  const once = C.stripRenderedImages(content);
  const twice = C.stripRenderedImages(once);
  assert.equal(once, twice);
});

test('stripRenderedImages: plain text without markers is unchanged', () => {
  assert.equal(C.stripRenderedImages('그냥 평범한 문장'), '그냥 평범한 문장');
});

// ---------------------------------------------------------------- rendered-image detection / idempotency

test('hasLiveTags: true only when a real <pic> tag remains', () => {
  assert.equal(C.hasLiveTags('<pic prompt="x">'), true);
  assert.equal(C.hasLiveTags('![그림:p1|x](url)'), false);
  assert.equal(C.hasLiveTags('그냥 텍스트'), false);
});

// ---------------------------------------------------------------- F1 instruction injection

test('buildInstructionText: lists only enabled characters, each alias set joined', () => {
  const text = C.buildInstructionText(REGISTRY);
  assert.ok(text.includes('아드리안 / Adrian / 아드리안 폰 아이젠베르크 / Adrian von Eisenberg / 마에스트로'));
  assert.ok(!text.includes('정수빈')); // disabled character omitted from roster
});

test('buildInstructionText: empty registry still returns usable instruction text', () => {
  const text = C.buildInstructionText([]);
  assert.ok(text.includes('<pic'));
  assert.ok(!text.includes('아무 별칭이나 그대로 사용 가능'));
});

test('injectInstruction: position "start" prepends', () => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
  const out = C.injectInstruction(msgs, C.normalizeSettings({ position: 'start' }), []);
  assert.equal(out.length, 3);
  assert.ok(out[0].content.includes('<pic'));
});

test('injectInstruction: position "end" appends', () => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
  const out = C.injectInstruction(msgs, C.normalizeSettings({ position: 'end' }), []);
  assert.equal(out.length, 3);
  assert.ok(out[2].content.includes('<pic'));
});

test('injectInstruction: position "depth" inserts N from the end', () => {
  const msgs = [{ content: '0' }, { content: '1' }, { content: '2' }, { content: '3' }];
  const out = C.injectInstruction(msgs, C.normalizeSettings({ position: 'depth', depth: 1 }), []);
  assert.equal(out.length, 5);
  assert.ok(out[3].content.includes('<pic')); // inserted before the last message
  assert.equal(out[4].content, '3');
});

test('injectInstruction: depth larger than message count clamps to the start', () => {
  const msgs = [{ content: '0' }];
  const out = C.injectInstruction(msgs, C.normalizeSettings({ position: 'depth', depth: 99 }), []);
  assert.ok(out[0].content.includes('<pic'));
});

test('injectInstruction: does not mutate the input array', () => {
  const msgs = [{ content: '0' }];
  C.injectInstruction(msgs, C.normalizeSettings({}), []);
  assert.equal(msgs.length, 1);
});

test('normalizeSettings: fills in defaults and rejects out-of-range values', () => {
  assert.deepEqual(C.normalizeSettings(undefined), C.DEFAULT_SETTINGS);
  assert.deepEqual(C.normalizeSettings({ position: 'bogus', role: 'bogus', depth: -1, maxImages: 99 }), C.DEFAULT_SETTINGS);
  assert.deepEqual(C.normalizeSettings({ depth: 0, maxImages: 1 }), { ...C.DEFAULT_SETTINGS, depth: 0, maxImages: 1 });
});

// ---------------------------------------------------------------- registry normalization (F4)

test('normalizeRegistry: empty/missing input yields empty registry (never pre-seeded)', () => {
  assert.deepEqual(C.normalizeRegistry(undefined), []);
  assert.deepEqual(C.normalizeRegistry({}), []);
  assert.deepEqual(C.normalizeRegistry({ characters: [] }), []);
});

test('normalizeRegistry: fills defaults, drops entries with no usable names', () => {
  const out = C.normalizeRegistry({ characters: [
    { names: ['아드리안', ''], appearance: 'x' },
    { names: [], appearance: 'y', enabled: false },
    { appearance: 'z' },
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].names.length, 1);
  assert.equal(out[0].enabled, true);
});

test('normalizeRegistry: enabled defaults true unless explicitly false', () => {
  const out = C.normalizeRegistry({ characters: [{ names: ['a'], enabled: false }, { names: ['b'] }] });
  assert.equal(out[0].enabled, false);
  assert.equal(out[1].enabled, true);
});
