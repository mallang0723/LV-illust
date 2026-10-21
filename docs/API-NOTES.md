# API-NOTES — 삽화가 (개인용) / LV-Illust

Everything cited below was read from the Lumiverse container's own type definitions and
TypeScript source (not from any AutoPic/SillyGgu code — clean room). Paths are inside
the `lumiverse` container as of this writing (image built 2026‑10‑10 per file mtimes).

- Spindle types: `/home/bun/.bun/install/cache/lumiverse-spindle-types@0.6.32@@@1/dist/*.d.ts`
  for the first-pass rounds; later rounds (where noted) read the container's actual
  *installed* copy at `/app/node_modules/lumiverse-spindle-types` (**0.6.40** — newer;
  a couple of methods used in later rounds, e.g. `imageGen.getPromptPresets`, are only
  declared there, not in the older cached copy). `.review/host/spindle-types/` holds the
  0.6.40 copy.
- Host source: `/app/src/spindle/*.ts`, `/app/src/image-gen/providers/novelai.ts`,
  `/app/src/services/image-gen.service.ts`
- User docs: `/app/user-docs/docs/extensions/index.md`

Confidence key: **VERIFIED** = read directly in the files above. **INFERRED** = a
reasonable reading of verified material, not contradicted by anything found, but not
executed. **UNVERIFIED** = genuinely untested against the live host; call this out to
the user before relying on it in production.

## Manifest validity (packaging)

Read `manager.service.ts` `readManifest`/`readManifestFromPath` (~709-767) and
`url-safety.ts` `normalizeSpindleHttpsUrl` (~11-36) read-only via `docker exec`, copies
kept at `.review/host/` (gitignored). The host requires `identifier` (matching
`/^[a-z][a-z0-9_]*$/`), `version`, `name`, `author`; `github`/`homepage` are validated
*only if non-empty* (`normalizeSpindleHttpsUrl` returns `""` and does not throw when the
field is blank and `required` wasn't passed — which is exactly how `readManifest`, the
path used for **Import Local**, calls it). Our `spindle.json` has `identifier: "lv_illust"`
(valid), `version`/`name`/`author` set, and `github: ""` — all **VERIFIED** valid for
Import Local without any changes. For GitHub "Install from Source", a different code path
(`manager.service.ts` ~1382) fills `github` from the pasted install URL when the
manifest's own field is empty, so no manifest edit is needed for that path either —
**VERIFIED** reading that line, not exercised against a live install.

## Permissions actually required

| Permission | Why | Evidence |
|---|---|---|
| `image_gen` | `spindle.imageGen.generate` | spindle-api.d.ts:684 gate comment; worker-host-image-gen-api.ts:108 `hasPermission("image_gen")` check — **VERIFIED** |
| `interceptor` | `spindle.registerInterceptor` (F1) | spindle-api.d.ts:214 doc comment — **VERIFIED** (permission gate itself not traced in worker-host.ts, but index.md lists `interceptor` as privileged and this is the only API that injects prompt content) |
| `chat_mutation` | `spindle.chat.getMessages` / `appendMessage` / `updateMessage` | worker-host.ts: `handleChatUpdateMessage` (~3868), append (~3782) and get-messages (~3718) each do `if (!this.hasPermission("chat_mutation")) throw ...` — **VERIFIED**. Note: `/app/user-docs/docs/extensions/index.md` describes `chat_mutation` only as "hide/unhide + bulk mutations on the current chat" and lists it as auto‑granted — that prose is stale/incomplete; the actual gate in worker-host.ts covers get/append/update/delete too, and LV‑DnH‑Menu (same author, already working in production) relies on exactly this. Trusted the code over the doc. |
| `characters` | `spindle.characters.get`/`update` for the per‑card registry (F4) | worker-host-content-api.ts:346 `handleCharactersUpdate` — `hasPermission("characters")` check, and shallow merge `{ ...existing.extensions, ...input.extensions }` — **VERIFIED** |
| `chats` | `spindle.chats.get(chatId)` to resolve the character card that owns a chat | spindle-api.d.ts:836-849 `chats.get` signature — **VERIFIED signature**; permission gate on the host side not individually traced (ran out of budget) but `"chats"` is listed as the permission for this whole namespace in permissions.d.ts and index.md — **INFERRED** gate, standard pattern matches every other namespace checked. |
| `generation` | `spindle.on("GENERATION_ENDED", ...)` subscription | **Found missing in review, added after the fact.** worker-host.ts `handleSubscribeEvent` (~2646-2668): `GENERATION_EVENTS` (a Set including `EventType.GENERATION_ENDED`) is checked with `if (WorkerHost.GENERATION_EVENTS.has(eventType) && !this.hasPermission("generation")) { ...; this.postToWorker({ type: "permission_denied", ... }); return; }` — **VERIFIED**. Without this permission, `handleGenerationEnded` (the whole F2 tag-detection path) silently never fires; nothing throws, the subscription is just dropped at registration time with a console warning on the host side only. |

`ui_panels` was **not** declared — LV‑DnH‑Menu (proven working) also omits it while
using `registerInputBarAction`/`showModal` from the frontend context, and
`permissions.d.ts` documents `ui_panels` as free-tier/auto-granted, so no manifest
declaration appears to gate it. **INFERRED** from the working sibling extension, not
independently re-derived from the installer's permission-check code.

## Image generation

- `spindle.imageGen.generate(input)` signature incl. `prompt`, `negativePrompt`,
  `parameters`, `owner_character_id`, `owner_chat_id`, `includeDataUrl` —
  api.d.ts:713-739 — **VERIFIED**.
- NovelAI character-prompt mapping: `parameters.characterTags: [{ tags }]` becomes
  `naiParams.characterPrompts` and `v4_prompt.char_captions` (`center`/`centers` fixed at
  `{x:0,y:0}`) — `/app/src/image-gen/providers/novelai.ts:169-193` — **VERIFIED**. This
  confirms DESIGN.md §6's note that character-slot positioning is always centered (no
  per-character placement control from an extension).
- Result shape `ImageGenResultDTO { imageDataUrl, model, provider, imageId?, imageUrl? }`
  — api.d.ts:818-827 — **VERIFIED**. `includeDataUrl:false` is honored per
  `worker-host-image-gen-api.ts:62` (`applyDataUrlInclusion`) — **VERIFIED**.
- Whether a request actually reaches the SharedNAI sidecar vs. direct NovelAI, and
  whether V4/V4.5's 6‑character cap or V5's higher cap applies, depends on the user's
  *connection profile* configuration, which this extension never inspects — **not
  applicable to this extension's code**, carried over from DESIGN.md's own note.

### `generate()` vs `generateNative()` — decision: switched to `generateNative()`

Review (2nd pass) finding 5 pointed out that DESIGN.md §0 explicitly says this extension
relies on **Lumiverse's own** main/style image prompt presets rather than storing its
own, and that `imageGen.generate()` does not apply them. Investigated by reading
(read-only, `docker exec lumiverse cat ...`, copies kept at `.review/host/`):
`worker-host-image-gen-api.ts` (`handleGenerate` ~208-219, `handleGenerateNative`
~223-335) and `/app/src/services/image-gen.service.ts` (`generateSceneBackground`
~373-712, `resolveImagePrompt`/`parseCustomPrompt` ~1488-1540, `composeWithBaseTags`
~1144-1150, `resolveActiveLoraPreset` ~176-180).

**What each path actually does, verified by reading the implementation (not just the
type signature):**

| | `imageGen.generate()` | `imageGen.generateNative()` |
|---|---|---|
| Permission | `image_gen` only (`worker-host-image-gen-api.ts:107-110`, `requirePermission()` checks only `"image_gen"` — identical gate on both handlers) | same |
| Parameter merge | `{...connection.default_parameters, ...input.parameters}` only (`handleGenerate` → `resolveGeneration` → provider call directly; no preset/LoRA logic anywhere in that path) | same merge happens first (`image-gen.service.ts:424-426`), **then** composed further (see below) |
| Native style/LoRA preset | **never applied** — this is finding 5's bug | `resolveActiveLoraPreset(settings)` (`:482`) resolves the user's active native preset; its `base_tags` is **unconditionally** composed onto the prompt via `composeWithBaseTags(tags, promptResult.prompt)` (`:501-505`) — this is not gated by `promptMode`/`skipParse` at all, so it still applies even with scene-analysis skipped. Its LoRA layers are applied to `params` too (`:477-500`) |
| Card-bound character LoRA | n/a | `resolveImageCharacterLayer(userId, chatId, opts?.characterLora)` resolves the chat's own bound character LoRA by default when `characterLora` is omitted (left `undefined`) — free extra correctness, not something we construct ourselves |
| Our `parameters.characterTags` | passed straight to the provider via `connection.default_parameters` merge; provider maps it directly (verified in novelai.ts, above) | merged in the same way, **then** at `:526-534` a NovelAI-specific block would **overwrite** `params.characterTags` from `promptResult.scene.character_appearances` *if and only if* `promptResult.scene` exists (i.e. scene-analysis ran). With `promptMode: 'custom'` (what `skipParse: true` resolves to, `handleGenerateNative` ~267-270), `resolveImagePrompt`'s `mode === 'custom'` branch (`image-gen.service.ts:1498`) returns `{prompt, negativePrompt}` with **no `scene` key at all** — so `Array.isArray(undefined?.character_appearances)` is `false`, the overwrite condition never fires, and our own `characterTags` survive completely untouched. **VERIFIED by reading the exact branch**, not inferred. |
| Scene-analysis LLM call | n/a (never calls it) | skipped entirely under `promptMode:'custom'` — we supply the exact scene prompt the tag's author already wrote; we do not want it re-interpreted by another LLM call |
| Request shape used | `{prompt, parameters, owner_chat_id, includeDataUrl}` | `{chat_id, prompt, promptMode:'custom', skipParse:true, parameters:{characterTags}, includeDataUrl:false}` — note the field name difference, `chat_id` not `owner_chat_id` (`worker-host-image-gen-api.ts:230-231` reads `input?.chat_id`) |

**Decision: switched `generateImage()` (backend.mjs) to `imageGen.generateNative()`**
with `promptMode: 'custom', skipParse: true`. This gets the user's native style/LoRA
preset composed onto our scene prompt (satisfying DESIGN.md §0's "use Lumiverse's own
image prompt presets") while our own `characterTags` (built from the per-card registry,
F3) pass through completely unmodified, and without invoking Lumiverse's own
scene-analysis LLM call (we already have an exact scene prompt from the `<pic>` tag's
author — re-interpreting it would be redundant and could drift from what was asked for).
**Confidence: VERIFIED by direct source read** of the exact conditional branches above,
not inferred from type signatures alone. **Not independently re-verified against a live
generation** — the composed-prompt behavior (style preset text actually prepended) has
not been visually confirmed on a real server; see "Known limitations".

**Follow-up (3rd review pass): the above restored the LoRA/style preset but not the
*main* prompt preset.** `generateNative()`'s own prompt resolution
(`resolvePromptInput`, `image-gen.service.ts:1319-1327`) does:

```ts
let prompt = opts?.prompt ?? preset?.prompt ?? settings.customPrompt ?? "";
```

Our `opts.prompt` (the tag's scene text) is never `null`/`undefined`, so it always wins
this `??` chain — the active main preset's own `prompt` text is **silently dropped
entirely**, not composed, regardless of `skipParse`. (`skipParse:true` additionally
skips `expandCharacterPromptMacro` at `:1336-1344`, which is the step that would
otherwise substitute `{{character_prompt}}`/`{{persona_prompt}}` and their `_negative_`
counterparts with a bound character/persona preset's text — irrelevant to us either way
since we never forward the raw preset text containing those tokens.)

Fixed by composing explicitly ourselves, using a *separate*, previously-uninvestigated
spindle API:

- `spindle.imageGen.getPromptPresets(userId?)` — worker-side definition
  `worker-runtime.ts:2430-2432` (`request({type:"image_gen_prompt_presets", ...})`);
  host dispatch `worker-host.ts:2539-2540`
  (`case "image_gen_prompt_presets": this.imageGenApi.handlePromptPresets(...)`); handler
  `worker-host-image-gen-api.ts:340-349` — gated by `this.requirePermission()`, the
  same `image_gen`-only check as every other image-gen call (verified, not a new
  permission); delegates to `image-gen.service.ts:343-349`
  `getMainImagePromptPresets(userId)`, which returns
  `{ activeId, activeConnectionId, presets }` filtered to
  `!preset.kind || preset.kind === "main"` (i.e. **excludes** character/persona/
  captioning presets — exactly the "main" preset DESIGN.md means). **VERIFIED by
  reading the full call chain**, worker-side signature through host implementation.
  — **Type-definition note:** this method (and its `ImageGenPromptPresetDTO`/
  `ImageGenPromptPresetsResultDTO` types) is absent from the
  `lumiverse-spindle-types@0.6.32` package cached under the Bun install cache (the copy
  originally read for earlier rounds); the container's actual installed package at
  `/app/node_modules/lumiverse-spindle-types` is **0.6.40**, which does declare it
  (`spindle-api.d.ts:707`: `getPromptPresets?(userId?: string): Promise<...>` — marked
  **optional**, hence `backend.mjs`'s `typeof api.imageGen.getPromptPresets !== 'function'`
  feature-detection before calling it). `.review/host/spindle-types/` has been
  refreshed to the 0.6.40 copy. This is a packaging/cache discrepancy on the host's
  side, not a version actually served differently to extensions — `worker-runtime.ts`
  (what's actually running) is the same single running instance that defines
  `spindle.imageGen` either way.
- Macro tokens: confirmed exact names/regex via `substituteCharacterPromptMacro`
  (`image-gen.service.ts:1380-1392`, `/\{\{\s*character_(?:negative_)?prompt\s*\}\}/gi`
  — pattern reconstructed from the two literal regexes shown) and
  `substitutePersonaPromptMacro` (`:1402-1412`, same shape for `persona_*`).

**Composition implemented in `core.mjs`:**
`stripCharacterPersonaMacros()` removes all four tokens (our own registry/characterTags
already supplies per-character appearance — splicing in a bound character/persona
preset snippet too would duplicate it, so tokens are *dropped*, not expanded);
`joinPromptParts()` joins non-empty, comma-trimmed fragments; `buildFinalPrompt()`
composes `[cleaned preset positive, scene prompt]` for the final `prompt`, and returns
the cleaned preset negative only when non-empty (`backend.mjs` then conditionally
includes `negativePrompt` in the request at all) — when there's nothing to contribute,
the field is **omitted entirely** rather than sent as `""`, specifically so
`resolvePromptInput`'s own `opts?.negativePrompt ?? preset?.negativePrompt ?? ...`
fallback chain (same file, same line as the positive prompt) still applies the
connection's own default negative prompt exactly as it did before any of this — sending
an explicit `""` would have short-circuited that `??` chain and silently dropped the
connection default instead (verified by reading the same `??` chain; this is also why a
non-empty preset negative is sent explicitly rather than relying on the host's
`preset?.negativePrompt` fallback: that fallback path still goes through
`expandCharacterPromptMacro`-skipped territory under our `skipParse:true`, so it would
leave `{{character_negative_prompt}}`-style tokens unstripped — we only trust our own
pre-cleaned text).

`backend.mjs`'s `fetchMainPreset()` fetches the preset **once per message-processing
pass** (not once per tag — the active preset can't change mid-pass) and once per
`regenerate` call; any failure (missing method, thrown error, malformed shape) is
swallowed and treated as "no preset" — generation is never blocked by this lookup.
**Confidence: VERIFIED by direct source read** of every cited line above. **Not
independently verified against a live generation** — whether the composed prompt
visibly changes a real generated image has not been confirmed on a live server (same
caveat as the LoRA/style preset finding above).

## Chat mutation

- `chat.updateMessage(chatId, messageId, patch)`: `patch.metadata`, if present,
  **replaces** `extra.spindle_metadata` wholesale — it does not merge with whatever is
  already there — `worker-host.ts` `handleChatUpdateMessage` (~3883): `extra.spindle_metadata = patch.metadata`.
  **VERIFIED.** Consequence: `spindle_metadata` is a *single shared bag* across every
  extension that touches a message, not per-extension namespaced. backend.mjs's
  `mergeMetadata()` always spreads the message's *existing* `metadata` object (as
  returned by `getMessages`, which already contains whatever other extensions wrote)
  before setting `[IDENTIFIER]`, so another extension's keys on the same message survive
  a write from this one — but only as long as nothing races between this extension's own
  read and write. No optimistic-concurrency check exists in the API, so two extensions
  (or two overlapping lv_illust calls) updating metadata on the same message at the same
  moment can still clobber each other. Not addressed — acceptable for an MVP that is the
  only metadata-writing extension expected to touch these messages, but worth remembering
  before installing a second metadata-writing extension alongside it.
- `getMessages` requires `chat_mutation` and returns messages with a normalized
  `metadata` field already split out of `extra.spindle_metadata` —
  `worker-host.ts` `handleChatGetMessages` (~3718-3748) — **VERIFIED**.

## Interceptor (F1)

- `registerInterceptor(handler)`; handler receives `(messages: LlmMessageDTO[], context: InterceptorContextDTO)`
  and must return `LlmMessageDTO[] | InterceptorResultDTO` — api.d.ts:189 — **VERIFIED**.
- `context.characterId` is available directly on `InterceptorContextDTO` (api.d.ts:120)
  — **VERIFIED** — so the registry lookup inside the interceptor itself doesn't need the
  `chats` permission at all; only the `GENERATION_ENDED`/`MESSAGE_EDITED` handlers do
  (they don't receive an interceptor context).
- **UNVERIFIED (not executed): message ordering.** I assumed `messages` is ordered
  oldest-first ending with the most recent turn (standard chat-history convention), so
  `injectInstruction`'s `depth` (count back from the end) and `position: 'end'`
  (append) land where a SillyTavern-style "depth N" author's note would. This is
  consistent with every doc comment that talks about "depth-injected" blocks being
  "spliced into the chat-history range" (api.d.ts, `LlmMessageDTO.__isChatHistory`
  comment) but I did not run a live generation to confirm the array's actual order.
  **Action before trusting this in play:** do one real generation with
  `position: "depth", depth: 1` and check (via the host's own Prompt Breakdown / dry
  run, or by eyeballing where the instruction text appears in the assembled prompt)
  that it lands right before the latest turn, not somewhere else.
- **UNVERIFIED: exact permission check for `registerInterceptor` itself.** The API doc
  comment says it requires `interceptor`; I did not individually trace the host-side
  `hasPermission` call for registration the way I did for chat/characters calls (time
  budget). Low risk — it is extremely unlikely to be gated by anything else, and the
  user docs independently list `interceptor` as the privileged permission for "modify
  the assembled prompt."

## Events

- `GENERATION_ENDED` payload: `{ generationId, chatId, messageId?, content?, error?, generationType? }`
  — api.d.ts:2748-2758 — **VERIFIED**. `generationType` can be
  `normal | continue | regenerate | swipe | impersonate` (api.d.ts InterceptorGenerationType,
  reused in the doc comment) — **VERIFIED the enum, INFERRED that it's reused verbatim on
  this payload** (the field is typed `string` on `GenerationEndedPayloadDTO`, not the
  union type itself). Because this event fires uniformly regardless of
  `generationType`, `handleGenerationEnded` doesn't need separate swipe/regenerate
  wiring — a swipe or regenerate is just another `GENERATION_ENDED` for a (possibly new)
  `messageId` with new `content`. **This is the basis for F2's swipe/regenerate handling**
  and was not independently exercised against a live swipe.
- `MESSAGE_EDITED` **UNVERIFIED payload shape.** It is only exposed through the generic
  `on(event: string, handler: (payload: unknown, userId?) => void)` overload — there is
  no `MessageEditedPayloadDTO` type anywhere in the `.d.ts` files I read. I inferred the
  shape `{ chatId, message }` by analogy with the sibling `MessageSwipedPayloadDTO` /
  `SwipeEditedPayloadDTO` (both of which *do* have that shape plus their own
  discriminator fields), and `source-message-metadata.ts`'s existence suggests message
  objects flow through events uniformly. `backend.mjs`'s handler defensively bails out
  (`if (!message || !chatId || message.is_user) return;`) if the shape doesn't match, so
  a wrong guess fails safe (does nothing) rather than throwing. **Needs a live edit to
  confirm the payload before trusting MESSAGE_EDITED reprocessing in practice.**

## Registry storage (F4)

- `character.extensions` is `Record<string, any>`, and `characters.update` shallow-merges
  the whole extensions object (`{ ...existing.extensions, ...input.extensions }`) —
  **VERIFIED** (worker-host-content-api.ts:367). lv_illust always writes the *entire*
  `extensions.lv_illust` value in one call, so this is safe: only our own namespaced key
  is replaced, every other extension's key under `extensions` survives untouched.
- Registry starts empty by construction: `normalizeRegistry()` returns `[]` for any
  character whose `extensions.lv_illust` is missing or malformed, and nothing in this
  codebase ever writes a non-empty default. Verified by test
  (`normalizeRegistry: empty/missing input yields empty registry (never pre-seeded)`).

## Frontend UI

- `ctx.ui.registerInputBarAction`, `ctx.ui.showModal`, `ctx.getActiveChat()`,
  `ctx.sendToBackend`/`ctx.onBackendMessage`, `ctx.events.on`, `ctx.state.subscribe` —
  all read from `dom.d.ts` `SpindleFrontendContext`/`SpindleFrontendContextV2` —
  **VERIFIED signatures**, and this exact subset is also what LV-DnH-Menu (same author,
  reportedly working) already uses in production, which is the strongest evidence
  available without running this extension myself.
- `registerMessageAction({ id, label, onClick(messageId) })` — `dom.d.ts` (~904-910) —
  **VERIFIED to exist** as a real, documented API ("message-level clickable actions" per
  the task brief). **Not used in this MVP.** It fires for every message, with no way to
  ask "does this message have a renderable image" from the options object itself — using
  it well would mean showing the action unconditionally and having its `onClick` inspect
  the clicked message's content/metadata (fetched via `chat.getMessages`-equivalent) to
  decide whether to act or show "no image here." Given the time budget, F6 is covered by
  the input-bar panel's per-image "다시 그리기" button only (backed by the `list_images`
  / `regenerate` backend calls), which is simpler and already covers "list images in the
  current chat with regenerate" per the task's primary ask. Wiring `registerMessageAction`
  too is a reasonable half-day follow-up, not done here.
- **UNVERIFIED: how message content is rendered.** I could not read Lumiverse's own chat
  frontend source (it ships as a compiled bundle under `/app/frontend/dist`, not
  TypeScript source, and reading minified bundle code wasn't a good use of the budget).
  I assumed the chat view renders Markdown images (`![alt](url)`), which is true of
  essentially every modern chat UI including SillyTavern-style ones, but **I did not
  confirm this against Lumiverse specifically.** If it turns out Lumiverse's renderer
  does *not* turn `![...](...)` into an `<img>` (e.g. it only supports a different
  component or stricter sanitization), the image will show as literal markdown text
  instead of a picture — content placement (the tag is still replaced in-place) still
  works, but the visual result would need `renderSuccessMarker()` in `src/core.mjs`
  adjusted to whatever syntax the real renderer wants. **This is the single most
  important thing to check in the "first task before building" sense that DESIGN.md §6
  asked for, and it could not be fully closed from source alone — it needs one real
  generation with a `<pic>` tag to see what actually renders.**
- **UNVERIFIED: preset composition (LoRA/style base_tags AND the main prompt preset),
  in practice.** Both code paths — `generateNative`'s automatic LoRA/style `base_tags`
  composition, and this extension's own explicit main-preset-prompt composition
  (`buildFinalPrompt`, fed by `spindle.imageGen.getPromptPresets`) — are verified by
  direct source read (see the `generate()` vs `generateNative()` section above, with
  file:line citations for both), but whether the composed text actually shows up,
  visibly, in a real generated image has not been confirmed on a live server. If the
  user has no active preset of either kind configured, composition is a no-op either
  way (falls back to the scene prompt alone, by design); if they do have one, it should
  apply, but this needs one real generation to see confirmed.
- **Accepted residual risk (narrowed in the 4th review round): the per-message lock's
  timeout cannot truly cancel a hung operation, only stop waiting for it AND stop it
  from writing once it checks.** If an operation (e.g. a stuck `generateNative` RPC with
  no timeout of its own) hangs past `lockTimeoutMs` (default 3 minutes), the lock
  releases so later operations for the same message aren't blocked forever, and the
  expired operation itself now checks `isExpired()` immediately before every write
  (`chat.updateMessage`, `pushOrphans`) and bails out if it's already past its deadline
  — this is what closed the round-4 data-loss regression (an expired operation
  previously still reached its write unconditionally). What remains unfixed, because no
  cancellation primitive is plumbed through arbitrary host RPCs: if the operation is
  suspended *inside* an `await` on a host call (e.g. mid-`generateNative`) at the exact
  moment its deadline fires, it keeps running until that `await` resolves — it simply
  checks `isExpired()` immediately afterward instead of proceeding blindly. So the
  window for "it writes something uncoordinated" is now bounded to "it was already past
  the LAST write-point check when the deadline fired" (a race that would require the
  deadline to fire in the narrow gap between a check and the write it guards — possible
  in principle, since JS can't make a check-then-write atomic across a true `await`
  boundary without a lock the write itself participates in, but not observed in testing
  and far narrower than the round-4 regression, which clobbered unconditionally).
  Logged via `console.error` when a deadline fires so it's at least observable.

## Independent review (Codex) findings — verified against this code, then fixed

A second, independent review pass (Codex) found 7 issues against the committed code.
Each was checked against the actual source (not taken on faith) before fixing:

1. **BLOCKER, confirmed real.** `processMessage`/`regenerate` read the message once,
   awaited `imageGen.generate` (can take seconds), then wrote content/metadata computed
   from that stale snapshot — silently reverting a concurrent edit/swipe or another
   extension's metadata write. Fixed: both paths now re-fetch the live message
   immediately before writing, locate each tag by its own verbatim raw text in the
   *current* content (not a stored offset), and refuse to touch the message at all if its
   active swipe changed underneath them — the generated image is kept instead as an
   "orphan" (`lv_illust.orphans` chat variable) visible read-only via `list_images`.
   Regression tests: `test/backend.test.mjs` "REGRESSION: a user edit made DURING
   generation…", "…swipe navigated away…", "…concurrent metadata write…", and two
   `regenerate`-specific ones.
2. **BLOCKER, confirmed real.** The malformed-tag fallback in `parseTags` captured text
   "through the next `<` or end of string" — when a broken tag had no `>` and nothing
   else in the message started with `<`, the *entire rest of the message* (including all
   following narrative) was swallowed into the malformed span and collapsed to a 200-char
   summary. Fixed: prefer the nearest `>` (almost always the broken tag's own intended
   close) as the boundary, bounded to 300 chars from the tag's start in the worst case —
   narrative text outside that bound is never touched. See `test/core.test.mjs`
   "REGRESSION (review finding 2)" (reproduces the exact repro given in review).
3. **MAJOR, confirmed real.** "+ 인물 추가" called `saveRegistry()` immediately with a
   `{names: [], ...}` entry, which `normalizeRegistry()` (correctly) drops — so starting
   from the required-empty registry, the button did nothing and no character could ever
   be added through the UI. Fixed: the new row is now purely local view state until its
   own "저장" is clicked with a non-empty name.
4. **MAJOR, confirmed real.** `view` (settings/registry/images) was written by whichever
   `loadAll()` happened to resolve last, with no way to tell a superseded load (e.g. the
   panel was closed and reopened for a different card before the first load answered)
   from the current one — stale data could flash over, or silently replace, a different
   card's. Fixed: a monotonic `loadToken` bumped on every `open()`; a load's results are
   discarded if the token no longer matches by the time it resolves. Writes are also now
   gated on `view.ready` (only true once a load for the *current* token fully succeeds),
   and every write targets `view.chatId`/`view.characterId` (the snapshot a given panel
   instance was opened for) rather than the live, possibly-already-moved-on outer
   `chatId`/`characterId`.
5. **MINOR, confirmed real.** The alias-matching "prefix" fallback (for an AI appending
   extra words to a name instead of using the action field) compared on the
   whitespace-*stripped* form, so "Anna" matched a registered alias "Ann" — not a real
   word boundary, just a longer string sharing the same prefix. Fixed: the fallback now
   requires an actual space after the alias in the original (whitespace-collapsed, not
   stripped) text.
6. **MINOR, confirmed real.** Failure/skipped sentinel tags embedded the raw `chars`/
   `prompt` attribute text (`<pic-failed id="..." chars="..." prompt="...">`), and since
   `scanTag` only disallows `<`/`"` inside an attribute value — not `>` — a prompt
   containing a literal `>` could make the `[^>]*`-style regexes (in both `core.mjs`'s
   history-strip and `backend.mjs`'s regenerate replace) stop too early: regenerate could
   report success while the stale marker stayed in the message, and history cleanup could
   leave raw tag text in what gets sent to the model. Fixed: the sentinel now carries only
   an opaque `id` (structured data already lives in metadata, which is where regenerate
   actually read it from anyway); matching uses one shared, exported regex builder
   (`markerRegexForId`) with no wildcard anywhere near a quote. `regenerate` now also
   checks that the replace actually matched before reporting success.
7. **MINOR, confirmed real, low severity for this threat model.** Aliases (typed by the
   user into the F4 registry panel) were spliced verbatim into the system/user/assistant
   instruction message — a stray pasted newline could inject an extra line. Not an
   external-attacker risk for a single-user tool, but cheap to fix regardless: aliases are
   sanitized (control chars/newlines stripped, length-capped) before being presented, and
   the roster now shows them as quoted data (`"이름"`) rather than bare instruction text.

No findings were rejected — all 7 were real bugs against this codebase, each with its own
regression test (`REGRESSION (review finding N)` in `test/core.test.mjs`, `REGRESSION …`
in `test/backend.test.mjs` and `test/frontend.test.mjs`).

## Second independent review (Codex, with host sources available) — verified, then fixed

A third review pass, this time with read-only copies of the actual host implementation
available (`.review/host/`, gitignored), re-tested the round-1 fixes directly (not just
read the code) and found that two of them were incomplete, plus three new issues. All 7
were checked against the actual code before fixing — **none were rejected**.

1. **BLOCKER, confirmed real (round-1 fix was incomplete).** The round-1 fix to
   `parseTags`'s malformed-tag boundary added a `>`-preferring heuristic, but the
   fallback branch that stops at the next `<` had **no bound at all** — a broken tag
   followed by ~2000 chars of real narrative and then *any* later `<` (not necessarily
   another `<pic>` tag) still made the entire narrative part of "the malformed span",
   which then got replaced by a marker (destroying it). Reviewer reproduced a 2,030→230
   character loss. Root design flaw, not just the missing bound: **replacing** a
   malformed tag's span with a marker is inherently destructive no matter how well the
   span is bounded. Fixed properly this time: malformed tags are never replaced — the
   original text is left **byte-for-byte in place**, and a short marker is only ever
   *inserted* right after it (`core.mjs` `planMessage`'s `{mode:'insert', ...}` entries,
   `backend.mjs`'s splice loop). A `metadata.lv_illust.malformedSeen` list (raw tag text)
   prevents the same malformed tag from being re-annotated on every later pass, since the
   text itself is never consumed/altered and would otherwise be "detected" again forever.
   The boundary-detection bound was also fixed to actually apply to the `nextLt` fallback
   too (it's now just dedup-key/scan-resume hygiene, not a safety mechanism, since nothing
   is deleted any more). Tests: `test/core.test.mjs` "REGRESSION (review finding 2, round
   1)" (updated) + "REGRESSION (review finding 1, round 2 — exact repro)" (reproduces the
   reviewer's ~2000-char case directly), `test/backend.test.mjs` two new integration-level
   tests.
2. **BLOCKER, confirmed real.** The round-1 fix to the stale-write race re-fetched the
   live message before committing — correct — but then **awaited `pushOrphans()`
   between that revalidating read and the actual commit**. `pushOrphans` does its own
   read-modify-write RPC pair (`variables.chat.get`/`set`), and an edit landing during
   those RPCs would be silently overwritten by the commit that followed, reopening
   exactly the race round 1 had just closed. Fixed: the message commit now always
   happens first, with no RPC awaited in between the revalidating read and the write;
   orphan bookkeeping strictly follows it. Test: `test/backend.test.mjs` "REGRESSION
   (2nd pass, finding 2)".
3. **MAJOR, confirmed real.** `GENERATION_ENDED` and `MESSAGE_EDITED` can fire close
   together for the *same* message. Each handler planned independently from its own
   snapshot (ids allocated from `existingImageIds` computed at that snapshot) — two
   overlapping handlers could both allocate `"p1"`, and whichever committed second
   silently overwrote the first's metadata record, even though the generation queue
   serialized the actual NAI calls. Fixed two ways: (a) `backend.mjs` now serializes the
   entire plan→generate→commit sequence per `(chatId, messageId)` via an in-memory lock
   (`withMessageLock`), and planning always re-reads the live message *after* acquiring
   the lock, so a handler queued behind another sees everything the first already
   committed before it plans anything; (b) `core.mjs`'s `nextImageId` is now
   collision-resistant by default (time+random), not a small sequential counter, as
   defense in depth for what the in-process lock can't cover (a worker restart
   mid-generation) — tests inject a deterministic counter via the new `idGenerator`
   option so assertions on exact ids stay readable. Test: `test/backend.test.mjs`
   "REGRESSION (2nd pass, finding 3)".
4. **MAJOR, confirmed real.** The host can resolve `generate()`/`generateNative()`
   successfully while image persistence failed internally
   (`worker-host-image-gen-api.ts:180-206` catches that and still resolves); `imageId`/
   `imageUrl` are optional on the result DTO (`api.d.ts:818-825`). The extension still
   recorded `status:'ok'` and wrote `![그림:id|...](undefined)` — and on regenerate, this
   could replace a previously-working image with a broken one. Fixed: `generateImage()`
   now validates the result has a non-empty `imageUrl` string and throws (routed through
   the existing failure path) otherwise; `regenerate` validates *before* touching any
   content/metadata, so a bad regeneration result leaves the old working image completely
   untouched. Tests: `test/backend.test.mjs` "REGRESSION (2nd pass, finding 4)" ×2.
5. **MAJOR, confirmed real.** `imageGen.generate()` does not apply Lumiverse's native
   main/style preset or card-level preset — contrary to DESIGN.md §0, which says this
   extension relies on Lumiverse's own presets rather than storing its own. See the
   "`generate()` vs `generateNative()`" section above for the full investigation and the
   switch to `generateNative()`. Test: `test/backend.test.mjs` "REGRESSION (2nd pass,
   finding 5)" (asserts the exact request shape: `generateNative`, `chat_id`,
   `promptMode:'custom'`, `skipParse:true`, `characterTags` intact).
6. **MINOR, confirmed real.** Orphaned images (no live message/tag to regenerate into —
   that's what made them orphans) still got a "다시 그리기" button in the panel, which
   either failed immediately or, worse, could target an unrelated surviving record that
   happened to share the id (finding 3's duplicate-id scenario). Fixed: `frontend.mjs`
   shows status/reason only for `status:'orphan'` entries, never a regenerate button.
   Test: `test/frontend.test.mjs` "REGRESSION (2nd pass, finding 6)".
7. **MINOR, confirmed real.** Turning auto-generation off for a chat also stopped the
   independent history-cleanup step (stripping rendered image markup down to a short
   placeholder before it's fed back to the model) — DESIGN.md §4's history-cleanup rule
   has no such condition; only F1's instruction injection is supposed to depend on the
   auto-gen flag. Fixed: the interceptor now always runs `stripRenderedImages` on every
   message regardless of the auto-gen flag, and only gates `injectInstruction` on it.
   Test: `test/backend.test.mjs` "REGRESSION (2nd pass, finding 7)".

**Bonus (not independently numbered, caught in the same pass):** embedded `"` characters
in a registry alias were not escaped/stripped before being wrapped in `"..."` for the
instruction roster, so an alias containing a quote could break out of its own quoting.
Fixed in `sanitizeAliasForInstruction` (strip `"` along with control chars). Test:
`test/core.test.mjs` "REGRESSION (review bonus)".

No findings were rejected in this pass either — 7/7 confirmed real, fixed, regression-tested.

## Third independent review (Codex, with host sources available) — verified, then fixed

A fourth review pass re-tested the round-2 fixes with real reproductions (not just code
reading) and found that finding 1 (malformed-tag handling) was still incompletely fixed,
plus one new major finding (preset composition, partial from round 2) and one new minor
(lock map cleanup). **No BLOCKER was reproduced this round** — the reviewer explicitly
confirmed the stale-write race, duplicate-id, missing-URL, orphan-button, and
auto-off/cleanup fixes from round 2 all held up under new reproductions. 2 MAJOR + 1
MINOR found; all 3 confirmed real against the actual code, none rejected.

1. **MAJOR (round-2 fix incomplete) — malformed-tag annotations could grow without
   bound.** Confirmed and reproduced exactly as described: a capped `malformedSeen`
   metadata list (`.slice(-50)`) evicted old entries while the physical annotation
   stayed in the message forever — past 50 distinct malformed tags, every later pass
   rediscovered an evicted-from-the-list (but still-unmarked-as-seen) tag and annotated
   it again, producing unbounded growth (reviewer measured 110 writes / 160 annotations
   over 110 passes at 51 distinct tags). A second variant showed the inserted
   annotation itself becoming part of the next parse's `tag.raw` for an unterminated
   tag, shifting the dedup key and causing nested annotations. **Root-caused and fixed
   properly this time**: idempotency is now a property of the *content itself*, not a
   side list with a cap to desync from reality. `parseTags`'s `checkAnnotated()` checks
   whether the exact fixed marker text (`MALFORMED_MARKER_TEXT`) is found immediately
   after a malformed span; if so, the tag is flagged `annotated: true` and `planMessage`
   skips it entirely (no new marker, nothing recorded anywhere) — correct regardless of
   how many malformed tags exist or how many passes run, because there is no cap to hit.
   The `malformedSeen` metadata field and its `MAX_SEEN_MALFORMED` cap were removed
   entirely, not just enlarged. Property-tested with `N=20` repeated passes over three
   scenarios (60 distinct malformed tags; an unterminated tag + long prose; a mix of
   valid/malformed) in `test/core.test.mjs`, asserting only the first pass writes
   anything and original text is always byte-for-byte recoverable; an integration-level
   test in `test/backend.test.mjs` reproduces the reviewer's exact 60-tag scale through
   `handleGenerationEnded`/`handleMessageEdited`.
2. **MAJOR (round-2 "generateNative" fix was incomplete) — the native main prompt
   preset was still only partially applied.** Confirmed by reading
   `image-gen.service.ts:1333` directly: `opts?.prompt ?? preset?.prompt ?? ...` means
   our inline scene prompt (never `null`/`undefined`) always wins — the active main
   preset's own prompt text was silently dropped, not composed, even after switching to
   `generateNative()`. Only the *separate* LoRA/style preset (round 2) was actually
   fixed; the main positive-prompt preset mechanism is a different code path entirely.
   Investigated and fixed as described in detail in the `generate()` vs
   `generateNative()` section above ("Follow-up (3rd review pass)") — composes the
   active main preset's cleaned prompt with the tag's scene prompt explicitly via
   `spindle.imageGen.getPromptPresets()`, with macro tokens stripped (not expanded) and
   the negative prompt handled to avoid doubling with the connection default. Six new
   regression tests in `test/backend.test.mjs` cover: composition happens, macro tokens
   are stripped, no-preset falls back to scene-alone, a host without the optional method
   never blocks generation, a thrown error from the method is swallowed, and regenerate
   also composes the preset.
3. **MINOR, confirmed real.** The per-message lock map (`messageLocks`) never deleted a
   settled entry — reproduced: processing 1,000 distinct `(chatId, messageId)` keys left
   1,000 permanent entries, including messages with no `<pic>` tags at all (the lock is
   acquired before that check). Fixed: a settled entry is deleted, but **only if it is
   still that key's most-recently-queued entry** — deleting unconditionally would let a
   second call's own entry (queued behind the first, for the same key) get erased by the
   first call's cleanup, which would let a third call bypass the queue entirely. Also
   added, per the coordinator's explicit request alongside this finding: a fixed overall
   deadline per operation (default 3 minutes, overridable via `createService(api,
   {lockTimeoutMs})` for tests), so a hung predecessor (e.g. a stuck host RPC with no
   timeout of its own) cannot block every later operation queued for the same message
   forever — on timeout the lock is released (logged via `console.error`) for the next
   queued operation. This does **not** cancel the hung operation itself (no cancellation
   primitive is plumbed through arbitrary host RPCs); if it completes later anyway, its
   result is discarded, but if it was about to write, that write could still land,
   uncoordinated with whatever ran after it timed out. This residual risk is accepted
   and documented, not silently assumed away — see "Known limitations". Tests: 1,000-key
   memory test, a same-key-queued-behind-a-settling-call test, and a real (short,
   `lockTimeoutMs: 20`) timeout test proving a second operation can proceed once the
   first's deadline elapses.

No findings were rejected in this pass either — all 3 confirmed real, fixed,
regression-tested. 124 tests total (was 103), all passing.

## Fourth independent review (Codex, with host sources available) — NOT CLEAR, then fixed

A fifth review pass re-tested round 3's fixes with real reproductions and found that
**both** were incomplete: the lock-deadline fix for finding 1 (round 3) introduced a new
data-loss regression of its own, and the malformed-tag structural fix for finding 2
(round 3) still had a surviving failure mode for the exact short repro. **Verdict was
"NOT CLEAR."** Both findings were reproduced, root-caused, and fixed; none rejected.

1. **MAJOR regression (round-3 fix for the lock deadline was itself unsafe) — an
   expired operation could still write and clobber a later operation's result.**
   Confirmed and reproduced exactly: round 3's `raceWithDeadline` raced an operation's
   promise against a timer so the NEXT queued operation wouldn't wait forever — but
   racing a promise never cancels the loser. The reviewer paused an operation (A) right
   before its final re-read, let A's deadline elapse (so a second operation, B, could
   acquire the lock and commit normally), then resumed A — and A's own, now-stale
   `chat.updateMessage` call still fired, overwriting B's image, an intervening user
   edit, and unrelated metadata, all in one write. **Fixed:** every locked operation now
   receives an `isExpired()` function; `processMessageInner` and `regenerateLocked`
   check it immediately before **every** write point (both `pushOrphans` call sites and
   the main `chat.updateMessage` commit, not just once) and bail out without writing if
   it's already true. This doesn't achieve true cancellation of a hung RPC the
   operation might be awaiting at the exact moment it expires (no cancellation
   primitive exists for that) — but it closes the actual data-loss hole, because by the
   time an expired operation reaches any write, it now always discovers it's expired
   first and stops. Also applied the identical pattern to the *separate* global
   generation queue (`queuedCall`/`raceGenerateDeadline`, `generateTimeoutMs`, default 5
   minutes): a hung `generateNative()` call no longer blocks every later queued
   generation (for any message) — the race rejects on timeout, which the existing
   try/catch in `processMessageInner`/`regenerateLocked` already treats as an ordinary
   generation failure (never writes without re-validating), so a late real result from
   the hung call, if it ever arrives, is simply discarded — nothing is left waiting for
   it. Tests: an exact reproduction of the reviewer's scenario (pause A at its final
   read, let its deadline elapse, run B to completion, resume A, assert A does not
   write and B's image/edit/metadata all survive) and a separate test for the global
   queue (a hung first generate() does not block a second message's generation, and the
   hung call's late resolution never reaches either message).
2. **MAJOR (round-3 fix for malformed-tag idempotency was incomplete) — the exact short
   repro `<pic prompt="unfinished` (nothing after it: no closing quote, no `>`, no `<`,
   no trailing prose) still produced 10 writes and a corrupted/nested annotation.**
   Root-caused: round 3 made idempotency content-based (check for the marker
   immediately *after* a computed malformed span) but still computed that span
   heuristically, and `scanTag`'s own unterminated-attribute-value scanning only stops
   at `"` or `<` — neither of which appears in the marker text — so on the second pass,
   the "unterminated value" scan read straight through the first-inserted marker as if
   it were more of the (still-unterminated) value, which moved where the span was
   computed to end on every subsequent pass, so the "is the marker right after the
   span" check kept looking in the wrong (ever-shifting) place and never found the
   marker it had already inserted. **Fixed structurally this time, exactly as
   requested:** the marker is now inserted immediately after the literal 4-character
   `<pic` opener itself — before any of the tag's own attribute text — and
   `MALFORMED_MARKER_TEXT` was changed to start with `⟦` (a character that is neither
   whitespace nor `>`). `parseTags`'s very first check on each `<pic` occurrence
   (`boundary = text[idx+4]`) already rejects anything where that position isn't
   whitespace or `>` as "not a tag opener" (this is the exact same rule that already
   made `<pic-failed`/`<pic-skipped` sentinels unparseable) — so an annotated malformed
   tag can no longer even be *recognized* as a `<pic` tag on a later pass, and
   `scanTag`'s problematic unterminated-value scanning is never invoked on it again at
   all. This eliminates the need for any span-length heuristic for malformed tags:
   `buildMalformedTag` no longer looks for `>`/`<` boundaries or applies any bound to
   decide where the tag "ends" — the relocation anchor used to re-find a malformed tag
   in possibly-changed content (see backend.mjs) is now just a fixed 32-character
   prefix, with no significance beyond being a reasonably unique search key (insertion
   is always exactly 4 characters into wherever that anchor is found, regardless of the
   anchor's own length). **A bug was also found and fixed in `backend.mjs`’s own splice
   loop while implementing this**: it still computed the insertion point as
   `at + tag.raw.length` (the OLD "insert after the whole anchor" arithmetic) instead of
   `at + 4` — core.mjs's own `parseTags`/`applyMarkers` were already fully correct and
   idempotent by this point, but backend.mjs's separate, hand-written splice loop (kept
   separate from `applyMarkers` for the stale-write-race fix, see finding 1 above) still
   had the stale arithmetic, which silently reintroduced repeated writes at the
   integration level even though core-level tests already passed. Caught by the
   project's own backend-level regression test for this exact scenario, not by the
   external review. Tests: the N=20-pass property tests from round 3 (60 distinct tags;
   unterminated + long prose; mixed valid/malformed) plus a new one for the *exact*
   short repro; a 40-trial seeded fuzz test (`FUZZ (review, 3rd pass, finding 1)`)
   generating random mixes of valid tags, unterminated tags at message end, unterminated
   tags followed by prose containing `<`/`>`/`"`, and nested `<pic` openers, each run for
   20 passes and asserted idempotent + byte-recoverable; and a backend-level test
   reproducing the exact short repro through the real event handlers.

Both findings confirmed real against the actual code and reproduced before fixing;
none rejected. 129 tests total (was 124), all passing.

## What was explicitly NOT done (by design, not oversight)

- No `generation_parameters` permission / no `parameters` return from the interceptor —
  F1 only injects a plain instruction message, never alters the outgoing LLM request's
  provider parameters.
- No `events`/`event_tracking` telemetry — not needed for the MVP feature set and keeps
  the permission list minimal.
- No handling of NAI PNG metadata import, manual (non-tag) generation panel, or Scene
  tool integration — all explicitly "2단계 (나중에)" in DESIGN.md.
