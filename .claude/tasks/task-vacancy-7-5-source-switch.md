# task-vacancy-7-5-source-switch — Task 7.5 ADMIN source switch in `SourceBudgetPanel` (plan r5 §Task 7.5)

## Agent: coder

## Status: ready

## Blockers: none

## Priority: high

## Model: opus

## Depends on: Task 6.5 (`PATCH /job-sourcing/sources/:id`) — in `main`

## Branch: feature/vacancy-7-5-source-switch

## Design tier: 2 (spec `docs/design/vacancy-queue.md` §7; reference PNGs `docs/design/assets/vacancy-queue/sources-{320,320-en,768,1440}.png`)

## Context

ADMIN turns a vacancy source on and off from the panel. The endpoint is
`PATCH /job-sourcing/sources/:id` (`apps/api/src/job-sourcing/admin/job-source-admin.controller.ts`, body
`setJobSourceEnabledSchema` = `{ enabled: boolean }`, strict). The panel is
`apps/web/app/components/job-sourcing/SourceBudgetPanel.tsx`; it stays inside `JobSuggestionDialog` and is also placed on the
queue page for ADMIN as the collapsed section «Джерела вакансій» (§7).

## Concrete changes

1. `apps/web/app/hooks/use-job-sourcing.ts` — `useSetJobSourceEnabled` (PATCH with the inverted value, then refetch the
   source list and health).
2. `apps/web/app/components/job-sourcing/SourceBudgetPanel.tsx` (+ small children if the file would pass ~400 lines) — per
   design §7:
   - name + icon + `Switch` (`role="switch"`, 44×44 hit area, `aria-label` = source name);
   - three separate states with chip + explanation line: disabled, paused (cooldown / 429 / challenge, with the «до <час>»
     time), readiness-blocked (policy / auth);
   - unit and quota line + the three-segment bar (used / reserved / uncertain, hatched), `role="img"` with all three numbers;
   - timestamps `dl`: last attempt, last success, last non-empty, policy until, authorization until («ніколи» when none);
   - enable failure: the destructive note with the readiness reason; the switch returns to its previous position; no
     toggle clears policy or cost state;
   - the collapsed summary with uk/en plurals (0, 1, 2, 5, 11, 21, 22 in uk; 1, 2, 5, 21 in en).
3. The queue page renders the collapsed section for ADMIN only.
4. Lingui catalogs for every new string.

## Reuse / Regression scope

- Existing `SourceBudgetPanel` tests (including "non-ADMIN panel not rendered") stay green.
- `apps/e2e/tests/job-source-admin-responsive.spec.ts` and `job-source-admin-rbac-api.spec.ts` stay green.

## RBAC

| Role   | Access                                               |
| ------ | ---------------------------------------------------- |
| ADMIN  | the panel, the switch, the queue-page section        |
| others | not rendered; the API answers 403 (Task 6.5 proves it) |

## Acceptance criteria

1. [ ] Toggle sends `PATCH /job-sourcing/sources/:id` with `{ enabled: !current }` and refetches; double activation sends one
       request.
2. [ ] Disabled, paused and readiness-blocked render as three different chips with their explanation lines (§7 table).
3. [ ] Quota bar: used / reserved / uncertain with a legend of numbers; `aria-label` carries all three.
4. [ ] Timestamps per §7, relative, «ніколи» when null.
5. [ ] Enable failure: the readiness reason is shown, the switch returns to the previous position, cached policy/cost state is
       unchanged (test).
6. [ ] Non-ADMIN: the panel and the queue-page section are not rendered.
7. [ ] i18n: Lingui macros (source `uk`) with `en`; plural forms verified for the counts above; `pnpm i18n:extract` leaves no diff.
8. [ ] Responsive 320 / 375 / 768 / 1024 / 1280 / 1440 / 1920: no horizontal overflow; `dl` one column on mobile, three from
       560 px; targets ≥ 44 px.
9. [ ] PR body has a ui-ux-designer conformance note against the reference PNGs.

## Seams under test (Master proposes, Coder confirms BEFORE writing tests)

- `SourceBudgetPanel` (rendered component) for states, bar, timestamps, failure.
- `useSetJobSourceEnabled` via `renderHook`: request shape and refetch.

## Assumptions

- A1 (Master): the design step of plan r5 ("Design Tier 2") is covered by the existing spec §7 and the four reference PNGs; no
  new Claude Design run. Mode B on the live stack checks conformance.
- A2 (Master, SPEC-M-1): widening the meter beyond what the server stores today goes to the Phase 7 closing
  decision brief, not into this PR.
- A1 (Coder): `listSources` projects an elapsed meter window (`resets_at <= clock_timestamp()`) as `used: 0`,
  `resetsAt: null`; `reserved` / `uncertain` stay as stored. A window resets in place only on the next write.
- A1 (Coder): meter bigint cells are read as `::float8`; a cell of the wrong type drops the whole `meter` to
  `null` rather than a partial object.
- A1 (Coder): `jobSourceMeterSchema` is a strict allow-list (`unit`, `window`, `limit`, `used`, `reserved`,
  `uncertain`, `resetsAt`); meter id, account key and policy version are not exposed.
- A1 (Coder): the meter beats the legacy per-source counter in `SourceSwitchCard` / `QuotaBar`; the legacy
  counter renders used-only.
- A1 (Coder): `SourceSwitchCard` always shows the server's `enabled`; `useSetJobSourceEnabled` has no
  optimistic update, so a refused enable needs no rollback; a ref guard keeps a double activation to one request.
- A1 (Coder): the blocked chip uses Lingui context `job source readiness` (bare «Заблоковано» is "Locked" in
  the finance catalog); the `SourceBudgetPanel` loading line uses context `job source list` (bare
  «Завантаження…» is "Uploading…"). The load error reuses "Could not load source health."
- A1 (Coder): the collapsed «Джерела вакансій» section sits at the top of the `job-queue` route body, closed by
  default, so the infinite list cannot bury it.
- A1 (Coder): `SourceBudgetRow` moved to its own file without behaviour change, so panel and card do not import
  each other.
- A1 (Coder, SPEC-H-1): `sourceDeadlines` (`production-catalog.ts`) resolves `policyUntil` / `authUntil` per
  source row from the row's `type` plus the snapshot entry matching `manifest_id`, earliest per kind
  (`POLICY_EXPIRES`, `AUTH_REQUIRED_FROM`); ISO instants or `null`, ADMIN-only in `jobSourceSchema`. The card
  shows an absolute date via `formatDeadline`, or «ніколи».
- A1 (Coder, SPEC-M-2, CR-L-1): the `SourceSwitchCard` `CHIP` table follows design §7/§8 (running outline +
  `Check`; disabled `secondary` + `Power`, `text-foreground` for contrast; paused `yellow-subtle` /
  `yellow-muted` + `Pause`; blocked destructive outline + `Lock`); raw `amber-*` / `green-*` removed.
- A1 (Coder, CR-M-1): the card `li` carries `@container` so `@min-[560px]:grid-cols-3` applies.
- A1 (Coder, COPY-H-1): `readinessPhrases` never renders the server's `readinessReason`; known blocker codes map
  to uk/en phrases, deduplicated, joined with «; »; unknown or none reads «Не готове до роботи» / "Not ready to run".
- A1 (Coder, COPY-M-1): the refusal alert reads bold «Не вдалося увімкнути.» then `{reason} Стан не змінено.`;
  `endSentence` adds a period only when the text does not already end in `.`, `!`, `?` or `…`.
- A1 (Coder, COPY-M-2, COPY-L-1): `quota-format.ts` formats with `Intl.NumberFormat(activeLocale)` and USD for
  money; the `QuotaBar` unit word agrees with the limit through one module-level ICU plural `msg` per unit
  (`QUOTA_LINE`), not `plural()`.
- A1 (Coder, COPY-L-2): the `QuotaBar` headline numerator is `used + reserved + uncertain`, as the design's
  `quota()` computes and the filled bar adds up.
- A1 (Coder, COPY-L-3, COPY-L-4): en «Last success»; an admin pause with no time reads «Призупинено
  адміністратором» / "Paused by an administrator".
- A1 (Coder): the deadline integration case uses a `RECRUITEE_ATS` source (`recruitee.board.bunq`, namespace
  `m75-<tag>`, required by `ck_job_sources_inventory_namespace_nonempty`) on scratch DB `crm_scratch_75` only.

Master A1 decisions (PR #1312 round 3 fix round; carried verbatim into the PR body):

- A1 (Master, UX-02 / QA-LOW-2): «Політика діє до» and «Авторизація до» are rendered only when the source has that
  deadline; a null deadline omits the row (as in the reference PNGs), because «ніколи» there reads as the opposite of
  "no deadline". The three relative stamps keep «ніколи».
- A1 (Master, UX-01 / QA-MED-2): a source with a quota meter shows only the meter; the budget-state row
  («Без ліміту запитів» and the other states) is rendered only when there is no meter.
- A1 (Master, QA-LOW-3): the card does not render the trigger label («за розкладом» / «за кнопкою»); design §7 does not
  list the trigger mode on the card. The job-suggestion dialog panel is unchanged.
- A1 (Master, QA-LOW-1): the quota headline «Ліміт: {used} / {total} запитів» counts used requests only, as in the design
  §7 example (232 / 500); reserved and uncertain stay in the bar and the legend.
- A1 (Master, SO-M-1): the readiness reason is shown for a refused enable only when the error code is
  `JOB_SOURCE_NOT_READY`; any other error shows the generic user-facing message.
- A1 (Master, UX-04 / QA-MED-1): the switch stays focusable while the request is in flight (`aria-disabled`, no native
  `disabled`); the existing in-flight guard still blocks a second send.
- A1 (Coder, UX-01): "has a meter" means the meter draws a bar (`meter.limit` > 0); a meter without a limit keeps the
  budget-state row.
- A1 (Coder, UX-07): the collapsed summary stacks under the title at every width, as in the 1440 reference PNG.
- A1 (Coder, UX-03): the disabled note stays a plain muted line per design §7, although the PNG draws a box.
- A1 (Coder, UX-06): the source icon is the generic `Globe`, as in the reference PNGs.
- A1 (Master, UX-05): the off-state switch contrast (≥ 3:1, SC 1.4.11) is fixed locally in `SourceSwitchCard`; the shared
  `Switch` primitive is not changed in this PR.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files from "Concrete changes".
2. Each AC: a named test or a `grep` for its testid / string.
3. Commit: `ac_verified: 1,...,8 (9 — PR body note, checked at PR time)` and `vision: ✓ /job-queue`.
