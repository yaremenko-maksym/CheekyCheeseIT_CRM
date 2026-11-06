# Extraction router: provider and local runtime facts (Task 5.4c-0)

**Date:** 2026-11-04 · **Why:** settles the rows of §2.3 of the extraction model router ADR
(`docs/architecture/2026-11-03-extraction-model-router.md`) before 5.4c-1 (classified leaf) and 5.4c-2b (self-heal) are
coded, and gives 5.4c-7 (MP-04) its licence and runtime facts.
**Shelf life:** limits, model lists and API behaviour expire **2026-12-04** (30 days); data terms and licences expire
**2027-02-02** (90 days). Recheck earlier on any of these signals: a provider deprecation email; a 404 or a new 429 shape in
the router's events; a change of the "Effective" / "Last modified" date on a terms page; a new major release of a runtime.

Method: public documentation pages only, read on 2026-11-04. No key, no account, no API call, no download. Every claim
below carries its source; "read" means 2026-11-04 for all of them. A claim taken from a non-vendor page is marked
**secondary**. Anything not settled is marked **UNVERIFIED** with what would settle it.

This file states facts for the owner and the coders. The data-terms section is **not legal advice**; it feeds no gate
(ADR §4.2).

---

## ADR deltas (contradictions Master must route)

Each item is a fact that breaks or weakens ADR text. None is a decision; each needs an ADR amendment or a task-file note.

1. **Gemini's model listing carries no free-tier field.** The `Model` resource has `name`, `baseModelId`, `version`,
   `displayName`, `description`, `inputTokenLimit`, `outputTokenLimit`, `supportedGenerationMethods`, `temperature`,
   `maxTemperature`, `topP`, `topK`, `thinking` and nothing about tier or price
   ([Models API reference](https://aistudio.google.com/api-reference/models)). The free/not-free split exists only as the
   "Free Tier" column of the human-facing pricing page ([pricing](https://aistudio.google.com/docs/pricing)).
   **Breaks:** §3.4 layer 2, Gemini row: "the models listing, restricted to what a free key may call … the free-key rule
   settled by 5.4c-0". The listing cannot do that restriction. Options for Master: a checked-in Gemini family pattern
   (the same device the ADR already uses for Groq, SR-H-1), or a chat probe that recognises the "no free quota" answer
   (item 2). Confidence HIGH on the listing fact.
2. **A free key calling a model outside the free tier does not get a 4xx "not allowed"; it gets 429 `RESOURCE_EXHAUSTED`
   with a quota limit of 0** (secondary: [forum report, limit 0](https://discuss.ai.google.dev/t/gemini-api-free-tier-limit-is-0-cannot-use-api-despite-valid-key/114215),
   [forum report, 2.5 Pro](https://discuss.ai.google.dev/t/getting-429-error-on-gemini-2-5-pro-free-tier-never-used-it-today/115129)).
   No Google page documents this shape. **Breaks:** §3.4 verdicts ("429/503 ⇒ `transient` (kept — busy is not rotten)")
   — a not-free model surfacing in the listing would probe `transient` every day and never drop; and §5.1, where such a
   429 reads as `BUSY` or `SPENT_DAY` (if its quota id names a day) and the model is retried every reset. The
   classifier needs a rule for "quota limit is 0" distinct from "quota used up", or the not-free models must be kept out
   by item 1's pattern. **UNVERIFIED** in exact body form; settle by one owner-run call with a free key against a
   not-free model (5.4c-5 smoke), body redacted to the error fields.
3. **A deprecated Gemini model is re-routed, not refused.** "On December 1, 2026, requests route automatically to
   `gemini-3.5-flash-lite`" (for `gemini-2.5-flash`; `gemini-2.5-pro` routes to `gemini-3.8-flash`)
   ([models](https://aistudio.google.com/docs/models), [pricing](https://aistudio.google.com/docs/pricing)).
   **Weakens:** §3.4 layer 1 and §5.1 `RETIRED` ("404 naming the model"): for an alias-routed retirement there is no 404,
   and the call silently runs on a different model than the managed list names. The models page also lists shut-down
   ids (`gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-3-pro-preview`, `gemini-3.1-flash-lite-preview`) without
   saying whether they 404 or re-route. **UNVERIFIED:** whether the OpenAI-compatible response's `model` field reports
   the routed-to id; settle by the 5.4c-5 smoke. If it does, the leaf can compare it with the requested id and treat a
   mismatch as `RETIRED`-like.
4. **Groq marks per-day versus per-minute only in headers, and only for requests.** The documented error object has
   two fields, `error.message` and `error.type` ([errors](https://console.groq.com/docs/errors)); no structured field
   distinguishes a per-day 429. The rate-limit headers do: `x-ratelimit-*-requests` "Always refers to Requests Per Day
   (RPD)" and `x-ratelimit-*-tokens` "Always refers to Tokens Per Minute (TPM)"; `retry-after` is set on a 429
   ([rate limits](https://console.groq.com/docs/rate-limits)). There is **no documented header for tokens per day
   (TPD)**, although TPD is a published limit. **Breaks:** §2.3 row 2 ("marks per-day 429s in a structured error
   field") and §5.1 `SPENT_DAY` ("Groq per-day token/request limits"). A documented rule exists only for RPD: a 429 with
   `x-ratelimit-remaining-requests: 0` is per-day. A TPD 429 is indistinguishable by documented fields; `retry-after`
   length is a usable but undocumented proxy. §5.1's rule "documented structured error fields only, never free text"
   then leaves TPD exhaustion classified `BUSY`. Master decides: accept that (it costs one short backoff per call until
   reset), or allow headers plus `retry-after` as the signal.
5. **Groq's strict `json_schema` models are few, and two are preview.** Strict mode: `openai/gpt-oss-20b`,
   `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `meta-models/muse-spark-open`
   ([structured outputs](https://console.groq.com/docs/structured-outputs)); the last two are "Preview" and "should not
   be used in production environments as they may be discontinued at short notice"
   ([models](https://console.groq.com/docs/models)). The production `llama-*` ids still on the models page were shut down
   on 2026-08-16 per the deprecations page ([deprecations](https://console.groq.com/docs/deprecations)) — the two Groq
   pages disagree. **Affects:** the Groq family pattern of §3.4 (SR-H-1) and MP-03's hosted candidates; strict
   structured output on Groq is in practice the `gpt-oss` family.
6. **Groq strict mode needs every property in `required` and `additionalProperties: false` on every object; optional
   fields are expressed as a union with `null`** ([structured outputs](https://console.groq.com/docs/structured-outputs)).
   **Affects:** 5.4c-1's schema rendering ("the schema rendered without `maxLength`"): the renderer must also emit
   all-required plus nullable unions for Groq strict, or send `strict: false` (best effort, which returns HTTP 400 on a
   mismatch). Streaming and tools are not supported with structured outputs — the ADR uses neither.
7. **Ollama's OpenAI-compatible endpoint cannot set the context window per request.** "The OpenAI API does not have a
   way of setting the context size for a model"; the workaround is a Modelfile `PARAMETER num_ctx` and a derived model
   name ([OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)), or the server-wide
   `OLLAMA_CONTEXT_LENGTH`, default **4096** tokens ([FAQ](https://docs.ollama.com/faq)). **Confirms** the ADR's warning
   in §2.3 row 6; 5.4c-8 must set the window at provisioning, and a window left at the default would hold far less than
   one detail page (§8.3 criterion 2).
8. **Groq's own terms say inputs and outputs are not used for training.** "Groq is not permitted to use Inputs or Outputs
   for training or fine-tuning any AI Model Services or other models"
   ([services agreement](https://console.groq.com/docs/legal/services-agreement)). §4 item 4 ("Free tiers may log
   prompts or train on them") is true of Gemini's unpaid tier and overstated for Groq, subject to the ambiguity in
   §4 below. Informational only; it narrows the accepted risk, it does not widen anything.
9. **Groq offers a zero-data-retention setting, but at organisation level, not per request** (Console Data Controls;
   [your data](https://console.groq.com/docs/your-data)). §4 item 3 ("a flag found by 5.4c-0 is reported to the owner")
   — reported here. It is an account setting the owner toggles, not a request field, so it does not bring back
   `FLAG_REJECTED` (§3.5). Owner action, if wanted, in 5.4c-5.
10. **Gemini's documented 403 covers key and project problems under one status with no documented reason field.**
    `PERMISSION_DENIED` / "Your project has been denied access" has four documented causes: free tier unavailable,
    payment needed, leaked or blocked key, policy suspension ([troubleshooting](https://aistudio.google.com/docs/troubleshooting)).
    **Weakens:** §5.1 `AUTH` ("a 403 only when the provider's documented structured error field marks it as a key or
    permission error"): with no documented field beyond `status`, a leaked-key 403 falls to `REFUSED` ("any other 403"),
    which never disables the provider and is retried on the next record. Master decides whether `PERMISSION_DENIED`
    itself counts as the documented marker. An `ErrorInfo.reason` may exist (AIP-193 envelope) but is UNVERIFIED here.

---

## 1. Gemini OpenAI-compatible endpoint

| Fact                                                                                                                                                                                                                                                                                                                                                                                                    | Source                                                                                                   | Confidence                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| The endpoint exists. Base URL `https://generativelanguage.googleapis.com/v1beta/openai/`; chat at `chat/completions` under it                                                                                                                                                                                                                                                                           | [OpenAI compatibility](https://aistudio.google.com/docs/openai)                                          | HIGH                                                   |
| Status: "Support for the OpenAI libraries is still in beta while we extend feature support"                                                                                                                                                                                                                                                                                                             | same                                                                                                     | HIGH                                                   |
| Auth: `Authorization: Bearer <key>` on the REST example. No `key=` query parameter is needed                                                                                                                                                                                                                                                                                                            | same                                                                                                     | HIGH                                                   |
| Structured output: "Gemini models can output JSON objects in any structure you define". The page shows it through the OpenAI SDK helpers (`zodResponseFormat` in JavaScript); the page does not name the raw `json_schema` type                                                                                                                                                                         | same                                                                                                     | MED                                                    |
| `zodResponseFormat` sends `{ type: 'json_schema', json_schema: { name, strict: true, schema } }` — so the documented path puts exactly that wire shape on the compat endpoint                                                                                                                                                                                                                           | [openai-node `src/helpers/zod.ts`](https://github.com/openai/openai-node/blob/master/src/helpers/zod.ts) | HIGH (by inference: the doc's example uses it)         |
| Native structured output ignores `minLength`, `maxLength`, `minProperties`, `maxProperties`, `uniqueItems`, `contains`, `minContains`, `maxContains`: "the API automatically strips and ignores them during request normalization rather than returning an error". It does not guarantee validity: "always validate values in your application"                                                         | [structured output](https://aistudio.google.com/docs/structured-output)                                  | HIGH (native); UNVERIFIED that compat behaves the same |
| Reasoning cannot be turned off for Gemini 2.5 Pro or Gemini 3 models through the compat layer                                                                                                                                                                                                                                                                                                           | [OpenAI compatibility](https://aistudio.google.com/docs/openai)                                          | HIGH                                                   |
| Model listing through compat: `GET https://generativelanguage.googleapis.com/v1beta/openai/models` (Bearer), and `/models/{model}`                                                                                                                                                                                                                                                                      | same                                                                                                     | HIGH                                                   |
| Native listing: `GET /v1beta/models`; entry `name` format `models/{model}`, `{model}` = `{base_model_id}-{version}`. No free-tier, tier or price field (ADR delta 1). The auth header name and the pagination limits are not on that page                                                                                                                                                               | [Models API reference](https://aistudio.google.com/api-reference/models)                                 | HIGH                                                   |
| Model id forms: stable (`gemini-3.6-flash`), preview (`-preview-MM-YYYY`, e.g. `gemini-2.5-flash-preview-09-2025`), latest alias (`gemini-flash-latest`, changes with "a 2-week email notice"), experimental. "Applies as of September 2025; older models may use different strings"                                                                                                                    | [models](https://aistudio.google.com/docs/models)                                                        | HIGH                                                   |
| Free-tier text models per the pricing page "Free Tier" column: `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, Gemma 4 (no id given). **Not** available free: `gemini-4-argon`, `gemini-3.1-pro-preview`. The Free card says only "Limited access to certain models" | [pricing](https://aistudio.google.com/docs/pricing)                                                      | HIGH (expires 30 d)                                    |
| A free key calling a not-free model: 429 `RESOURCE_EXHAUSTED`, quota limit 0 (ADR delta 2)                                                                                                                                                                                                                                                                                                              | secondary: forum reports linked in delta 2                                                               | LOW — UNVERIFIED                                       |
| The Google docs moved: every `ai.google.dev/gemini-api/docs/*` URL read today answers 301 to `aistudio.google.com/docs/*`. The ADR and code comments that cite the old host keep working only through the redirect                                                                                                                                                                                      | observed 301 on the four pages fetched                                                                   | HIGH                                                   |

**Gemini id pattern for §3.4 (SR-H-1), proposed from the documented id forms above, not decided here:**
`^gemini-[0-9]+(\.[0-9]+)?-(flash|flash-lite|pro)(-preview(-[0-9]{2}-[0-9]{4})?)?$`. It admits the free text models listed
above and excludes image, TTS, robotics, `-customtools` and `-latest` aliases. Whether to admit `gemma-*` ids needs their
id form, which the pricing page does not give (UNVERIFIED). The `models/` prefix of the native listing is stripped
before matching; the compat listing's id form is UNVERIFIED (settle by one listing call in the 5.4c-5 smoke).

## 2. Groq

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Source                                                                                                       | Confidence                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Base URL `https://api.groq.com/openai/v1`; auth `Authorization: Bearer <key>`                                                                                                                                                                                                                                                                                                                                                                                                               | [API reference](https://console.groq.com/docs/api-reference)                                                 | HIGH                                    |
| `response_format: { "type": "json_schema", "json_schema": {...} }` "enables Structured Outputs which ensures the model will match your supplied JSON schema"; only on supported models. `json_object` is the older JSON mode                                                                                                                                                                                                                                                                | same                                                                                                         | HIGH                                    |
| `strict: true` uses "constrained decoding to guarantee that the output will always match your schema exactly". Strict models: `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `meta-models/muse-spark-open`. Best-effort (`strict: false`) also on `openai/gpt-oss-safeguard-20b`                                                                                                                                                                                          | [structured outputs](https://console.groq.com/docs/structured-outputs)                                       | HIGH (expires 30 d)                     |
| Strict requires all properties in `required`, `additionalProperties: false` on every object, optional = union with `null`. Supported types: string, number, boolean, integer, object, array, enum, anyOf. `maxLength`, `minLength`, `pattern`, `format` are not mentioned                                                                                                                                                                                                                   | same                                                                                                         | HIGH; keyword support UNVERIFIED        |
| Best-effort mismatch: HTTP 400 with the message "Generated JSON does not match the expected schema. Please adjust your prompt." No error code is documented for it                                                                                                                                                                                                                                                                                                                          | same                                                                                                         | HIGH                                    |
| Streaming and tool use "are not currently supported with Structured Outputs"                                                                                                                                                                                                                                                                                                                                                                                                                | same                                                                                                         | HIGH                                    |
| Listing: `GET https://api.groq.com/openai/v1/models` → `{ "object": "list", "data": [ { "id", "object", "created", "owned_by", "active", "context_window", "public_apps" } ] }`. The models page calls it "a JSON list of all active models"                                                                                                                                                                                                                                                | [API reference](https://console.groq.com/docs/api-reference), [models](https://console.groq.com/docs/models) | HIGH                                    |
| Chat models on the models page — production: `openai/gpt-oss-120b`, `openai/gpt-oss-20b` (131 072 context, 65 536 max completion); preview: `minimaxai/minimax-m2.7` (196 608), `meta-models/muse-spark-open`, `openai/gpt-oss-safeguard-20b`, `qwen/qwen3.8-27b` (131 072; qwen max completion 16 384). The page still lists `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` as production                                                                                            | [models](https://console.groq.com/docs/models)                                                               | HIGH; llama rows contradicted (delta 5) |
| Deprecation: after shutdown "Requests to deprecated model IDs will return errors" — status and body not documented. Notice periods observed: about 8 days to about 2 months. Recent shutdowns: `groq/compound` and `groq/compound-mini` (2026-09-21), `qwen/qwen3.6-27b` → `qwen/qwen3.8-27b` (2026-09-14), both `llama-*` ids above (2026-08-16), `qwen/qwen3-32b` and `meta-llama/llama-4-scout-17b-16e-instruct` (2026-07-17). "Some models are automatically upgraded to a replacement" | [deprecations](https://console.groq.com/docs/deprecations)                                                   | HIGH; 404 shape UNVERIFIED              |
| Error object: `{ "error": { "message": "<string>", "type": "invalid_request_error" } }`. Status codes 400, 401, 403, 404, 413, 422, 424, 429, 498 (flex tier at capacity), 499 (caller cancelled), 500, 502, 503. "You aren't charged for requests returning server errors"                                                                                                                                                                                                                 | [errors](https://console.groq.com/docs/errors)                                                               | HIGH                                    |
| Rate limits are per organisation: "Rate limits apply at the organization level, not individual users"                                                                                                                                                                                                                                                                                                                                                                                       | [rate limits](https://console.groq.com/docs/rate-limits)                                                     | HIGH                                    |
| Headers: `x-ratelimit-limit-requests` / `-remaining-requests` / `-reset-requests` = RPD; `x-ratelimit-limit-tokens` / `-remaining-tokens` / `-reset-tokens` = TPM; `retry-after` in seconds, only on 429. No TPD header (delta 4)                                                                                                                                                                                                                                                           | same                                                                                                         | HIGH                                    |

**Groq family pattern for §3.4 (SR-H-1), proposed, not decided:** `^openai/gpt-oss-(20b|120b)$` covers the two
production strict models. Admitting `qwen/qwen3\.[0-9]+-[0-9]+b` or `meta-models/*` would admit preview models (delta 5);
that is MP-03's call. `openai/gpt-oss-safeguard-*` is a guard model and stays out (best-effort schema only).

## 3. Free-tier limits and the gone-model answer

| Provider | Model                          | RPM | RPD   | TPM | TPD   | Source                                                   |
| -------- | ------------------------------ | --- | ----- | --- | ----- | -------------------------------------------------------- |
| Groq     | `openai/gpt-oss-120b`          | 30  | 1 000 | 8 K | 200 K | [rate limits](https://console.groq.com/docs/rate-limits) |
| Groq     | `openai/gpt-oss-20b`           | 30  | 1 000 | 8 K | 200 K | same                                                     |
| Groq     | `qwen/qwen3.8-27b`             | 30  | 1 000 | 8 K | 200 K | same                                                     |
| Groq     | `openai/gpt-oss-safeguard-20b` | 3   | 1 000 | 2 K | 200 K | same                                                     |
| Gemini   | any                            | —   | —     | —   | —     | **UNVERIFIED** — not on any public page (below)          |

- **Groq:** the page offers "Free Plan Limits" and "Developer Plan Limits" views and the table read does not label
  which one it is. **UNVERIFIED** that these are the free numbers; settle by the owner reading the limits page of the
  free organisation (the page says exact values are there). Note: 8 K TPM is smaller than one 50 000-character input
  plus answer, so a single large Groq call can hit TPM on its own.
- **Gemini:** the rate-limits page no longer carries a table; it points to the AI Studio rate-limit page, which
  requires a Google login ([rate limits](https://aistudio.google.com/docs/rate-limits); the AI Studio page answered 302
  to a login). What the public page does say: limits are "applied per project, not per API key"; dimensions are RPM,
  input TPM and RPD; exceeding any one triggers the error; "Requests per day (RPD) quotas reset at midnight Pacific
  time"; preview and experimental models are more restricted. Secondary reports put free per-model daily limits between
  15 and 100 requests ([forum](https://discuss.ai.google.dev/t/gemini-api-free-tier-daily-quota-does-not-reset-persistent-429-resource-exhausted/183406)).
  **Settle by** the owner reading AI Studio's rate-limit page for the free project and pasting the numbers into the
  5.4c-2b task file; §3.4's `PROBE_CAP` for Gemini must come from that number, not from this file.
- **Gone model, Gemini:** no documented 404 shape for `generateContent` or compat. Deprecated ids re-route (delta 3).
  The Interactions API (a different surface) documents `model_not_found` with HTTP 404
  ([API errors](https://aistudio.google.com/docs/api-errors)) — that page states it covers "all Interactions API error
  codes" and does not apply to `generateContent` or compat. **UNVERIFIED.**
- **Gone model, Groq:** "Requests to deprecated model IDs will return errors"; status and body undocumented.
  **UNVERIFIED.** Settle both by one request each to a known-shut-down id in the 5.4c-5 smoke (`gemini-2.0-flash`,
  `llama-3.1-8b-instant`), bodies redacted to error fields.

## 4. Free-tier data terms (facts for the owner, not legal advice)

**Gemini API, Unpaid Services** — [Gemini API terms](https://aistudio.google.com/docs/terms), "Effective March 23, 2026".
Expires 2027-02-02.

- Use: Google "uses the content you submit to the Services and any generated responses to provide, improve, and develop"
  its products and machine-learning technologies.
- Human review: "human reviewers may read, annotate, and process your API input and output". Google states it
  disconnects this data from the account, API key and project before reviewers see it.
- Instruction: "Do not submit sensitive, confidential, or personal information to the Unpaid Services."
- Retention: **no fixed period stated** for unpaid prompts and responses (ambiguity). Grounding with Google Search stores
  prompts, context and output for thirty days — the router does not use grounding.
- Region: "You may use only Paid Services when making API Clients available to users in the European Economic Area"
  (also Switzerland and the United Kingdom). Ambiguity: whether an internal back-office extraction of public pages is
  "making API Clients available to users" in those regions; the CRM's users are in Ukraine, which is none of them.
- Pricing page row "Used to improve our products": **Yes** on free, **No** on paid, for every free text model
  ([pricing](https://aistudio.google.com/docs/pricing)).
- This **confirms** the ADR's belief in §2.3 row 5 and the residual risk the owner accepted in §4.1 / §4.2.
- The "Do not submit … personal information" instruction is in tension with §4.1's accepted residual risk (names in
  prose survive contact stripping). Recorded for the owner; not a gate.

**Groq** — read 2026-11-04, expires 2027-02-02.

- Training: "Groq is not permitted to use Inputs or Outputs for training or fine-tuning any AI Model Services or other
  models" (exceptions for customer permission or instruction) —
  [services agreement](https://console.groq.com/docs/legal/services-agreement), "Last Modified: June 22, 2026".
- Retention: "By default, Groq does not retain customer data for inference requests"; it may log inputs and outputs for
  troubleshooting reliability errors or "suspected abuse (e.g. rate-limit circumvention)", and "These logs are retained
  for up to 30 days, unless legally required to retain longer"; opt-out and zero data retention in Console Data
  Controls — [your data](https://console.groq.com/docs/your-data).
- Human review: not addressed on the data page. The DPA limits access to "Only employees whose job function involves
  supporting the delivery of Cloud Services" — [DPA](https://console.groq.com/docs/legal/customer-data-processing-addendum),
  effective October 15, 2025.
- Region: "All customer data is retained in Google Cloud Platform (GCP) buckets located in the United States" (storage,
  not processing) — [your data](https://console.groq.com/docs/your-data); "Groq may transfer and Process Personal Data
  to and in the United States and other countries" — [DPA](https://console.groq.com/docs/legal/customer-data-processing-addendum).
- **Ambiguity:** the agreement says "Certain Cloud Services and AI Model Services may be designated as fee-free" but
  does not say whether the training clause covers free-plan use specifically; nothing found says it does not. The
  privacy policy does not apply to data Groq processes as a processor
  ([privacy policy](https://groq.com/privacy-policy), effective November 12, 2025).

## 5. Local runtimes (§8.3: Ollama OpenAI endpoint, llama.cpp server, vLLM)

The ADR pins no runtime version yet. The versions below are the latest releases on the read date, recorded so 5.4c-7
re-checks against the version it pins.

**llama.cpp server** — latest release v0.8.0 (28 Oct; nightly build b11960)
([releases](https://github.com/ggml-org/llama.cpp/releases/latest)).

- Schema: `/chat/completions` takes the schema in `response_format`:
  `{ "type": "json_schema", "json_schema": { "schema": … } }` or `{ "type": "json_object", "schema": … }`; it is converted
  to a grammar that constrains sampling ([grammars README](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)).
- Schema limits: a subset of JSON Schema. Supported and enforced: `minLength`, `maxLength`, `minimum`, `maximum`,
  `minItems`, `maxItems`. `additionalProperties` defaults to `false`; `pattern` must be anchored `^…$`; no `uri` / `email`
  formats; nested `$ref` broken, remote `$ref` unsupported; `properties` cannot mix with `anyOf`/`oneOf` in one type;
  `patternProperties`, `uniqueItems`, `contains`, `not`, conditionals unsupported. **"Unsupported features are skipped
  silently"** — enforcement is partial without an error (same source). 5.4c-1's schema must stay inside the supported
  subset, and its post-hoc Zod parse stays mandatory.
- The schema "is not injected into the prompt" — the prompt must describe the structure (same source).
- Context window: server flag `-c, --ctx-size N`, "0 = loaded from model"; no per-request window is documented; the
  pool is shared across `-np, --parallel` slots, "sized to n_parallel*N" without `-c`
  ([server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)). Concurrency 1 ⇒ `-np 1`.
- Logging: `--log-prompts-dir` "only used for debugging, default: disabled"; `--log-disable` exists (same source).
- Auth: `--api-key` / `--api-key-file` / `LLAMA_API_KEY` (same source).
- CPU-only: no CPU guidance on the server README beyond the thread count flag; CPU inference is the project's base
  backend. **UNVERIFIED:** whether a client disconnect stops generation (§8.3 criterion 7) — not documented; settle in
  MP-04 by measurement.

**Ollama** — latest release v0.40.14 (3 Nov) ([releases](https://github.com/ollama/ollama/releases/latest)).

- Schema: "Structured outputs work through the OpenAI-compatible API via `response_format`"; native form is a JSON
  schema in `format` ([structured outputs](https://docs.ollama.com/capabilities/structured-outputs)). The page does not
  say whether `json_schema` (versus `json_object`) is the accepted `response_format` type, nor the enforcement
  mechanism. **UNVERIFIED**; settle in MP-04 with a schema-violating prompt.
- Context window: not settable through the OpenAI endpoint (delta 7). Server-wide `OLLAMA_CONTEXT_LENGTH`, default
  4096; per request only through the native API's `num_ctx` ([FAQ](https://docs.ollama.com/faq)).
- Memory: "Required RAM will scale by `OLLAMA_NUM_PARALLEL` * `OLLAMA_CONTEXT_LENGTH`"; `OLLAMA_NUM_PARALLEL` default 1;
  binds `127.0.0.1:11434` by default (same source).
- Logging of prompts, and disconnect behaviour: not on the pages read. **UNVERIFIED**; settle in MP-04 (marker prompt
  absent from the log, §8.3).

**vLLM** — docs "latest developer preview", footer October 15, 2026.

- CPU: x86 with "`avx512f` (Recommended), `avx2` (Limited features)"; AMD needs Zen 4 or newer; dtypes FP32 / FP16 /
  BF16 with BF16 recommended; quantisation AWQ, GPTQ, INT8 W8A8; prebuilt x86 wheels since 0.17.0 and a CPU image on
  Docker Hub; GGUF not mentioned on the CPU page ([CPU install](https://docs.vllm.ai/en/latest/getting_started/installation/cpu.html)).
- Schema: xgrammar or guidance backends, default `auto`; the page does not state a guarantee
  ([structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs.html)).
- Context: `--max-model-len` — "Model context length (prompt and output)", engine-level, no per-request override
  ([engine args](https://docs.vllm.ai/en/latest/configuration/engine_args.html)).
- **UNVERIFIED:** whether the Hetzner CX33 vCPU exposes `avx512f`; settle by `grep -o avx512f /proc/cpuinfo | head -1`
  on the VPS (Master over the owner-authorised ssh alias, D9). Without it vLLM runs with "limited features"; GGUF
  weights (the ADR's §8.3 supply-chain format) are not shown as supported on CPU.

## 6. Licences of the candidate families (§8.3: Qwen, Gemma, Phi, Llama)

Read at the published card or licence page, 2026-11-04; expires 2027-02-02. **No model is picked here** (MP-04). The
ADR requires the licence "read at the pinned digest"; these are family-level reads, to be repeated on the exact card
MP-04 pins.

| Family    | Card read                                                                                        | Licence                                                        | Commercial use, by the text                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen      | [Qwen/Qwen3-4B](https://huggingface.co/Qwen/Qwen3-4B)                                            | "License: apache-2.0"                                          | Permitted: Apache 2.0 grants "a perpetual, worldwide, non-exclusive, no-charge, royalty-free" licence ([Apache 2.0 text](https://ai.google.dev/gemma/apache_2)). Context 32 768 native. Newer Qwen versions are not linked from this card; their licence is UNVERIFIED                                                                                                                                   |
| Gemma 4   | [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it)                            | "License: apache-2.0", linked to Google's Gemma 4 licence page | Permitted under Apache 2.0. Earlier Gemma generations are under the **Gemma Terms of Use** ([terms](https://ai.google.dev/gemma/terms), last modified April 1, 2026): use allowed subject to the Prohibited Use Policy, and "Google reserves the right to restrict (remotely or otherwise) usage of any of the Gemma Services" it believes violate the agreement. Pin a Gemma 4 card, not an earlier one |
| Phi       | [microsoft/Phi-4-mini-instruct](https://huggingface.co/microsoft/Phi-4-mini-instruct)            | "mit"                                                          | Permitted: MIT. 3.8 B parameters, 128 K context, Ukrainian listed among 24 languages                                                                                                                                                                                                                                                                                                                     |
| Llama 3.2 | [Llama 3.2 licence](https://dev.meta.ai/llama/llama3_2/license), release date September 25, 2024 | Llama 3.2 Community License                                    | Permitted with conditions: "a non-exclusive, worldwide, non-transferable and royalty-free limited license"; a separate licence is needed above 700 million monthly active users; distribution requires "Built with Llama" displayed; use must follow the Acceptable Use Policy (not read here — UNVERIFIED). Only the Llama family is not a plain permissive licence                                     |

Note on the Gemma 4 row: the licence page Google links (`ai.google.dev/gemma/docs/gemma_4_license`) was not fetched;
the Apache 2.0 text page fetched does not name Gemma. The card's own licence field is the primary statement.

## 7. Error-format table for the test fixtures

Bodies are minimal and contain no prompt-like text. Only rows marked **documented** may be copied as-is; the others are
reconstructions to be replaced by the redacted bodies from the 5.4c-5 smoke.

| Provider | Case                                                           | Status          | Structured fields                                                                                                            | Example body                                                                                                                                                                                                                                                                                                                                                                                                                                                | Basis                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Groq     | any error                                                      | 4xx/5xx         | `error.message`, `error.type`                                                                                                | `{"error":{"message":"<redacted>","type":"invalid_request_error"}}`                                                                                                                                                                                                                                                                                                                                                                                         | **documented** ([errors](https://console.groq.com/docs/errors))                                                                                                                                                          |
| Groq     | 429 per-day (requests)                                         | 429             | body as above; headers `x-ratelimit-remaining-requests: 0`, `retry-after: <seconds>`                                         | `{"error":{"message":"<redacted>","type":"<redacted>"}}`                                                                                                                                                                                                                                                                                                                                                                                                    | **documented** headers ([rate limits](https://console.groq.com/docs/rate-limits)); body `type` value UNVERIFIED                                                                                                          |
| Groq     | 429 per-minute (tokens)                                        | 429             | headers `x-ratelimit-remaining-tokens: 0` (or low), `retry-after`                                                            | same                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **documented** headers                                                                                                                                                                                                   |
| Groq     | 429 per-day (tokens, TPD)                                      | 429             | none documented (delta 4)                                                                                                    | same                                                                                                                                                                                                                                                                                                                                                                                                                                                        | UNVERIFIED                                                                                                                                                                                                               |
| Groq     | strict-off schema mismatch                                     | 400             | message "Generated JSON does not match the expected schema. Please adjust your prompt."                                      | `{"error":{"message":"Generated JSON does not match the expected schema. Please adjust your prompt.","type":"invalid_request_error"}}`                                                                                                                                                                                                                                                                                                                      | message **documented** ([structured outputs](https://console.groq.com/docs/structured-outputs)); `type` value UNVERIFIED                                                                                                 |
| Groq     | key missing or invalid                                         | 401             | `error.type`                                                                                                                 | `{"error":{"message":"<redacted>","type":"invalid_request_error"}}`                                                                                                                                                                                                                                                                                                                                                                                         | status **documented**; `type` value UNVERIFIED                                                                                                                                                                           |
| Groq     | gone model                                                     | 404?            | UNVERIFIED                                                                                                                   | UNVERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                  | "will return errors" only ([deprecations](https://console.groq.com/docs/deprecations))                                                                                                                                   |
| Groq     | flex capacity                                                  | 498             | —                                                                                                                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **documented**; not on the free path — classify `TRANSPORT` (ADR §5.1: BUSY is only 429 and 503; any other 4xx/5xx is TRANSPORT)                                                                                         |
| Gemini   | Google API error envelope (native)                             | per HTTP        | `error.code` (HTTP number), `error.message`, `error.status` (e.g. `RESOURCE_EXHAUSTED`), `error.details[]` each with `@type` | `{"error":{"code":429,"message":"<redacted>","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaDimensions":{"location":"global","model":"<model-id>"}}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"55s"}]}}` | envelope **documented** in [AIP-193](https://google.aip.dev/193); `QuotaFailure`, `quotaId`, `retryDelay` values **secondary** ([gemini-cli issue](https://github.com/google-gemini/gemini-cli/issues/8437), 2025-09-14) |
| Gemini   | 429 per-minute                                                 | 429             | `quotaId` ending `PerMinute-FreeTier` (e.g. `GenerateContentInputTokensPerModelPerMinute-FreeTier`)                          | as above with that `quotaId`                                                                                                                                                                                                                                                                                                                                                                                                                                | secondary (same issue)                                                                                                                                                                                                   |
| Gemini   | 429 per-day                                                    | 429             | `quotaId` containing `PerDay` (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`)                                          | as above                                                                                                                                                                                                                                                                                                                                                                                                                                                    | secondary (same issue; forum report)                                                                                                                                                                                     |
| Gemini   | not-free model on a free key                                   | 429             | as per-day/per-minute but quota value 0 (delta 2)                                                                            | UNVERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                  | secondary forum reports                                                                                                                                                                                                  |
| Gemini   | project denied (free tier unavailable, leaked key, suspension) | 403             | `status: PERMISSION_DENIED`; message "Your project has been denied access"                                                   | `{"error":{"code":403,"message":"<redacted>","status":"PERMISSION_DENIED"}}`                                                                                                                                                                                                                                                                                                                                                                                | status and message **documented** ([troubleshooting](https://aistudio.google.com/docs/troubleshooting)); `details` UNVERIFIED                                                                                            |
| Gemini   | gone model                                                     | 404 or re-route | UNVERIFIED (delta 3)                                                                                                         | UNVERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                        |
| Gemini   | any error on the **compat** endpoint                           | per HTTP        | UNVERIFIED: whether compat returns the Google envelope above, an OpenAI-style `error` object, or a list wrapping it          | UNVERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the compat page documents no error shape                                                                                                                                                                                 |

Classification consequences for 5.4c-1 (facts, not a design): the Gemini per-day signal is the **`quotaId`** inside
`details[]` of `@type` `google.rpc.QuotaFailure`, a structured field — if compat carries it. Gemini's 403 has three
documented causes (free tier unavailable, payment, leaked key) under one status; §5.1 `AUTH` on a 403 needs a
documented key/permission field, and none beyond `status` is documented, so by §5.1 such a 403 is `REFUSED` unless
5.4c-5 shows an `ErrorInfo.reason`. **Superseded:** the ADR's provider-facts amendment (item 10) settled this: a 403 with the
documented envelope is `AUTH`, any other 403 `TRANSPORT`.

## Limits the merged code enforces (2026-11-06)

**No live probe has been made.** The merged PRs ran on fixtures with no real key, and the 5.4c-5 smoke is still ahead, so this
section adds no provider finding and every UNVERIFIED row in this document stands. These are the router's own limits and the
provider fields it reads: what the code does, not what a provider has been seen to do. Symbols are in
`packages/inference/src/router/` unless named otherwise; verify by grepping the symbol.

| Limit                                     | Value                                         | Symbol                                                             |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Own daily cap                             | 50 % of the configured free limit             | `OWN_CAP_SHARE`, `ownCapOf`                                        |
| Probes per provider per refresh           | 6, one above the list target of 5             | `PROBE_CAP`, `MANAGED_LIST_TARGET`                                 |
| Pause between probes                      | 6 s                                           | `PROBE_PAUSE_MS`                                                   |
| Answer tokens on a probe                  | 16, one fixed prompt                          | `PROBE_MAX_TOKENS`, `MODEL_PROBE_PROMPT`                           |
| Busy days before `dead` (Gemini)          | 3, then re-probed after 7 days                | `BUSY_DEAD_DAYS`, `BUSY_DEAD_REPROBE_DAYS`                         |
| Alive days before promotion               | 3                                             | `PROMOTION_STREAK`                                                 |
| Backoff on a busy model                   | 9 s, once per model per call                  | `BUSY_BACKOFF_MS`                                                  |
| Hosted budget per call                    | at most 120 s                                 | `MAX_HOSTED_BUDGET_MS`                                             |
| Local timeout                             | at most 300 s                                 | `LOCAL_TIMEOUT_LIMIT_MS`                                           |
| Smallest managed context                  | 16 000 tokens, fixed                          | `MIN_MANAGED_CONTEXT`                                              |
| Fit estimate                              | 2 characters per token, 32 tokens of overhead | `CHARS_PER_TOKEN`, `MESSAGE_OVERHEAD_TOKENS`                       |
| Listing read                              | 200 entries, 256-character ids, 512 KiB       | `LISTING_MAX_ENTRIES`, `LISTING_MAX_ID_CHARS`, `LISTING_MAX_BYTES` |
| Error body parsed                         | 2 MiB; over the cap means no marker           | `internal/classified-chat.ts`                                      |
| Longest provider-stated pause honoured    | 24 h                                          | `MAX_PAUSE_MS`                                                     |
| Largest token count believed from a reply | 10 000 000                                    | `MAX_REPORTED_TOKENS`                                              |

**Provider day, as the code reads it** (`providerDay`): America/Los_Angeles for Gemini, UTC for Groq.

**Provider fields the classifier reads**, all by fixture until the smoke: Gemini `error.status` `PERMISSION_DENIED` on a 403
means `AUTH`; a 429 `quotaId` containing `PerDay` means `SPENT_DAY`; a 503 means `BUSY`. Groq
`x-ratelimit-remaining-requests: 0` means `SPENT_DAY`; `retry-after` is read as whole seconds. A list-wrapped Gemini error body
reads its first element only (`errorJson`), an assumed shape with fixtures for 403 and 429 and none for 404.

**Could not be sourced:** real per-model free limits (the code takes them from configuration), a real list-wrapped error, and
the zero-limit 429 body. All three wait on the 5.4c-5 smoke.

## What could not be established (summary)

| Item                                                                                    | What settles it                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Gemini free-tier RPM / TPM / RPD per model                                              | Owner reads the AI Studio rate-limit page for the free project (login required) |
| Gemini compat error body shape (Google envelope or OpenAI-style)                        | One redacted error from the 5.4c-5 smoke                                        |
| Gemini response to a free key on a not-free model (assumed 429, limit 0)                | Same smoke, one call to a not-free id                                           |
| Gemini gone-model answer (404 vs silent re-route; `model` field in the response)        | Same smoke, one call to `gemini-2.0-flash`                                      |
| Gemini compat listing id form (with or without `models/`)                               | Same smoke, one listing call                                                    |
| Gemini compat honours the same ignored keywords as native structured output             | Same smoke                                                                      |
| `gemma-*` id form on the Gemini API                                                     | Pricing or models page section for Gemma, or the listing                        |
| Groq: whether the rate-limit table read is the Free plan                                | Owner reads the free organisation's limits page                                 |
| Groq: TPD 429 marker; gone-model status and body; `error.type` / `error.code` values    | 5.4c-5 smoke, redacted                                                          |
| Groq: whether the no-training clause covers free-plan use                               | Groq support or Legal reading the full agreement                                |
| Ollama: accepted `response_format` type and enforcement; prompt logging; disconnect     | MP-04 measurement on the pinned version                                         |
| llama.cpp: disconnect stops generation                                                  | MP-04 measurement                                                               |
| vLLM: `avx512f` on the CX33; GGUF on CPU                                                | `/proc/cpuinfo` on the VPS; vLLM GGUF docs                                      |
| Llama Acceptable Use Policy text; Gemma 4 licence page; licences of newer Qwen versions | Read at the card MP-04 pins                                                     |

## Applicability to us

- No version pin in `.claude/rules/common/version-pins.md` covers a provider or a runtime yet; 5.4c-7 pins the runtime,
  and these facts must be re-read on that version.
- The router's own rule of §5.1 — classify only on documented structured fields — meets two gaps (Groq TPD, Gemini compat
  errors). Both are listed as deltas so Master decides rather than the coder.
- The ADR keeps hosts as package constants: `generativelanguage.googleapis.com` and `api.groq.com` are the two egress
  hosts for 5.4c-5. The docs host move (`ai.google.dev` → `aistudio.google.com`) does not change the API host.
