# 삽화가 (개인용) / LV-Illust

[한국어](README.md)

A personal Lumiverse (Spindle) extension. When the AI writes a `<pic ...>` tag mid-reply,
it's replaced in place with a generated NovelAI image, and names mentioned in the tag are
looked up in a per-character appearance registry and routed into NovelAI's per-character
prompt slots (`characterTags`).

> **Personal / private use only.** Not licensed for redistribution. Intended for
> installing on your own server, not for publishing or sharing as a package.

## Features

| # | What it does |
|---|---|
| F1 | Before generation, injects an instruction ("if a picture is needed, write `<pic chars="name" prompt="scene">`") into the prompt. Position/depth/role are configurable. |
| F2 | On generation end, finds `<pic>` tags in the reply and renders them one by one. Max 2 images per reply (configurable); extra tags get a visible "skipped" marker. A malformed tag's original text is **never deleted or summarized** — it's left byte-for-byte in place, with only a short marker appended right next to it (message length never shrinks because of malformed-tag handling). |
| F3 | Matches names in a tag against the registry (multiple aliases per character, longest-alias-first, case/whitespace-insensitive, a partial match only counts at a real word boundary), substitutes the registered appearance prompt, and routes it to NAI's character slot. Unregistered or disabled characters fall back to whatever the AI itself described in the scene text. |
| F4 | A per-character-card appearance registry (names, appearance prompt, on/off), shared across every chat using that card. **Starts empty** — nothing is pre-seeded. |
| F5 | Renders the image directly in place of the tag (`chat.updateMessage`). Failures and over-the-cap skips each get a distinct, recoverable marker; the original tag data is kept in message metadata. Generation goes through Lumiverse's own `imageGen.generateNative`, composing both the active main prompt preset and the active style/LoRA preset onto the scene prompt (scene prompt alone if neither is set). |
| F6 | The input-bar "삽화가 설정" (Illustrator Settings) panel lists this chat's generated images with a "다시 그리기" (regenerate) button. If the message changed (edited/swiped) while a generation was in flight, the image is never discarded — it's kept as a recoverable, status-only entry (no regenerate button — there's nowhere left to put it) in that same panel instead. |

Lumiverse's own main/style prompt presets, per-card presets, and auto-scene generation are
left untouched — this extension only adds "in-reply picture tags" + "per-character
appearance registry," nothing Lumiverse already does natively.

## Permissions and why each is needed

| Permission | Why |
|---|---|
| `image_gen` | `spindle.imageGen.generate` to actually render images |
| `interceptor` | Injects the F1 instruction before generation, and rewrites past rendered images down to a short placeholder so image markup/tags are never fed back into the model |
| `chat_mutation` | Reads messages (`getMessages`) and rewrites the tag in place with the image (`updateMessage`) |
| `characters` | Reads/writes the per-card registry under `extensions.lv_illust` (F4) |
| `chats` | Resolves which character card owns the current chat (`chats.get`), to load that card's own registry |
| `generation` | Subscribes to `GENERATION_ENDED` — without this permission the host silently refuses the subscription itself, so F2 (tag detection) would never run at all |

All six are privileged permissions requiring admin approval (on a single-user personal
server, that's just you, the installer).

## Install

### (a) Import Local
1. Copy this repo into the server's `data/extensions/lv_illust/repo/` (see `설치방법.txt`
   for the exact `docker cp` commands).
2. Log in as owner → Extensions (Spindle) panel → **Import Local**.
3. Approve the six permissions above and Enable.

### (b) GitHub "Install from Source" (if this repo is ever pushed)
1. Extensions panel → **Add Extension** → *Install from Source*, paste the repo URL.
2. Approve the same permissions and Enable.

(This repo is currently local-only and has not been pushed anywhere. If it ever is, this
flow works as-is.)

## Known limitations

- Whether Lumiverse's chat view actually renders the markdown image syntax
  (`![...](...)`) this extension writes as a visible picture was never confirmed against
  a live server. Test with one real `<pic prompt="...">` after installing.
- Both the main-prompt-preset composition and the native style/LoRA preset composition
  were confirmed by reading the actual implementation, but whether either visibly shows
  up in a real generated image hasn't been confirmed live.
- The `MESSAGE_EDITED` event's payload shape is inferred (no type definition exists for
  it). If the guess is wrong, the handler fails safe — it does nothing rather than acting
  on bad data.
- If a message is edited or swiped while a generation for it is still in flight, the
  image is never spliced into the (now different) message — it's kept as a recoverable,
  un-auto-retried, status-only entry visible in the panel instead (no regenerate button).
- Processing for one message is serialized, and a hung operation (past 3 minutes)
  releases its lock so later operations aren't blocked forever. A hung operation that
  resumes later always checks, immediately before any write, whether it has already
  expired — and skips the write if so, so it can no longer overwrite whatever a later
  operation already committed (an earlier version of this check had a gap that let
  exactly this happen; found and fixed by review). It still can't be truly cancelled
  mid-flight while awaiting a single host call (no cancellation primitive exists for
  that) — it just checks again the instant that call returns. The image-generation
  queue has the same kind of deadline (5 minutes) so one stuck generation can't block
  generation for other messages either.

See `docs/API-NOTES.md` for the evidence behind every API claim (file:line,
VERIFIED/INFERRED/UNVERIFIED).

## Build & test

```sh
node scripts/build.mjs     # src/ -> dist/ (no dependencies)
node --test test/*.test.mjs
node scripts/pack.mjs      # release/lv_illust-<version>.zip (reproducible build)
```
