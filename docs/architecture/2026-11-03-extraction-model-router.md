# ADR: Extraction model router — adopting the VideoContentFactory provider chain into `@crm/inference`

## Status

**Accepted — 2026-11-04.** Proposed 2026-11-03, amended 2026-11-04, and approved by the owner on 2026-11-04. The approval
answers D7 and accepts the recommendations for D4 and D5. Task: r5 Task 5.4c (plan
`docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`, Task 5.4 amendment of 2026-11-03 and §"Model split —
owner decision, 2026-10-18").

**Amended 2026-11-08 — hosted-only (owner decision).** The local model is withdrawn; the router uses free Gemini, Groq
and OpenRouter models only, and an all-exhausted day shows a localized notice. See "Amendment 2026-11-08 — hosted-only"
below; it supersedes the parts of the earlier amendments and sections that it names.

**Amendment, 2026-11-04 (owner corrections, relayed by Master).** (1) The CRM installs **its own** lightweight local
model; VCF's model and hardware are not adopted, only the strategy that keeps a small model answering (§8). (2) Small
dose is **unconditional**: built as part of the local route; MP-03 tunes it, it does not gate it (§5.4). (3) Owner
decisions D1–D3 are recorded (§4.1–§4.3): hosted routes for every source the model can serve; providers whose free
tier may train on or human-review prompts are accepted; OpenRouter is not in the first router version.

**Provider-facts amendment, 2026-11-04 (A1, by the architect; source:
`docs/architecture/2026-11-04-extraction-provider-facts.md`).** No owner decision changes.

1. Gemini's listing has no free-tier field: Gemini candidates are filtered by a checked-in family pattern (§3.4).
2. A free key on a model it cannot call gets 429 with limit 0 (forum-sourced): a Gemini model answering a probe with a
   non-per-day 429 on three consecutive probe days is dropped as `dead`; one redacted call in the 5.4c-5 smoke confirms it (§3.4).
3. Retired Gemini models are re-routed, not refused: a 2xx whose response `model` names another version or variant retires
   the requested id; UNVERIFIED that the compat endpoint reports it, else pinned ids and the daily refresh are the repair (§5.1).
4. Groq has no structured per-day field: `SPENT_DAY` comes from the documented `x-ratelimit-remaining-requests: 0`; a
   per-day token 429 has no marker and is `BUSY` with one wait and a cool-down, never a loop; own caps stay the guard (§5.1).
5. Only four Groq models take strict `json_schema`, two of them preview: the Groq pattern and fallback list are the two
   production `gpt-oss` models (§3.4).
6. Strict schema rules (every property required, `additionalProperties: false`, optional as a union with `null`) are
   rendered for every route by 5.4c-1.
7. Ollama's window is server-wide, default 4096: 5.4c-8 sets it, and the input ceiling takes the configured window (§2.1, §8.4).
8. Groq's terms forbid training on inputs: §4 item 4 is corrected for Groq; Gemini's text and D2 are unchanged.
9. Groq's zero data retention is an organisation setting, an optional owner action, not a request flag (§4 item 3).
10. Gemini's 403 has four documented causes, all about the key or project: a 403 carrying the provider's documented error
    envelope is `AUTH`, never `REFUSED`; any other 403 is `TRANSPORT` (§5.1).
11. An error body is parsed whole (capped at 2 MiB), not cut at 2 000 characters, which broke real Google errors; over the
    cap means no marker; each rule reads one fixed field (Gemini 429: `error.details[]`, `retryDelay` only from its `RetryInfo` entry; 403:
    `error.status`, never `details`); `RETIRED` takes `error.code` `model_not_found` or the requested id in `error.message`
    as a whole token (§5.1).

**Amendment, 2026-11-06 (what shipped; A1, by the architect; source: the merged code of 5.4c-1, 5.4c-2, 5.4c-2b, 5.4c-6,
5.4c-W, W-ops and 5.4c-3).** No owner decision changes. Where this ADR and the code disagreed, the code is what shipped and
the sections are corrected in place; the shipped limits are listed in
`docs/architecture/2026-11-04-extraction-provider-facts.md`.

1. **`busyDead` is a new state record (§3.2, §3.4).** A Gemini model dropped for three busy days is stamped with its day.
   The refresh keeps it off the list and out of the candidates until `isBusyDeadReprobeDue`, seven days later. The record
   cap is `MAX_BUSY_DEAD_ENTRIES` (50), keeping the newest: dropping the oldest returns that id to the queue and restarts its
   count. A smaller cap would let six always-busy ids starve a good candidate.
2. **A re-probe settles the stamp (§3.4).** A held model that answers alive loses the stamp and starts probation at streak 0;
   any other answer stamps it again, with verdict `dead`.
3. **The rest of the non-alive candidates rest too (§3.4).** `restNonAlive` stamps every model that answered non-alive,
   apart from a busy 429 (the three-day count owns it), when it is not on the list the run serves. Its probation record goes.
   A listed entry answering 404 that leaves while another entry survives rests as well; a transient or unknown entry still
   on the list stays unstamped. When nothing survives, the file keeps its list and nothing listed rests.
4. **`MIN_MANAGED_CONTEXT` is a fixed 16 000 (§3.4).** The relation to the local chunk size is intended, not enforced: nothing
   derives or checks it, and the `shortcut:` comment on the constant still waits on 5.4c-6, which has landed.
5. **Pinned ids have no eviction protection (§3.4).** A promotion at a full list pushes the tail entry off, pinned or not.
   A pinned id gets no probation record, so it cannot re-promote through the refresh and returns only as a tail candidate;
   the reader treats it as promoted while listed.
6. **Record cap 11 (§3.2).** `MAX_MODEL_RECORDS` is `MANAGED_LIST_TARGET` (5) plus `PROBE_CAP` (6), for probation and busy
   records per provider. Off-list records go first; the `shortcut:` comment on the constant records that more than `PROBE_CAP`
   unprobed off-list records still lose the oldest, restarting its promotion or busy count.
7. **The worker secret has a floor on both ends (§2.4).** At least `MIN_WORKER_SECRET_CHARS` (32) characters and
   `MIN_WORKER_SECRET_DISTINCT_CHARS` (8) distinct ones; `isUsableWorkerSecret` is the single rule.
8. **The extraction-worker adapter keeps error codes apart (§2.4).** A caller's abort stays `TIMEOUT`; the adapter's own timer,
   a non-2xx reply, a transport failure, a malformed envelope and data failing the caller's schema are `PROVIDER_ERROR`. A code
   the worker sends passes unchanged for `NOT_CONFIGURED`, `PROVIDER_ERROR`, `INVALID_OUTPUT` and `TIMEOUT`; `RATE_LIMITED`
   becomes `PROVIDER_ERROR`.
9. **State-file rejection is per record for the spent and retired lists (§6.1, SPEC-L-2 of 5.4c-2b).** See §6.1.
10. **Only the busy 429 counts toward `dead` (§6.1, SPEC-L-1 of 5.4c-2b).** A 503 is `transient` and ends a run; §3.4 and §6.1 now
    say so.
11. **The start-up refresh can send no probe (§3.2, SPEC-L-10 and SR-L-24 of 5.4c-2b).** When every id on the list is held,
    no candidate is eligible, the outcome is failed with `NOTHING_SURVIVED`, and the `AUTH` bit stays until a due re-probe. This
    fails closed; the seven-day rule stays.
12. **The §5.3 signals get new tables, and the 5.5b task owns the first call site (§7.2).**

### Amendment 2026-11-08 — hosted-only

**Owner decision, 2026-11-08 (A3, taken by the owner; written up by the architect).** This amendment is normative. Where an
older section of this ADR disagrees with it, this amendment wins, and the older section carries a "Superseded 2026-11-08"
note pointing here.

1. **The local model is withdrawn.** The server never runs a local LLM runtime for extraction. The measured cause is the
   MP-04 replay of the one candidate, qwen2.5-1.5b, on the production host. It reached an MP-03 schema-valid rate of 0.68
   (uk) and 0.32 (en) and a field accuracy of 0.16 and 0.14. After an abort, the CPU stayed busy for 36 s against a
   10 s limit. The owner stopped the replay. The extraction compose project, the weights volume and the images were
   removed from production.
2. **The router uses free hosted models only: Gemini, Groq and OpenRouter.** OpenRouter returns as a route (D3 is
   superseded, §4.3). The owner bought $10 of OpenRouter credits, which raises the `:free` limit to 1000 requests a day.
   **Only free models are ever used**, never a paid one (§3.5).
3. **When every provider, model and limit is exhausted, the user sees a localized error** (uk and en, through Lingui),
   not a slow fallback and not an empty result (H.2, H.8).

What it supersedes: Decision items 2, 6, 7 and 8; D3, D8 and D9; the local route of §2.1, §2.4, §3.1 and §3.3; §5.3 "slow,
never a silent failure"; §5.4 (the small dose); the local phase of §6.2; the tasks 5.4c-7 and 5.4c-8; and §8 as a whole
(withdrawn, kept as the record of the attempt). D1, D2, D4–D7 and D10 stand unchanged. D11 (OpenRouter
`data_collection: allow`, decided by the owner the same day) is new (H.9).

#### H.1 Router config without a local route (HIGH)

- **Providers.** `HOSTED_PROVIDERS` is `gemini`, `groq`, `openrouter`. `HOSTED_BASE_URLS` gains
  `openrouter: 'https://openrouter.ai/api/v1'`, a package constant like the other two. `RouterProvider` is `HostedProvider`;
  the value `local` disappears from the router's types.
- **Removed:** `localRouteSchema`, `LocalRouteConfig`, `floorBudgetMs`, `MAX_FLOOR_BUDGET_MS`, `LOCAL_TIMEOUT_LIMIT_MS`,
  `isAllowedRouterLocalModelUrl`, `localRuntimeKey`, `ROUTER_LOCAL_MODEL_URL` and the local single-flight queue.
- **A stale config fails closed.** `routerConfigSchema` stays `.strict()`, and `local` is not in the provider enum. A config
  that still carries `floorBudgetMs` or a `local` route is therefore refused (`CONFIG_REFUSED`; the adapter answers
  `NOT_CONFIGURED`). It is never silently stripped into a different config.
- **The two local refines and their replacement.**
  - `routes.at(-1)?.provider === 'local'` has no successor. Routes are tried in config order, as §5.2 already says.
  - `floorBudgetMs >= MAX_SMALL_DOSE_GROUPS * local.timeoutMs` becomes
    `hostedBudgetMs >= Math.max(...routes.map((r) => r.timeoutMs))`. The idea is the same: the budget must hold one whole
    request of the route it protects. It now protects the slowest configured route instead of the floor. The refine stays
    total, so a failed `routes` (empty) reaches it without throwing.
  - Unique providers per route list: kept. `routes` stays `.min(1).max(3)`.
- **`hostedBudgetMs` is positive** (it was non-negative only so that a local-only config could carry 0).
- **The route schema is a discriminated union on `provider`.** The OpenRouter member has one extra required field,
  `dataCollection: 'allow' | 'deny'`, with no default (§3.5). It is set to `allow` (owner decision D11, H.9). The Gemini and Groq members refuse it.
- **The call ceiling is the hosted budget.** `routerCallCeilingMs(config)` returns `config.hostedBudgetMs`. On the
  collection side, `CALL_CEILING_MS` becomes `MAX_HOSTED_BUDGET_MS` (120 s) instead of 120 s plus six local requests of up to
  300 s each, and `WORKER_STRUCTURER_TIMEOUT_MS`, `WORKER_ADAPTER_TIMEOUT_MS` and `WORKER_HOLD_MS` shrink with it. §5.5 is
  unchanged otherwise: one request in flight, a real abort, a coded `TIMEOUT` before the transport's.

#### H.2 The all-exhausted outcome: `LIMITS_EXHAUSTED` (HIGH for the behaviour, MED for the name)

- **A new public code.** `INFERENCE_ERROR_CODES` gains `LIMITS_EXHAUSTED`. The name is cheap to change until it ships.
- **Definition.** A router call ends `LIMITS_EXHAUSTED` only when all three hold:
  1. it produced no answer;
  2. the set of **available** routes is non-empty. A route is available when it is configured, its key is present and its
     provider is not `AUTH`-disabled;
  3. every available route ended the call **limit-blocked**: its own cap refused a unit (`CAP`, D5 unchanged); or every
     model it could try is spent for the provider day (`SPENT_DAY` in this call, or a spent entry in route state); or its
     provider's `CREDIT` bit is set.
- **How it differs from a transient failure.** A route that ended `BUSY`, `TIMEOUT`, `TRANSPORT`, `INVALID_OUTPUT`,
  `REFUSED`, `FIT`, `BUDGET` (the call's own time ran out) or `RETIRED` with nothing left to try is **not** limit-blocked.
  If any available route ended that way, the call keeps today's codes: `PROVIDER_ERROR`, `INVALID_OUTPUT` when the record
  caused it, or `TIMEOUT` on an abort. A busy route recovers in minutes; an exhausted one waits hours for its reset. So a
  mix of one spent and one busy route is transient, and HR never sees "limits exhausted" for a quarter-hour blip. The
  reverse error is impossible by construction: when every route is limit-blocked, the code is always `LIMITS_EXHAUSTED`.
- **Neighbouring cases.** Every available route `AUTH`-disabled, or no route available: `PROVIDER_ERROR` plus the existing
  `HOSTED_ROUTES_DEAD` flag (wrong or revoked keys, an operator problem, not limits). No route configured at all:
  `NOT_CONFIGURED`.
- **Router event.** `EXHAUSTED`, carrying the per-route reasons (route, internal code; never text), replaces
  `FELL_TO_LOCAL`. The `onEvent` callback stays mandatory.
- **No reset time in the port result.** `ExtractionResult` keeps `{ ok: false, code }`. The user message says "try again
  later" and needs no time; a reset time would widen a cross-package contract for no reader.
- **The extraction worker passes the code through unchanged**, like `NOT_CONFIGURED`, `PROVIDER_ERROR`, `INVALID_OUTPUT` and
  `TIMEOUT` (Amendment 2026-11-06 item 8). The worker's reply envelope schema adds it. The adapter must not fold it into
  `PROVIDER_ERROR`.
- **The collection cycle (`ModelStructurer`).** `BY_INFERENCE_CODE` maps `LIMITS_EXHAUSTED` to a new `ModelStop` kind,
  `LIMITS_EXHAUSTED`, with no cause field. On that stop:
  - the model stage stops for the rest of the cycle, with no further port call;
  - the record that met it and every remaining record stay **owed**. They are not counted in `modelAttempts` and are
    never parked; `settleModelPending` treats them as it treats `BUDGET_EXHAUSTED`. The checkpoint is the existing owed
    set, so the next cycle retries them;
  - the deterministic stages run on, and fields they produced are still written.
- **Why a new kind and not `BUDGET_EXHAUSTED`.** That stop is the CRM's own per-cycle budget (`HTML_MODEL_CALLS_PER_CYCLE`),
  always clear by the next cycle and invisible to users. **Why not `MODEL_UNAVAILABLE`.** That stop means the config or
  transport is broken and the owner must act. `LIMITS_EXHAUSTED` is a normal daily state that clears itself at reset, and
  it is the one the user is told about.
- **Health flag.** `MODEL_HEALTH_FLAG_VALUES` gains `MODEL_LIMITS_EXHAUSTED`. It is raised on the stop (or by the readiness
  answer of H.3) and cleared by the first successful call or `READY` readiness of a later cycle. It is emitted once per
  cycle through the existing `claimEmissions`, at warn level, not error: it is expected under load. `MODEL_ROUTE_VALUES`
  gains `openrouter` and keeps `local`, so a historical row stays valid. Both are CHECK constraints on
  `job_model_health_flags` and `job_model_route_daily`, so this is forward DDL in `manual-staged/` (critical path).

#### H.3 Preflight becomes a readiness check that sends nothing (HIGH)

- **What it was.** Up to four attempts, 10 s, 30 s and 60 s apart (`PREFLIGHT_BACKOFF_MS`), each sending the synthetic
  `PREFLIGHT_INPUT` through `localOnlyRouterConfig`. It existed to wait out the local model's cold load (§5.3, MP-04).
- **Why not a hosted probe instead.** A probe through the hosted routes would spend a free request on every cycle, from
  the same daily limit the vacancies need. The daily refresh (§3.4) already probes the model lists.
- **What it is now.** The worker's `/preflight` reads its own route state (spent entries, `CREDIT` and `AUTH` bits, own-cap
  counters), sends **no model request**, and answers one of:
  - `READY`: at least one available route is not limit-blocked;
  - `LIMITS_EXHAUSTED`: routes are available, and every one is limit-blocked;
  - `NO_ROUTE`: no route has a key, or every route is `AUTH`-disabled.

  It reads the own-cap counters and reserves no unit.

- **What the collection side does with it.**
  - `READY`: the model stage runs.
  - `LIMITS_EXHAUSTED`: the model stage is skipped with the H.2 stop and zero calls.
  - `NO_ROUTE`, or the worker unreachable: `MODEL_UNREACHABLE`. Its meaning narrows to "the worker or its routes".
- **One attempt, no backoff.** `PREFLIGHT_BACKOFF_MS` and the multi-attempt loop in `reachModel` go, and so do
  `PREFLIGHT_INPUT`, `PREFLIGHT_INSTRUCTION` and `localOnlyRouterConfig`. `preflightReplySchema` becomes the three-value
  answer. A worker that is down is retried by the next cycle.
- **`READY` is advisory.** Limits can run out mid-cycle; H.2 covers that.

#### H.4 The extraction worker stays (HIGH)

- **Why it stays.** Its reason never depended on the local runtime. A process that parses hostile pages must not hold the
  provider keys and a DB role at once (§2.4, option c). Folding the router into the API would put three provider keys
  next to the DB credentials, in the process that fetches third-party HTML. Hosted-only does not change that threat; it
  adds a third key. The worker keeps holding the keys and the state files, and no DB credential.
- **What goes.** The runtime network and the runtime container. `ROUTER_LOCAL_MODEL_URL`, `LOCAL_MODEL_KEY` and
  `LOCAL_MODEL_NAME` leave `extractionWorkerEnvSchema`. The small-dose groups leave `EXTRACTION_TABLE_VERSION`, which
  becomes a version of the schema and prompt only.
- **What is added.** `extractionWorkerEnvSchema` and `HOSTED_KEY_ENV` gain `openrouter: 'OPENROUTER_API_KEY'`.
  `routeFromEnv` still drops a route whose key is absent, so the worker starts with whichever keys the owner has entered.
  Today that is OpenRouter alone: no Gemini or Groq key exists yet.
- **What stays.** The dedicated internal network, `EXTRACTION_WORKER_SECRET` with `isUsableWorkerSecret`, the data-only
  strict schema, the second `stripContacts` and the 0600 env file. The worker never reads `.env.production`.
- **Collection-side env.** `MODEL_EXTRACTION_ENV_KEYS` drops `EXTRACTION_CYCLE_LOCAL_MS_LIMIT`, because the local time
  budget of §5.5 item 6 is gone. It renames `EXTRACTION_LOCAL_CONTEXT_TOKENS` and `EXTRACTION_LOCAL_MAX_ANSWER_TOKENS` to
  `EXTRACTION_INPUT_CONTEXT_TOKENS` and `EXTRACTION_INPUT_MAX_ANSWER_TOKENS`.
- **Where the input ceiling comes from (MED).** Operations set those two keys to the **smallest** configured hosted window,
  so every route fits every input. `routerInputCeilingChars` loses its small-dose parameter. Drift between the two sides is
  safe: a prompt too large for one route is `FIT` on that route, and the cascade moves on (§5.2). It turns into a failure
  only when it fits no route, and then it is `PROVIDER_ERROR`, never `LIMITS_EXHAUSTED`. MP-03 reports the share of inputs
  that were cut.
- **Placement.** The memory budget of the model was the reason for a separate compose project. Whether the worker now
  joins the main deploy compose is DevOps's call in 5.4c-5. The internal network and the secret are not optional either
  way.
- **The key moves (owner action).** `OPENROUTER_API_KEY` goes into the worker's 0600 env file. The API's own env keeps it
  only while an API-side consumer remains. Today those are `build-inference-config.ts` (the single-route `openrouter`
  provider), `inference.module.ts` and `inference-model-resolver.service.ts`, and `deploy.yml` writes the key into the API
  env. Removing it there is a separate DevOps step once `INFERENCE_EXTRACTION_PROVIDER=router` is live, and only after a
  grep confirms no API reader is left.

#### H.5 OpenRouter: the free-only guard

Specified in §3.5, rewritten by this amendment from "deferred" to "built". In short:

- only `:free` ids are requested;
- every catalogue price is 0;
- the `openrouter` author and every other suffix are denied;
- the request sends `max_price` 0 and `require_parameters`;
- the limits are 1000 a day and about 20 a minute;
- `SPENT_DAY`, `CREDIT` and `FLAG_REJECTED` are classified;
- the key's USD `limit` of $0 is the backstop.

A paid model is unreachable by four independent checks (§3.5).

#### H.6 The small dose is retired (HIGH)

- **Why it existed.** A 1.5B-class local model could not answer the full schema, so §5.4 split the ask into field groups
  and merged the answers. Hosted routes always got the full shape (§5.4, "hosted: full shape").
- **Why it does not carry over.** Each group re-sends the whole input. So a six-group dose costs up to six requests and
  six times the input tokens of one full call, against 1000 requests a day and about 20 a minute. It does not help a
  hosted context limit, because the input, not the schema, is what fills the window. Its only beneficiary was the
  withdrawn model.
- **What survives.**
  - the D10 guard: a field without a surviving quote becomes null, on every route;
  - `modelReplySchema` with its evidence spans;
  - the strict-schema rendering every route uses: `renderSchema` and `structuredOutputFor` move out of `small-dose.ts`;
  - the per-record `missing` list, which still narrows what the deterministic stage leaves to the model.
- **What goes.** `runSmallDose`, `DoseAsk`, the `SmallDose` type, `ExtractionRequest.smallDose`, `MAX_SMALL_DOSE_GROUPS`,
  `small-dose-table.ts` (`smallDoseFor`, `FLOOR_UNCERTAINTY`), the hand-back, `PROMPT_TOO_LARGE` (a local-only code), the
  `localMs` usage field and the local cycle time budget.

#### H.7 Limits and resets per provider (MED until the 5.4c-5 smoke)

| Provider   | Free limit fed to `freeLimit`                                     | Own cap (D5, 50 %) | Pacing (`minGapMs`)    | Reset assumed                    |
| ---------- | ----------------------------------------------------------------- | ------------------ | ---------------------- | -------------------------------- |
| Gemini     | per model, from `2026-11-04-extraction-provider-facts.md`         | half of it         | per provider-facts     | midnight Pacific (documented)    |
| Groq       | per model, from the same file                                     | half of it         | per provider-facts     | UNVERIFIED; the smoke records it |
| OpenRouter | 1000 requests a day for `:free` once ≥ $10 of credits were bought | 500                | 3000 ms (~20 a minute) | UNVERIFIED; the smoke records it |

Own caps stay per provider and per policy version (D5). A reset time is used only by the health flag's message and by
operators. No code path waits on it, so an error here delays a retry by one cycle at most.

#### H.8 How the message reaches HR and ADMIN

- **The text** (Lingui; in this module the `uk` text is the source message and `en` is its catalog entry):
  - uk: «Пошук вакансій тимчасово недоступний: ліміти AI-моделей на зараз вичерпано. Спробуйте пізніше.»
  - en: "Vacancy sourcing is temporarily unavailable: AI model limits are exhausted for now. Try again later."

  The copy-reviewer reviews both. The owner's suggested wording is the starting point, not frozen text.

- **One API field, derived from the flag.** The read model is "is `MODEL_LIMITS_EXHAUSTED` raised and not cleared". It is
  exposed as `sourcingNotice: 'AI_LIMITS_EXHAUSTED' | null` in two strict response schemas in `@crm/shared`:
  - `jobQueueListResponseSchema`, the HR, SENIOR and ADMIN queue, served by `JobQueueService.list`;
  - `jobSourceOperationalListSchema`, ADMIN `GET /job-sourcing/admin/sources/health`, served by
    `JobSourceAdminController`.

  Both schemas are strict, so the field is added to the schema, never passed through. It is a closed enum, so further
  notices are new values, not new fields. It carries no provider name, count or time: no RBAC-relevant data reaches the
  HR view.

- **Where it shows.**
  - **Queue** (`/job-queue`, the existing notice pattern with `AlertTriangle` and `<Trans>`, test id
    `job-queue-ai-limits`). It is a separate block above the list, outside the `if / else if` chain, so it can stand beside
    the "partial list" notice. It sits in a live region with `role="status"`.
  - **ADMIN sources** (`/admin/sources`): the same text as a banner over the health table.
- **The ADMIN manual run.** `POST /job-sourcing/collect` uses the same concept.
  - `jobCollectionRunSchema` gains the same `sourcingNotice` field, set when the run's model stage stopped on limits. The
    deterministic stages still ran.
  - When nothing succeeded **and** the model stage stopped on limits, the existing 503 carries a new code,
    `JOB_SOURCING_AI_LIMITS_EXHAUSTED` in `JOB_SOURCING_ERROR_CODES`. It has the same localized text in the client
    catalog and an English fallback `message`.
  - Any other "nothing succeeded" keeps today's 503 and code.
- **Where it lands now, and where later.** Nothing in production calls the model wiring until task 5.5b, the first HTML
  model provider (§7.2, delivery state). Until then the flag is never raised, the field is always `null` and both views
  show nothing. The code ships with tests that raise the flag through the store. The message goes live when 5.5b wires
  `prepareCycle`. Later, the HR queue's empty state is the natural second place, when a queue stays empty because the
  model stage was skipped; it is a follow-up, not part of H-3.

#### H.9 Two OpenRouter decisions

- **D11, `provider.data_collection` on the OpenRouter route: `allow`** (decided by the owner, 2026-11-08). The owner's
  words: "let them collect data, we never send personal information to the models anyway".
  - **The facts it rests on.** The 2026-11-08 probe found that `deny` gives `nvidia/nemotron-3.5-super-vl:free` a 404
    ("No endpoints found matching your data policy (Free model training)").
    `dots-studio/dots-3-note-preview:free` and `xingchen-agi/xing4.0-29b-a4b:free` answer 200 with `deny`. The two Gemma
    models answer 429 either way.
  - **Rationale.** It is consistent with D2. Only public vacancy text leaves the host, and contact details are stripped
    before it does.
  - **What it makes load-bearing.** With `allow`, the contact-stripping guard of 5.4a (`stripContacts`, run on the
    collection side and again in the extraction worker, §2.4) becomes **the** privacy control for OpenRouter. No
    provider-side setting stands behind it. So it is **mandatory on every hosted route**: no config value, route or
    provider can skip it.
  - **Test obligation.** For each hosted provider (`gemini`, `groq`, `openrouter`), a router-level privacy test sends an
    input carrying every contact shape `stripContacts` handles. It asserts that the outgoing request body holds none of
    them, and that no code path reaches a leaf without passing the strip. It runs in the inference privacy specs and the
    extraction-worker spec, on production, probe and chain-check requests alike (§3.3, one request builder).
  - **One config value.** `dataCollection` is required on the OpenRouter route, with no default, and is set to `allow`.
    Changing it is a config change, not a code change. If it is ever set to `deny`, the nemotron model is
    `FLAG_REJECTED` and the cascade moves on.
- **OD-2, `provider.ignore` contents** (A1, taken by the architect and recorded here; the owner may override).
  **Decided: empty.** Its old content came from the
  D2 exclusion that no longer exists. The field stays in the request builder, so a later entry is a config value.

## Context

The owner decided on 2026-10-18 that vacancy extraction runs on Gemini, Groq, OpenRouter and the local model: a
router over free hosted models with prompt dosing, so that no provider starts refusing, over a local baseline.
Everything must work on the local model alone; the free hosted models are an accelerator. Generation (Cloudflare
Workers AI) is out of scope for r5. **Owner decision D3 (2026-11-04) narrows that list for the first router version:
Gemini, Groq and the local floor.** OpenRouter can be added later (§3.5).

The owner already runs such a chain in his own project, **VideoContentFactory** (VCF; read-only for this ADR, read at
its state of 2026-11-03). Today `@crm/inference` offers one extraction route, chosen by `INFERENCE_EXTRACTION_PROVIDER`
(`local` | `openrouter`), behind `ExtractionPort` (`extract({ input, schema, instruction }) → { ok, data, usage? } |
{ ok: false, code: InferenceErrorCode }`). The HTML path (Tasks 5.4a/5.4b) composes privacy guards and a shared
budget around that port. The router slots in **behind the same port** and its result type does not change, but 5.4b does:
`ExtractionRequest` gains `smallDose` and `signal`, and `ModelStructurer` passes the real schema, derives its timeout and
hold from the router's ceiling, and threads the abort (§5.4, §5.5).

Forces:

- **Privacy.** Page text leaves the host. Contact stripping and the `ai-input=no` gate already run before the port
  (5.4a/5.4b); free hosted tiers may log or train on prompts, which the owner has accepted (§4.1, §4.2).
- **A small model fails unless it is dosed.** The local floor is a lightweight model on a CPU host shared with the CRM
  (§8.2). Sent a large structured request, such a model comes back empty or wrong on every prompt; asked what it can
  answer, it answers.
- **Free tiers churn.** Models are renamed, retired, rate-limited per minute and capped per day; the error texts
  differ per provider.
- **"Slow, never a silent failure."** A chain that runs dry must fall to local and say so; a local failure must stop
  loudly, not report "nothing extracted".
- **Repo invariants.** Secrets only in worker-read optional env keys (never config, DB, logs, reports, build layers;
  never `CLOUDFLARE_*`); exhaustion classified by documented status/error codes, never by page text; Zod v4
  validation of every model output; deterministic tests without keys or network.

## Decision (summary)

> **Hosted-only since 2026-11-08** (Amendment 2026-11-08). Items 1, 3, 4 and 5 stand. Items 2, 6, 7 and 8 are replaced by
> 2′, 6′ and 7′ below (7′ replaces both 7 and 8). In item 5, D3 is superseded (§7.1). The original items are kept unchanged after this note, as the record.
>
> - **2′.** The `router` provider runs Gemini, Groq and OpenRouter (free models only, §3.5) from a checked-in allowlist.
>   It has no local floor. It keeps rotation, the fit filter, own caps and spent/retired skipping, under a whole-call
>   deadline equal to the hosted budget (H.1, HIGH).
> - **6′.** Classification stays as in item 6. A call that finds every available route limit-blocked ends
>   `LIMITS_EXHAUSTED`. The cycle stops its model stage and keeps the records owed. The `MODEL_LIMITS_EXHAUSTED` flag is
>   raised, and HR and ADMIN see a localized message. The preflight becomes a readiness check that sends nothing (H.2,
>   H.3, H.8, HIGH).
> - **7′.** The local model is withdrawn: no local LLM runtime on the server for extraction. The small dose is retired,
>   and the D10 guard stays (H.6, §8, HIGH).

1. **Copy-adapt** VCF's routing patterns into `@crm/inference` behind `ExtractionPort`, whose result is unchanged (§2, HIGH).
2. A third extraction provider value, `router`: hosted routes from a checked-in provider allowlist (Gemini, Groq) in
   front of a **required** local floor; rotation, fit filter, own caps, spent/retired skipping, a whole-call deadline
   that reserves the floor's time (§2.1, §5.2, HIGH).
3. Keys only as optional worker env keys; own caps, spent/retired/provider state in a worker state file behind a port
   (§3.2, HIGH for the port, MED for the file).
4. **Self-healing model lists** (owner decision D6): request-time retirement, a daily refresh of each provider's
   managed list from its listing, with probes on a fixed synthetic prompt where the provider is probed, a pinned fallback list, a weekly
   `MODEL_LIST_STALE` check — adopted from VCF (§3.4, HIGH).
5. Privacy guards stay in front of the router, whose only entry is authenticated and data-only (§2.4); the router stores and logs no text. Owner decisions D1–D3 (2026-11-04):
   every source the model can serve may use the hosted routes, training-permitting free tiers included, and the
   accepted risk is stated once in §4.1. `ai-input=no`, the `unspecified` policy and contact stripping are not weakened
   (§4, decided).
6. Classification by status and bounded structured error fields, never page text; every fall to local is an event;
   preflight before a model-using cycle (§5, HIGH).
7. **The CRM's own local model:** a lightweight text model chosen by criteria and picked by MP-04, in its own pinned
   container, installed on production only by the owner; if none passes, the owner chooses another host or deterministic
   HTML with model extraction disabled (§8, HIGH for the criteria, **no model named**).
8. **The local route is dosed, always:** hand-back and field-group small dose, refusal of a prompt that does not fit,
   preflight and an absolute ceiling with a real abort are mandatory behaviour, not options (§5.4, §5.5, §8.4, HIGH for the pattern, MED for
   the field groups until MP-03 tunes them).

---

## 1. What VideoContentFactory does, and what is portable

VCF is a single-owner content pipeline (Node 22, `--experimental-strip-types`, SQLite through a synchronous driver).
Its model layer is an `LlmExecutor` function type — `(prompt, tools?, hint?) → Promise<string>`, throwing on failure —
composed from the pieces below.

### 1.1 The pieces

| VCF mechanism (symbol)                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                  | Portable?                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Route** (`Route` type)                                                | A named executor plus capability facts: usable context tokens, image support, and `rotate` (may it be the first route tried)                                                                                                                                                                                                                                                                  | **Yes** — the shape is the router's unit                                                                                 |
| **Cascade** (`createChainExecutor`)                                     | Tries routes in order; each failure is recorded as `<route>: <why>` and announced ("X failed, asking Y"); all failed → one error joining every reason                                                                                                                                                                                                                                         | **Yes**                                                                                                                  |
| **Fit filter** (`createFittingChainExecutor`, `fitRoutes`)              | Drops routes that cannot take this call (prompt larger than the context window, images on a text-only route) before spending a request; when nothing fits it tries everyone and says so                                                                                                                                                                                                       | **Yes**, minus images                                                                                                    |
| **Balancing** (`createBalancedChainExecutor`)                           | A per-instance counter rotates which rotatable route goes first, so successive calls spread over providers; a `rotate: false` route (Gemini, budget reserved) is only a fallback                                                                                                                                                                                                              | **Yes**                                                                                                                  |
| **Hybrid floor** (`createHybridExecutor`)                               | Hosted chain first for named calls, the local model behind it; the fall is announced through `onFallback`                                                                                                                                                                                                                                                                                     | **Yes** — this is "local baseline"                                                                                       |
| **OpenAI-compatible leaf** (`createOpenAICompatExecutor`)               | One provider, an ordered list of models; skips models marked spent or retired; a minimum gap between calls to one provider (`COMPAT_MIN_GAP_MS` = 3 s); 429 whose body matches a per-day pattern (`DAILY_LIMIT`: "per day", `TPD`, `RPD`, "daily") → model spent for the day; 404 naming a model or endpoint (`retiredAnswer`) → model retired; an off-schema answer passes to the next model | **Yes**, the classification and pacing; **no**, the body-text handling (§5)                                              |
| **Gemini leaf** (`createGeminiExecutor`)                                | Native Gemini API; 7 s minimum gap (`MIN_CALL_GAP_MS`); 429/503 waited out with backoff 9 s / 25 s (`BUSY_BACKOFF_MS`) before moving on; a 429 naming a `PerDay` quota → spent; safety block (`promptFeedback.blockReason`, `finishReason`) → failure                                                                                                                                         | **Pattern yes**; the native client is replaced by Gemini's OpenAI-compatible endpoint if research confirms it (§2.3)     |
| **Own daily caps** (`budgetGuarded`, `providerBudget`, `consumeQuota`)  | Before each call a per-provider counter for the provider's own day (Pacific for Gemini, UTC for the rest) is spent; over the cap → the route is skipped without a request                                                                                                                                                                                                                     | **Yes** — maps onto the CRM's existing account meters (§3)                                                               |
| **Spent ledger** (`SpentStore`, table `llm_spent`)                      | `(model, provider-day)` rows: "this model said no more today"; read by every process                                                                                                                                                                                                                                                                                                          | **Concept yes; storage no** (§3)                                                                                         |
| **Retired ledger** (`RetiredStore`, table `llm_retired`)                | Models that answered "gone"; cleared by the daily model refresh, because a fresh probe is the authority                                                                                                                                                                                                                                                                                       | **Concept yes; storage no** (§3)                                                                                         |
| **Model refresh** (`pickLiveModels`, `classifyModelStatus`)             | Daily probe of the free catalogue; drops 404s and small contexts, keeps alive before busy before unknown; never wipes the list on a bad morning                                                                                                                                                                                                                                               | **Partly** — **Yes** (owner decision D6) — adopted with a pinned fallback, a provider allowlist and id validation (§3.4) |
| **Preflight** (`PREFLIGHT_PROMPT`, `PREFLIGHT_BACKOFF_MS`)              | One trivial call to the local model before a run that needs it; 4 attempts, 10 / 30 / 60 s apart; no answer → the run stops at once, names the address, marks nothing as judged, writes a durable "model unreachable" marker                                                                                                                                                                  | **Yes**                                                                                                                  |
| **Wall-clock ceiling** (`boundExecutor`)                                | One logical call is capped, because per-request timeouts sum across a cascade                                                                                                                                                                                                                                                                                                                 | **Yes** — essential                                                                                                      |
| **Dosing** (`DosedCall`, `dosePlanFor`, `callDosed`, `SmallDoseNeeded`) | See 1.2                                                                                                                                                                                                                                                                                                                                                                                       | **Yes, re-scoped**                                                                                                       |

### 1.2 What "dosing" means in VCF — and in the CRM

In VCF, **a dose is the shape of a call sized to the model that answers it**, not a rate. A call has a `full` shape
(the structured request, for a large hosted model) and a `small` shape (a decomposition into simple questions the small
local model answers reliably, read by code). On the hybrid, a call goes `full` to the hosted chain; when the chain gives
up, the executor **hands the call back** (`SmallDoseNeeded`) instead of sending the full prompt to the small model —
which is what used to come back empty — and the small dose runs pinned to the local route.

What keeps a free provider from **refusing** is a separate set of mechanisms: the per-provider minimum gap, the own
daily caps below the provider's published limit, the spent ledger (never re-ask a model that said "no more today"),
and rotation across providers.

The owner's phrase "prompt dosing, so a provider does not start refusing" therefore maps onto **both**, and this ADR
adopts both under explicit names:

- **Pacing** — gap, own caps, spent/retired ledgers, rotation. Keeps hosted providers below their refusal threshold.
- **Dosing** — the input **and the schema** sized per route: every input the caller sends fits the **local** route's
  window, a route that cannot take it is dropped by the fit filter and never fed a truncated prompt, and the local route
  is asked in field groups rather than the full schema (§5.4).

### 1.3 What is not portable

- **Storage.** SQLite with a synchronous driver; the CRM uses PostgreSQL/Drizzle, and the extraction worker holds no DB
  credential (Task 5.2).
- **Why VCF persists the ledgers.** VCF runs every clip in its own short process, so in-memory state would be lost
  between calls. The CRM extractor is one long-lived process; that reason does not carry over (§3.2).
- **Provider error bodies stored and logged.** VCF writes up to 200–300 characters of the provider's error body into
  its ledgers and notes. A provider error body can echo the prompt; in the CRM it is never persisted or logged — only a
  classified code (§5).
- **Body-text classification by broad regex.** VCF decides "spent for the day" by matching the body against
  `DAILY_LIMIT`. The CRM classifies by status code plus documented structured error fields of the parsed body (§5).
- **`response_format: json_object` with a retry without it on a 400.** The CRM plan requires strict `json_schema` where
  the route supports it, local Zod validation always, and no code-fence fallback.
- **The Claude CLI executor, images, the WSL gateway resolution, Ollama's native API, the env-supplied model lists and
  the providers that need a card** (VCF already rejects Cerebras and Together; the CRM does not add them either).
- **VCF's local models and its GPU** (§8.1).

---

## 2. How to adopt it: three options

All three keep `ExtractionPort`'s result unchanged and extend its request (`smallDose`, `signal`; §5.4, §5.5).

### Option A — copy-adapt the patterns into `@crm/inference` (recommended)

Re-implement the mechanisms of §1.1 inside `@crm/inference` against its own contracts: `FetchLike` and
`boundedRequest` for transport, `sendChatCompletion` for the OpenAI-compatible call, `runExtraction` for parse + one
correction retry + Zod validation, `InferenceErrorCode` for the public result. VCF's code is the reference, its
constants are the starting values, and each adopted mechanism names its VCF origin in a code comment (provenance, so a
later fix in VCF can be found and carried over by hand).

- **For:** one runtime and one set of conventions (Zod v4, "never throws", bounded transport, no provider host from
  env); the CRM's privacy rules apply from the first line; testable through the package's existing fake-fetch seam; no
  cross-repo coupling.
- **Against:** two copies of similar logic evolve separately; VCF fixes do not flow automatically.
- **Size:** the router core is small (cascade, fit, rotation, floor: VCF does it in under 100 lines); the bulk is
  failure classification and its fixtures.
- **Confidence: HIGH** — the patterns run daily in VCF and the target seam already exists.

### Option B — a shared package used by both projects

Rejected, **HIGH**: runtime mode, storage, error contract and privacy rules all differ, the repo has no publish channel, and
a CRM release would depend on a personal project's.

### Option C — call VCF's executor across processes

Rejected, **HIGH**: CRM production would depend on a personal project and the owner's machine, and vacancy text would cross
into a process that logs provider bodies, outside every CRM gate.

**Decision (proposed): Option A.**

### 2.1 Shape inside `@crm/inference`

> **Superseded in part 2026-11-08 (H.1).** The router has no local route, floor, floor budget or small-dose runner. The
> provider allowlist is `gemini`, `groq`, `openrouter`. The call ceiling is the hosted budget. Rows below that describe
> the local route, `serialLocal`, the floor or the dose are the record of the earlier shape. The modules that stay are
> config, fit, the cascade, state, own caps, the managed lists, the listing, the refresh and the classified leaf.

| Element       | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Config        | `extraction.provider` gains a third value, `router` (additive; `local` and `openrouter` keep their exact behaviour, and `openrouter` is not a router route, D3). The `router` block lists **routes** in priority order. Each route has a provider id (`gemini`, `groq`, `local`), its API key (hosted only), a **pinned fallback** model list (the managed list of §3.4 supersedes it while valid), its context window, its structured-output capability (`json_schema` / `json_object` / none), its minimum call gap and `rotate`. The local route is required and always last; the schema refuses a router config without it. **Superseded 2026-11-08 (H.1):** the route set is `gemini`, `groq`, `openrouter`, and a config that carries a `local` route is refused. Both hosted routes rotate by default: VCF's `rotate: false` on Gemini reserved its allowance for other work, and in the CRM extraction is the only consumer. |
| Hosts         | Package constants, as today (no base-URL env); the local route keeps its env URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Route leaf    | One OpenAI-compatible leaf for every provider, built on `sendChatCompletion` widened to return an **internal classified failure** (§5) instead of collapsing everything into `PROVIDER_ERROR`. Gemini uses its OpenAI-compatible endpoint, which takes `json_schema` with `strict: true` (5.4c-0; the endpoint is in beta).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Router        | `createRouterExtractionAdapter(config, deps)` returns an `ExtractionPort`. Per call: fit filter → rotation among rotatable hosted routes → cascade through hosted routes (full shape) → hand-back → local floor (small dose, §5.4). A whole-call deadline caps the sum of per-attempt timeouts (VCF's `boundExecutor` lesson).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Deps (seams)  | `fetchImpl`, `now`, `sleep`, a `RouteStatePort` (§3.2), an `OwnCapPort` (§3.1) and `onEvent` (§6.2). As with a missing `onEvent` (§5.3), a config with a hosted route and no `OwnCapPort` is refused: an uncapped hosted route is not a state the router can be built in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Public result | The type stays `{ ok: true, data, usage? }` or `{ ok: false, code: InferenceErrorCode }`, plus an optional `usage` on the failure branch, so a failed floor call is still charged to the cycle's limit (§5.5). Internal codes never leave the package, exactly as `MODEL_UNAVAILABLE` does not today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Process       | **The router runs only in the extraction worker**, which holds the hosted keys, `ROUTER_LOCAL_MODEL_URL` and the state files, reaches the runtime, and holds **no DB credential** (Task 5.2). It is not the plan's collection worker, which has a DB role, runs `HtmlProvider` and `ModelStructurer`, and keeps gate, strip, budget, result guard and persistence. The one way in is the entry of §2.4. The API process never builds the router.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Input ceiling | An exported pure helper returns the largest page text the configured **local** route accepts, computed from that route's **configured** window — never a runtime default (Ollama's is 4096 tokens, less than one detail page) — reserving the instruction, the longest group's answer and the correction (§5.1). Its consumer is `buildExtractionPrompt`, which takes it as a limit below `MAX_MODEL_INPUT_CHARS`, cuts the page text itself and reports `truncated`. No chunker exists on main and none is added: each record stays one chunk and one port call. Hosted routes receive the same cut text, so evidence is one text per record.                                                                                                                                                                                                                                                                                       |
| One port      | `InferenceClient` keeps a single `extraction` port over the whole chain. There is no per-source provider set: under D1 and D2 every call that reaches the port may use every configured route. The gate in front of the port decides whether a call happens at all (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The existing `InferenceModelResolverService` (OpenRouter, cheapest model under guardrails, chosen at runtime) stays as
it is for `provider: openrouter`. Under `router` the models come from each provider's self-healing managed list with a
pinned fallback (§3.4), not chosen by price.

### 2.2 What the router does not do

It does not strip contacts, check `ai-input`, build the prompt envelope, reserve the shared 20-call cycle budget, chunk
by record boundary, or check URL grounding. Those stay in 5.4a/5.4b **in front of** the port. The router sees
already-stripped, already-permitted text and returns schema-validated data; the result guard still runs after it.

### 2.3 Provider facts: settled by 5.4c-0, with follow-ups

5.4c-0 settled the open facts from primary sources in `docs/architecture/2026-11-04-extraction-provider-facts.md` (limits
and API behaviour expire 2026-12-04, terms and licences 2027-02-02). What it could not settle is below. Every rule in this
ADR is safe without these answers; an answer replaces a hand-written fixture, and one that lands after 5.4c-1 is applied
then.

| Item                                                                                                             | Settled by                                                               | Owner action |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| Gemini compat error body: Google envelope with `QuotaFailure`, or OpenAI-style                                   | one redacted error in the 5.4c-5 smoke                                   | yes (key)    |
| A free key on a not-free Gemini id (assumed 429, limit 0)                                                        | one redacted call, same smoke                                            | yes          |
| Gemini gone-model answer (404 or re-route), and the response `model` of both `gemini-2.0-flash` and a healthy id | one call to each, same smoke                                             | yes          |
| Gemini compat listing id form; whether compat ignores the same schema keywords as native                         | one listing call; same smoke                                             | yes          |
| Groq per-day token 429 marker; gone-model status and body (`llama-3.1-8b-instant`); `error.type` values          | same smoke, redacted                                                     | yes          |
| Gemini free-tier RPM, TPM and RPD per model (D5's numbers, `PROBE_CAP`)                                          | the owner reads AI Studio's rate-limit page (login)                      | yes          |
| Groq free-plan limits                                                                                            | the owner reads the free organisation's limits page                      | yes          |
| Groq's daily reset time (config assumes midnight UTC, §5.1)                                                      | the owner reads the same limits page                                     | yes          |
| Whether Groq's no-training clause covers free-plan use                                                           | Groq support or Legal                                                    | yes (asks)   |
| `avx512f` on the VPS (vLLM on CPU)                                                                               | `grep -o avx512f /proc/cpuinfo \| head -1`, Master over the D9 ssh alias | no           |
| Ollama's `response_format` type and enforcement, prompt logging, disconnect; llama.cpp disconnect                | MP-04 on the pinned version                                              | no           |
| `gemma-*` id form; licences at the pinned card                                                                   | the listing; MP-04                                                       | no           |

### 2.4 The extraction worker's entry

> **Amended 2026-11-08 (H.3, H.4).** The worker stays, for the reason given here (keys and a DB role never in one
> process). Its runtime network and every local env key go. It now holds the OpenRouter key as well. `/preflight` is a
> readiness check that sends no model request. `LIMITS_EXHAUSTED` passes through the adapter unchanged.

The split puts a network entry in front of the router, with hosted keys and egress behind it and the gates on the far side.
Designed twice (SR-H-46):

| Shape                                                 | Verdict                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** Dedicated network, secret, data-only request  | **Adopted.** It stops everything short of code execution in the collection worker: an SSRF or a compromised renderer has neither the route nor the secret                                                                                                                         |
| **(b)** The invariants inside the extraction worker   | **Stripping adopted, as one step on top of (a).** The gate is not: the `ai-input` signal comes from robots fetched by the collection side, and this worker has neither the DB nor the egress to read it again. A signal supplied by the caller proves nothing against that caller |
| **(c)** No split: the router in the collection worker | Rejected: a process parsing hostile pages would hold keys and a DB role together, against Task 5.2. A queue in place of an endpoint has the same trust and more infrastructure                                                                                                    |

**Confidence: HIGH.** The entry:

- **Network.** A dedicated internal network holding only the two workers, separate from the runtime network, with no published
  port. The collection worker never joins the runtime network; the browser container never joins this one.
- **Authentication.** Every call carries `EXTRACTION_WORKER_SECRET`, held only by these two workers and compared in constant
  time. A missing or wrong secret is refused and reaches no route; a worker without one does not start. One rule binds both
  ends, `isUsableWorkerSecret`: at least 32 characters, at least 8 of them distinct. Both workers read
  their own owner-created `0600` env files, never `.env.production`: the API loads that file through `env_file`, and the
  `write-env` deploy job writes it.
- **Data only, strict schema.** `extract` takes the bounded delimited input from `buildExtractionPrompt` and a table version;
  `preflight` takes nothing and runs the fixed call of §5.3; `/resume-write` takes the task, the caller-redacted facts and the gate feedback. A foreign field is refused, and a version mismatch too (two images
  mid-deploy). No URL, host, provider, model, key, instruction or schema crosses: `EXTRACTION_SYSTEM_PROMPT`,
  `modelReplySchema`, the field-group table and `merge` are one checked-in module both workers import, and the extraction
  worker builds the `ExtractionRequest` from its copy. So this is no general prompt relay in authority, though not in content:
  a secret holder can place a question in `input` and read the answer from a schema field, bounded by the own caps.
- **Second strip.** The extraction worker passes the input through `stripContacts` before any route. On an honest call that
  changes nothing; a non-zero count raises an event, with no text.
- **Reply.** Answer, `usage`, events and health flags (§5.3), recorded on the DB side. The collection side keeps treating the
  reply as untrusted, and the guard stays there. Closing the connection is the abort. The adapter keeps a caller's abort as
  `TIMEOUT`. Its own timer, a non-2xx reply, a transport failure, a malformed envelope and data failing the caller's schema are
  `PROVIDER_ERROR`. §5.4 keeps a record owed on both. A code the worker sends passes unchanged, except `RATE_LIMITED`, which
  becomes `PROVIDER_ERROR`.

**If the collection worker itself is compromised (code execution), this much holds and this much does not:**

- **Holds:** no route receives text that `stripContacts` would change. The hosted keys stay unreadable, and the caller chooses
  no host, model or instruction. Use is bounded by the own caps, and cost by free tiers with no billing (§3.1).
- **Does not hold:** `ai-input=no`. That code holds those pages' text and can submit it as input, up to the own caps. The same
  goes for what the worker's DB role can read beyond pages: users, team memberships and legacy résumé inputs. Nor
  does stripping stop a contact deliberately obfuscated past its patterns. This entry cannot fix either: that process already
  has the text and the outbound web access it fetches with (plan Task 2.2), so it needs no router to leak. Its protection is
  that worker's own hardening and egress proxy.

---

## 3. Data and secret model

### 3.1 Where each kind of state lives

> **Amended 2026-11-08 (H.4).** `OPENROUTER_API_KEY` joins the hosted keys the extraction worker reads, and it is
> forbidden to the router everywhere else. The local URL, model name and key rows no longer apply.

| State                                                                                                                                                                                                                 | Lifetime                                                                      | Where                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider API keys (`GEMINI_API_KEY`, `GROQ_API_KEY`; `LOCAL_MODEL_KEY`, `LOCAL_MODEL_NAME`, and a new `ROUTER_LOCAL_MODEL_URL` (§3.3); the router never reads `LOCAL_MODEL_URL` or the existing `OPENROUTER_API_KEY`) | process                                                                       | **Optional env keys in the API env schema, read only by the extraction worker.** Absent key → that route does not exist (VCF: "a provider without a key simply does not take part"). Never in the router config schema's persisted form, a manifest, the DB, a build layer, a report, a log or an error message. Never named `CLOUDFLARE_*` (C-21). | Task 5.2 rule; existing `buildInferenceConfig` pattern (a provider block exists only when its key is present)                                                                                                                                                                                                                                    |
| Per-provider minimum gap (`nextFreeAt`)                                                                                                                                                                               | seconds                                                                       | **Process memory**, inside the leaf                                                                                                                                                                                                                                                                                                                 | Per-minute limits are per key; one process holds the key                                                                                                                                                                                                                                                                                         |
| Rotation counter                                                                                                                                                                                                      | process                                                                       | **Process memory**                                                                                                                                                                                                                                                                                                                                  | VCF's design; losing it on restart costs nothing                                                                                                                                                                                                                                                                                                 |
| **Own caps** — our calls per provider per provider-day                                                                                                                                                                | provider day                                                                  | **Worker state file**, through an `OwnCapPort` adapter over the `RouteStatePort`; limits frozen in config under a policy version                                                                                                                                                                                                                    | The worker has no DB credential, so `job_account_meters` is out of its reach; one writer needs no atomic DB guard. A lost file resets the count, and the provider's own limit (`SPENT_DAY`) is then the backstop. That is a hard stop because **both keys are on free tiers with no billing** (5.4c-5): the provider refuses, it does not charge |
| **Spent** — "the provider said: no more today" for a model                                                                                                                                                            | until the provider's reset (UTC; Pacific for Gemini)                          | **Worker state file**, write-through behind a `RouteStatePort` (§3.2)                                                                                                                                                                                                                                                                               | Survives restarts without a DB credential                                                                                                                                                                                                                                                                                                        |
| **Retired** — "the provider said: this model is gone" (`retiredAnswer`)                                                                                                                                               | until the next successful daily refresh (§3.4) — **not** cleared by a restart | **Worker state file**, same port                                                                                                                                                                                                                                                                                                                    | Owner decision D6: retirement must hold across restarts until the fresh probe, the authority, clears it                                                                                                                                                                                                                                          |
| **Provider-level bits** — `AUTH`, `CREDIT`                                                                                                                                                                            | `CREDIT` until the limit's reset; `AUTH` until the proof of §3.2              | **Worker state file**, same port                                                                                                                                                                                                                                                                                                                    | REV-L-10: a restart or a crash loop no longer re-spends a refused request                                                                                                                                                                                                                                                                        |
| **Managed model list** — the self-healed ordered model ids per provider                                                                                                                                               | until the next successful refresh of that provider                            | **Worker managed-list file** (§3.4), read with the pinned list as fallback                                                                                                                                                                                                                                                                          | Owner decision D6                                                                                                                                                                                                                                                                                                                                |
| Usage / cost per call                                                                                                                                                                                                 | permanent (metering)                                                          | Returned with the answer and committed by the caller's budget — never stored by the package                                                                                                                                                                                                                                                         | §6.2                                                                                                                                                                                                                                                                                                                                             |

**The `OwnCapPort` and the shared 20-call cycle budget are different things.** 5.4b reserves one slot of the
cross-provider cycle budget per extraction; the own cap is a per-provider daily ceiling consulted per **attempt**,
before a request is spent on a provider. A router call that cascades across both hosted providers uses one cycle slot
and one own-cap unit per HTTP request it sends, retries included (unit rules: §5.1). A small dose stays inside that one
slot, however many field groups it asks (§5.4).

### 3.2 Route state (spent, retired, provider bits): where it persists

D6 (owner, below) requires retirement to hold across restarts until the daily refresh clears it, so plain process
memory — the first edition's recommendation — no longer suffices.

| Option                                                            | For                                                                                                                                                                                                                                                                       | Against                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Worker state file, write-through (recommended)**                | Survives restarts; needs no DB credential (the worker has none, Task 5.2) and no new service; one small JSON document on the worker's persistent data volume, beside the managed-list file (§3.4); the in-memory map stays the read path, every change is written through | Not shared by a second worker replica; needs a persistent volume (task 5.4c-8 provisions it)          |
| Postgres table (rows with the reason as a **code**, never a body) | Shared across replicas; consistent with "per-host/account state shared through PostgreSQL" in r5                                                                                                                                                                          | A Drizzle migration (critical path); needs a DB credential or an API-side endpoint in the worker path |
| Redis keys with a TTL at the provider's reset                     | Expiry is free; Redis already runs                                                                                                                                                                                                                                        | A second store for one feature; the worker would need Redis access                                    |
| Process memory only                                               | Smallest                                                                                                                                                                                                                                                                  | **Fails D6**: a restart forgets retirements before the refresh has replaced the list                  |

**Recommendation:** the worker state file behind the `RouteStatePort`, so a Postgres adapter can replace it without
touching the router if a second replica appears. Owner decision D4 (A2), narrowed by D6 to "which persistent store".
**Confidence: HIGH** for the port, **MED** for the file (depends on the volume task 5.4c-8 provisions).

**State-file rules** (the same for the managed-list file):

- **Data, not code.** JSON validated by a Zod schema on every read; never imported, evaluated or used as a path. An
  unreadable, invalid or oversized file is treated as empty state (for the managed list: the pinned fallback), and the
  event says so, an own-cap reset included.
- **Written before sending.** A failed write-through of an own-cap unit refuses that request, exactly as a refused unit does
  (§5.2 step 4). Any other failed write stays in memory and raises the event.
- **Schema, strictly bounded** (SR-M-6):
  - every entry has **structured fields** `provider` and `model` — never one joined `provider:model` string, because
    a model id may itself contain `:`; log lines may print the pair, the file never parses it back;
  - `provider` is an enum of the checked-in provider allowlist; `model` must pass the **same** model-id validation as
    the refresh (§3.4), so a hand-edited or corrupted file cannot smuggle in an id the refresh would have refused;
  - `code` is an enum of the internal codes, `status` an integer 100–599, timestamps ISO strings, the provider day a
    `YYYY-MM-DD` string;
  - an **entry cap** per file (spent and retired: 300; the managed list: `TARGET` per provider; probation and busy records:
    `MAX_MODEL_RECORDS`, 11 per provider; `busyDead`: 50) and a byte ceiling checked **before** parsing (64 KiB); over either ⇒
    treated as invalid. A change that would pass the ceiling is refused: no memory change, no write, `STATE_WRITE_FAILED` with
    reason `oversized`;
  - **probation records** (SR-M-9) live in the **route-state file**, not in the managed-list file: per new model,
    `provider`, `model`, `aliveStreak` (an integer, schema-bounded to `[0, N]`, clamped on write) and `lastProbeDay`
    (the UTC day of the last probe that counted). The managed-list file stores only the ordered ids; it carries **no**
    promotion flag that the reader would trust (§3.4);
  - **busy records** (§3.4 verdicts) live in the same file, per probed Gemini model, listed or new: `provider`, `model`,
    `busyDays` (an integer, schema-bounded to `[0, 3]`, clamped on write) and `lastProbeDay`;
  - **provider records**: the persisted `AUTH` / `CREDIT` bits and `lastStartupRefreshAt` (SR-M-11), and the own-cap count per
    provider day, written through **before** the request is sent.
- **Single writer.** Only the extraction worker writes, and inside it one serialised writer (a promise queue) owns each
  file: every change is applied to the in-memory state and the whole document is written from it, so two concurrent
  changes cannot lose each other. A second worker replica is out of scope for files (D4: Postgres then).
- **Durable atomic replace**: write a temporary file in the same directory with mode `0600`, `fsync` it, rename it over
  the old file, then `fsync` the directory; a crash at any point leaves either the old or the new file, never a torn
  one. The files live on the worker's own volume, never on a shared or world-readable path.
- **Contents**: the fields above. **Never** a provider error body. VCF stores up to 300 characters of the body as the
  reason; the CRM stores the classified code instead, because a provider body can echo the prompt (§4 item 2). This is
  the one deliberate departure from the VCF `RetiredStore` behaviour (`isRetired` / `markRetired` / `list` / `clear`
  are otherwise adopted).
- **Pruning**: spent entries of past provider days are dropped on load.

**The restart caveat, reduced (REV-L-10, SR-M-7, SR-M-11).** `AUTH` and `CREDIT` persist, so a restart or a crash loop
does not re-send a refused request. What clears each bit is narrow, because the wrong proof would re-open a refused
route:

| Bit      | Cleared only by                                                                                                                                                                  | Not cleared by                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `AUTH`   | a **keyed chat probe** to that provider that returns 2xx (the fixed probe prompt, the shared request builder) — this applies to Groq too, which the daily refresh does not probe | a successful listing fetch: a listing that answers proves nothing about a chat call |
| `CREDIT` | the limit's reset; for OpenRouter, whose prepaid balance never resets, a keyed chat probe that returns 2xx (as `AUTH`)                                                           | a refresh that sends no chat probe                                                  |

**Start-up refresh.** At worker start, every provider carrying a persisted `AUTH` bit, or OpenRouter carrying a persisted `CREDIT` bit (§3.5), gets an on-demand refresh of that
provider alone, under the constraints of the daily one, so a rotated key is picked up at the next start rather than up to
a day later. It differs from the daily job in one way: it **sends exactly one fixed-prompt chat probe** to that provider,
Groq included, because that probe is the only proof that clears the bit. The one case with no probe: every id on the list is
held as `busyDead`, so there is nothing to probe, the outcome is failed with `NOTHING_SURVIVED`, and the bit stays until a due
re-probe. It is **rate-limited by a persisted
per-provider `lastStartupRefreshAt`**: if the last start-up refresh of that provider is less than **1 hour** old, the
start skips it, so a crash loop sends at most one start-up refresh per provider per hour regardless of the restart
policy. The own-cap unit is still released for these codes (§5.1), and start-up probes count against the own caps like
any probe.

### 3.3 Transport and key hygiene

> **Amended 2026-11-08 (H.1).** `ROUTER_LOCAL_MODEL_URL`, the narrow plain-HTTP allowance for the runtime container and the
> private-address HTTPS case go with the local route. Every route is now a package-constant HTTPS host.
> `https://openrouter.ai/api/v1` is the third. The one request builder carries the OpenRouter routing fields of §3.5.

- **Hosted hosts** are HTTPS package constants; no env or config can point a hosted route elsewhere.
- **The local URL** comes from a new env key, `ROUTER_LOCAL_MODEL_URL`, validated when the config is parsed: no
  credentials in the URL; plain `http` **only** to loopback or the runtime's container name, a **package constant**, not
  env; `https` to loopback, that name, or a private address (RFC 1918, fc00::/7). Refused: link-local (169.254.0.0/16, which
  holds cloud metadata, and fe80::/10), IPv4-mapped forms, any other name or address. Anything refused ⇒ **the whole router
  is `NOT_CONFIGURED`** and no hosted route runs (§8.5), never a request to an arbitrary host.
- **Plain HTTP stays narrow.** Today two gates refuse `http://<container>`: `isUrlAllowed` in `boundedRequest` and the
  refine on `LOCAL_MODEL_URL`, which `validateEnv` enforces at boot. `LOCAL_MODEL_URL` and `allowLoopbackHttp` are **not**
  widened. `boundedRequest` gains a separate option naming the one constant host, set only by the local leaf; a test asserts
  hosted and `openrouter` calls still refuse HTTP.
- **TLS verification is never disabled.** HTTPS to a private address (§8.5) that needs a private CA gets that CA configured
  for the local route; neither a relaxed `rejectUnauthorized` nor `NODE_TLS_REJECT_UNAUTHORIZED` is acceptable.
- **Redirects are refused**: every request goes through `boundedRequest`, which already sets `redirect: 'error'`; the
  router adds no transport of its own.
- **Keys travel in headers only** — `Authorization: Bearer` for OpenAI-compatible endpoints, and if a native Gemini
  leaf is ever needed, the API-key header, **never** a `key=` query parameter (URLs end up in logs and errors).
- **Keys never appear in** `onEvent` payloads, thrown or returned values, internal codes or notes; a 5.4c-1/5.4c-2 test
  seeds a marker key and asserts it is absent from every event and result.
- **One request builder for every hosted chat request** (SR-H-2). Production calls, refresh probes and chain-check
  probes all go through the same builder, so a probe can never differ from production in anything but its prompt and its
  small `max_tokens` (§8.4). Gemini and Groq carry no mandatory privacy field in the first version (§4 item 3). A test
  asserts every other non-prompt field identical on production, probe and chain-check bodies.
- **Listing fetches** (SR-M-8) follow the same transport rules: fixed HTTPS URLs that are package
  constants (no id, query or user value interpolated); `boundedRequest` with its size cap and `redirect: 'error'`; the
  key in a header only (for Gemini the API-key header, **never** a `key=` query parameter); the body parsed by a Zod
  schema that caps the number of entries read (entries beyond the cap are ignored and counted) and the length of every
  field before any id validation runs.

### 3.4 Model lists: self-healing, with a pinned fallback (owner decision D6)

**Owner decision, 2026-11-03:** the available-model list **must self-heal** after a model dies, by the VCF mechanism.
This replaces the first edition's "pinned, alert only, never rewrite". It amends the plan's "pinned
model/provider/runtime config" for hosted model ids: what stays pinned is the **provider allowlist**, the hosts, the
local runtime and model digest (§8; the local model is never self-healed) and a **fallback model list** per hosted
provider; the hosted model ids in use become managed data. (Master records the amendment in the plan.)

**With two hosted providers (D3)** the mechanism holds, with one change in what backs it: VCF's chat-probed refresh runs
on OpenRouter, its Groq path is listing-only, and it has no Gemini refresh at all. In the CRM, **Gemini is therefore the
only provider the daily refresh chat-probes**, and that path has not run anywhere yet.

Three layers, adopted from VCF in this order of authority:

**1. Request-time retirement (immediate).** A response classified `RETIRED` (`retiredAnswer`: status 404 and a body
naming a model or an endpoint; or, for Gemini, a 2xx re-routed to another version or variant, §5.1) marks the provider and
model retired through the
`RouteStatePort` (persisted, §3.2). The current call moves to the next model at once; every later call skips the model
until the next successful refresh.

**2. Daily refresh (repair).** A daily timer inside the extraction worker (main has no scheduler to reuse), run
some time before the collection window so a fresh list is in place — rebuilds each provider's list:

| Provider | Source of candidates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Probe                                                                                                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Groq     | the models listing, **active** entries with their context (`pickGroqModels`: keep current ids still listed, add at most one largest-context chat model; non-chat ids such as speech, guard or TTS models excluded). **CRM restriction (SR-H-1):** because Groq additions are never chat-probed, an addition must also match the **checked-in Groq family pattern** `^openai/gpt-oss-(20b\|120b)$`: the two production models with strict `json_schema`. The other two strict models are preview, which Groq says may be discontinued at short notice; admitting them is a reviewed pattern change after MP-03. The pinned fallback list is those two ids | no chat probe — availability comes from the listing (VCF: its problem is rate limits, not staleness)                                                                                                                                                                                                                    |
| Gemini   | the models listing, ids after stripping `models/`, filtered by the **checked-in Gemini family pattern** `^gemini-[0-9]+(\.[0-9]+)?-(flash\|flash-lite\|pro)(-preview(-[0-9]{2}-[0-9]{4})?)?$`. The listing has no free-tier field, so a not-free id can match; the three-day rule below drops it                                                                                                                                                                                                                                                                                                                                                         | yes: the current list first, then the largest-context new candidates, at most `PROBE_CAP`, with a pause between probes. VCF's value of 10 was sized for another provider's daily limit; the CRM's comes from Gemini's free limit, which the owner reads (§2.3), small enough that probes do not eat the day's allowance |

- **Verdicts** (`classifyModelStatus`, adopted as-is): 2xx ⇒ `alive`; 404 ⇒ `dead`; 429/503 ⇒ `transient` (kept — busy is not
  rotten); timeout, network error or any other status ⇒ `unknown`, **never** `dead`. CRM additions: `AUTH` on the listing
  fetch or a probe ⇒ that provider's refresh **fails** and its previous list is kept. A Gemini model whose probe answers a
  429 **without** a per-day quota id on **three consecutive probe days** is dropped as `dead`: by forum reports, a free key
  calling a model it cannot use gets 429 `RESOURCE_EXHAUSTED` with a limit of 0, which would otherwise read as busy forever.
  A model already `SPENT_DAY` today, or with an `OK` call since the last refresh, is not probed: a no-probe day, which
  neither increments nor resets the count. The count lives per provider and model in the route-state file (§3.2), for listed
  models and candidates alike, bounded to `[0, 3]`. One redacted call in the 5.4c-5 smoke confirms the shape; if the body
  marks the zero limit in a structured field, 5.4c-1 classifies it at request time instead. Only that busy 429 counts: a 503 is
  `transient` and ends the run, as does any other answer.
- **`busyDead` hold.** The third busy day stamps the model in the `busyDead` record (`applyProbeDay`), and its busy and probation
  records go. A stamped model stays off the list and out of the candidates; seven days later `isBusyDeadReprobeDue` makes it a
  candidate behind the unheld ones. Alive clears the stamp and starts probation at streak 0; anything else stamps it again. The
  record holds the newest 50 (`MAX_BUSY_DEAD_ENTRIES`); dropping the oldest returns it to the queue and restarts its count.
- **The rest of the non-alive candidates.** `restNonAlive` stamps every model that answered non-alive, other than a busy 429, and
  is not on the list the run serves, and removes its probation record, so a candidate that keeps failing gives its probe slot
  away. A listed entry answering 404 that leaves while another survives rests too. A transient or unknown entry still listed
  stays unstamped. When nothing survives, the caller passes the unchanged list, so nothing listed rests.
- **Selection — VCF's `pickLiveModels` with a CRM ordering change (SR-H-1).** Drop `dead` and every model under
  `MIN_MANAGED_CONTEXT` (a fixed 16 000 tokens, VCF's value). The intent is at least the local chunk size, so every managed model
  fits every chunk, but nothing derives or checks that relation: the `shortcut:` comment on the constant waits on 5.4c-6, which has
  landed, and a local chunk size above the floor would break the guarantee silently. Keep `TARGET` (VCF: 5). A promotion at a
  full list pushes the tail entry off with no protection for a pinned id: a pinned id has no probation record, so it cannot
  re-promote through the refresh and returns only as a tail candidate; while listed, the reader orders it as promoted. An evicted
  non-pinned entry keeps its full-streak record, so its next alive probe is no new promotion and cannot retake the head. VCF ranks by status then context, which would put a brand-new, unreviewed,
  large-context candidate **first** for all vacancy text. The CRM instead:
  - keeps **existing** entries in their current order (dropping the dead), and **appends** new candidates at the
    **tail**, below every existing entry, ranked among themselves by status then context;
  - **promotes** a new entry above older ones only after it has been `alive` on N consecutive **probe days** (N = 3
    proposed, a package constant). The streak is the probation record in the route-state file (§3.2), bounded to
    `[0, N]`. Rules (SR-M-9):
    - a **probe day** is a UTC day on which that model was actually probed; the streak increments by one on an `alive`
      probe day only if `lastProbeDay` is an earlier day (a second probe on the same day counts once), and resets to 0
      on a `transient` or `unknown` probe day;
    - a **no-probe day** — the model was not reached under `PROBE_CAP`, the provider was skipped (cap refusal, `AUTH`,
      fetch failure) or the job did not run — neither increments nor resets the streak;
    - the reader **recomputes** promotion, never trusts it: an entry is ordered as promoted only if it is in the pinned
      fallback list or its probation record shows `aliveStreak == N`; an entry without a valid record is on probation.
      A promotion emits an event naming provider and model, so it is visible;
    - **the daily refresh never chat-probes Groq**, so a Groq addition never earns a streak: it stays on probation (tail)
      until a human adds it to the pinned fallback list by a reviewed change. Only a Gemini entry can be promoted by the
      refresh; the weekly chain check earns no streak;
    - until promotion an entry serves only when every older model of that provider failed (see Consequences: in
      practice that is routine on free tiers);
  - uses an **effective context** of `min(provider-reported context, the route's configured context window)` for every
    filter and ranking — a provider-reported number is untrusted input and can never widen what the route accepts.
- **Never wipe.** If the listing fetch fails, or nothing survives, that provider's managed list is **left untouched**
  and the provider counts as failed.
- **Retirement reset, per provider (SR-M-5).** VCF clears every retirement only when every provider refreshed; one
  failing provider would then block every other provider's recovery. The CRM clears a provider's retired entries on
  **that provider's own** successful refresh (its `AUTH` bit clears only by the narrower proof of the §3.2 table, never
  by the refresh's success alone) — the fresh probe of that provider is the authority (VCF: "one still really gone costs
  one request tomorrow, then is retired again"); for Groq the fresh listing is, as in VCF. A provider that is not
  configured (no key) is **skipped**, not counted as failed.
- **Independent providers**: one failing never blocks another. The job's result is **failed** if any provider failed
  (VCF: exit 1), which raises a health event; the log lists provider, model ids and verdicts only — never a key, never a
  probe or provider body.

**3. Weekly chain check (secondary signal).** VCF's `checkModelChain` is kept as a separate, cheaper check: one minimal
probe of every hosted model currently in use, Groq's included, with the same verdict rules. Any `dead` entry raises the
durable health flag `MODEL_LIST_STALE`; a run with no dead entry clears it, and so does a successful daily refresh that
has removed every entry the flag named (the repair heals the signal). It alerts; it never edits a list — repair is layer
2's job. Its probes obey **every** constraint below exactly as the refresh probes do (SR-M-3): the fixed synthetic
prompt, the shared request builder, the provider allowlist, the own caps, the transport rules of §3.3; and they carry
the same tests (§6.1).

**The managed list is read** per provider through a `managedModels(provider, fallback)` reader: the managed-list file's
entry for that provider if it is valid and non-empty, else the **pinned fallback list** from the package config. A
missing, empty or invalid file therefore degrades to the first edition's behaviour, never to an empty chain.

**Constraints the refresh must hold** (the privacy and security surface of self-heal):

- **Probes carry only a fixed synthetic prompt** — a package constant in VCF's form ("reply only with JSON
  `{"ok":true}`") — never vacancy text, never a page, never anything read from the DB. A test asserts the probe request
  body equals the constant plus the route's fixed fields.
- **Probes are built by the shared request builder** (§3.3).
- **Providers come only from the checked-in provider allowlist** (`gemini`, `groq`), and only those that are configured
  (key present). A listing cannot introduce a provider.
- **Model ids are untrusted input** from a hosted listing: each is validated **before** it is probed, stored or logged;
  a failing id is dropped and counted. Ids are only ever sent as the JSON `model` field, never placed into a URL or a
  path. The pattern (SR-H-1):
  - common to all providers: letters, digits and `. _ - /` and at most one `:`, bounded length (128), no leading `/`,
    no `..`, no whitespace or control characters, no URL scheme;
  - **Groq**: the checked-in family pattern of the table above;
  - **Gemini**: the checked-in family pattern of the table above.
- **Probes count against the own caps** (`OwnCapPort`, unit rules of §5.1): a provider whose cap cannot reserve a probe
  is skipped for the day and keeps its list.
- **Rollback of self-heal alone**: deleting the managed-list file returns every provider to its pinned fallback;
  disabling the job stops repairs while request-time retirement still works.

**Confidence: HIGH** for the mechanism and the Groq path (VCF runs them daily); **MED** for the Gemini path (a chat-probed
refresh and a pattern standing in for the missing free-tier field are not in VCF).

### 3.5 OpenRouter route: free models only (built — Amendment 2026-11-08; was "deferred", D3)

> **Restored and amended 2026-11-08.** D3 is superseded (§4.3). The specification that was kept here for restoration is
> now the build spec, narrowed where the facts of 2026-11-08 allow. Confidence: HIGH for the guard's shape, MED for the
> exact OpenRouter field names and markers until the 5.4c-5 smoke confirms them by fixture.

- **Route.** Provider id `openrouter`, base URL the package constant `https://openrouter.ai/api/v1`. The key is the
  existing `OPENROUTER_API_KEY`, read only by the extraction worker (H.4). §3.1 otherwise forbids the router this key.
- **A paid model can never be selected. Four independent checks**, any one of which is enough to refuse:
  1. **Id shape.**
     - A requested id is exactly `<author>/<model>:free`. This narrows the earlier "plain or `:free`": every free entry
       of the 2026-11-08 catalogue except `openrouter/free` carries the suffix, so nothing usable is lost.
     - Any other suffix is refused: `:online` forwards the prompt to a web search; also `:extended`, `:nitro`, `:floor`,
       `:thinking` and any future one.
     - Every id whose author is `openrouter` is denied (`openrouter/auto`, `openrouter/free`). These are meta-routers
       that choose the upstream themselves.
     - The check runs in `isValidProviderModelId('openrouter', id)` on the pinned list, the managed list and every listing
       entry before it is probed, stored or logged (§3.4).
  2. **Catalogue price.**
     - From `GET /api/v1/models`, a candidate needs **every** field of `pricing` to parse as the number 0. A missing,
       blank or non-numeric price is not free.
     - The existing `fetchOpenRouterCatalog` reads `pricing.prompt` only; the router's listing reads them all.
     - A candidate must also list `structured_outputs` in `supported_parameters`. That drops the two Gemma models, which
       offer `response_format` only. `MIN_MANAGED_CONTEXT` applies as for the other providers.
  3. **Request fields** on production, probe and chain-check requests alike, from the one request builder (§3.3):
     - `provider.max_price` with every price 0;
     - `provider.require_parameters: true`;
     - `provider.data_collection` from the route's `dataCollection` value (D11: `allow`);
     - `provider.ignore` from config (OD-2: empty).

     Never a `models` fallback array, a `route` field or `transforms`: each would let OpenRouter pick a model this guard
     did not check. A builder that cannot produce these fields disables the route; it never sends without them.

  4. **The key's USD `limit` is $0** (an owner setting; the key showed `limit: 0` on 2026-11-08). Even if the three checks
     above failed, a paid request has no spend to draw on. The 5.4c-5 smoke confirms that `:free` calls succeed under a $0
     limit with a positive credit balance, because the probe's 200s on 2026-11-08 suggest it but do not prove it.
- **Limits.**
  - `freeLimit.requestsPerDay` is 1000. That is OpenRouter's `:free` limit once at least $10 of credits were bought; the
    owner bought exactly $10. So the own cap is 500 (D5).
  - `minGapMs` is 3000, under the ~20 requests a minute that `:free` models allow.
  - `PROBE_CAP` stays 10. Probes count against the own cap (§3.4).
  - A negative credit balance makes OpenRouter answer 402 even on free models. That is `CREDIT` below.
- **Classification** (§5.1, one table, bounded structured fields, never page text):
  - **`FLAG_REJECTED`** is classified **before** `RETIRED`, or it retires good models. It covers a 404 whose
    `error.message` reports that no endpoint matches the data policy, and a 400 that refuses a routing parameter. The
    call moves to the next route; it is never retried without the flag, and the own-cap unit is released.
    - On a production request, it sets a persisted provider bit. A 2xx probe clears it, and the probe must carry every
      production field to the model the bit was recorded against (or the current first model, if that one is retired).
      The start-up refresh can be that probe.
    - On a probe, that model becomes ineligible, and the provider bit is never set.
  - **`SPENT_DAY`**: a 429 whose `error.message` holds the whole token `free-models-per-day`. The model, and with it the
    provider (the limit is per account, not per model), is spent until the reset.
  - **`BUSY`** with a cool-down: a 429 with `free-models-per-min`, or an upstream 429 without either marker. One wait,
    never a loop (§5.2).
  - **`CREDIT`**: a 402, or the key's limit reached. The provider is off until the bit clears, and the event is loud.
    A prepaid balance never resets, so for OpenRouter the bit is cleared the way `AUTH` is (§3.2): a keyed chat probe
    that returns 2xx, at the start-up refresh or the daily one. The owner tops up or raises the key limit; the next
    probe brings the provider back.
  - **`AUTH`**: a 401, or a 403 with the documented error envelope.
  - **`RETIRED`**: a 404 that is not `FLAG_REJECTED` goes to `retiredAnswer` (request-time retirement, §5.1), unchanged.
- **Egress.** `openrouter.ai` only, listing included.
- **Tests that come with it** (5.4c-H1):
  - hostile ids: suffixes, the `openrouter` author, path tricks, case;
  - the free filter, including a price present as `"0.0000001"`, missing or `null`;
  - the request-field assertion on all three request kinds;
  - a disabled route when a field cannot be built;
  - classification fixtures for each marker above, and a literal "free-models-per-day" in a page-echoing message that
    must not match outside `error.message`.

The existing single-route `openrouter` value of `extraction.provider`, its adapter and its `data_collection: deny` are
unchanged. The router does not reuse that adapter, so the D11 `allow` does not leak into it.

---

## 4. Privacy constraints that hold for EVERY route

These hold for the local route too; none of them depends on which route answers.

1. **Before the router, always** (5.4a/5.4b, unchanged, in the collection worker): `ai-input=no` ⇒ the port is never called;
   `unspecified` follows an explicit policy argument; contacts stripped (emails, phones, messengers, profile URLs); page text
   only inside the delimited data block of the user message; input capped. The router's one entry from there is the extraction
   worker's (§2.4): authenticated, data-only, with a second `stripContacts`. The `ai-input` gate cannot be re-checked at that
   entry, and rests on the collection worker's integrity; §2.4 states what that means.
2. **The router logs and stores no text.** Not the input, not the model output, not a provider error body (it can echo
   the prompt). Events and notes carry route, model, internal code, HTTP status, counts and timings only. This is
   stricter than VCF.
3. **No per-request privacy flag exists** (5.4c-0). Gemini's and Groq's privacy rests on their published terms, which the
   owner has accepted (§4.1, §4.2). Groq offers zero data retention as an **organisation setting**, not a request field;
   turning it on is an optional owner action in 5.4c-5 and does not bring back the refusal handling of §3.5.
4. **What the free tiers do with prompts.** Gemini's unpaid tier uses prompts and answers to improve Google's products,
   with human review. Groq's terms forbid training on inputs and outputs, though they do not say whether that covers
   free-plan use; Groq may log them for up to 30 days for troubleshooting or abuse. Even after contact stripping, the text
   is a third party's published page. The owner has accepted that for every source the gates admit (D2); the risk is stated
   once, in §4.1.
5. **Egress** only to the pinned provider hosts (Task 5.2: "egress allowed to the provider host only"), widened per
   added provider.

### 4.1 Which sources may use hosted routes — owner decision D1 (decided 2026-11-04)

**Decided: every source for which the model can do the task may use the hosted routes.** "Can do the task" means the
call reaches the port at all: the record needs a field that deterministic extraction did not produce (Task 5.5, stage C)
and the gates of item 1 above admit it. This replaces the recommended per-source allowlist with default local-only;
there is no per-source flag, no provider set per source, and reading a source's terms is no longer a precondition per
source.

**Never weakened:** `ai-input=no` blocks **all** routes, the local one included; `unspecified` follows the explicit
policy argument; contacts are stripped before any route. These run before the port (item 1), so no router configuration
can bypass them.

**The residual risk, accepted by the owner on 2026-11-04.** The text of third-party pages, after contact stripping, is
sent to free-tier providers that may retain it, train on it and have humans review it. Stripping removes the listed
contact shapes and nothing else, so names and other personal details written in prose can go out with the text. No
source's terms are read before its text is sent, so a source whose terms restrict such reuse is sent all the same unless
its signal says `ai-input=no`. Text once sent cannot be recalled; removing a key stops further sending only.

### 4.2 Providers whose free terms allow training or human review — owner decision D2 (decided 2026-11-04)

**Decided: yes.** Such providers may receive vacancy text after stripping, whether or not research confirms the belief
about the Gemini API's unpaid tier. No field or filter gates this: the per-source training flag of the earlier edition
is removed, and the caller passes no provider list. What remains of the Legal read in 5.4c-0 is one informational note
on each provider's free-tier data terms, with a source and an expiry date. It feeds **no gate**; it keeps the accepted
risk of §4.1 accurate, and a material change in those terms goes back to the owner.

### 4.3 OpenRouter — owner decision D3 (decided 2026-11-04)

> **Superseded 2026-11-08 (owner decision; Amendment 2026-11-08).** OpenRouter is a route, free models only (§3.5). The
> `data_collection` question is answered by D11: `allow`, which makes contact stripping load-bearing on every hosted route
> (H.9). The text below is the record of the 2026-11-04 decision.

**Decided (2026-11-04, superseded): OpenRouter is not enabled in this version.** The first router version has Gemini,
Groq and the local floor, which narrows the owner's decision of 2026-10-18. The question of keeping
`data_collection: "deny"` against an empty free pool is moot for now and is re-decided if OpenRouter is added (§3.5).

---

## 5. Failure semantics

### 5.1 Classification (internal codes; one table for every hosted leaf)

> **Amended 2026-11-08 (H.1, H.6, §3.5).** The table holds for Gemini, Groq and OpenRouter, with three changes.
>
> - OpenRouter adds `FLAG_REJECTED`, classified before `RETIRED`, and documents `CREDIT` as a 402 (§3.5).
> - `PROMPT_TOO_LARGE` and every mention of the local floor are withdrawn with the local route.
> - `FLAG_REJECTED` releases its own-cap unit.

Classification uses the HTTP status first, then the **whole** error body, parsed as JSON, of which only the provider's
**documented structured error fields** are read, plus its rate-limit headers — never the page text, never a free-text
regex over the body. A prefix cut is not used: a real Google error with three quota violations, pretty-printed, runs
past 2 000 characters and would stop parsing. The body is already capped at 2 MiB by `boundedRequest`; a body over the
cap or not parsable is read as having no marker: a 429 is `BUSY`, never `SPENT_DAY`; a 403 is `TRANSPORT`, never `AUTH`;
a 404 is `TRANSPORT`, never `RETIRED`. Each rule reads one fixed place, never anywhere in the body, because a provider body
can echo request content: a Gemini 429's per-day marker only from `error.details[]` (from the first element's when the
compat endpoint wraps the envelope in a list; Groq's comes from headers); the 403 rule only Gemini's `error.status` or
the shape of Groq's `error` object, never `details`; the 404 rule only `error.message` and `error.code`. The body is
discarded after classification.

| Internal code      | Signal (fixtures from 5.4c-0's error table)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Router action                                                                                                                                                                                                                                                                                                                   | Ledger                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `OK`               | 2xx, envelope valid, output passes Zod after at most one correction retry (`runExtraction`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | return                                                                                                                                                                                                                                                                                                                          | own cap committed                                                                                                    |
| `BUSY`             | 429 without a per-day marker, including Groq's per-day token 429, which has none; 503                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | a short bounded backoff on the same model (VCF Gemini: 9 s, 25 s) **only if** the call deadline allows; a `retry-after` (Groq) or `retryDelay` (Gemini) longer than that puts the model in a **cool-down** until it elapses, in process memory; then next model / next route. At most one wait per model per call, never a loop | none                                                                                                                 |
| `SPENT_DAY`        | 429 with a per-day marker. Groq: `x-ratelimit-remaining-requests` exactly `0` (the request headers always mean per day, documented). Gemini: a `QuotaFailure` quota id containing `PerDay` (secondary; if the compat body lacks it, the 429 is `BUSY` and the own caps hold)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | next model / next route                                                                                                                                                                                                                                                                                                         | model spent until the provider's reset                                                                               |
| `CREDIT`           | 402 / insufficient credit. Gemini and Groq document none (5.4c-0); OpenRouter does (§3.5), and its bit clears by a keyed 2xx probe (§3.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | next route                                                                                                                                                                                                                                                                                                                      | whole provider spent until the limit's reset (OpenRouter: until the bit clears, §3.2); a loud event (limit pause)    |
| `RETIRED`          | 404 naming the model or an endpoint (`retiredAnswer`; "naming" means `error.code` is `model_not_found`, or `error.message` holds the requested id as a whole token, bounded by characters outside `[A-Za-z0-9._-]` or the string's ends, and an empty id never matches; a bare 404 is `TRANSPORT`, so a wrong base URL never retires everything). **Gemini re-route:** a 2xx whose response `model`, after stripping `models/`, matches the Gemini family pattern with a **different version or variant capture** than the requested id — Google routes a deprecated id to a successor instead of refusing it. A response id that fails id validation or the pattern (a `-NNN` revision suffix, say) is no signal and retires nothing. UNVERIFIED that compat reports the routed-to id (§2.3); if it does not, pinned ids and the daily refresh are the only repair | after a 404, next model; after a re-route, the answer is used and the event names both ids, the response id only after it passed id validation (§3.4)                                                                                                                                                                           | model retired (persisted) until the next successful refresh (§3.4)                                                   |
| `AUTH`             | 401; a 403 whose body parses as the provider's **documented error envelope** (Gemini `error.status: PERMISSION_DENIED`; Groq an `error` object with `message` and `type`). Gemini's `PERMISSION_DENIED` has four documented causes, all about the key or project; read as `REFUSED`, a leaked key would be retried on every record. Any other 403 (HTML, empty, foreign JSON — an edge layer reacting to the page) is `TRANSPORT`, so page text can never disable a provider                                                                                                                                                                                                                                                                                                                                                                                        | next route                                                                                                                                                                                                                                                                                                                      | whole provider disabled, **persisted**, until the proof of §3.2; loud event — a key problem is never read as "spent" |
| `REFUSED`          | a safety block or content filter (OpenAI-compatible `finish_reason: content_filter`; Gemini block reason): an input-triggered refusal must not disable a provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | next route; **not** retried on the same provider                                                                                                                                                                                                                                                                                | none (it is about this input, not the model)                                                                         |
| `INVALID_OUTPUT`   | empty content, `finish_reason: length` (the answer hit `max_tokens`), non-JSON, fenced, schema-invalid after the one correction retry, over 2 MiB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | next model (VCF `answerFits`: an answer that would fail later is passed over now); at the floor, a failed answer (§5.3). An empty answer is never "nothing found"                                                                                                                                                               | none                                                                                                                 |
| `TIMEOUT`          | per-attempt timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | next route                                                                                                                                                                                                                                                                                                                      | none; own cap unit stays spent (the request may have been billed)                                                    |
| `TRANSPORT`        | network error, other 4xx/5xx, envelope invalid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | next route                                                                                                                                                                                                                                                                                                                      | none                                                                                                                 |
| `PROMPT_TOO_LARGE` | **local route only, before each HTTP request, correction retry included:** the estimated prompt, the group's `maxAnswerTokens` and the correction maximum (its prefix plus `MAX_CORRECTION_CHARS`) exceed the route's window (VCF `promptFits`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | a **per-record** failure with public `INVALID_OUTPUT`, never `PROVIDER_ERROR`, which would stop the cycle as `MODEL_UNAVAILABLE`. **Never sent, so the runtime can never truncate it**                                                                                                                                          | none; the input ceiling should have prevented it, so an occurrence is a defect signal                                |

The literal word "quota" (or any other word) in the **page** never changes a classification: the page is input, not a
provider response. A 5.4b test already pins this at the port boundary; 5.4c repeats it at the leaf. Groq's per-minute
token limit can be smaller than one large prompt, so the Groq route's configured window is set no higher than it: the fit
filter then skips Groq for such a page instead of cooling it down on every call.

**Durations from headers.** `retry-after` is non-negative integer seconds; `retryDelay`, read only from the `RetryInfo` entry of `error.details[]`, and `x-ratelimit-reset-*` are
parsed as durations; a non-finite, negative or unparsable value counts as absent. Every derived pause is clamped to 24 h
and to the provider's reset. The reset is fixed in config, never read from a header: midnight Pacific for Gemini (documented);
midnight UTC for Groq, an **unverified config assumption** until the owner reads it (§2.3).

**Own-cap unit rules** (the `OwnCapPort`, §3.1). One unit is **one HTTP request** to a hosted provider, reserved
immediately before the request is sent. A `BUSY` re-try on the same model and the one correction retry of
`runExtraction` are separate requests and reserve their own units; a unit that cannot be reserved stops that provider
for this call (no request is sent). After the response, by code:

| Code                                                     | The request's unit                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `OK`, `INVALID_OUTPUT`, `REFUSED`, `BUSY`, `SPENT_DAY`   | **committed** — the provider counted the request                                                         |
| `TIMEOUT`                                                | **committed** — the request may have been counted                                                        |
| `AUTH`, `CREDIT`, `FLAG_REJECTED`, `RETIRED` after a 404 | **released** — refused before any work; these codes disable the model or provider, so they cannot repeat |
| `RETIRED` after a Gemini re-route (a 2xx)                | **committed** — the provider did the work, and its answer is used                                        |
| `TRANSPORT` with no response (connection never made)     | **released**                                                                                             |
| `TRANSPORT` with a response                              | **committed**                                                                                            |

The local floor reserves no own-cap unit; the 5.4b cycle slot covers the whole call, floor included.

### 5.2 Pacing and dosing, as one algorithm

> **Amended 2026-11-08 (H.1, H.6).** The pacing survives: own caps, minimum gaps, rotation, the fit filter and spent/retired
> skipping. Everything about the floor does not: there is no `floorBudgetMs`, no hand-back to local, no `FELL_TO_LOCAL`
> event and no required local route. The whole-call deadline is `hostedBudgetMs` alone, and a call that finds every
> available route limit-blocked ends `LIMITS_EXHAUSTED` (H.2). The steps below are kept as the record.

Per `extract` call:

1. **Deadline.** The hosted cascade may use `hostedBudgetMs`, the floor `floorBudgetMs`; their sum is the call's absolute
   ceiling (§5.5). The cascade cannot spend the floor's time (VCF summed per-request timeouts until `boundExecutor`
   existed). A floor that overruns its own budget ends in `TIMEOUT`; it gets no more time.
2. **Candidates.** Hosted routes that have a key, at least one model not spent / retired, are not disabled, and whose
   context window fits the input (fit filter). The input is already sized to the local window by the caller, so the
   floor always fits.
3. **Rotation.** Among rotatable candidates, the next one in the per-process rotation goes first; the rest keep their
   configured order (VCF `createBalancedChainExecutor`). A non-rotatable route (for example a provider whose allowance is
   reserved for something else) is only a fallback.
4. **Per attempt.** Ask the `OwnCapPort` for one unit of this provider's day; refused ⇒ skip the provider without a
   request. Wait out the provider's minimum gap (VCF: 3 s for OpenAI-compatible providers, 7 s for Gemini). Send with
   the provider's structured-output mode, built by the shared request builder (§3.3). Classify (§5.1).
5. **Hand-back and floor.** Every hosted candidate exhausted, filtered or refused ⇒ `SMALL_DOSE_NEEDED`, and the small dose
   runs on the local route, with no own cap and no gap, under `floorBudgetMs` (§5.4). Every request passes the fit check
   first (`PROMPT_TOO_LARGE`, §5.1). Emit `FELL_TO_LOCAL` with the list of `(route, code)` that led there.
6. **Result.** The first `OK` wins. If the floor also fails, the public code is the floor's (`TIMEOUT`,
   `INVALID_OUTPUT` or `PROVIDER_ERROR`). A router with no valid local route never starts: it is `NOT_CONFIGURED` before any
   hosted request, as §3.3 and §8.5 require.

Own-cap values sit **below** each provider's published free limit, so the provider never reaches its refusal state;
`SPENT_DAY` is then the exception that corrects a wrong cap, not the normal stop. Values: D5.

### 5.3 "Slow, never a silent failure"

> **Superseded 2026-11-08 by "exhausted, never silent" (H.2, H.3, H.8).** Nothing is slow any more, because there is no
> floor. Nothing is silent either. A call that finds every available route limit-blocked ends `LIMITS_EXHAUSTED`, raises
> `MODEL_LIMITS_EXHAUSTED`, and reaches HR and ADMIN as a localized message. A transient failure keeps today's codes and
> flags. What changes in the text below:
>
> - `FELL_TO_LOCAL` is replaced by `EXHAUSTED`. The 5.4c-3 test now fails the wiring if the handler is missing or swallows
>   `EXHAUSTED`.
> - **`HOSTED_ROUTES_DEAD` evidence excludes limit codes.** An `EXHAUSTED` reason of `CAP`, `SPENT_DAY` or `CREDIT`, and a
>   `PROVIDER_DISABLED` event with code `CREDIT`, are evidence for `MODEL_LIMITS_EXHAUSTED`, not for "hosted routes dead".
>   An `AUTH` disable, a non-aborted transient attempt and the other reasons stay evidence for `HOSTED_ROUTES_DEAD`, exactly
>   as written. So one cycle never raises both flags for the same cause. Keys that are wrong say "dead"; limits that are
>   spent say "exhausted".
> - The preflight paragraph is replaced by the readiness check of H.3: one call that sends no model request, with no
>   backoff. `MODEL_UNREACHABLE` keeps its "clears only when a later call reaches the worker" rule.
> - The "floor failure" bullet is gone. A failed call returns the 5.4b outcome its code maps to, or the H.2 stop.
> - In the accepted limit, "the pinned list and the floor are the safe state" now reads "the pinned list is the safe
>   state".

- A fall to local is an event, never silence — and an event is only as loud as its consumer, so the consumer is
  **mandatory**, not optional. The wiring (5.4c-3) must supply an `onEvent` handler; the router config schema has
  no "no events" mode. That handler: (a) increments a durable per-day counter of floor falls and of each hosted
  provider's codes (the existing metering/health surface, no text); (b) raises a durable health flag "hosted routes
  dead" when a cycle ran with at least one hosted provider configured, produced evidence about a hosted route, and
  **none** answered, cleared by the first answer. An answer is a hosted `OK`, or a 2xx `RETIRED` that names a hosted
  route and a non-empty `servedModel`: the route served the request, under a different model. The 404 `RETIRED` shape is
  not an answer. Evidence is a hosted attempt that was not aborted, a disabled provider, or a fall with any reason other
  than a well-formed `FIT` skip, malformed reasons and a non-array `reasons` included: a page too big for a route asked that route nothing. A
  cycle with no evidence (a local-only config, only aborted calls, only `FIT` falls or falls with an empty or absent `reasons`,
  only `ATTEMPT` or `PROVIDER_DISABLED` events refused as malformed, a lone 404 `RETIRED`) leaves the flag unchanged (the answer and evidence rules come from task 5.4c-4, PR #1277); (c) re-emits the flag once per collection cycle while it stays raised, so it cannot be seen once and
  forgotten. A 5.4c-3 test fails the wiring if the handler is missing or swallows `FELL_TO_LOCAL`.
- **Preflight** (VCF pattern, adopted as-is): before a collection cycle that will use model extraction, one trivial call
  to the local route; 4 attempts at 10 / 30 / 60 s gaps. No answer ⇒ the model stage of that cycle does not start, no
  record is marked as extracted or "nothing found", and a durable health signal "model unreachable" is raised (the
  r5 job-sourcing health surface is the candidate home; 5.4c-4 confirms it). The signal clears **only** when a later call reaches
  the model, never by age (VCF `MODEL_DOWN_FRESH_HOURS`: after a while only the wording changes). The attempts' spacing is what lets a
  model reloading after a restart come back, so MP-04's measured cold load must fit inside it. The deterministic HTTP/JSON-LD stages
  still run — the VCF rule "a check written for one step must not cost the others".
- A floor failure on a record returns the 5.4b outcome `MODEL_UNAVAILABLE` / `EXTRACTOR_FAILED` with the remaining IDs; what
  happens to those records next is §5.4's table.
- `AUTH` and `CREDIT` raise a loud event once per process, not per call.
- **Health from outside an answer.** The refresh and the chain check (§3.4) run with no answer to ride on. Their failed-job
  event and `MODEL_LIST_STALE` are codes in the state file; every `extract` and `preflight` reply carries them, and the
  collection side records them on the DB side. A preflight opens every model-using cycle, so a flag arrives within one cycle.
  **Accepted limit:** with no model-using cycle the flag waits. No text moves meanwhile, and the pinned list and the floor are
  the safe state.

### 5.4 Small dose: mandatory on the local route

> **Retired 2026-11-08 (H.6).** The small dose existed only for the local route, which is withdrawn. On hosted routes it
> would multiply requests against the daily and per-minute free limits and would not help a context limit. What survives
> of this section is the D10 guard, a field without a surviving quote becomes null on every route, together with the
> evidence-span reply schema and the strict-schema rendering. The outcome table below still describes how a record that
> failed extraction is settled. Its local-only rows (hand-back, dose groups, `PROMPT_TOO_LARGE`) no longer occur.
> The `LIMITS_EXHAUSTED` row is added by H.2: the records stay owed, they are not counted and they are never parked.

**Owner correction, 2026-11-04: built unconditionally, as part of the local route (task 5.4c-6). MP-03 tunes it; it does
not gate it.** The earlier edition built this only if MP-03 showed the need; that left the floor free to fail on every
prompt until someone measured it. A full structured request to a small model is the failure this exists to prevent, and
in VCF it is what used to come back empty.

**Plan, by the routes that can answer** (VCF `dosePlanFor`): at least one hosted candidate ⇒ `full-then-small`; no hosted
candidate (no keys, all spent) ⇒ `small` directly. Hosted routes always receive the full shape; **the local route never
does**, unless the field-group table is deliberately one group (below).

**Hand-back** (VCF `SmallDoseNeeded`, `callDosed`, `pinnedLocal`). VCF throws across the executor; `@crm/inference` never
throws, so the cascade ends with an **internal** `SMALL_DOSE_NEEDED` result naming why the hosted routes gave up, and a
dose runner in the router answers it, every request pinned to the local route. It never leaves the package; the public
result is unchanged.

**Field groups, read by code** (VCF `DosedCall`):

- `ExtractionRequest` gains an optional `smallDose`: an ordered list of at most `MAX_SMALL_DOSE_GROUPS` field groups (§5.5),
  each with a name, a short instruction, a strict flat sub-schema of a few related fields and a `maxAnswerTokens`, plus a
  pure `merge(parts)` that assembles the result in code. `ModelStructurer` (5.4b) always supplies it, and a test asserts
  that; a request with no `smallDose` declares that its own schema is already small enough, which only a deliberately small
  schema may do.
- **The envelope stays whole.** A group's instruction is a checked-in constant **appended to** `req.instruction`, never a
  replacement: `EXTRACTION_SYSTEM_PROMPT` is the prompt-injection defence, and it reaches the port as `instruction`. The
  input is the same delimited user message. The combined text stays under `MAX_EXTRACTION_INSTRUCTION_CHARS`, past which
  `sendChatCompletion` cuts silently, and counts in the fit check.
- Each group is one `runExtraction` on the same input: strict `json_schema`, parse, one correction retry, Zod.
- **The full schema is real.** Today `ModelStructurer` passes `z.unknown()`, so the port validates nothing, and the guard's
  `outputSchema` is not enough: it declares records and URL fields `z.unknown()`. 5.4c-6 composes `modelReplySchema` from the
  guard's definitions: `records` of the record schema, at most **1** (a detail page is one posting; `HtmlProvider` keeps only
  the first anyway, so more is a wrong answer), URLs typed string or null so they render. A record-shape error is
  `INVALID_OUTPUT` and cascades; the guard stays behind it unchanged, per record and per URL.
- Hosted routes never see a group; a group failure never goes back up the cascade.
- **The floor is asked only what is used.** Stage C applies only `MODEL_FILLABLE_FIELDS` (`description`, `location`,
  `employmentType`, `remote`), and only where Stage B left them empty. The table covers those; a group with no missing field
  is not asked (Task 5.5, stage C), and other fields merge as null.
- **Unquoted facts are dropped, on every route (owner decision D10, 2026-11-04).** Sub-schemas carry flat `<field>Quote`
  strings, which `merge` turns into `evidence`. Main's guard drops a bad **quote**, never a fact, so a field with no
  surviving quote is still applied today. 5.4c-6 changes the guard: a string fact with no surviving quote becomes null, and
  the record and its other fields stay. URLs keep their own whole-URL check. A boolean (`remote`) is kept, because the guard
  never gives a boolean evidence; nulling it would drop every `remote`. **Cost:** a true field the model did not quote is
  lost; deterministic values still win. MP-03 reports the dropped share, for tuning the table.
- `uncertainty` is required by the guard and is not asked of a model on the floor: `merge` sets a fixed constant that marks a
  floor answer. Nothing on main reads it yet.

**Groups run per discovered record, and a record yields one posting.** The guard accepts up to 100 records per reply, and
separate groups answering about a page with several postings have nothing to align on: an apply URL from one posting
would pass grounding on another. So:

- Stage C hands the structurer one `DiscoveredRecord` per detail page, and the port contract narrows to that. Text holding
  several postings is split by discovery or not sent to a model.
- Sub-schemas are flat objects, never arrays. `merge` yields **exactly one** record, and `ModelStructurer` stamps its id.
- Every group's constant says to answer about the page's main posting only. The identity group also returns
  `postingsOnPage`, an integer bounded by its sub-schema and kept out of the merged record. For anything but 1, `merge`
  returns an explicit failure, which the runner maps to public `INVALID_OUTPUT`, so `ModelStructurer` records a per-record
  issue. It never returns `{ records: [] }`, which the guard would pass as "no postings".
- **Residual:** a model that miscounts can still mix a sidebar posting's facts into a record. MP-03's labelled set includes
  such pages and measures it.

**A failed group is a failed call** (VCF: "this module never turns a failed call into an answer"). Any group that ends in
`TIMEOUT`, `TRANSPORT` or `INVALID_OUTPUT` fails the whole floor answer with the floor's public code, and the record stays
due. A model answering `null` for a nullable field is an answer; a group that did not answer is never recorded as nulls,
so "the model did not run" can never read as "the page does not say".

**What MP-03 tunes:** the group boundaries and count (up to the cap), each group's wording and `maxAnswerTokens`, and
whether a candidate holds larger groups. One group holding the whole schema is a legal table; that group is still flat, one
record. If MP-03 shows the chosen model answers it reliably, the tuning is a one-line reviewed change and no code path
changes. There is no off switch: the hand-back and the runner remain.

**Cost, stated:** each group re-sends the input, so one record costs the local model as many prompt evaluations as there
are groups. MP-04 measures that wall time; it is the main reason the table is tuned. The 5.4b cycle slot covers the whole
call, groups included; time is limited by §5.5.

**What happens to a record, by outcome.** These extend the real counters `modelAttempts` and `modelPending`
(`settleModelPending`). Today a reached record is cleared after one try until its content changes, whatever the result; a
missed one counts, and its third miss clears it, so three cycles of stops would park healthy pages; and `MODEL_UNAVAILABLE`
reaches everything, so an outage clears them at once. 5.4c-6 changes that to:

| Outcome                                                                                                                                                                                                                                                                       | Counts in `modelAttempts`? | Next                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answered, including a page that gave no fields                                                                                                                                                                                                                                | no, reset                  | cleared, revisit pace (as today)                                                                                                                                                                                                      |
| **Record-caused:** `INVALID_OUTPUT`, `PROMPT_TOO_LARGE`, `postingsOnPage` other than 1, guard reasons, in a pass where **another record succeeded**                                                                                                                           | **yes**                    | owed on `MODEL_BACKOFF_MS`; the third clears it until the content changes, and is reported                                                                                                                                            |
| **Not the record's fault:** a pass ending `EXTRACTOR_FAILED` (nothing succeeded: a bad runtime or digest answers that way on every record), `TIMEOUT`, `CANCELLED`, `PORT_THREW`, unknown code, budget stops (the local-time limit too), `PROVIDER_ERROR`, a failed preflight | **no**                     | stays owed, due at the longest backoff, and never parked. So a source with one record never parks it, at one call per backoff. The in-flight record of a `TIMEOUT` is offered last next cycle, so one slow page cannot block the rest |
| `NOT_CONFIGURED`, `ai-input` skips                                                                                                                                                                                                                                            | no                         | cleared, as today: a configuration state or a decision                                                                                                                                                                                |

### 5.5 Stopping a call: a ceiling, an abort, one request in flight

> **Amended 2026-11-08 (H.1, H.6).** The ceiling, the abort and one request in flight per route survive, over
> `hostedBudgetMs` only. The local request queue, the `floorBudgetMs` term of the ceiling sum and the per-cycle local
> time budget are withdrawn with the local route.

A floor budget that grows with the group count does not survive the layer above. `ModelStructurer` gives up after
`DEFAULT_STRUCTURER_TIMEOUT_MS` (120 s), frees the route after `DEFAULT_ABANDONED_HOLD_MS` (250 s, from
`MAX_REQUESTS_PER_PORT_CALL`), and the port takes no signal. An abandoned router call would keep sending, hosted requests
with vacancy text included, while the next record started. **So the 5.4b hold changes:**

1. **A cap on groups.** `MAX_SMALL_DOSE_GROUPS`, a package constant (6 proposed); a request above it sends nothing and fails.
2. **An absolute ceiling per call.** `hostedBudgetMs` and `floorBudgetMs` are config with package maxima, and
   `routerCallCeilingMs(config)` exports their sum. Each request's timeout is the lesser of the route's and what remains. The
   schema refuses a `floorBudgetMs` that cannot give every group of a full table one request; correction retries take what
   is left.
3. **An abort that stops sending.** `ExtractionRequest` gains `signal`. The cascade and the dose runner check it before every
   request and it wakes backoff and minimum-gap sleeps; `sendChatCompletion` and `boundedRequest` take it, so a request in
   flight is cancelled. `ModelStructurer` owns one controller per call and aborts it on its timeout or on the cycle's
   `signal`. `boundedRequest` reports a timeout and an abort alike today, so it gains a separate result: an aborted call
   cascades nowhere and raises no "hosted routes dead" flag.
4. **A timeout and hold derived from the ceiling.** The wiring passes the existing `timeoutMs` as the ceiling plus a margin,
   so the router's coded `TIMEOUT` arrives first, and `abandonedHoldMs` as that plus a grace. The hold ends when the call
   settles, and the slot stays consumed. `PORT_HTTP_TIMEOUT_MS` and `MAX_REQUESTS_PER_PORT_CALL` remain only as the
   defaults for `local` and `openrouter`.
5. **One local request in flight.** One `ModelStructurer` per router, and the local leaf serialises its own requests, so a
   preflight or a second caller queues. A runtime that keeps generating after a disconnect would defeat this, which is why
   §8.3 tests it; `max_tokens` bounds it regardless.
6. **A local-time budget per cycle** holds the plan's "local = calls + CPU time". `usage` gains `localMs` on success **and on
   failure**, an abandoned call counts its elapsed time, and `ModelBudgetPort` refuses the next reservation (`BUDGET_EXHAUSTED`,
   `CYCLE_LIMIT`) once the cycle's total reaches a limit frozen from MP-04.

---

## 6. Test strategy and MP-03 hooks

### 6.1 Without keys, without network

> **Amended 2026-11-08 (H.1, H.6).** Tests of the local floor, its budget and concurrency, and the small dose are not
> written; the specs that carry them are rewritten by 5.4c-H1. In their place: a `local` route is `CONFIG_REFUSED`, an
> all-limit-blocked call ends `LIMITS_EXHAUSTED` (5.4c-H2), and the OpenRouter free-only checks and classification
> (5.4c-H3). The seams below are unchanged.

- **Seam:** the package's existing `fetchImpl` (`FetchLike`), plus injected `now` and `sleep` — the same seams the
  OpenRouter adapter tests use today. No env, no DB.
- **Fixtures per provider**, one file per provider with a case per row of §5.1: status, headers and a minimal body.
  They are **hand-written from each provider's published error format** (5.4c-0 cites the source of each) and contain no
  real prompt, no real page, no key, no account id. Recording live traffic is not part of the test strategy; the
  controlled smoke of Task 5.2 runs once per route by the owner and is never turned into a fixture unscrubbed.
- **Router tests** with scripted leaves: rotation order across successive calls; a non-rotatable route never first;
  fit filter drops a small-context route and keeps the floor; own cap refused ⇒ no request sent (fetch call count 0);
  spent model skipped on the next call; retired model skipped at once and after a restart (file adapter reloaded); `AUTH`
  (401, or a 403 with the documented envelope) disables the provider once and emits once, while a 403 with an HTML, empty or
  foreign body is `TRANSPORT` and persists nothing, and a content-filter refusal is `REFUSED`; a Groq 429 with
  `x-ratelimit-remaining-requests: 0` is `SPENT_DAY`, one without a marker waits at most once and cools the model down, and
  a bad or over-long header pause is absent or clamped; a Gemini 2xx naming another version retires the requested id, while
  a revision-suffixed or invalid response id retires nothing; the own-cap unit table of §5.1 per code, retries reserving
  their own units; the floor's budget stays whole even when every hosted attempt hangs (fake timers); no hosted key
  configured ⇒ no hosted request is ever sent and the plan is `small`; a hosted route without an `OwnCapPort` and an invalid
  local URL both refuse the config, with zero hosted requests; floor failure ⇒ the floor's public code; the word "quota" in
  the input changes nothing; no event payload ever contains input or body text (assert on a seeded marker string); a strict
  `null` reaches the guard as absent and leaves a field already filled by Stage B unchanged.
- **Stopping (§5.5):** after an abort the fake fetch's call count stops growing, on hosted and local routes alike and through
  the worker's connection; a request in flight is cancelled and a sleep wakes; an aborted call raises no "hosted routes dead"
  flag; never two local requests in flight, even after an abandoned call; a slot is not freed while its call still runs; a
  group count over the cap sends nothing; the ceiling holds with every request hanging; the structurer's timeout and hold
  exceed the exported ceiling; the cycle's local-time limit refuses the next reservation, and a failed floor call is charged
  against it.
- **Transport (§3.3):** hosted and `openrouter` calls refuse plain HTTP; the local leaf reaches only the constant host over
  it; link-local, IPv4-mapped and foreign names are refused.
- **Local-route tests (5.4c-6, §8.4):**
  - **Small dose:** a request with `smallDose` never sends the full schema to the local route (fake fetch records every
    body); hosted routes receive the full schema and never a group; the hand-back emits `FELL_TO_LOCAL` and
    `SMALL_DOSE_NEEDED` never reaches the public result; groups merge by code into one record that passes the full schema
    and the guard; a group with no missing field is not asked; a one-group table behaves as a full call on the local route.
  - **Envelope:** every group body carries the whole `EXTRACTION_SYSTEM_PROMPT` and the same delimited input; the longest
    combined instruction stays under the cut.
  - **Identity:** a page with two postings, scripted `postingsOnPage: 2`, ends as a per-record `INVALID_OUTPUT` issue from
    `ModelStructurer`, with no record and no "no postings" result; the merged record carries the discovered record's id; a
    hosted reply with two records is `INVALID_OUTPUT` and cascades.
  - **Failed group:** a `TIMEOUT`, `TRANSPORT` or `INVALID_OUTPUT` in any group fails the whole answer with the floor's
    code, never partial data; a model `null` on a nullable field is kept.
  - **`ModelStructurer` always supplies `smallDose` and passes `modelReplySchema`;** a record-shape error cascades, and the
    guard still drops one bad URL per field.
  - **Fit:** a prompt over the window less the reserves is refused with zero requests sent, for every group; a first request
    that barely fits never overflows on its correction retry; a page over the ceiling is cut by `buildExtractionPrompt`,
    reports `truncated` and does not stop the records behind it.
  - **Decoder and output bound:** no body carries `maxLength`, while an overlong value still fails Zod; every local request
    carries the group's `max_tokens` and every probe the small constant; `finish_reason: length` ⇒ `INVALID_OUTPUT`.
  - **Quotes and `uncertainty`:** `merge` turns `<field>Quote` into `evidence` that survives the guard, and sets the constant.
    **D10:** on a hosted reply and a floor reply alike, a string fact with no surviving quote ends null while the record, its
    quoted fields, its URLs and a boolean stay.
  - **Empty answer** ⇒ `INVALID_OUTPUT`. **Timeout:** the config refuses a local timeout of 300 s or more.
  - **Outcome table (§5.4):** a third record-caused failure clears the record until its content changes; three cycles of an
    outage, stops, the local-time limit or `EXTRACTOR_FAILED` park nothing and leave `modelAttempts` unchanged; a record that
    timed out is offered last.
- **Leaf tests** per fixture: classification table, identical non-prompt fields on every hosted request body, structured-output mode
  per capability, no key in any thrown or returned value.
- **Self-heal tests (5.4c-2b)**, all with fixtures and a fake `fetchImpl`, no key, no network:
  - **Pure pick functions** over fixture listings: `classifyModelStatus` per status (404 dead; 429/503 transient;
    timeout and other statuses unknown, never dead); `pickLiveModels` ranking, context floor and `TARGET`; `pickGroqModels`
    (keeps listed current ids, drops inactive, adds at most one large-context chat model, never a non-chat id); the
    Gemini family pattern; three consecutive busy-429 probe days drop a Gemini model as `dead`, and a 503 does not count.
  - **Model-id validation** with hostile ids: path traversal, a URL, whitespace and newlines, control and non-ASCII
    characters, over-long ids, a leading `/`, a second `:` — each dropped and counted, never probed, stored or logged
    raw. Groq: an id outside the checked-in family pattern is never added. Gemini: an id outside its pattern is dropped.
  - **Selection order (SR-H-1)**: a new large-context `alive` candidate is appended **below** every existing entry; it
    is promoted only after N consecutive `alive` refreshes, and a `transient` or `unknown` probe day resets its streak; a no-probe day (cap reached, provider skipped, job not run) leaves the streak unchanged; two probes on one day count once; a hand-edited streak above N is rejected by the schema and an entry absent from the pinned list without a record of streak N is ordered as probation; a Groq addition is never promoted by the refresh; a reported
    context larger than the route's window is capped to the window before any filter or ranking.
  - **Never wipe**: a failed listing fetch, `AUTH`, or nothing surviving leaves the managed-list file byte-identical;
    an invalid, empty or missing file makes `managedModels` return the pinned fallback.
  - **Per-provider reset (SR-M-5)**: provider A failing does not stop provider B's retired entries from clearing on B's
    success; an unconfigured provider counts as skipped, not failed; the job reports failure when any configured provider
    failed. `MODEL_LIST_STALE` clears when a refresh removes every entry it named.
  - **Probe hygiene — refresh and weekly chain check alike (SR-M-3)**: the fake fetch records every request body; each
    equals the fixed probe constant plus the shared builder's fixed fields; no request exceeds `PROBE_CAP` per provider;
    the **daily** job sends Groq no chat request; a provider outside the allowlist or without a key receives no request; a
    cap refusal skips the provider with no request.
  - **Listing fetch (SR-M-8)**: the URL is a constant; the key is in a header and absent from the URL; a redirect is
    refused; an over-size body and an over-count entry list are bounded, not parsed whole.
  - **State files (SR-M-6)**: too many entries or too many bytes reject the file whole. A bad entry in the spent or retired
    list is dropped alone and counted (`STATE_ENTRIES_DROPPED`), so one hand-edited line does not cost the rest. A bad probation,
    busy or `busyDead` record resets the whole route-state file (`STATE_RESET`, reason `invalid`), and a bad managed-list entry
    rejects that file whole. Two concurrent changes both survive (single writer);
    the written file has mode `0600`; a write interrupted between temp file and rename (fake fs) leaves the previous
    file readable.
  - **Start-up refresh (SR-M-7, SR-M-11)**: a persisted `AUTH` bit triggers a refresh of that provider at start, which sends
    exactly one chat probe, to Groq too, unless every listed id is held as `busyDead` (§3.2); a successful listing fetch alone leaves the bit set, a 2xx probe clears it; a second
    start within 1 hour of the persisted `lastStartupRefreshAt` sends no request (crash-loop bound, fake clock).
  - **No secret or body in output**: a seeded marker key and a marker provider body are absent from every log line and
    event.
- **Mutation gate** (Stryker, unit scope) on the classification, the router core, the small-dose runner and merge, and the
  self-heal pick, validation and never-wipe logic: 0 survivors, as for 5.4a/5.4b.

### 6.2 MP-03 and MP-04 measurement hooks

> **Amended 2026-11-08: MP-03 is hosted-only, and MP-04 is closed.** MP-04 ran and failed (Amendment 2026-11-08 item 1).
> No later measurement on the production host is planned. The events lose the field-group and "floor answered" fields.
>
> MP-03 keeps its pipeline rule: every page goes through `HtmlStructurer.structure`, never a leaf. It runs one phase, a
> config with one hosted route per provider (`gemini`, `groq`, `openrouter`), on labelled pages the gates admit. It
> reports:
>
> - schema-valid rate and field accuracy per provider and model, uk and en apart;
> - the D10 dropped-field share;
> - the share of inputs cut by the input ceiling (H.4);
> - per-provider `SPENT_DAY` / `BUSY` / `FLAG_REJECTED` counts;
> - the number of free requests one collection cycle consumes. That last figure checks the 1000-a-day and own-cap
>   numbers of H.7 against real volume.
>
> For OpenRouter, it runs with `dataCollection: allow` (D11). It may run on the OpenRouter key alone while the Gemini and
> Groq keys do not exist; each provider's row is filled when its key arrives. MP-03 still gates hosted enablement (5.4c-5)
> and picks the pinned fallback lists. The "local phase" and the floor wording below are the record of the plan before
> 2026-11-08.

`deps.onEvent(event)` receives, per attempt and per call: route, provider, model, internal code, HTTP status, input
characters, total tokens, cost when the provider reports it, attempt latency, whole-call latency, the field group when
the attempt belongs to a small dose, and whether the floor answered. **No text.** The package does not aggregate; the
caller (and the MP-03 harness) does.

The MP-03 harness (a read-only spike, not product code) never calls a leaf or a port directly. It feeds every page
through the same 5.4a/5.4b pipeline production uses — the `ai-input` gate, `stripContacts`, the prompt envelope and the
result guard, i.e. `HtmlStructurer.structure` — with the port built from a router config. Two phases:

- **Local phase:** a config with no hosted route, over the whole labelled set, per candidate of §8.3, small dose on. It
  runs together with MP-04 (task 5.4c-7), which adds the resource measurements on the target host and picks the model.
- **Hosted phase:** after the local pick, a config with one hosted route and the floor, per provider, on labelled pages
  the gates admit, using keys the owner has provisioned for it. The per-attempt events separate the hosted provider's own
  answers from floor answers. D1 and D2 are answered, so this phase waits on keys rather than on a decision.

It then computes outside the package: field accuracy against the labels, grounding and invented-URL rate (through the
5.4a result guard), schema-valid rate, latency p50/p95, cost per page, and the floor-fall rate of the full chain.
MP-03 gates hosted enablement, as the plan says, and tunes the small dose of §5.4; it does not gate the small dose. MP-04
gates the install (task 5.4c-8).

---

## 7. Owner decisions and task breakdown

### 7.1 Decisions (classified per `autonomy-levels.md`)

| ID       | Question                                                                                                       | Level                                              | Answer or recommendation                                                                                                                                                                                                                                                                                                                                      | Reversible?                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **D1**   | Which sources may send text to hosted models                                                                   | **Decided by the owner 2026-11-04**                | Every source for which the model can do the task; `ai-input=no`, the `unspecified` policy and contact stripping unchanged; residual risk accepted (§4.1)                                                                                                                                                                                                      | Removing the keys stops sending; text already sent is not recallable |
| **D2**   | May a provider whose free tier can train on or human-review prompts receive vacancy text                       | **Decided by the owner 2026-11-04**                | Yes, after stripping (§4.2)                                                                                                                                                                                                                                                                                                                                   | Same                                                                 |
| **D3**   | OpenRouter in the router                                                                                       | **Decided by the owner 2026-11-04**                | **Superseded 2026-11-08:** OpenRouter is a route, free models only; `data_collection` is D11 (§3.5, §4.3). Original answer: not in this version; `deny` re-decided if it is added                                                                                                                                                                             | Yes — add a provider row later                                       |
| **D4**   | Which persistent store holds route state and the managed list (memory alone is ruled out by D6)                | **Decided by the owner 2026-11-04** (ADR approval) | Worker state files (write-through, atomic replace) behind the `RouteStatePort`; Postgres adapter only when a second worker replica appears                                                                                                                                                                                                                    | Yes — swap the adapter                                               |
| **D5**   | Own daily caps per provider                                                                                    | **Decided by the owner 2026-11-04** (ADR approval) | 50 % of each provider's published free limit (5.4c-0 supplies the numbers), frozen as limits in config under a policy version                                                                                                                                                                                                                                 | Yes — a new policy version                                           |
| **D6**   | Model list after a model dies                                                                                  | **Decided by the owner 2026-11-03**                | **Self-heal** by the VCF mechanism: request-time retirement, daily refresh with a pinned fallback, weekly stale check (§3.4) — replaces "alert only"                                                                                                                                                                                                          | Yes — delete the managed-list file / disable the job                 |
| **D7**   | Adoption shape                                                                                                 | **Decided by the owner 2026-11-04** (ADR approval) | Option A, copy-adapt into `@crm/inference`                                                                                                                                                                                                                                                                                                                    | Yes — revert the PRs                                                 |
| **D8**   | If no model passes MP-04 on the VPS: another host, or deterministic HTML with model extraction disabled (§8.5) | **A3, asked only if it happens**                   | Deterministic HTML first, because it spends nothing and loses only what measured coverage can then price; another host once that loss is known                                                                                                                                                                                                                | Yes                                                                  |
| **D9**   | Where the load replay of MP-04 runs                                                                            | **Decided by the owner 2026-11-04**                | On the VPS, run by Master over the ssh alias (owner-authorized 2026-11-04): the candidate under the container limit (4 vCPU and the RAM left beside the CRM), synthetic data only, stopped if CRM p95 degrades. Alternative path: the owner's own machine under the same limit, synthetic or seed data only, which is indicative of the VPS, not proof (§8.2) | The run is; load already put on production is not                    |
| **D10**  | Fields a model returns without a surviving quote                                                               | **Decided by the owner 2026-11-04**                | Filtered out on every route: the field becomes null, the record and its other fields stay (§5.4). MP-03 still reports the dropped share                                                                                                                                                                                                                       | Yes — one filter                                                     |
| **D11**  | OpenRouter `provider.data_collection` (asked again by the restored §3.5)                                       | **Decided by the owner 2026-11-08**                | `allow`: only public vacancy text with contacts stripped leaves the host. It is one required config value (`dataCollection`). Contact stripping becomes the load-bearing privacy control for OpenRouter and is mandatory on every hosted route, with a per-provider test (H.9)                                                                                | Yes — one config value; text already sent is not recallable          |
| **OD-2** | OpenRouter `provider.ignore` contents                                                                          | **A1, the architect, 2026-11-08**                  | Empty: its old content came from the D2 exclusion that no longer exists (H.9)                                                                                                                                                                                                                                                                                 | Yes — a config value                                                 |

**Amended 2026-11-08.**

- **D3 is superseded.** OpenRouter is a route, free models only (§3.5, §4.3).
- **D8 and D9 are moot.** The question D8 answered ("no model passes") happened, and the owner's answer is stronger: the
  local model is withdrawn, not moved to another host. The replay D9 placed is done.
- D11 and OD-2 are new.

Nothing in this table blocks a task.

Before 2026-11-08 (record): D1–D3, D9 and D10 were answered, so nothing here was blocked on them. D8 blocked only the
local model's branch (5.4c-7, 5.4c-8).

### 7.2 Tasks

> **Amended 2026-11-08 (hosted-only).** The table below is kept as the record of the local-model plan; its tagged rows
> say what changed. The remaining Phase 5 work is these tasks, in this order: **5.4c-H1 → 5.4c-H2 → 5.4c-H3 → 5.4c-H4**,
> then **MP-03 (hosted-only, §6.2)** after H3, then **5.4c-5 (re-scoped)** after H1–H3 and MP-03. H4 may run in parallel
> with H3 once H2 is merged; it touches disjoint files.
>
> | Task                                                    | Agent · model                                                                                               | Depends on             | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
> | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **5.4c-H1** Withdraw the local route and the small dose | coder · **opus**, high (cross-package contract: `ExtractionRequest`, `routerConfigSchema`, the worker link) | this ADR amendment     | H.1 and H.6: the local route schema and its helpers leave `routerConfigSchema`; the config refines become hosted-only (total, as H.1 writes them); `routerCallCeilingMs` is the hosted budget; `smallDose` leaves `ExtractionRequest` and the API call sites; `renderSchema` / `structuredOutputFor` move out of the small-dose module before it is deleted; the worker env and `EXTRACTION_TABLE_VERSION` follow H.4. A stale config with a local route fails closed. Tests of §6.1 that exercised the local route are rewritten for hosted routes, not deleted silently |
> | **5.4c-H2** `LIMITS_EXHAUSTED` end to end               | coder · **opus**, high; **security-reviewer** (DDL on a CHECK constraint)                                   | 5.4c-H1                | H.2 and H.3: the new inference error code and its exact definition, the `EXHAUSTED` router event, the worker pass-through, the `ModelStop` kind and its owed-not-parked accounting, the `MODEL_LIMITS_EXHAUSTED` flag with its once-per-cycle emission, the narrowed `HOSTED_ROUTES_DEAD` evidence, the request-free readiness preflight, and a new manual-staged DDL widening `MODEL_HEALTH_FLAG_VALUES` and `MODEL_ROUTE_VALUES`                                                                                                                                        |
> | **5.4c-H3** OpenRouter route, free models only          | coder · **opus**, high; **security-reviewer** (external send, key)                                          | 5.4c-H1; after 5.4c-H2 | §3.5 and H.9: the provider in `HOSTED_PROVIDERS` and `HOSTED_BASE_URLS`, the `dataCollection` config value, the four independent free-only checks, the OpenRouter classification (FLAG_REJECTED, SPENT_DAY, BUSY, CREDIT, AUTH), the managed-list refresh filtered by pricing and `structured_outputs`, the worker key env, and the per-provider contact-stripping tests over production, probe and chain-check requests                                                                                                                                                  |
> | **5.4c-H4** The limits notice in the UI                 | coder · **opus** (cross-zone contract api ↔ shared ↔ web); ui-ux-designer; copy-reviewer (uk/en)            | 5.4c-H2                | H.8: the `sourcingNotice` field on the queue list, the operational sources list and the manual run, the 503 code for a run where nothing succeeded on limits, the queue and admin banners with the owner's uk/en text through Lingui. The field stays `null` in production until 5.5b                                                                                                                                                                                                                                                                                     |
>
> **5.4c-5 is re-scoped, not retired:** three keys (Gemini, Groq, OpenRouter) provisioned by the owner into the extraction
> worker only, the OpenRouter key with a $0 USD limit checked before use; the worker provisioning items moved here from
> 5.4c-8 (the `0600` env files, a generated `EXTRACTION_WORKER_SECRET`, the §2.4 network holding only the two workers with
> no published port, the API env without the secret, an unauthenticated call refused); egress to the three provider
> hosts and their listing endpoints only; the controlled smoke per route, OpenRouter's free-only fixtures included; the
> hosted keys moved out of the API env and the API deploy path. It no longer depends on 5.4c-8, and "the floor is live
> before any hosted key exists" no longer applies. **5.4c-7 and 5.4c-8 are retired**; nothing replaces them.

Model tier per `model-routing.md`. Every code task: Coder in its own worktree, code-reviewer, **security-reviewer**
(keys, external send), mutation gate on the changed scope.

Original order (record; superseded by the 2026-11-08 order above): 5.4c-0 → 5.4c-1 → 5.4c-2 → 5.4c-6 → 5.4c-W → 5.4c-3 and 5.4c-4 → 5.4c-8 (install) → 5.4c-5. 5.4c-7 (MP-04,
the gate of 5.4c-8) runs after 5.4c-6, alongside 5.4c-W; 5.4c-2b follows 5.4c-2 and precedes 5.4c-5. The small dose precedes the measurement because MP-04 and
MP-03 must measure what production will run.

| Task                                                                                                                                   | Agent · model                                                                                                                                                | Depends on                                                      | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5.4c-0** Provider and local facts                                                                                                    | `external-research` by Master or a sonnet agent; Legal (opus) for the terms note                                                                             | ADR approved                                                    | **Done 2026-11-04:** `docs/architecture/2026-11-04-extraction-provider-facts.md`. Its follow-ups are the table of §2.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **5.4c-1** Classified leaf                                                                                                             | coder · sonnet, medium                                                                                                                                       | 5.4c-0                                                          | Widen the OpenAI-compatible call to return the internal codes of §5.1, Groq's header rules and the Gemini re-route check included; structured-output mode per route capability; the schema rendered in the **strict form for every route** (every property in `required`, `additionalProperties: false` on every object, an optional field as a union with `null`, no `maxLength`; a `null` means "not found", maps to absent before `guardExtractionResult`, and never overwrites a filled field or counts as answered); `max_tokens` and `finish_reason`, temperature 0 on the router's local route; `signal` through `sendChatCompletion` and `boundedRequest`; the local leaf's own plain-HTTP option (§3.3); per-provider fixtures from 5.4c-0's error table; no router yet; public behaviour of `local` / `openrouter` unchanged (their specs stay green)                                                                                                                               |
| **5.4c-2** Router core                                                                                                                 | coder · **opus**, high                                                                                                                                       | 5.4c-1                                                          | Config schema (`router`, local route required, `OwnCapPort` required with a hosted route, providers `gemini` / `groq` / `local`), fit filter, rotation, cascade honouring `signal`, budgets and `routerCallCeilingMs` (§5.5), floor with its single-flight leaf, `RouteStatePort` (memory and file, §3.2), the `OwnCapPort` state-file adapter, `onEvent`, the input-ceiling helper, `ROUTER_LOCAL_MODEL_URL` validation (§3.3), `PROMPT_TOO_LARGE` per request and the 300 s refusal (§8.4); request-time retirement and the `managedModels` reader (§3.4); tests of §6.1                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **5.4c-2b** Model self-heal + daily refresh                                                                                            | coder · **opus**, high (security surface: untrusted model ids, probes leaving the host, a persisted file)                                                    | 5.4c-2, 5.4c-0 (listing shapes)                                 | §3.4 layers 2 and 3 for Gemini and Groq with all their constraints, the start-up refresh and clearing proof of §3.2, and the tests of §6.1 (SR-H-1..SR-M-11). Nothing from §3.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **5.4c-W** Extraction worker service (**prerequisite**: none exists on main; the prod compose has `postgres`, `redis`, `api`, `nginx`) | **coder · opus** for the entrypoint and the `ExtractionPort` adapter; **DevOps** · sonnet for the service                                                    | 5.4c-6, plan Task 2.5 (the collection side)                     | The process of §2.1 and the entry of §2.4, with health flags carried as §5.3 says. Tests: an unauthenticated call, a foreign field and a version mismatch are each refused with zero requests at any route; a contact in the input reaches a fake route stripped and raises the event; a flag in the state file reaches the next reply                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **5.4c-3** Wiring                                                                                                                      | coder · **opus**, high                                                                                                                                       | 5.4c-2, 5.4c-6, 5.4c-W                                          | Optional env keys read only by the extraction worker (the `LOCAL_MODEL_URL` refine unchanged), `INFERENCE_EXTRACTION_PROVIDER=router` there, `buildInferenceConfig` mapping, `ModelStructurer` built with `timeoutMs` and `abandonedHoldMs` from `routerCallCeilingMs`, the **mandatory** `onEvent` consumer of §5.3; a test pins `ModelStructurer` as the only consumer of the extraction port in `apps/api`, so a future direct caller cannot skip the guards; no log line carries a key or text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **5.4c-4** Preflight + health                                                                                                          | coder · sonnet, medium                                                                                                                                       | 5.4c-W                                                          | Preflight before a model-using cycle; "model unreachable" health signal, cleared only by a later call that reaches the model; deterministic stages unaffected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **5.4c-5** Hosted enablement (re-scoped 2026-11-08, see above)                                                                         | DevOps · sonnet + human-only (keys, egress)                                                                                                                  | 5.4c-H1–H4, 5.4c-W, MP-03, 5.4c-2b, 5.4c-3                      | Gemini and Groq keys provisioned by the owner into the extraction worker, **each from a free-tier project or account with no billing enabled**: billing brings different cost and data terms from the ones D2 accepted, and removes the hard stop §3.1 relies on; egress allowlist per provider host (listing endpoints included); controlled smoke per route (Task 5.2), which runs the owner's redacted calls of §2.3; Groq's zero data retention if the owner wants it (§4 item 3). (Record: the floor was to be live before any hosted key existed; withdrawn 2026-11-08.)                                                                                                                                                                                                                                                                                                                                                                                                                |
| **5.4c-6** Small dose and call control                                                                                                 | coder · **opus**, high (cross-package contract: `ExtractionRequest`, `ModelStructurer`, `ModelBudgetPort`, `buildExtractionPrompt`, `guardExtractionResult`) | 5.4c-2, 5.4b                                                    | §5.4 and §5.5, unconditional, the outcome table included, and the D10 guard change with its test (§6.1). **This changes the 5.4b hold and contract** (§5.5). **MP-03 tunes the table and does not gate it**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **5.4c-7** MP-04 (retired 2026-11-08)                                                                                                  | **DevOps** · sonnet for the container definition, the guards and the harness; **where the replay runs and who runs it: D9**                                  | 5.4c-0, 5.4c-6, MP-05 baseline                                  | **Makes a merged model service unable to start on production without the owner (§8.6):** a separate compose file and project, a CI assertion, the rehearsal of the deploy paths. Container definition per Task 5.2 and §8.3, limited to the production host's budget, thresholds frozen in the task file before the run. For each candidate on the MP-03 labelled set through the production pipeline with the small dose, on synthetic or seed data only (D9): tokens/s, wall time per record, peak RAM, CPU, cold load, CRM p95 with and without, estimate against reported prompt tokens, reasoning output, whether a disconnect stops generation, plus the MP-03 local-phase metrics (§6.2). **Output: the pick with its digest, licence and limits, the frozen floor budget and cycle limit, or "none passes", which goes to D8.** Tunes the §5.4 table with MP-03                                                                                                                       |
| **5.4c-8** Local model install (retired 2026-11-08)                                                                                    | DevOps · sonnet prepares; **the owner runs it on the production server (A3: prod)**                                                                          | 5.4c-7 passing, 5.4c-W, 5.4c-3, 5.4c-4, the owner's explicit go | Runbook section for the owner-run start of the opt-in project (§8.6): pinned image and weights by digest with verification, limits, the extraction worker's persistent volume, the two workers' own `0600` env files (§2.4) with a generated `EXTRACTION_WORKER_SECRET`; on the host, the checks of §8.3 (outbound attempt fails, no published port, marker prompt absent from the container log), **neither the API container nor the collection worker is on the runtime network, and neither env holds hosted keys or `ROUTER_LOCAL_MODEL_URL`; the §2.4 network holds only the two workers with no published port, the API env lacks the secret, and an unauthenticated call is refused**, the window set server-wide and checked with the head marker, and a preflight (§8.4); the owner-run VPS smoke of §8.2 (D9); the undo of §8.6. Then `INFERENCE_EXTRACTION_PROVIDER=router` in the worker with no hosted key: local-only and working. **No agent runs a production step unasked** |

**Delivery state, 2026-11-07.**

- Merged: 5.4c-1 (#1259), 5.4c-2 (#1264), 5.4c-2b (#1266), 5.4c-6 (#1271), 5.4c-W (#1273), W-ops (#1274), 5.4c-3 (#1275),
  5.4c-4 (#1277).
- **The durable home of the §5.3 signals is new tables (5.4c-4).** `job_source_health_events` is per source, with a `NOT NULL`
  foreign key to a source, and a route-level signal has no source; `job_account_meters` is one counter per account, unit and
  window, with no flag concept. The task file names `job_model_route_daily` and `job_model_health_flags`; the migration decides
  the final names.
- **The `buildModelExtraction` call site and the use of `prepareCycle` belong to task 5.5b, the first HTML model provider.**
  `HtmlProvider` is abstract with no concrete subclass, so nothing in production calls the wiring until then. `prepareCycle`
  itself arrived with 5.4c-4, replacing `forCycle`. The 5.5b task file must cite backlog items 366 and 367, the obligations
  that first caller inherits.

MP-03 itself stays the plan's measurement. Its local phase runs with 5.4c-7 and on the same set; its hosted phase runs
once keys exist for the measurement and before 5.4c-5 (§6.2). MP-03 still gates hosted enablement and picks hosted
candidates; it does not gate the small dose.

> **Amended 2026-11-08.** MP-03 has no local phase and no small dose to tune. It runs hosted-only, per provider, after
> 5.4c-H3, and still gates 5.4c-5 (§6.2).

---

## 8. The CRM's own local model

> **Withdrawn 2026-11-08 (owner decision, Amendment 2026-11-08).** No local LLM runtime runs on the server for
> extraction, now or later. This section is kept unchanged as the record of the attempt: its selection criteria, host
> budget and install guards are what a future proposal would have to re-argue, not reuse. D8 and D9 are moot; 5.4c-7 and
> 5.4c-8 are retired (§7.2). Nothing here is a task.

**Owner correction, 2026-11-04:** "We do not take the model from the factory. The factory's model is an example of using
a local model so that it does not fail on every prompt. We must install our own lightweight model on the server,
sufficient for our tasks. Take that strategy and adapt it to our needs."

### 8.1 What is adopted, and what is not

**Not adopted: VCF's model and hardware.** VCF runs Qwen text and vision models on a 6 GB RTX 3060, chosen by measuring
them against VCF's own prompts on that card. None of VCF's model names, digests, windows or timeouts is a CRM default,
and its success on a GPU says nothing about a CPU host. **Adopted: the strategy**, §8.4.

### 8.2 The host

| Fact                                                                                                                 | Source                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Target VPS: Hetzner CX33, 4 vCPU, 8 GB RAM. The runbook mentions no GPU anywhere, so the design assumes **CPU only** | `docs/runbooks/deployment.md`                          |
| Measured on production 2026-10-18: 4 cores, 7.6 GB RAM (6.6 free), 41 GB disk free                                   | plan, owner's dependency answers; not re-measured here |
| Shared with the whole CRM (nginx, API, Postgres, Redis), and later the extraction worker and one headless browser    | runbook; plan Tasks 5.1, 5.2                           |

The plan's note of 2026-10-18 says a local model "at usable speed" does not fit this host. No MP-04 measurement stands
behind it, and it predates a batch, field-group design. This ADR neither relies on it nor overrules it: **MP-04 decides**,
and the fall-back is §8.5. "Usable" is defined by the workload rather than by tokens per second: the due model calls of
a cycle complete inside the collection window while the CRM keeps its p95. The thresholds are frozen in the MP-04 task
file before the run. **Confidence: LOW** that a passing model exists on this host; that is why the gate exists.

**Where MP-04 runs (owner decision D9, 2026-11-04):** on the VPS, run by Master over the ssh alias (owner-authorized
2026-11-04), the candidate in a container limited to this host's budget (4 vCPU and the RAM left to it beside the CRM, from
MP-05), with synthetic data only, and stopped if CRM p95 degrades. **Alternative path:** the owner's own machine under the same
limit, synthetic or seed data only. That result is **indicative of the VPS, not proof**: CPU generation and memory bandwidth
differ. Either way 5.4c-8 checks on the VPS after install, owner-run: a short smoke with the container limit on, wall time per
record against MP-04's frozen thresholds, and an abort if CRM p95 degrades.

### 8.3 Selection criteria (all must hold, measured on the pinned runtime)

The model is a lightweight **text** model chosen for extraction on this host. No vision, no tools.

1. **RAM ceiling.** Peak memory of the runtime, with the model loaded **at the configured window**, stays inside the
   container limit, and the limit leaves the CRM its p95/p99 (MP-05 baseline) with the worker and browser running. Free
   memory measured today is the outer bound, not the ceiling.
2. **Context window at least the input size.** The effective window holds the instruction, the group schema, the answer
   and correction reserves, and a typical detail page uncut (MP-02 sizes). The input ceiling follows the window (§2.1), so
   a smaller window is legal only while it still holds such a page. Note: the package caps input at
   `MAX_EXTRACTION_INPUT_CHARS` (50 000) while plan Task 5.4 defaults to 60 000 characters; the local ceiling applies
   below both.
3. **JSON-schema enforcement on the pinned runtime**, for this model, through the OpenAI-compatible endpoint. A model
   that answers empty under the schema fails, whatever it answers without one.
4. **A licence that permits commercial use**, read at the pinned digest and recorded.
5. **Sufficient for our tasks:** the small dose of §5.4 passes MP-03's accuracy, grounding and schema-valid thresholds on
   the labelled set, on Ukrainian and English pages alike.
6. **Wall time:** one record, all groups asked, fits the workload definition of §8.2, on the shared CPU, cold load
   included.
7. **A disconnect stops generation** on the pinned runtime (§5.5): a call that was aborted must not keep the CPU busy.

**The pick is made by MP-04, not here.** Candidates to start from, **all unverified** (fit, licence, schema behaviour and
availability on the runtime are for 5.4c-0 and MP-04): small quantised open-weight text models of the Qwen, Gemma, Phi and
Llama families. Being in this list is not a recommendation, and the Qwen family's use in VCF is not evidence for this host.

**Runtime**, from plan Task 5.2 (OpenAI-compatible, enforcing JSON schema: Ollama's OpenAI endpoint, llama.cpp server or
vLLM, confirmed on the pinned version; one that needs a GPU drops out; concurrency 1), made verifiable. 5.4c-8 checks each
item on the host:

- **Network:** a dedicated `internal: true` network shared only with the extraction worker; no API, nginx or collection worker
  on it and **no `ports:`**, because published ports bypass the host firewall and these runtimes commonly serve without auth. An
  outbound attempt from the container fails.
- **Logs:** request and prompt logging off (§4 item 2). A marker prompt is sent and is absent from the container log.
- **Supply chain:** image pinned by `sha256` digest; weights fetched at provisioning by digest, verified after fetch, in a
  non-executable format (GGUF or safetensors, never pickle, no remote code).
- **Container:** non-root, `no-new-privileges`, capabilities dropped, CPU, RAM, thread and pids limits.

### 8.4 The strategy: mandatory behaviour of the local route

What keeps a small model from failing on every prompt. None of it is optional and none has a config switch; a route that
cannot satisfy it is not the local route.

| Behaviour                                                                                                                                                                                                                           | VCF origin                                                      | In the CRM                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Small dose:** the full schema is never sent to a model that cannot answer it                                                                                                                                                      | `DosedCall`, `callDosed`, `SmallDoseNeeded`, `pinnedLocal`      | §5.4, task 5.4c-6                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Refuse, never truncate:** a prompt that does not fit is an error before it is sent. VCF's runtime kept the tail and dropped the instructions at the top, silently: here that would drop the untrusted-data rule and keep the page | `promptFits`, `estimateTokens`, `ANSWER_RESERVE_TOKENS`         | `PROMPT_TOO_LARGE` (§5.1), checked per HTTP request with the correction reserved. Only code cuts text, only the page text, and it reports `truncated`. The estimate is conservative and tuned on our text: VCF's constants are starting values, and Cyrillic tokenises differently, so MP-04 compares the estimate with the runtime's reported prompt tokens                                                                 |
| **The window is set, and checked:** a runtime default smaller than the configured window is the same silent truncation by another route                                                                                             | `num_ctx` on every request                                      | No candidate runtime takes a per-request window on its OpenAI-compatible endpoint (5.4c-0): 5.4c-8 sets it server-wide (`OLLAMA_CONTEXT_LENGTH`, default 4096; llama.cpp `--ctx-size`; vLLM `--max-model-len`), and the route's configured window is that same value. 5.4c-8 verifies it with a prompt near the window whose answer depends on a marker at its **head**, and repeats that after any runtime or digest change |
| **Input sized to the window**                                                                                                                                                                                                       | `promptBudget`                                                  | input ceiling helper, consumed by `buildExtractionPrompt` (§2.1)                                                                                                                                                                                                                                                                                                                                                             |
| **Preflight** before a cycle; no answer stops the model stage only, and a durable signal stays up                                                                                                                                   | `PREFLIGHT_PROMPT`, `PREFLIGHT_BACKOFF_MS`, `MODEL_UNREACHABLE` | §5.3, task 5.4c-4                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Wall-clock ceiling** on one logical call, and a stop that stops                                                                                                                                                                   | `boundExecutor`                                                 | §5.5                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **A slow answer is not a dead one:** Node's fetch gave up waiting for headers at 300 s, so an unstreamed answer past that died as "fetch failed" whatever the timeout said                                                          | `stream: true`                                                  | The per-request timeout is set by MP-04 (the package default is 60 s, plan Task 5.4 says 120 s). The local route's config refuses a timeout of 300 s or more until the leaf streams; if MP-04 needs one, streaming is added then                                                                                                                                                                                             |
| **An empty answer is a failure**                                                                                                                                                                                                    | "returned no content"                                           | `INVALID_OUTPUT` (§5.1), never "nothing found"                                                                                                                                                                                                                                                                                                                                                                               |
| **No decoder sees a length, and the answer is bounded another way:** a grammar closes a string where `maxLength` runs out, and the cut text parses and passes. Without a bound a looping decoder runs to the timeout                | `withoutLengths`                                                | The schema sent to any route is rendered without `maxLength`; lengths hold in local Zod validation. Array bounds stay. Every local request sets `max_tokens` from its group's `maxAnswerTokens`, every probe a small constant; a truncated answer is `INVALID_OUTPUT`                                                                                                                                                        |
| **Structured and deterministic:** the schema enforced by the runtime, temperature 0                                                                                                                                                 | `format`, `temperature: 0`                                      | Task 5.4c-1. Today the shared chat call sends no `response_format` and temperature 0.1, so this is a change for the router's local route only; `provider: local` keeps its behaviour                                                                                                                                                                                                                                         |
| **Code first:** what code can decide is not asked                                                                                                                                                                                   | `pickPayoffLine`, skipped `planBeats`                           | §5.4; a group with no missing field is not asked                                                                                                                                                                                                                                                                                                                                                                             |

**Model-specific or hardware-specific in VCF, and not adopted as a rule:**

- **The thinking-mode workaround** (`SKIP_REASONING`, an empty closed `<think>` prefill, and `think: false`). VCF's own
  notes show the behaviour differs between two models of one family. For the CRM it is an MP-04 observation, not a rule:
  reasoning output costs wall time and may empty a schema answer, so a candidate shows it under criteria 3 and 6. If the
  chosen model needs a flag, it is recorded beside that model's pin and leaves with it.
- **Free-text answers read by word matching** (`frameAnswer`, no `format`): it exists because a vision model answered
  empty under a schema. Criterion 3 requires schema enforcement, so groups answer in schema. Reconsider only if no
  candidate passes that criterion, and that would be a change to this ADR.
- **Vision routing, image token budgets, frame scaling, `wsl-gateway` resolution, Ollama's native `/api/chat`.**
- **`unloadModel` and `keep_alive`** as VCF sets them: they solve VRAM contention with a transcriber on a 6 GB card. The
  CRM's analogue is RAM shared with the CRM, so how long the model stays resident between cycles is a value MP-04 chooses
  and the container limit bounds, not VCF's ten minutes.
- **VCF's values:** `LOCAL_CONTEXT_TOKENS`, its ten-minute timeout, `MAX_READINGS_PER_RUN` (the CRM's shared 20-call budget
  stands).

VCF's notes also say a bigger server with a model that holds a JSON schema would make its frame decomposition
unnecessary. That is why the field-group table is tunable down to one group (§5.4) rather than fixed.

### 8.5 If no model passes on the VPS — owner decision D8 (A3, asked only then)

No automatic fall-back. The router's schema requires the local route, so **hosted routes do not run without a floor**:
"everything must work on the local model alone" is what that requirement enforces. Per the plan, the owner chooses:

- **Another host** for the runtime, reached over HTTPS on a private address (§3.3); same criteria, re-measured there; or
- **Deterministic HTML with model extraction disabled** (plan Task 5.2 allows it): the deterministic stages ship, and
  sources or fields that need a model wait.

Running hosted routes with no floor would be a reversal of the 2026-10-18 rule, and only the owner can make it.

### 8.6 Installation is an owner action

Nothing here authorises an agent to touch production. DevOps prepares and documents (tasks 5.4c-7, 5.4c-8); **the owner
runs every production step, or instructs it explicitly at that moment** (A3: prod). Undo: stop and remove the container and
its **weights** volume, not the worker's state volume; the preflight then fails loudly, the model stage does not start, and
the deterministic stages and the CRM carry on.

**A merged change must not be able to start the runtime on production.** `deploy-stack-on-vps.sh` runs `up -d
--remove-orphans` on `docker-compose.prod.yml` with no service list, so a service added to that file starts on the next
deploy and takes RAM from the CRM. Task 5.4c-7 (DevOps) therefore:

- puts the runtime and the extraction worker in a **separate compose file with its own project name**, which the deploy script
  does not name. A CI assertion fails if the composed deploy configuration (`docker-compose.prod.yml` with the
  `docker-compose.ghcr.yml` overlay) gains a model service or the deploy script names that file;
- gives the runtime network to that project, because a foreign container on a network of the main stack could fail the
  `down --remove-orphans` of the deploy's network-reset path, and a missing external network would fail its `up`. How the §2.4
  network crosses projects, surviving deploys and coupling neither, is that task's to settle and rehearse;
- **tests on the disposable host, by rehearsing both deploy paths with the runtime up**, that it survives and stays
  reachable. Orphan removal is expected to be scoped by project; that was read from the script's flags and is unverified,
  hence the test. A profile in the main file is rejected because it does depend on how `--remove-orphans` treats inactive
  profiles.

The existing `local` adapter admits a loopback base URL only, and the router's local route has its own URL key and transport
option (§3.3), so `provider: local` stays as it is, for loopback use. **Amended 2026-11-08:** that adapter is not deployed for extraction (amendment item 1); it stays in the code only for a loopback development run.

---

## Consequences

> **Amended 2026-11-08 (hosted-only).** The bullets below are the record of the local-model plan. What changes:
>
> - **Positive.** No model runtime on the CRM host: no memory or CPU taken from the CRM, no install guards, no model
>   measurement before production. Three free providers instead of two widen the daily capacity; OpenRouter alone adds
>   1000 free requests per day. The small dose and its table are gone, so a call is one request per route attempt.
> - **Negative.** There is no floor. A day when every route is limit-blocked is a day with **no model extraction**: the
>   records stay owed and are retried on a later cycle, and the user sees the owner's localized notice (H.8) instead of
>   slow results. Extraction now depends entirely on three third parties' free terms, which change without notice.
> - **Privacy, accepted (D11).** OpenRouter may let its upstream providers keep and train on what it sends. Only public
>   vacancy text is sent, and only after `stripContacts`. That makes the contact-stripping guard the load-bearing privacy
>   control on every hosted route; a regression there is a privacy defect, and the per-provider tests of H.9 exist to
>   catch it.
> - **Risks.** A free model id that stops being free is caught by four independent checks (§3.5), and the key's $0 limit is
>   the last one; a pricing field the parser does not know fails closed. Reset times for Groq and OpenRouter are
>   UNVERIFIED (H.7), so the notice may show longer than needed. D10 still drops a true field the model did not quote.

- **Positive.** The owner's chain arrives behind `ExtractionPort` with an unchanged result type. Local-only is the working
  state from the install; hosted routes are additive. Pacing below the providers' limits makes "refused" the exception.
  Every fall and every failure is an event with a code. The local floor is dosed from its first call, so it does not depend
  on a measurement to stop failing. A cycle's cancellation now truly stops the router's sending, which main could not do;
  `local` and `openrouter` keep their bounded hold, and they stop only at their next request timeout.
- **Negative.** Logic similar to VCF's is maintained twice, by hand. A second process, with an authenticated entry and a secret
  to provision (§2.4). The merged 5.4b port and structurer change: a signal, a real schema, a derived hold. The worker needs a
  persistent volume for two small state files. The hosted model ids in use
  change without a PR (D6): a refresh can add a model nobody reviewed — bounded by the provider allowlist, the Groq family
  pattern, the Gemini family pattern, id validation and `TARGET`. Two providers mean two sets of terms, keys and egress rules
  to keep current. A small dose costs one prompt evaluation per group, so floor extraction is slow by construction, and a
  cycle over its local-time limit leaves records due. The input ceiling cuts long pages for hosted routes too. The local
  model takes memory and CPU from the CRM's own host; the container limits bound that, and MP-04 measures it.
- **Privacy, accepted.** D1 and D2 trade the per-source local-only default for simplicity and capacity. The residual risk
  is stated in §4.1 and accepted by the owner. No configuration keeps one source local; a source is stopped from reaching
  any model by disabling it or building its provider without `model`.
- **Probation is weaker than it looks (SR LOW notes).** "Serves only when every older model failed" is **routine**, not
  rare: free tiers hit their daily limits most days, so once the older models of a provider are spent, its tail
  (unreviewed, on-probation) models answer real vacancy text regularly. Probation limits ordering, not exposure; the
  exposure bounds are the provider allowlist, the patterns and id validation. Conversely, a provider that is busy
  (`transient`) on probe days resets streaks and can **delay promotion indefinitely** — this fails safe (the model stays
  at the tail) and costs only ordering quality.
- **Risks.** Provider error formats change silently: a per-day 429 read as `BUSY` costs a few wasted requests, not a
  failure (the cascade moves on), and the fixtures make the drift visible when updated. No model may pass on this host:
  the gate is MP-04 and the answer is D8, with model extraction waiting rather than failing. Field groups may lose
  cross-field context a full schema would have kept: MP-03 measures it and tunes the table. With two hosted providers, a
  day both are spent is a floor-only day: slower, loud, and correct. D10 drops a true field the model did not quote (§5.4).
  MP-04's local result may not hold on the VPS; the post-install smoke catches that. A compromised collection worker can
  defeat `ai-input=no` (§2.4).

## Rollback

**Amended 2026-11-08 (hosted-only).** These rows apply from 5.4c-H1 on. The table after them is the record of the
local-model plan; its "Local model" and "Small-dose table" rows are moot, and its runtime rows no longer leave a floor.

| Level                                   | Command / action                                                                                                                                                                                    | Expected state                                                                                         | Verification                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Runtime, instant — the privacy rollback | Remove `GEMINI_API_KEY`, `GROQ_API_KEY` and `OPENROUTER_API_KEY` from the worker env, restart. Text already sent is not recalled                                                                    | No route is configured: extraction reports `NOT_CONFIGURED`, deterministic stages and the CRM carry on | No request to any provider host in egress logs; router events list no attempt                       |
| OpenRouter only                         | Remove `OPENROUTER_API_KEY` from the worker env, restart. Or revoke the key in the OpenRouter dashboard (owner action)                                                                              | The chain keeps Gemini and Groq                                                                        | Router events list no `openrouter` attempt; no request to `openrouter.ai`                           |
| One other provider                      | Remove that provider's key from the worker env                                                                                                                                                      | That route does not exist; the chain keeps the rest                                                    | Router events list no attempt for that provider                                                     |
| UI notice (5.4c-H4)                     | `git revert` the H4 PR                                                                                                                                                                              | The field and banners are gone; the limits flag still records the state                                | The queue response has no `sourcingNotice`; `pnpm --filter @crm/web typecheck` green                |
| Code (5.4c-H1..H3)                      | `git revert` the PRs, newest first. Reverting H1 restores a schema that **requires** a local route, so a hosted-only config then fails closed and extraction stops until one exists; no text leaves | `@crm/inference` back to the pre-amendment router                                                      | `pnpm --filter @crm/inference test` and the API inference specs green                               |
| Health-flag DDL (5.4c-H2)               | Owner-run reverse DDL from the H2 PR body: narrow the CHECK constraints back only after deleting or remapping rows that carry the new values (A3: prod data)                                        | Constraints match the reverted code                                                                    | `SELECT` of the constraint definitions; no row violates them                                        |
| This amendment                          | `git revert` its squash commit                                                                                                                                                                      | The ADR and plan describe the local-model plan again; no code changes                                  | `grep -c "Amendment 2026-11-08" docs/architecture/2026-11-03-extraction-model-router.md` prints `0` |

| Level                                   | Command / action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Expected state                                                                                    | Verification                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Runtime, instant — the privacy rollback | Remove `GEMINI_API_KEY` and `GROQ_API_KEY` from the worker env, restart. **Not** `INFERENCE_EXTRACTION_PROVIDER=openrouter`: that sends text to a hosted route. Text already sent is not recalled                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Router with the floor alone; no hosted request, and self-heal has nothing to refresh              | Router events list only the local route; no request to a hosted host in egress logs                         |
| Hosted, one provider                    | Remove that provider's key from the worker env                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | That route does not exist; the chain keeps the rest and the floor                                 | Router events list no attempt for that provider                                                             |
| Self-heal only                          | Disable the daily refresh job; delete the managed-list file to return to the pinned fallback lists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Request-time retirement still works; lists stop changing                                          | `managedModels` events name the fallback; no listing request in egress logs                                 |
| Per source                              | Disable the source, or build its `HtmlProvider` without `model`. Setting `onUnspecified` is not this control: it affects only an `unspecified` signal, and a source whose robots say `yes` is allowed whatever the policy                                                                                                                                                                                                                                                                                                                                                                                                                                 | That source's text reaches no route                                                               | Its report's model stage is `SKIPPED`; no model event and no budget reservation for its records             |
| Local model (owner-run, §8.6)           | Stop and remove the runtime container and its weights volume; keep the worker's state volume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Preflight fails loudly, the model stage does not start, deterministic stages and the CRM carry on | "Model unreachable" health signal up; CRM p95 back to baseline                                              |
| Small-dose table                        | Revert the table to its previous reviewed edition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The same hand-back and runner with the previous groups                                            | Per-group events name the previous groups                                                                   |
| Code                                    | Set `INFERENCE_EXTRACTION_PROVIDER=local` first (a reverted env schema no longer accepts `router`), then `git revert` the 5.4c-n PR(s), newest first. `ROUTER_LOCAL_MODEL_URL` may stay: it is a separate key, the reverted schema drops unknown keys (no `.strict()` on it), and `LOCAL_MODEL_URL` was never widened, so the API still boots. `local` reaches loopback only, so with the runtime in its own container extraction reports `NOT_CONFIGURED` or `PROVIDER_ERROR` until wiring is restored. No text leaves, but **coverage is lost**: main's code clears those records on either code, so they get no model pass until their content changes | `@crm/inference` back to `local` / `openrouter`; no schema migration to undo                      | `pnpm --filter @crm/inference test` and the API inference specs green; the API boots with the key still set |
| This ADR                                | Close or revert its PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | No decision recorded; 5.4b unaffected                                                             | `docs/architecture/` no longer lists the file                                                               |

## Sources

- Owner decision 2026-10-18 and the Task 5.4 amendment of 2026-11-03: `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`
  (§"Model split — owner decision, 2026-10-18"; the owner's VPS capacity answer; Tasks 5.2, 5.4, 5.5; MP-03, MP-04, MP-05).
- Owner corrections and decisions D1–D3, 2026-11-04, relayed by Master; D6, 2026-11-03, relayed by Master.
- `docs/runbooks/deployment.md` — target VPS and what shares it.
- Task files for 5.4a (guards) and 5.4b (`HtmlStructurer`, `ModelBudgetPort`) — Master's task set of 2026-11-03.
- `@crm/inference`: `ExtractionPort`, `ExtractionRequest`, `MAX_EXTRACTION_INPUT_CHARS`, `MAX_EXTRACTION_INSTRUCTION_CHARS`,
  `MAX_CORRECTION_CHARS`, `InferenceErrorCode`, `inferenceConfigSchema`, `InferenceClient`, `createLocalExtractionAdapter`
  (loopback only), `createOpenRouterExtractionAdapter`, `sendChatCompletion` (already sends `data_collection: deny` for
  `openrouter`; no `response_format` or `max_tokens`; temperature 0.1), `isModelUnavailable`, `selectModel`,
  `boundedRequest` and `isUrlAllowed`, `DEFAULT_TIMEOUT_MS`.
- `apps/api` job sourcing, read at main `10e99b08`: `ModelStructurer`, `EXTRACTOR_FAILED`, `stripContacts`, `assertModelAllowed`, `DEFAULT_STRUCTURER_TIMEOUT_MS`,
  `DEFAULT_ABANDONED_HOLD_MS`, `BY_INFERENCE_CODE`, `assertModelAllowed`, `buildExtractionPrompt`, `MAX_MODEL_INPUT_CHARS`,
  `EXTRACTION_SYSTEM_PROMPT`, `guardExtractionResult`, `DiscoveredRecord`, `HtmlProvider`; `validateEnv` and the
  `LOCAL_MODEL_URL` refine. `docker-compose.prod.yml` and `deploy-stack-on-vps.sh`.
- API: `buildInferenceConfig`, `InferenceModelResolverService`, the env schema's optional inference keys,
  `ModelUsage`, `settleModelPending`, `MODEL_BACKOFF_MS`, `MODEL_FILLABLE_FIELDS`.
- VideoContentFactory (read-only, 2026-11-03): `createChainExecutor`, `createFittingChainExecutor`,
  `createBalancedChainExecutor`, `createHybridExecutor`, `budgetGuarded`, `providerBudget`, `consumeQuota`,
  `createOpenAICompatExecutor` (`DAILY_LIMIT`, `COMPAT_MIN_GAP_MS`), `createGeminiExecutor` (`MIN_CALL_GAP_MS`,
  `BUSY_BACKOFF_MS`), `SpentStore`, `RetiredStore`, `retiredAnswer`, `classifyModelStatus`, `pickLiveModels`, the
  preflight constants, `boundExecutor`, `DosedCall` / `callDosed` / `SmallDoseNeeded`; its knowledge notes on model
  backends and per-call doses; its free-provider guide (card-requiring providers rejected) and provider-balancing plan;
  for self-heal (D6): its daily free-model refresh script (`PROBE_CAP`, `TARGET`, the fixed JSON probe prompt, the
  per-provider independence, the retirement reset after a fully successful run), `pickGroqModels`, `pickLiveModels`,
  `MIN_MANAGED_CONTEXT`, `parseModelFile` / `formatModelFile`, `managedModels` (pinned fallback on a missing or empty
  file), and the weekly chain check with its `MODEL_LIST_STALE` marker.
- VideoContentFactory for §5.4 and §8 (read-only, 2026-11-04, from the owner's Windows checkout at its commit `c18c40ca`
  of 2026-11-01, not the WSL copy): `dosePlanFor`, `pinnedLocal`, `withSmallDoseBehind`, `promptFits`, `estimateTokens`,
  `ANSWER_RESERVE_TOKENS`, `promptBudget`, `createOllamaExecutor`, `SKIP_REASONING`, `withoutLengths`, `unloadModel`,
  `MODEL_DOWN_FRESH_HOURS`, and the knowledge notes `llm-backends` and `model-call-doses`.
- Provider and runtime facts: `docs/architecture/2026-11-04-extraction-provider-facts.md` (5.4c-0, read 2026-11-04); what
  it could not settle is listed in §2.3. Nothing in this ADR was fetched from the network.
- **Amendment 2026-11-08:** the owner's hosted-only decision, the $10 OpenRouter credit purchase (which raises the `:free`
  limit to 1000 requests per day) and the localized notice text, relayed by Master; the owner's D11 answer on
  `data_collection`, relayed by Master. The MP-04 result that preceded the decision, and the OpenRouter facts in §3.5 and
  H.9, are as relayed; OpenRouter's limits, reset time and error bodies stay **UNVERIFIED** until the 5.4c-5 smoke. The
  code symbols named in H.1–H.8 were read at origin/main `10517861`.
