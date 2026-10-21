# API-NOTES — LV-AutoPic

Everything cited below was read from the Lumiverse container's own type definitions and
TypeScript source (not from any AutoPic/SillyGgu code — clean room). Paths are inside
the `lumiverse` container as of this writing (image built 2026‑10‑10 per file mtimes).

- Spindle types: `/home/bun/.bun/install/cache/lumiverse-spindle-types@0.6.32@@@1/dist/*.d.ts`
- Host source: `/app/src/spindle/*.ts`, `/app/src/image-gen/providers/novelai.ts`
- User docs: `/app/user-docs/docs/extensions/index.md`

Confidence key: **VERIFIED** = read directly in the files above. **INFERRED** = a
reasonable reading of verified material, not contradicted by anything found, but not
executed. **UNVERIFIED** = genuinely untested against the live host; call this out to
the user before relying on it in production.

## Permissions actually required

| Permission | Why | Evidence |
|---|---|---|
| `image_gen` | `spindle.imageGen.generate` | spindle-api.d.ts:684 gate comment; worker-host-image-gen-api.ts:108 `hasPermission("image_gen")` check — **VERIFIED** |
| `interceptor` | `spindle.registerInterceptor` (F1) | spindle-api.d.ts:214 doc comment — **VERIFIED** (permission gate itself not traced in worker-host.ts, but index.md lists `interceptor` as privileged and this is the only API that injects prompt content) |
| `chat_mutation` | `spindle.chat.getMessages` / `appendMessage` / `updateMessage` | worker-host.ts: `handleChatUpdateMessage` (~3868), append (~3782) and get-messages (~3718) each do `if (!this.hasPermission("chat_mutation")) throw ...` — **VERIFIED**. Note: `/app/user-docs/docs/extensions/index.md` describes `chat_mutation` only as "hide/unhide + bulk mutations on the current chat" and lists it as auto‑granted — that prose is stale/incomplete; the actual gate in worker-host.ts covers get/append/update/delete too, and LV‑DnH‑Menu (same author, already working in production) relies on exactly this. Trusted the code over the doc. |
| `characters` | `spindle.characters.get`/`update` for the per‑card registry (F4) | worker-host-content-api.ts:346 `handleCharactersUpdate` — `hasPermission("characters")` check, and shallow merge `{ ...existing.extensions, ...input.extensions }` — **VERIFIED** |
| `chats` | `spindle.chats.get(chatId)` to resolve the character card that owns a chat | spindle-api.d.ts:836-849 `chats.get` signature — **VERIFIED signature**; permission gate on the host side not individually traced (ran out of budget) but `"chats"` is listed as the permission for this whole namespace in permissions.d.ts and index.md — **INFERRED** gate, standard pattern matches every other namespace checked. |

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
  (or two overlapping LV‑AutoPic calls) updating metadata on the same message at the same
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
  **VERIFIED** (worker-host-content-api.ts:367). LV-AutoPic always writes the *entire*
  `extensions.lv_autopic` value in one call, so this is safe: only our own namespaced key
  is replaced, every other extension's key under `extensions` survives untouched.
- Registry starts empty by construction: `normalizeRegistry()` returns `[]` for any
  character whose `extensions.lv_autopic` is missing or malformed, and nothing in this
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

## What was explicitly NOT done (by design, not oversight)

- No `generation_parameters` permission / no `parameters` return from the interceptor —
  F1 only injects a plain instruction message, never alters the outgoing LLM request's
  provider parameters.
- No `events`/`event_tracking` telemetry — not needed for the MVP feature set and keeps
  the permission list minimal.
- No handling of NAI PNG metadata import, manual (non-tag) generation panel, or Scene
  tool integration — all explicitly "2단계 (나중에)" in DESIGN.md.
