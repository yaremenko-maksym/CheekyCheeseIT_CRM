# Cloudflare Workers AI as a router provider: endpoint, catalogue, errors, limits

**Date:** 2026-11-17 · **Why:** the `cloudflare` route of the `@crm/inference` router (ADR
`2026-11-03-extraction-model-router.md`, "Amendment 2026-11-17 — Cloudflare provider") is built on these facts:
the chat URL, the listing the daily refresh reads, the classification of errors and the own cap.
**Shelf life:** recheck before the first production run of the route, on any Cloudflare changelog entry titled
"Planned model deprecations", and whenever a refresh run records `NOTHING_SURVIVED` for `cloudflare`. Prices and
the free allocation: recheck monthly against the pricing page.

## Short answer

Chat goes to `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions` with
`Authorization: Bearer <token>` and an OpenAI-shaped body. The catalogue is
`GET /accounts/{account_id}/ai/models/search`, filterable by task. Its documented response type is
`result: array of unknown`, so the entry shape is taken from Cloudflare's own docs pipeline (MED). A deprecated
model answers HTTP 410 (internal code 5028). The free allocation is 10 000 Neurons a day, reset at 00:00 UTC;
over it, code 3036 on HTTP 429.

## Facts

- The OpenAI-compatible Chat Completions endpoint is `/v1/chat/completions` under the base URL
  `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1`; the curl example sends
  `Authorization: Bearer {api_token}`. "Most Workers AI text generation models support the OpenAI Chat Completions
  API." — [OpenAI compatible API endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/),
  accessed 2026-11-17.
- Model search: `GET /accounts/{account_id}/ai/models/search`; query parameters `author`, `format` (`openrouter`),
  `hide_experimental`, `include_deprecated` ("If true, include models for up to three months after their
  deprecation date. Defaults to false."), `page`, `per_page`, `search`, `source`, `task` ("Filter by Task Name").
  The response is `{ errors, messages, result: array of unknown, success }`. Accepted permissions: Workers AI Read
  or Write. — [Model Search API reference](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/),
  accessed 2026-11-17.
- Wrangler reads the same endpoint with `per_page=50` and pages until a short page; its `Model` type is
  `{ id, source, task?: { id, name, description }, tags, name, description? }`. —
  [workers-sdk `packages/wrangler/src/ai/utils.ts` and `types.ts`](https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/src/ai),
  branch `main`, accessed 2026-11-17.
- Catalogue entries as Cloudflare's docs pipeline stores them carry `name` (`@cf/mistralai/mistral-small-3.1-24b-instruct`),
  `id` (a UUID), `task.name` (`Text Generation`) and `properties: [{ property_id, value }]`. Seen property ids:
  `context_window` (a string, e.g. `"128000"`), `price` (a list of `{ unit, price, currency }` with units
  `per M input tokens` and `per M output tokens`), `planned_deprecation_date` (e.g. `"2026-11-20"`),
  `function_calling`, `vision`, `reasoning`. The docs build drops a model once its `planned_deprecation_date` is in
  the past. — [cloudflare-docs `bin/fetch-ai-models.js`](https://github.com/cloudflare/cloudflare-docs/blob/production/bin/fetch-ai-models.js)
  and [`src/content/workers-ai-models/*.json`](https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/workers-ai-models),
  branch `production`, accessed 2026-11-17.
- Error table: "Model deprecated", internal code `5028`, HTTP `410`, "`${model}` was deprecated on `${date}`";
  "Invalid model ID", `3042`, HTTP `404`; "No such model", `5007`, HTTP `400`; "Account limited", `3036`, HTTP `429`,
  "You have used up your daily free allocation of 10,000 neurons"; "Out of capacity", `3040`, HTTP `429`;
  "Model requires Workers Paid plan", `5035`, HTTP `403`; "Account blocked", `3023`, HTTP `403`. —
  [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/), accessed 2026-11-17.
- The free allocation is 10 000 Neurons a day on both Workers Free and Workers Paid; Workers Free cannot go above
  it, Workers Paid is billed $0.011 per 1 000 Neurons above it. "All limits reset daily at 00:00 UTC." Per-model
  rates: `@cf/mistralai/mistral-small-3.1-24b-instruct` $0.351 / M input and $0.555 / M output tokens
  (31 876 / 50 488 Neurons per M); `@cf/openai/gpt-oss-20b` $0.200 / $0.300 (18 182 / 27 273);
  `@cf/google/gemma-4-26b-a4b-it` $0.100 / $0.300 (9 091 / 27 273). — [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
  accessed 2026-11-17.
- Eighteen models were deprecated on 2026-05-30, among them `@cf/meta/llama-3.1-8b-instruct-awq` and
  `@cf/google/gemma-3-12b-it`; Cloudflare recommends `@cf/google/gemma-4-26b-a4b-it` among the replacements. —
  [Planned model deprecations](https://developers.cloudflare.com/changelog/post/2026-05-08-planned-model-deprecations/),
  accessed 2026-11-17.
- JSON Mode (`response_format` with `json_schema` or `json_object`) is documented for six models; none of the three
  pinned here is on that list, and "Workers AI can't guarantee that the model responds according to the requested
  JSON Schema". — [JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/), accessed 2026-11-17.
- Context windows: Mistral Small 3.1 128 000, gpt-oss-20b 128 000, Gemma 4 26B A4B 256 000 tokens (the
  `context_window` property of each catalogue entry above).

## Applicability to us

- The account id is part of the path, so the route's base URL cannot be a fixed constant. The host and the path
  around the id stay package constants; the id is admitted only as 32 lowercase hex characters.
- The pinned chain is `@cf/mistralai/mistral-small-3.1-24b-instruct`, `@cf/openai/gpt-oss-20b`,
  `@cf/google/gemma-4-26b-a4b-it`: all three are Text Generation models with no `planned_deprecation_date` in the
  catalogue entries above. The task file's `@cf/google/gemma-4-26b-it` does not exist; the real id has `-a4b-`.
- The pinned models are not on the JSON Mode list, so the route is configured with `structuredOutput: 'none'`;
  the router's own schema validation and correction retry carry the shape.
- Neurons are not requests. The own cap stays a request count, derived from a worst-case call priced at the
  Mistral rates, and the refresh admits an addition only when its listed price is at or below those rates.

## What could not be established

- **UNVERIFIED: the entry shape of `/ai/models/search`.** The API reference types `result` as `array of unknown`;
  `properties[]` comes from the docs pipeline, which reads a different endpoint (`ai-cloudflare-com.pages.dev/api/models`),
  and wrangler's `Model` type has no `properties`. The listing parser therefore fails closed: an entry without a
  `properties` array, a context or a price is dropped, never read as "no deprecation".
- **UNVERIFIED: the error body on the OpenAI-compatible path.** The 410 evidence is the native run endpoint (prod log of
  PR #1370: `Workers AI responded 410: AiError: Model has been deprecated`); the error table does not say which body the
  `/ai/v1/chat/completions` path sends. The router therefore retires on the 410 status alone, and reads code 3036 from
  the Cloudflare v4 envelope (`errors[].code`) only when one is present.
- **UNVERIFIED: the largest `per_page` the search accepts.** Wrangler pages at 50; the router reads one page of 50 and
  treats a full page as a failed listing, so a truncated catalogue can never shrink the managed list.
- **Not established: whether the owner's account is on Workers Paid.** On Workers Paid, Neurons above the allocation
  are billed; the own cap is sized to stay inside the allocation either way.
