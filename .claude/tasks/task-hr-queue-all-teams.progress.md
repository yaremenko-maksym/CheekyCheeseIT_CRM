# Progress: task-hr-queue-all-teams

current_milestone: 1/6
last_commit: 899e8b7f7 (wip: Step 1 diagnosis + Q1)
last_push: 73fca8108 (899e8b7f7 push in flight)

## Milestones

1. [x] Step 1 red repro + diagnosis + Q1 (Open question, A3)
2. [ ] API read scope `TEAMS` (union) + list over member generations
3. [ ] card / continuations / duplicates in the union
4. [ ] senior picker restricted to the HR's teams, grouped by team
5. [ ] writes from the union derive one team (dismiss / undo / opened / submit / tailored)
6. [ ] web: drop TeamSwitcher, HR teamId null, picker grouped; tests; E2E

## Design (containment)

- `resolve()` stays STUDIO | TEAM | NONE: every write and every tailored-resume path keeps it, so the
  compiler refuses a union scope anywhere a write could take it.
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
