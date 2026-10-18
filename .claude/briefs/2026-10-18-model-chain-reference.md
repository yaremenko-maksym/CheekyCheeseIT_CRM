# Reference: the VideoContentFactory model chain, for r5 Task 5.2 / 5.4

**Source:** the owner's VideoContentFactory project, relayed 2026-10-18 by the Claude session working in it, at the
owner's instruction ("спроси у сессии на контент фабрике"). Repo root `/Users/maksym/Desktop/programming/VideoContentFactory`,
read `main`. **Not yet read by me directly** — this file records what that session reported, with its symbol and file
addresses so the code can be read when Phase 5 starts.

**Status:** reference, not a decision. The decisions it serves are in the r5 plan §4 (local by default, free hosted
models as an accelerator) and Task 5.2. **Re-verify before building:** that project moves, and two of its premises
do not hold for us (see "Where it does not transfer").

---

## 1. Layering is per CALL, not global

`LLM_BACKEND=hybrid`; see `src/llm/executor.ts` — `executorFor`, `createHybridExecutor`.

- A short list of quality-sensitive "creative" calls (`DEFAULT_CREATIVE_CALLS`: headline, packaging, cutaway plan,
  semantic QC, analyst) goes to the **free hosted chain first**, with the local model behind the whole chain.
- Everything high-volume (readers, votes, proofreading, claims, topic gates) is **local primary**.
- Three hosted chains by call kind, in `creativeChainFor`: words `Groq→Gemini→OpenRouter`, images
  `Gemini→Groq→OpenRouter`, analyst `OpenRouter→Groq→Gemini`.

**Their owner's rule, since 2026-10-14, in their words:** the farm must produce a complete result on local alone;
slower is fine, silent loss is not. That is the same rule our owner stated for us, which is why this shape was
pointed at.

## 2. Router: static order plus three pre-call filters, and no latency measurement

- **Fit before call** — `src/lib/routeFit.ts`, `createFittingChainExecutor`: drop a route _before_ spending a request
  if the prompt will not fit that model's context window, or the model cannot take images. Trigger was Groq's free
  tier at ~8k against 11k prompts. It never strands a call: if nothing fits, try everything.
- **Rotation** — `createBalancedChainExecutor`: concurrent independent calls rotate which interchangeable provider
  goes first (Groq / OpenRouter). Gemini is `rotate:false` because its budget is reserved.
- **Self-counted quotas** — `budgetGuarded`, `geminiBudget` / `providerBudget`, caps in `src/config.ts` `quotaCaps`
  (Gemini 200/day, LLM 1500/day, an OpenRouter cap). Cap reached → skip that provider **without spending a request**.
- **Model lists are data, not code** — `scripts/refreshFreeModels.ts` (daily cron) writes `data/models/groq.txt` and
  `openrouter.txt`; `src/lib/managedModels.ts` reads them with a config fallback; `src/lib/modelChain.ts` parses ids
  carrying vision tags. `scripts/checkModelChain.ts` (weekly) pings every configured id with one tiny question, and a
  404 or renamed id writes a staleness marker (`src/lib/modelListStale.ts`) that the heartbeat and dashboard surface.

> **The reason this health check exists, and the single most transferable thing in this document:** a fallback cascade
> **hides a dead model perfectly** for as long as a live one follows it. They had **three dead at once on 2026-09-27
> and nothing noticed.** This is the same defect shape as our own ledger inversion on PR #1025 — a mechanism whose
> failure makes the system quieter rather than louder. Build the health check with the chain, not after it.

## 3. "Dosing" is two separate mechanisms

**(a) Pacing, so a provider does not start refusing.** One client-side gap per provider instance: `src/llm/gemini.ts`
`MIN_CALL_GAP_MS = 7000`, `src/llm/openaiCompat.ts` `COMPAT_MIN_GAP_MS = 3000`, implemented as a `nextFreeAt` clock —
effectively a one-concurrency queue per provider. A 429/503 meaning "busy" → backoff `BUSY_BACKOFF_MS = [9000, 25000]`
then the next model in the list. A 429 meaning **the day is spent** (Gemini `PerDay`, OpenAI-compatible `DAILY_LIMIT`
regex) → that model is skipped for the rest of the day immediately, with no retries.

**(b) Shaping the prompt to whichever model will answer.** `src/lib/dose.ts` — `callDosed`, `dosePlanFor` — plus a
per-call table in their `.claude/knowledge/model-call-doses.md`. A big hosted model receives the full structured
call; a small local model receives a decomposed version: one question at a time, plain words, output parsed by code —
one frame per call instead of twenty, one pick per round instead of a JSON array. The `full-then-small` path matters:
when the hosted chain fails at runtime the executor hands back `SmallDoseNeeded` rather than sending the full prompt
to a 4B model, **which answers empty**.

Also `src/lib/promptBudget.ts`: local `num_ctx` 16384, and **Ollama silently truncates the HEAD of an overlong
prompt — the instructions are what gets lost.** They window long inputs and make the Ollama executor refuse an
overflow loudly instead.

## 4. Failure handling

No checkpoint or resume at the LLM layer. All hosted budgets spent → the same call falls to local. Local unreachable →
`src/llm/preflight.ts` refuses to start a run **before anything is claimed** (`src/lib/modelDown.ts` writes a
`MODEL_UNREACHABLE` marker, fresh for 2h), so no item is ever marked failed because of a machine fault. Per item,
optional steps **degrade** (no headline, unproofread captions) rather than fail the item. Resumability lives at the
pipeline level: items stay in a queue state and a re-run picks them up.

## 5. Their local runtime

Ollama, on the Windows host of a WSL2 laptop (`ollama.ts` handles the `wsl-gateway` host name). Text `qwen3:8b`
(code default `qwen3.5:4b`), vision `qwen3-vl:4b`, default Ollama quantisation (Q4_K_M), reasoning off for short
structured calls (`src/lib/reasoning.ts`).

## 6. What they would do from day one

1. Ask whether the prompt fits **this** model's context before calling, and refuse an overflow loudly. Silent
   truncation on Ollama and 413s on free tiers cost them weeks of bad output.
2. Health-check the configured model ids on a schedule. A fallback chain makes dead models invisible.
3. Do not send the big structured prompt to the small model and hope. Write the small-dose version up front — small
   models return **empty** on big JSON schemas.
4. Count daily quotas yourself: provider 429 bodies are inconsistent, and per-minute and per-day look alike.
5. Test every call with a fixture and a fake executor keyed on the **call name**, never on prompt text — a double
   matching a phrase once silently answered everything.

---

## Where it does not transfer, and what we must measure ourselves

Two premises of theirs are false for us, and both bear on whether "local by default" is affordable here:

- **They have a GPU; we do not.** Their runtime is a laptop with an NVIDIA card. Our production host, measured
  2026-10-18: **4 CPU cores, 7.6 GB RAM (6.6 free), 41 GB disk free, no GPU.** They recorded **no tokens/second
  figure** and said explicitly not to plan on one from them. Their estimate for our box — a 3–4B Q4 model rather
  than 8B, and single-digit tokens/second — is an **estimate, not a measurement**, and is labelled as such.
- **Their box runs nothing else; ours runs the CRM.** A local model on our production host competes for CPU with
  Postgres, Redis and the API. MP-04 already asks for CRM p95 with and against the local runtime, and that
  measurement is now the one that decides whether local-by-default means a separate host, or batch work scheduled
  off-peak.

So MP-01 and MP-04 stay real open measurements; this document shortens the design, not the measuring.

**Their conclusion, which survives the difference:** a weaker local model makes dosing **more** important, not less —
short prompts, short outputs, one field family per call.

**Expiry:** re-read the source paths before building Phase 5, and at the latest by 2027-01-15, which is the plan's
own catalog-review date.
