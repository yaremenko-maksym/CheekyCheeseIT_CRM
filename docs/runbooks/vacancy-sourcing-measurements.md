# Vacancy sourcing — measurement log (MP-01 … MP-14)

**For:** whoever runs a measurement that a vacancy-sourcing activation decision waits on, and whoever reads
one before that decision.
**Source of the questions:** plan r5 §8 "Measurement plan" (`docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`).
**Companion:** `docs/runbooks/vacancy-sourcing.md` (operations), Task 8.2 checklist there.

---

## Rules for every entry

1. **Thresholds are frozen before the run.** Write the pass condition into the entry first, commit it, then run.
   A threshold written after the numbers is not a gate.
2. **Never the live CRM database.** Measurements run on a scratch or QA database (`DATABASE_URL` inline in the
   command, never `export`), or read production through aggregates only (Task 8.3). See
   `.claude/rules/common/live-db-access.md`.
3. **Network traffic obeys the access hygiene of Task 2.2**: bounded requests, the per-host gap, stop at the first
   challenge, 403 on an allowed route, or 429 without `Retry-After`. External GETs to job sites need the owner's
   explicit "go" in the chat.
4. **An entry names its run ID** (the `job_source_runs` run id, a CI run URL, or a harness output directory) so a
   reader can find the raw data. A number without a run ID is a claim, not a measurement.
5. **A missing measurement blocks only the decision it feeds** (plan §8). It never blocks unrelated work.
6. **Public text aggregates only**: no candidate, employer contact or personal data in an entry.

## Entry template

```markdown
### MP-NN — <date YYYY-MM-DD> — <one-line question>

- **Threshold (frozen <date>, by <owner/reviewer>):** <pass condition>
- **Method:** <what was run, harness or query, version / commit sha>
- **Environment:** <scratch DB name / host / "production, read-only aggregates">
- **Sample:** <volume, stratification, period>
- **Run ID:** <id / URL / output directory>
- **Raw numbers:** <table or list>
- **Result:** PASS | FAIL | INCONCLUSIVE (<why>)
- **Decision:** <what this unlocks or blocks>
- **Consuming task:** <plan task id>
```

---

## Status board

State as of 2026-11-14. "No recorded run" means no dated entry exists in this file or elsewhere in the repository
(checked by a repository-wide search for the measurement id); it is not a negative result.

| ID    | Question                                         | Unlocks                                                | State                                                                 |
| ----- | ------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------- |
| MP-01 | Which permitted HTML routes need JS rendering?   | HTML engine (5.1)                                      | no recorded run                                                       |
| MP-02 | Response size / pagination per source            | per-source byte cap or list+detail mode (2.2)          | no recorded run                                                       |
| MP-03 | Which model route extracts well enough, at what cost | route, model, fallback settings (5.2)              | local candidate only (see MP-04 entry); hosted routes not measured    |
| MP-04 | Can a local model run on the target host?        | local vs hosted (5.2)                                  | **FAIL, 2026-11-08** — local runtime withdrawn                        |
| MP-05 | Host headroom and worker needs                   | resource, lease and timeout caps (2.5, 4.2, 4.6)       | no recorded run; run-ownership caps wait on it                        |
| MP-06 | Do unchanged postings create revisions?          | normalizer fixes (2.1)                                 | no recorded run (needs shadow collection)                             |
| MP-07 | Storage growth                                   | retention, disk / backup budget (1.4)                  | no recorded run (needs shadow collection)                             |
| MP-08 | Relevance good enough to expand?                 | expansion gate (8.2)                                   | no labelled corpus yet                                                |
| MP-09 | Triage share and backlog age                     | triage ceiling (8.2)                                   | needs live HR traffic (wave 2+)                                       |
| MP-10 | Configurations worth their cost?                 | cadence / disable (8.2)                                | needs live traffic (wave 3+)                                          |
| MP-11 | Any source close to blocking us?                 | per-host gap, ceiling, pause rules (2.2)               | continuous once any source runs                                       |
| MP-12 | Associations correct?                            | association rules (4.3)                                | no labelled pairs yet                                                 |
| MP-13 | Queue queries fast at projected volume?          | indexes, generation retention (6.2)                    | no recorded run at MP-07 size (backlog 351)                           |
| MP-14 | Queue freshness                                  | source cadence (2.5)                                   | needs live traffic (wave 3+)                                          |

**Order that unblocks the first activation wave (Task 8.2):** MP-05 baseline and MP-02 for the wave-1 sources first
(they freeze the caps), then MP-06 / MP-07 from a shadow run, then MP-13 at MP-07 size. MP-01 matters only once an HTML
source is proposed. MP-03 matters only once model extraction is proposed for a source.

---

## Entries

### MP-04 — 2026-11-08 — Can a local model run on the production host?

- **Threshold:** the frozen pass table of ADR `docs/architecture/2026-11-03-extraction-model-router.md` (§8.3 / §8.4).
  Abort rule of the harness: any CRM probe 5xx or no answer, rolling p95 above 2 × baseline, or host RAM under 800 MiB.
- **Method:** `scripts/devops/extraction-mp04/mp04.mjs` over the 50 synthetic pages of its fixtures, through
  `ModelStructurer.structure` on a local-only router (procedure: `docs/runbooks/extraction-worker.md`, section
  "MP-04 / MP-03").
- **Environment:** the production host, owner-run replay (A3).
- **Sample:** one candidate, qwen2.5-1.5b.
- **Run ID:** owner-run harness output directory; no copy found in the repository. The numbers below are taken from
  the ADR amendment of 2026-11-08, not from the raw report.
- **Raw numbers:** schema-valid rate 0.68 (uk) and 0.32 (en); field accuracy 0.16 and 0.14; after an abort the CPU
  stayed busy for 36 s against a 10 s limit. The owner stopped the replay.
- **Result:** FAIL.
- **Decision:** no local LLM runtime on the server, ever, for extraction. The extraction compose project, weights
  volume and images were removed from production. The router uses free hosted models only (Gemini, Groq, OpenRouter
  `:free`).
- **Consuming task:** 5.2 / 5.4c-7.
- **Follow-up:** `docs/runbooks/extraction-worker.md` still describes the local runtime install; it is historical
  until rewritten for the hosted-only worker.
