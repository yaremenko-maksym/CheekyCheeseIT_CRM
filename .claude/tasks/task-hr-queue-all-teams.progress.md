# Progress: task-hr-queue-all-teams

current_milestone: 6/6 (E2E + verification; mutation gate green)
last_commit: final (see git log); mutation survivors killed in a47611be0, 9086ce2f4, 0fc89a6b2
last_push: see `git ls-remote origin fix/hr-queue-all-teams`

## Milestones

1. [x] Step 1 red repro + diagnosis + Q1 (Open question, A3)
2. [x] API read scope `TEAMS` (union) + list over member generations
3. [x] card / continuations / duplicates in the union
4. [x] senior picker restricted to the HR's teams, grouped by team
5. [x] writes from the union derive one team (dismiss / undo / opened / submit / tailored)
6. [x] web: drop TeamSwitcher, HR teamId null, picker grouped; tests; E2E

## Design (containment)

- `resolve()` stays STUDIO | TEAM | NONE. Writes and tailored resumes go through `resolveWrite()`,
  which returns ONE TEAM scope picked from the union per action, so a write never holds a union.
- New `resolveView()` for the read paths only (list, card, continuations, seniorOptions): an HR with
  2+ live teams and no `teamId` gets `{ kind: 'TEAMS', teams: TEAM scopes[] }`.
- Read helpers widen to `JobQueueViewScope`; each `.kind` branch in them is made exhaustive.
- The list reads N member TEAM generations (each published by its own `currentGeneration`); merged
  order = `row_number()` over the raw entries, before any predicate; the signature carries the
  member generation ids, so a changed member is refresh-required.

## blast_radius

- `JobQueueScopeService.resolve` — unchanged behaviour. Callers: job-queue.service list / card /
  seniorOptions / continuation (move to `resolveView`), queue-actions.service `writeScope` and the
  STUDIO-only checks, tailored-access `authorizeSenior`, tailored-resumes.service list.
- `visibleOpportunityPredicate`, `listableOpportunityPredicate`, `scopedTeamRowPredicate`,
  `queueRowJoins`, `cardRow`, `seniorRows`, `seniorTotal`, `duplicateRows`, `policySignature`,
  `seniorOptionRows` — widened; TEAM / STUDIO / NONE output pinned by the existing unit specs
  (queue-scope.spec, queue-read-sql.spec, job-queue.service.spec) and integration specs.
- `writeScope` (queue-actions.service) — HR without `teamId` derives one team per action.
- `authorizeSenior` (tailored-access) via `resolveWrite`; `TailoredResumesService.list` via
  `resolveView`. Unit fakes delegate `resolveView` / `resolveWrite` to `resolve`, so every old
  pinning assertion on `resolve` still binds.
- Web: `TeamSwitcher` deleted; `teamId` dropped from the route search; HR scope `teamId: null`.
