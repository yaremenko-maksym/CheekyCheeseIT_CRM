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
5. [ ] The three empty states stay distinct: every match stop-listed (§5.4, `job-queue-seniors-stop-all`, already
       rendered from `stopListedSeniorCount`), triage and zero-match (§5.5, different icon and headline). Add an explicit API
       reason only if triage and zero-match cannot be told apart from the existing fields; say which in the report.
6. [ ] i18n: every new string is a Lingui macro (source `uk`) with `en`; `pnpm i18n:extract` leaves no diff; `node
       scripts/devops/check-no-russian-letters.mjs` passes.
7. [ ] Responsive: no horizontal overflow at 320 / 375 / 768 / 1024 / 1280 / 1440 / 1920; touch targets ≥ 44 px.
8. [ ] Mutation gate: 0 survivors on the changed files (run by Master in WSL).

## Seams under test (Master proposes, Coder confirms BEFORE writing tests)

- The card read model through `GET /job-queue/:id` on a real database (integration spec), per role.
- `JobQueueCard` (rendered component) for the visible fields.

## Assumptions

- A1 (Master): a field with no data source today is not invented and does not pass AC 1. Per-senior availability (§5.2) has
  none (no column in the schema nor in the queue read SQL; verified 2026-11-10); a new column is a migration, so it is an
  owner decision (A3), raised by Master. The Coder lists every such field in the report as `AC 1 partial: <field> — no
  source`, runs `decision-frontier` for anything else unclear, and continues with the rest.

Coder A1 decisions (PR #1313, review rounds 0–1; carried verbatim into the PR body):

- A1 (Coder): `lastSeenAt` comes from `job_opportunities.last_observed_at`; `stackKeywords` comes from
  `job_opportunities.stack_keywords`. The stack falls back to `matchedKeywords` when `stackKeywords` is empty.
- A1 (Coder): `stackKeywords` are deduped after clipping to 100 characters, before the 60 cap, because the card keys
  its chips by keyword.
- A1 (Coder): `matchEvidence` comes from the senior's `TECH_MATCH` items `keyword:STRENGTH`; items without a known
  strength are dropped.
- A1 (Coder): a STUDIO senior's team is their first live membership, in the senior-picker order. ADMIN grouping is
  done client-side (teams in first-seen order; seniors with no team first, without a heading; the keyboard hand-off
  finds the first new senior by `data-arrival`), because the API orders seniors by id.
- A1 (Coder): duplicate submitted names are `TAKEN` assignments under `scopedTeamRowPredicate`, so another team's are
  never counted; each senior is named once (by user id), even when two teams submitted them in a STUDIO view.
- A1 (Master, COPY-M-1): the duplicate line is uk «Уже подано: {seniors}», en "Already submitted: {seniors}"; the list
  item already shows the duplicate's title, so the line does not repeat it.
- A1 (Coder): `dismissal` is the own-scope row, including an undone one; the lateral reads one row (`LIMIT 1`). Re-hide
  sends the newest known version, max(session, card), because dismissal versions only grow; the card's version is
  used only when the scope kind matches.
- A1 (Coder, SPEC-H-1): `noMatchReason`, first match wins: any own LEAD → none; stop-listed → `STOP_LISTED`; any own
  live TRIAGE match row → `TRIAGE`; manual card → `NO_MATCH`; employer not verified, or not evaluated at the current
  revision → `TRIAGE`; otherwise → `NO_MATCH`.
- A1 (Master, CR2-M-1, PR #1313 round 2): an opportunity excluded at its current revision gets `noMatchReason:
  EXCLUDED` and its own (fourth) empty state, uk «Вакансію відсіяно автоматичним відбором» / en "Filtered out by
  automatic screening" (design §5.5); `NO_MATCH` is given only for an `OPEN` verdict. The stop-list still wins over
  `EXCLUDED`, and the check runs before the employer check, so the text never blames the employer.
- A1 (Master, UX-M-2, PR #1313 round 3): an excluded card (`noMatchReason: EXCLUDED`) does not show the «Потребує
  розгляду» triage badge; the excluded empty state is the only status it shows.
- A1 (Master, QA-LOW-1, PR #1313 round 3): the «Чому збіг» toggle is ≥ 44 px tall at every width, because design §5.2
  and AC 7 do not limit the target size to mobile.
- A1 (Master, UX-L-4, PR #1313 round 3): stack tokens are shown as stored (lowercase); the repo has no canonical keyword
  casing map, and CSS capitalisation would misspell names like TypeScript. A casing map is a backlog item.
- A1 (Master, QA-LOW-2, PR #1313 round 3): the triage empty-state wording that names the employer when the employer is
  verified comes from `main`; neutral wording is a backlog item, not this PR.
- A1 (Master, SPEC-L-1): «востаннє бачили» is shown whenever `lastSeenAt` exists; the design has no 24 h threshold.
- A1 (Coder, SPEC-M-1): the engagement form comes from the primary source's latest revision
  (`normalized.employmentType`), classified to `B2B | EMPLOYMENT | null`. The value set was taken from the provider
  adapters and their fixtures, not from prod data. B2B: B2B, ФОП, JDG, sole proprietor. EMPLOYMENT: employee phrases
  from the layer-1 lexicon and a bare `permanent`. Schedule-only, contractor/freelance, fixed-term, intern, mixed,
  negated, unknown or empty values give `null`.
- A1 (Master, design §5.1): a `null` engagement form renders «Форма співпраці: Не вказано» / "Contract type: Not
  stated"; the form stays visible per the owner's note in the design.
- A1 (Coder): a hit stack chip gets an sr-only «, збігається» (SC 1.4.1), Lingui context "job-queue stack chip,
  screen-reader suffix".
- Decision for Task 7.4b (SPEC-M-2): the triage grant stores the client-sent `policyVersion` as an audit stamp and no
  server value validates it; the only per-source value is `job_sources.policy_version`. The 7.4b brief settles which
  value the client sends.

## Do not touch

- The triage assignment UI («Призначити команді…») — that is `task-vacancy-7-4b-triage-assign.md`, after this task.
- The list row and filters beyond what a renamed shared type strictly needs.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files from "Concrete changes".
2. Each AC: a named test or a `grep` for its `data-testid` / string.
3. `pnpm typecheck`; `pnpm --filter @crm/api test` with `DATABASE_URL` set inline to a scratch database.
4. Commit: `ac_verified: 1,...,8` and `vision: ✓ /job-queue`.
