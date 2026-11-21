# task-sources-04-wn-muse-smartrecruiters — Working Nomads, The Muse and SmartRecruiters collect

## Agent: coder
## Status: ready
## Model: claude-opus-5 high (jev T3; security-reviewer MANDATORY on the PR)
## Branch: feat/sources-04-wn-muse-smartrecruiters
## Source: `~/.claude/handoffs/sources-connect-2026-11-19/task-04-unblock-wn-muse-smartrecruiters.md`

## Context
- Working Nomads: prod `enabled=f`, readiness `BLOCKED` (`STATUS_CONSTANT_BLOCKED`). Owner accepted
  the risk 2026-11-16 (`WORKINGNOMADS_OWNER_DECISION` in
  `apps/api/src/job-sourcing/providers/owner-decisions.ts`), but `WORKINGNOMADS_SOURCE_STATUS.blocked`
  is still `true` (`apps/api/src/job-sourcing/providers/sources/workingnomads.provider.ts:24`), and a
  decision lifts only `PERMISSION_UNCLEAR`, never the constant. The provider's header comment says
  lifting needs "a real adapter with a real fixture - not a flag": check whether `refuse()` stands
  in for a missing adapter; if so, the adapter (+ real capture) is in scope.
- The Muse: same shape (`MUSE_SOURCE_STATUS` in `sources/muse.provider.ts:39`). Owner 2026-11-19:
  connect it under the 2026-11-16 ACCEPT_RISK decision, keyless, inside the vendor's 500
  requests/hour, with the link back to the posting. Registering an app stays an owner option
  (Master records it in the LEDGER), not a blocker.
- SmartRecruiters: adapter exists (`sources/smartrecruiters.provider.ts`, manifest
  `type: 'SMARTRECRUITERS_ATS'` in `providers/manifest.definitions.ts:450`), but `entries: []`,
  `fetchProfile: null`, no committed payload capture (`NO_API_CAPTURE`), no prod row. Owner Q8 said
  "connected at the very end": that is now.
- How `job_sources` rows reach prod: find it (seed-delta / generated manifest rows / deploy.yml),
  cite file:line, and `notes.add` it (task 05 needs the same fact). Never write prod rows by hand.

## Zone
Write: `owner-decisions.ts` (only if needed), `sources/workingnomads.provider.ts`,
`sources/muse.provider.ts`, `sources/smartrecruiters.provider.ts`, `manifest.definitions.ts`
(only the three entries), generated manifest artefacts the repo regenerates, their specs
(`manifest.owner-decisions.spec.ts`, `owner-decisions.frozen.spec.ts` as needed), fixtures.
Do NOT touch Arbeitnow / WWR / RSS / Djinni files (parallel tasks).

## Acceptance criteria
1. Flip both status constants to not blocked, reason text citing the owner decisions (2026-11-16
   ACCEPT_RISK; 2026-11-19 Muse keyless, <= 500 req/h, link back). Update the tests that pin
   `STATUS_CONSTANT_BLOCKED`. Muse request budget enforced in code (fetch profile / rate limit),
   tested.
2. SmartRecruiters: pick 2-3 company boards that hire senior engineers (A1, record the pick below),
   commit a real capture of the postings API payload (one plain GET each, owner-approved), add
   entries and a fetch profile following the other ATS types.
3. The prod rows appear and are enabled through the existing seed-delta / deploy path (cite it).
4. Unit tests for each change; full `@crm/api` unit suite green.
5. (Master, after deploy) each of the three types has a `SUCCEEDED` run.

## Assumptions
- (A1) SmartRecruiters boards: <coder fills: company ids + why>.
