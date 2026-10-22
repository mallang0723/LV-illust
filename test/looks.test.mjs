import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core.mjs';

const sorted = (a) => a.slice().sort();

// ---------------------------------------------------------------- tag lists

test('splitTagList: commas split, weighted groups and brackets stay whole, blanks dropped', () => {
  assert.deepEqual(C.splitTagList('a, b ,, c'), ['a', 'b', 'c']);
  assert.deepEqual(C.splitTagList('1.2::red dress, white gloves::, silver hair'), ['1.2::red dress, white gloves::', 'silver hair']);
  assert.deepEqual(C.splitTagList('(red eyes, glowing:1.1), tall'), ['(red eyes, glowing:1.1)', 'tall']);
  assert.deepEqual(C.splitTagList('파란 눈，검은 코트、장갑\n모자'), ['파란 눈', '검은 코트', '장갑', '모자']);
  assert.deepEqual(C.splitTagList(''), []);
  assert.deepEqual(C.splitTagList(undefined), []);
});

test('dedupeTags: case/space-insensitive, first spelling and order win', () => {
  assert.deepEqual(C.dedupeTags(['Lowres, text', 'LOWRES,  Text, watermark', 'text']), ['Lowres', 'text', 'watermark']);
});

// ---------------------------------------------------------------- classification heuristic

const CASES = [
  // body
  ['1girl', 'body'], ['1boy', 'body'], ['silver hair', 'body'], ['long hair', 'body'], ['blue eyes', 'body'], ['heterochromia', 'body'],
  ['dark skin', 'body'], ['tall', 'body'], ['muscular', 'body'], ['petite', 'body'], ['freckles', 'body'], ['scar on cheek', 'body'],
  ['cat ears', 'body'], ['fox tail', 'body'], ['horns', 'body'], ['ponytail', 'body'], ['ahoge', 'body'], ['twintails', 'body'],
  ['1.2::silver hair::', 'body'], ['(blue eyes:1.1)', 'body'], ['young', 'body'], ['elf', 'body'], ['검은 머리', 'body'], ['푸른 눈', 'body'],
  // outfit
  ['black coat', 'outfit'], ['white gloves', 'outfit'], ['school uniform', 'outfit'], ['glasses', 'outfit'], ['red ribbon', 'outfit'],
  ['silver ring', 'outfit'], ['boots', 'outfit'], ['thighhighs', 'outfit'], ['long sleeves', 'outfit'], ['necklace', 'outfit'],
  ['hat', 'outfit'], ['hair ribbon', 'outfit'], ['hair ornament', 'outfit'], ['hairband', 'outfit'], ['earrings', 'outfit'],
  ['eyepatch', 'outfit'], ['umbrella', 'outfit'], ['1.2::red dress, white gloves::', 'outfit'], ['교복', 'outfit'], ['안경', 'outfit'],
  ['머리띠', 'outfit'], ['귀걸이', 'outfit'], ['검은 코트', 'outfit'], ['off-shoulder dress', 'outfit'],
  // unsure (-> body, flagged)
  ['barefoot', 'unsure'], ['nude', 'unsure'], ['navel', 'unsure'], ['mystery tag', 'unsure'], ['black', 'unsure'],
  ['tan coat', 'unsure'], ['pale blue dress', 'unsure'], ['horn-rimmed glasses', 'unsure'], ['ear piercing', 'unsure'],
  ['1.2::silver hair, red dress::', 'unsure'], ['', 'unsure'],
];
for (const [tag, kind] of CASES) {
  test(`classifyTag(${JSON.stringify(tag)}) -> ${kind}`, () => assert.equal(C.classifyTag(tag), kind));
}

test('classifyTag: Latin keywords match whole words only (hair is not "chair", cap is not "cape"-prefix noise)', () => {
  assert.equal(C.classifyTag('chair'), 'unsure');
  assert.equal(C.classifyTag('cape'), 'outfit');
  assert.equal(C.classifyTag('bodysuit'), 'outfit');
  assert.equal(C.classifyTag('ponytail'), 'body'); // not read as "tail" + something
});

test('splitAppearance: unsure tags go to body AND are listed for review; nothing is dropped', () => {
  const src = '1boy, silver hair, black coat, mystery tag, white gloves, barefoot';
  const sp = C.splitAppearance(src);
  assert.deepEqual(sp.outfit, ['black coat', 'white gloves']);
  assert.deepEqual(sp.body, ['1boy', 'silver hair', 'mystery tag', 'barefoot']);
  assert.deepEqual(sp.review, ['mystery tag', 'barefoot']);
  assert.deepEqual(sorted([...sp.body, ...sp.outfit]), sorted(C.splitTagList(src)));
});

// ---------------------------------------------------------------- migration

test('normalizeRegistry migration: combined appearance -> body + outfit, original kept, nothing lost', () => {
  const src = '1girl, short brown hair, school uniform, glasses, red ribbon, mystery tag';
  const [c] = C.normalizeRegistry({ characters: [{ id: 'c9', names: ['수빈'], appearance: src, enabled: true }] });
  assert.equal(c.body, '1girl, short brown hair, mystery tag');
  assert.equal(c.outfit, 'school uniform, glasses, red ribbon');
  assert.equal(c.legacyAppearance, src);
  assert.equal(c.needsReview, true);
  assert.deepEqual(c.reviewTags, ['mystery tag']);
  assert.deepEqual(sorted([...C.splitTagList(c.body), ...C.splitTagList(c.outfit)]), sorted(C.splitTagList(src)));
  assert.equal('appearance' in c, false);
});

test('normalizeRegistry migration: a fully classifiable record is not flagged but still recoverable', () => {
  const [c] = C.normalizeRegistry({ characters: [{ names: ['a'], appearance: '1boy, silver hair, black coat' }] });
  assert.equal(c.body, '1boy, silver hair');
  assert.equal(c.outfit, 'black coat');
  assert.equal(c.legacyAppearance, '1boy, silver hair, black coat');
  assert.equal(c.needsReview, undefined);
});

test('normalizeRegistry migration: idempotent — already-split records are never re-split, flags survive', () => {
  const first = C.normalizeRegistry({ characters: [{ names: ['a'], appearance: 'silver hair, black coat, zzz' }] });
  const second = C.normalizeRegistry({ characters: first });
  assert.deepEqual(second, first);
  // user edits that move a coat into body are respected, not re-classified
  const edited = C.normalizeRegistry({ characters: [{ ...first[0], body: 'silver hair, black coat', outfit: '', needsReview: false }] });
  assert.equal(edited[0].body, 'silver hair, black coat');
  assert.equal(edited[0].outfit, '');
  assert.equal(edited[0].needsReview, undefined);
  assert.equal(edited[0].legacyAppearance, 'silver hair, black coat, zzz'); // original stays recoverable
});

test('normalizeRegistry: empty / missing appearance gives empty body+outfit and no flags; negative is normalized', () => {
  const out = C.normalizeRegistry({ characters: [{ names: ['a'] }, { names: ['b'], appearance: '  ', negative: ' extra   fingers ' }] });
  assert.equal(out[0].body, ''); assert.equal(out[0].outfit, '');
  assert.equal(out[1].negative, 'extra fingers');
  assert.equal(out[1].legacyAppearance, undefined);
});

test('normalizeRegistry: ids are unique — a deleted row\'s number is never reused for a new character', () => {
  const out = C.normalizeRegistry({ characters: [{ id: 'c0', names: ['a'] }, { id: 'c2', names: ['b'] }, { names: ['new'] }, { names: ['new2'] }] });
  assert.deepEqual(out.map((c) => c.id), ['c0', 'c2', 'c1', 'c3']);
});

// ---------------------------------------------------------------- prompt order + outfit override

const REG = C.normalizeRegistry({ characters: [
  { id: 'c0', names: ['아드리안'], body: '1boy, silver hair', outfit: 'black coat, white gloves', negative: 'extra fingers', enabled: true },
  { id: 'c1', names: ['수빈'], body: '1girl', outfit: '', enabled: true },
  { id: 'c2', names: ['끔'], body: '1girl', outfit: 'kimono', enabled: false },
] });

test('buildCharacterTags: body first, then outfit, then the scene action', () => {
  const { characterTags } = C.buildCharacterTags(C.splitChars('아드리안: smirking'), REG);
  assert.deepEqual(characterTags, [{ tags: '1boy, silver hair, black coat, white gloves, smirking' }]);
});

test('outfit override: "| 옷:" replaces ONLY the saved outfit for that picture, body untouched', () => {
  const { characterTags } = C.buildCharacterTags(C.splitChars('아드리안: smirking | 옷: black suit, red tie'), REG);
  assert.deepEqual(characterTags, [{ tags: '1boy, silver hair, black suit, red tie, smirking' }]);
  const en = C.buildCharacterTags(C.splitChars('아드리안: smirking | outfit= swimsuit'), REG);
  assert.deepEqual(en.characterTags, [{ tags: '1boy, silver hair, swimsuit, smirking' }]);
  const only = C.buildCharacterTags(C.splitChars('아드리안: | 옷: yukata'), REG);
  assert.deepEqual(only.characterTags, [{ tags: '1boy, silver hair, yukata' }]);
});

test('outfit override fallback: no override, an empty override, or an unrelated "|" part uses the saved outfit', () => {
  for (const chars of ['아드리안', '아드리안: smirking', '아드리안: smirking | 옷:', '아드리안: smirking | 옷: ']) {
    const { characterTags } = C.buildCharacterTags(C.splitChars(chars), REG);
    assert.ok(characterTags[0].tags.includes('black coat, white gloves'), chars);
  }
  const { characterTags } = C.buildCharacterTags(C.splitChars('아드리안: a | b'), REG);
  assert.equal(characterTags[0].tags, '1boy, silver hair, black coat, white gloves, a, b');
});

test('outfit override on a character with no saved outfit, and on disabled/unknown names (kept as text, not lost)', () => {
  assert.deepEqual(C.buildCharacterTags(C.splitChars('수빈: smile | 옷: apron'), REG).characterTags, [{ tags: '1girl, apron, smile' }]);
  const dis = C.buildCharacterTags(C.splitChars('끔: waving | 옷: hanbok; 모르는: x | 옷: cape'), REG);
  assert.deepEqual(dis.characterTags, []);
  assert.deepEqual(dis.extraFragments, ['끔: waving, hanbok', '모르는: x, cape']);
});

test('legacy un-normalized record with only `appearance` still builds (all of it as body)', () => {
  const { characterTags } = C.buildCharacterTags(C.splitChars('x: y'), [{ names: ['x'], appearance: '1boy, silver hair', enabled: true }]);
  assert.deepEqual(characterTags, [{ tags: '1boy, silver hair, y' }]);
});

test('buildCharacterTags: per-character negatives are collected only for matched, enabled characters', () => {
  const { negatives } = C.buildCharacterTags(C.splitChars('아드리안, 수빈, 끔, 모르는'), REG);
  assert.deepEqual(negatives, ['extra fingers']);
});

test('planMessage jobs carry the scene characters\' negatives', () => {
  const { jobs } = C.planMessage('<pic chars="아드리안" prompt="골목">', { registry: REG, maxImages: 2 });
  assert.deepEqual(jobs[0].negatives, ['extra fingers']);
  assert.deepEqual(jobs[0].characterTags, [{ tags: '1boy, silver hair, black coat, white gloves' }]);
});

test('instruction text tells the AI about the per-scene outfit syntax', () => {
  assert.ok(C.buildInstructionText(REG).includes('| 옷:'));
});

// ---------------------------------------------------------------- negative composition

const preset = (negativePrompt, prompt = '') => ({ prompt, negativePrompt });

test('buildFinalPrompt negative: preset + common + character negatives, de-duplicated case-insensitively, in that order', () => {
  const r = C.buildFinalPrompt('scene', preset('lowres, Text'), { commonNegative: 'text, watermark', characterNegatives: ['Extra Fingers', 'WATERMARK, extra fingers'] });
  assert.equal(r.negativePrompt, 'lowres, Text, watermark, Extra Fingers');
});

test('buildFinalPrompt negative: nothing anywhere -> undefined (field omitted, host default stays)', () => {
  assert.equal(C.buildFinalPrompt('scene', null).negativePrompt, undefined);
  assert.equal(C.buildFinalPrompt('scene', preset(''), { commonNegative: '', characterNegatives: [] }).negativePrompt, undefined);
  assert.equal(C.buildFinalPrompt('scene', preset(' , '), { commonNegative: ' ' }).negativePrompt, undefined);
});

test('buildFinalPrompt negative: a macro-only preset negative no longer leaks — stripped to nothing, or replaced by our own negatives', () => {
  const macroOnly = preset('{{character_negative_prompt}}, {{ persona_negative_prompt }}');
  assert.equal(C.buildFinalPrompt('s', macroOnly).negativePrompt, undefined);
  assert.equal(C.buildFinalPrompt('s', macroOnly, { commonNegative: 'lowres' }).negativePrompt, 'lowres');
});

test('buildFinalPrompt negative: with boundNegatives the two bound-NEGATIVE tokens are kept for the host to expand, our negatives are appended after them', () => {
  const r = C.buildFinalPrompt('s', preset('worst quality, {{character_negative_prompt}}, {{persona_negative_prompt}}'),
    { boundNegatives: true, commonNegative: 'lowres', characterNegatives: ['extra fingers'] });
  assert.equal(r.negativePrompt, 'worst quality, {{character_negative_prompt}}, {{persona_negative_prompt}}, lowres, extra fingers');
  const macroOnly = C.buildFinalPrompt('s', preset('{{character_negative_prompt}}'), { boundNegatives: true });
  assert.equal(macroOnly.negativePrompt, '{{character_negative_prompt}}'); // sent explicitly -> never the host's raw-preset fallback
});

test('INVARIANT: the positive prompt never contains a bound macro; the negative contains one only when boundNegatives is on', () => {
  const p = preset('{{character_negative_prompt}}, {{persona_negative_prompt}}, bad', '{{character_prompt}}, {{ persona_prompt }}, masterpiece, {{char}}');
  for (const boundNegatives of [false, true, undefined]) {
    const r = C.buildFinalPrompt('scene', p, { boundNegatives, commonNegative: 'c', characterNegatives: ['d'] });
    assert.ok(!/\{\{\s*(?:character|persona)_prompt/i.test(r.prompt), 'positive macro leaked');
    assert.ok(r.prompt.includes('{{char}}'), 'ordinary macros are left for the host');
    const bound = /\{\{\s*(?:character|persona)_negative_prompt/i.test(r.negativePrompt);
    assert.equal(bound, boundNegatives === true);
    assert.ok(!/\{\{\s*(?:character|persona)_prompt/i.test(r.negativePrompt));
  }
});

test('buildFinalPrompt: positive side unchanged — preset positive + scene, positive macros stripped', () => {
  assert.equal(C.buildFinalPrompt('forest', { prompt: 'watercolor, {{character_prompt}}', negativePrompt: '' }).prompt, 'watercolor, forest');
});

test('normalizeSettings: commonNegative is trimmed/collapsed/capped, boundNegatives defaults on', () => {
  const d = C.normalizeSettings(undefined);
  assert.equal(d.commonNegative, ''); assert.equal(d.boundNegatives, true);
  const s = C.normalizeSettings({ commonNegative: '  lowres,   text \n', boundNegatives: false });
  assert.equal(s.commonNegative, 'lowres, text'); assert.equal(s.boundNegatives, false);
  assert.equal(C.normalizeSettings({ commonNegative: 'x'.repeat(5000) }).commonNegative.length, C.MAX_NEGATIVE_LEN);
  assert.equal(C.normalizeSettings({ commonNegative: 5 }).commonNegative, '');
});

test('composeScene: preview of what a tag becomes (positive, negative, per-character slots), no I/O', () => {
  const r = C.composeScene({
    chars: '아드리안: smirking | 옷: suit', scene: '골목', registry: REG,
    mainPreset: { prompt: 'masterpiece', negativePrompt: 'lowres' },
    settings: { commonNegative: 'text', boundNegatives: false },
  });
  assert.equal(r.prompt, 'masterpiece, 골목');
  assert.equal(r.negativePrompt, 'lowres, text, extra fingers');
  assert.deepEqual(r.characterTags, [{ tags: '1boy, silver hair, suit, smirking' }]);
  assert.equal(C.composeScene({ scene: 'x' }).negativePrompt, '');
});
