# Vacancy queue relevance via Jev — design

Status: approved by the owner in chat 2026-11-24 (weights and percent semantics chosen explicitly;
the rest are Master's calls, listed below). Merge-when-ready for the PRs of this design.

## Intent

The HR vacancy queue (`/job-queue`) must put on top the vacancies that fit a senior best. Today the
order is freshness plus a count of role-matched seniors; the resume-skills overlap ("k of n skills")
is a keyword match and is display-only. The owner wants Jev to judge how well a senior's resume
technologies and specialty fit the vacancy description, and that judgement to drive the order.

## Owner decisions

1. With several seniors, the vacancy is ranked by its **best** senior (highest relevance).
2. Relevance matters more than freshness: `score = 100·e^(−age/7) + 300·fit − penalties`, `fit ∈ [0,1]`.
   At equal fit the fresher vacancy wins; a strong old vacancy beats a weak fresh one.
3. Every senior on the queue card shows a **percentage** = Jev fit only (`round(100·fit)`). The date is
   not in the percentage; it affects only the order.

## Goals / non-goals / anti-goals

- Goals: Jev-graded fit per (vacancy, senior); order by best senior's score; percent per senior on the card.
- Non-goals: changing eligibility gates, role classification, exclusions, the senior's interview card,
  re-tuning penalties.
- Anti-goals: a vacancy disappearing or sinking to the bottom because Jev is down or has not graded it
  yet; a `0%` shown for "not graded"; resume personal data (names, contacts, employers) sent to Jev.

## Approaches considered

- **A (picked): async Jev pass + stored grade, pure `evaluate` reads it.** Same shape as `role-ai`
  (client, store, pass, cron, flag). Keeps `evaluate`/`rank` pure and the queue read path unchanged.
- B: call Jev inside recompute. Rejected: `evaluate` is pure and synchronous by contract; a network call
  under the recompute row lock would stall the worker and break determinism.
- C: improve the deterministic keyword overlap instead of Jev. Rejected: the owner asked for Jev, and
  `jev-first.md` routes a relevance grade to Jev.

## Design

- **Jev question (Master's call):** one `DecisionPort` request per vacancy, one `score` question per
  role-matched senior (≤ 50 per request, chunk above), 5 levels
  (no fit / weak / partial / strong / excellent). `fit = value / 4`, clamped to `[0,1]` (a fractional
  value is allowed by the adapter). State: the vacancy (title, description, technical roles) and, per
  senior, an opaque key, the senior's technical roles (specialty) and canonical resume skills. Nothing
  else from the resume. Instruction says to treat the state as data.
  `Jev-first: vacancy↔senior fit -> Jev (score)`.
- **Storage:** a new table keyed by `(opportunity_id, senior_id)` holding `fit`, the input digest
  (vacancy revision/description hash + the senior's `profileVersion`), grader version, status and
  retry bookkeeping (attempts, next attempt). Only the raw grade is stored; the composite stays in
  `rank.ts`, so a re-weighting is a code change, not a migration.
- **Pass:** cron like `role-ai` behind a new env flag (default off, enabled in `deploy.yml`), picks
  role-matched (LEAD) opportunities whose pairs lack a fit for the current digest; on landing a grade
  it enqueues the opportunity dirty (`enqueueDirty` with its own reason). Failures back off; a Jev
  outage turns Jev off for the rest of the pass.
- **Rank:** per-senior score as decision 2. Specialty enters through Jev (roles in the state).
  A pair with no fit yet uses a neutral `fit = 0.5` for ranking and shows **no** percent.
  The team/studio rank becomes `max(senior score)` — the count bonus in `rankSelect` is removed
  (decision 1). `rank_score` stays an integer clamped to `0..1000`.
- **Recompute:** the fits become an `evaluate` input; `opportunityInputsVersion` must include them so
  reconciliation sees a changed grade; `EVALUATE_RULE_VERSION` is bumped (full gradual recompute).
- **API/UI:** the per-senior card schema gains a nullable `relevancePercent`; `MatchedSeniors.tsx`
  shows it next to each senior (`uk` + `en` Lingui strings; nothing when null).

## Slicing (each PR mergeable alone)

1. Table + manual DDL + prod wiring + Jev client + pass + cron + flag (no rank change).
2. `evaluate` input + rank formula + `rankSelect` max + rule-version bump + `relevancePercent` in the DTO.
3. UI percent in `MatchedSeniors.tsx`.

## Left to the builder

Exact table/column names, the dirty reason string, pass limit and cadence (start with role-ai's 20 /
10 min), and the level descriptions' wording.
