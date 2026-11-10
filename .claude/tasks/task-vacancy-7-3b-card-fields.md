# task-vacancy-7-3b-card-fields — Task 7.3b: the card API returns the fields the design requires (backlog item 396)

## Agent: coder

## Status: ready (Task 7.4, PR #1306, merged into `main`)

## Blockers: none

## Priority: high

## Model: opus

## Depends on: Task 7.4 (#1306) merged into `main`

## Branch: feature/vacancy-7-3b-card-fields

## Design tier: 2 (edit to the existing card; spec `docs/design/vacancy-queue.md` §5.1, §5.2, §5.5, §5.6, §5.8, §5.9 is the reference)

## Context

The card response (`GET /job-queue/:id`, `jobQueueCardResponseSchema` in `packages/shared/src/schemas/job-sourcing.ts`)
lacks fields the design requires, so the 7.3 card renders without them (backlog item 396, SPEC-M-2 of #1302). Two more gaps
came out of the 7.4 reviews:

- **Re-hide after undo (QA-MED-1 of #1306).** «Приховати» → «Скасувати» → reload → «Приховати» answers 409 forever: after a
  reload the client does not know the dismissal version. The owner accepted (decision brief Q2, 2026-11-10) one card field:
  `dismissal: { scope, version } | null`.
- **Zero-match vs triage.** A vacancy whose every matched senior is stop-listed and one that matched nobody both arrive as
  `TRIAGE`; the web tells them apart only by `stopListedSeniorCount`.

Cross-zone (api ↔ shared ↔ web). The card is scoped data: every new field obeys the visibility matrix (design §3).

## Concrete changes

1. `packages/shared/src/schemas/job-sourcing.ts` — extend the card schema (and the per-senior card schema) with:
   - terms: engagement form (`B2B` / employment / not stated) and a «salary not stated» flag (§5.1, `job-queue-terms`);
   - last seen at source (§5.1 meta);
   - the full vacancy stack (§5.1 «Збіг стеку»);
   - per senior: availability (free from <date> / busy) and the «Чому збіг» evidence (§5.2);
   - ADMIN only: the team of each senior (id + name) for the team headings (§5.6); absent for HR;
   - ADMIN only: the `policyVersion` the triage grant request needs (`jobQueueTeamTriageGrantRequestSchema`), consumed by
     Task 7.4b; absent for HR;
   - the own-team possible-duplicate line «На схожу вакансію вже подано: <назва> · <senior>» (§5.8), own team only;
   - an explicit empty-state reason that separates "matched nobody" from "every match is stop-listed" (§5.5), or a
     recorded decision that `stopListedSeniorCount` is enough (one line in Assumptions);
   - `dismissal: { scope, version } | null` — the actor's live dismissal in the actor's own scope (HR: own team; ADMIN:
     studio), `null` when none.
2. `apps/api/src/job-sourcing/queue/**` — the card read model fills those fields under the same scoping as the existing
   fields; integration specs on the real database (`crm_qa` or a scratch database).
3. `apps/web/app/components/job-queue/**` — render the new fields per the design sections above; the dismiss path uses
   `card.dismissal.version` after a reload (fixes the re-hide 409).
4. Lingui catalogs (`packages/shared/src/i18n/locales/{uk,en}`) for every new visible string.

## Reuse / Regression scope

- Masking contract of Task 6.4 / plan r5: a foreign submission stays `{ submittedElsewhere: true }`; no new field may carry a
  foreign team's id, name, submitter or timestamp to HR.
- `MatchedSeniors.tsx`, `JobQueueCard.tsx`, `JobQueueActions.tsx` tests from 7.3 / 7.4 stay green.

## RBAC

| Role         | Access                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| ADMIN        | every new field, studio-wide; team headings                                                              |
| HR (scoped)  | every new field inside the actor's team scope only; no team heading, no foreign data, own `dismissal`    |
| others       | no queue access (unchanged)                                                                              |

## Acceptance criteria

1. [ ] The keys of `jobQueueCardResponseSchema` cover every field named in design §5.1, §5.2, §5.6 and §5.8 (backlog 396
       "Verify"); each one is rendered on the card per its section.
2. [ ] HR never receives a foreign team's data through a new field: a real-DB integration spec asserts the raw JSON for an HR
       actor carries no other team's id, name, senior, submitter or timestamp (absence, not "did not parse").
3. [ ] ADMIN sees the seniors grouped under team headings (§5.6) and gets `policyVersion`; HR gets neither.
4. [ ] `dismissal`: hide → undo → reload → hide succeeds (no 409); the integration spec covers a dismissal in another
       scope (another team's dismissal is never returned to HR).
5. [ ] Zero-match vs every-match-stop-listed: the card shows the two empty states of §5.5 correctly, from an explicit field or
       a recorded decision.
6. [ ] i18n: every new string is a Lingui macro (source `uk`) with `en`; `pnpm i18n:extract` leaves no diff; `node
       scripts/devops/check-no-russian-letters.mjs` passes.
7. [ ] Responsive: no horizontal overflow at 320 / 375 / 768 / 1024 / 1280 / 1440 / 1920; touch targets ≥ 44 px.
8. [ ] Mutation gate: 0 survivors on the changed files (run by Master in WSL).

## Seams under test (Master proposes, Coder confirms BEFORE writing tests)

- The card read model through `GET /job-queue/:id` on a real database (integration spec), per role.
- `JobQueueCard` (rendered component) for the visible fields.

## Assumptions

- A1 (Master): if a field has no data source in the schema today (for example availability or evidence), the Coder does not
  invent one: run `decision-frontier` and report it; the rest of the task continues.

## Do not touch

- The triage assignment UI («Призначити команді…») — that is `task-vacancy-7-4b-triage-assign.md`, after this task.
- The list row and filters beyond what a renamed shared type strictly needs.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files from "Concrete changes".
2. Each AC: a named test or a `grep` for its `data-testid` / string.
3. `pnpm typecheck`; `pnpm --filter @crm/api test` with `DATABASE_URL` set inline to a scratch database.
4. Commit: `ac_verified: 1,...,8` and `vision: ✓ /job-queue`.
