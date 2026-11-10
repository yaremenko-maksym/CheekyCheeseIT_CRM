# Which of our inference routes can take 1–2 base64 PNG pages as `image_url` parts on the free tier?

**Date:** 2026-11-10 · **Why:** Task 11 of the verified-base-resume plan (`POST /visual-check`) must
decide which configured route/model may receive image parts; a wrong answer either sends images to a
text-only model (provider 400) or refuses a route that would have worked.
**Shelf life:** short. Both providers renamed or retired models within months, and Groq's vision models
are preview. Recheck (a) when Google's deprecation date of 2026-12-01 passes (`gemini-2.5-flash`,
`gemini-2.5-pro` reroute), (b) whenever Groq's vision page lists a different model or a model leaves
preview, (c) when `GEMINI_MODEL_PATTERN` / `GROQ_MODEL_PATTERN` in
`packages/inference/src/internal/model-id.ts` change, (d) monthly otherwise.

## Short answer

- **Gemini (OpenAI-compatible endpoint): yes.** Every Gemini model is multimodal, the compat endpoint
  documents `image_url` with a `data:image/…;base64,` URL, PNG is accepted, the whole request (text +
  inline bytes) must stay under 20 MB, and the flash / flash-lite families have a free tier. Every id
  our Gemini pattern admits is vision-capable.
- **Groq: not through our router today.** The only Groq vision models are `qwen/qwen3.8-27b` (max 3
  images) and `meta-models/muse-spark-open` (max 5, gated preview), both **preview**, and neither matches
  `GROQ_MODEL_PATTERN` (`openai/gpt-oss-(20b|120b)`, text-only). Admitting one is a pattern change plus
  a security-review question, not a Coder default.
- **Privacy caveat (A3, owner):** Google's pricing page states free-tier content **is used to improve
  products**. A rendered resume page is candidate PII.

## Facts

### Our routes (repository, base `c7d6b2a2c`)

- Hosted providers are exactly `gemini` and `groq`; base URLs are package constants
  `https://generativelanguage.googleapis.com/v1beta/openai/` and `https://api.groq.com/openai/v1` —
  `packages/inference/src/router/config.ts` (`HOSTED_PROVIDERS`, `HOSTED_BASE_URLS`).
- Gemini ids must match `GEMINI_MODEL_PATTERN`
  `^gemini-([0-9]+(?:\.[0-9]+)?)-(flash|flash-lite|pro)(?:-preview(?:-[0-9]{2}-[0-9]{4})?)?$`; Groq ids
  must match `GROQ_MODEL_PATTERN` `^openai\/gpt-oss-(20b|120b)$` —
  `packages/inference/src/internal/model-id.ts`.
- The managed model listing drops any provider-listed id that fails the same patterns
  (`parseGeminiModelId`, `isValidProviderModelId('groq', …)`) — `packages/inference/src/router/model-listing.ts`.
  So a Groq vision id would never appear in the managed list either.
- Chat messages are built as `{ role: string; content: string }[]` and the response schema reads
  `message.content` as a string — `packages/inference/src/internal/chat-completions.ts`
  (`buildChatMessages`). There is no content-part array today; the Coder must add one for image parts.

### Gemini API (OpenAI compatibility)

- The compat base URL is `https://generativelanguage.googleapis.com/v1beta/openai/`; the
  image-understanding example sends a user message with a `text` part and an `image_url` part whose
  `url` is `data:image/jpeg;base64,{base64_image}`, model `gemini-3.8-flash`. The page states no
  image-specific limits and says OpenAI library support "is still in beta" —
  [Gemini OpenAI compatibility](https://aistudio.google.com/docs/openai) (formerly
  `ai.google.dev/gemini-api/docs/openai`, 301), accessed 2026-11-10.
- "All Gemini model versions are multimodal." — [Image understanding](https://aistudio.google.com/docs/image-understanding), accessed 2026-11-10.
- Supported MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/heic`, `image/heif` — same page.
- Max 3,600 image files per request — same page.
- Inline data: total request size (text prompts, system instructions, inline bytes) limited to
  **20 MB**; larger goes through the File API — same page.
- Token cost: 258 tokens if both dimensions ≤ 384 px; otherwise tiled into 768×768 tiles at 258 tokens
  each (crop unit = floor(min dimension / 1.5); e.g. 960×540 gives 6 tiles) — same page.
- Free tier ("Free of charge" input) exists for `gemini-3.8-flash`, `gemini-3.6-flash`,
  `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`, `gemini-2.5-flash`,
  `gemini-2.5-flash-lite`, `gemini-2.5-pro`; **not** for `gemini-3.1-pro-preview` or the
  `gemini-4-*` models. Free-tier content "used to improve products: Yes" —
  [Gemini API pricing](https://aistudio.google.com/docs/pricing), accessed 2026-11-10 (the page's
  last ~9k characters were not read).
- `gemini-2.5-pro` and `gemini-2.5-flash` are deprecated and reroute on 2026-12-01 (to
  `gemini-3.8-flash` and `gemini-3.5-flash-lite` respectively) — same pricing page.
- The rate-limits page does not publish free-tier RPM/TPM/RPD numbers; it says limits are viewed in
  Google AI Studio per project, and it says nothing about image input counting toward limits beyond
  token cost — [Rate limits](https://aistudio.google.com/docs/rate-limits), accessed 2026-11-10.

### Groq

- Vision models: `qwen/qwen3.8-27b` (max **3** images per request, each counts as 2048 input tokens)
  and `meta-models/muse-spark-open` (max **5** images, up to 1,026 tokens each, limited preview —
  "contact us" for access). Base64 data URLs are supported (example `data:image/jpeg;base64,…`). A
  request with an image URL is limited to **20 MB**; no separate base64 limit and no resolution limit
  are stated — [Groq Vision](https://console.groq.com/docs/vision), accessed 2026-11-10.
- `qwen/qwen3.8-27b`: input text + images, output text, **Preview**, context 131,072, max file size
  20 MB, max 3 input images — [Groq model page](https://console.groq.com/docs/model/qwen/qwen3.8-27b),
  accessed 2026-11-10.
- Both vision models are in the **preview** list; preview models "may be discontinued at short
  notice". The production list (`llama-3.1-8b-instant`, `llama-3.3-70b-versatile`,
  `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, whisper) contains no vision model —
  [Groq models](https://console.groq.com/docs/models), accessed 2026-11-10.
- The public rate-limit table is the **Developer** plan (e.g. `qwen/qwen3.8-27b` 30 RPM / 1K RPD /
  8K TPM / 200K TPD, same as gpt-oss); free-plan values are only in the account's limits page —
  [Groq rate limits](https://console.groq.com/docs/rate-limits), accessed 2026-11-10.

## Applicability to us

- **Gemini route:** every id `GEMINI_MODEL_PATTERN` accepts is in a multimodal family, so "provider is
  gemini" already implies vision-capable; no new allowlist is needed. Free tier holds for the
  flash / flash-lite ids; a configured `gemini-3.1-pro-preview` would not be free (the route config
  governs that, not this endpoint). Two PNG pages are far below 20 MB; at e.g. 1240×1754 (A4 at
  150 dpi) a page costs roughly 2×3 = 6 tiles ≈ 1,548 tokens, two pages ≈ 3.1k input tokens per call.
- **Groq route:** our pattern admits only `gpt-oss`, which Groq's models page does not list as
  image-capable and the vision page omits. Sending image parts there would at best 400. Admitting
  `qwen/qwen3.8-27b` means widening a security-reviewed checked-in pattern (ADR §3.4, SR-H-1) to a
  preview model that can vanish at short notice; at 2048 tokens per image, two pages plus a prompt
  approach the Developer-plan 8K TPM in one call, and the free plan is presumably no higher. Not
  worth it for Task 11.
- **Local route:** out of scope of this research (any id passes `isValidModelId`; vision depends on
  the runtime's model). Treat as not vision-capable unless a later task proves otherwise.
- **Data:** free-tier Gemini content is used by Google to improve products. Sending a candidate's
  rendered resume to it is a personal-data decision for the owner (A3; Legal may need to weigh in),
  independent of the technical answer.

## What could not be established

- Gemini compat endpoint: no documented per-image byte limit or image count specific to the
  OpenAI-compatible path; the 20 MB / 3,600 numbers come from the native image-understanding page and
  are assumed to apply. Confidence MED.
- Free-tier numeric rate limits for both providers: not published on public pages (Gemini: per project
  in AI Studio; Groq: account limits page). Whether image tokens count toward Gemini free TPM is not
  stated.
- Groq: accepted image formats beyond the JPEG example, max resolution, and whether the 20 MB limit
  differs for base64 bodies are not stated. Whether `gpt-oss` returns an error or silently drops image
  parts was not verified (no live calls allowed).
- Groq free-plan data-use terms were not researched.

## Decision input

1. `isVisionCapable(route, modelId)` = `route.provider === 'gemini' && GEMINI_MODEL_PATTERN.test(modelId)`.
   Groq (`gpt-oss` only) and `local` return false. No new env/config knob.
2. `/visual-check` walks the configured routes, takes only vision-capable ones, sends at most 2
   `image_url` parts with `data:image/png;base64,…`, and refuses before sending when the encoded
   request would exceed 20 MB (in practice cap well below, e.g. a few MB per page).
3. No vision-capable route configured (or all exhausted / own cap hit) → reply `unavailable`; never
   fall back to a text-only route with the images dropped.
4. Groq vision (`qwen/qwen3.8-27b`) is a separate, security-reviewed pattern change — not part of Task 11.
5. Before enabling in prod: owner decision on sending candidate PII to free-tier Gemini, whose content
   is used to improve Google products.
