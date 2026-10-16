# Rationale: skills-invocation

Rationale layer for `.claude/rules/common/skills-invocation.md`. Not auto-loaded — read on demand.

**Source:** ECC AGENTS.upstream §"Workflow Surface Policy" (skills as canonical surface) + Phase 4
deliverable (skills lifted from `lessons.md`) + superpowers framework expectations.

---

## Why the core file must keep the trigger table whole

Two independent reasons, and the second is recent:

1. **`when_to_use` is a mirror, not a source.** Each `.claude/skills/<name>/SKILL.md` carries
   `when_to_use:` in the frontmatter (Anthropic's skillify schema: leak `skills/bundled/skillify.ts`)
   so the skill-loader can auto-invoke by trigger phrases. That field is a reflection of the table,
   so the table is the source of truth and both must be edited together (see
   `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` D2).
2. **The listing's `description` cannot carry the trigger.** The operator's global settings set
   `skillListingMaxDescChars: 300`, and a longer description is silently cut mid-sentence in the
   listing.

   This was acute on 2026-10-16, when the restructure began: 17 of the 23 project skills were over
   the limit and therefore truncated, which was the stated reason for keeping the mapping whole. PR
   #1012 landed the same day and trimmed **all 23** descriptions to within 300 characters, so no
   description is truncated today (verified: max 267 chars). The wording in the core rule was
   corrected accordingly — the claim "most descriptions are truncated" was true for a few hours and
   is now false.

   The mapping still stays always-on in full, for a reason that does not expire with the character
   count: a `description` and a `when_to_use` are written **for the skill's own reader** and say when
   that one skill applies. Only the mapping states trigger → skill → **which agents it binds**, and
   that third column is not recoverable from any skill file. The truncation argument was always the
   weaker of the two.

## The table-drift incident (2026-07-28)

The trigger table prescribed `superpowers:security-review` and `superpowers:simplify`. **Both skills
were absent** from the installed `superpowers@6.0.3` (the pack carries 14 others).

So a mandatory trigger was unfulfillable precisely on the PRs (finance / auth) it is meant to
protect: `Skill` failed with "not found", and by the rule's own wording that is an explicit failure —
but in fact agents simply continued without it. The broken references managed to spread across 7
working files (`RULES.md` + 4 agent docs + the rule file itself).

**Root cause:** the table was written in Phase 4 (2026-06-03) against the pack composition of the
time. An upstream-pack update silently invalidates rows — nothing binds the table to what actually
lies on disk.

**How it was fixed:**

- `superpowers:security-review` → project-local `security-review` (a project delta over OWASP, the
  patterns confirmed by incidents #110 / #159-#161 / #164);
- `superpowers:simplify` → the prefix-less `simplify` (built-in, exists).

### Why the check is procedural and not a CI gate

CI runners do not have the operator's `~/.claude/plugins`, so a guard script (in the spirit of
`check-e2e-shard-coverage.py`) could verify only project-local references, not `<pack>:<skill>`. The
project-local half **is** machine-checked — `scripts/architect/check-skill-registry.mjs` plus the
`check-skill-registry.yml` workflow, added after this incident. The pack half stays a procedural
reconciliation, which is why the core rule carries the three `ls`/`grep` commands.

### The two catches, in full

1. **A skill may exist but not fit.** The built-in `security-review` is a **slash command**
   `/security-review` (in the Claude Code source — `commands/security-review.ts`), not a bundled
   skill. Its prompt runs `git diff origin/HEAD...` and fails (`fatal: ambiguous argument
'origin/HEAD...'`) in the agent environment where `origin/HEAD` is not configured — verified by an
   actual call from a subagent. **There is no name collision:** slash commands and `Skill(<name>)`
   are different invocation registries, so `Skill('security-review')` resolves unambiguously to our
   project-local `.claude/skills/security-review/`.
2. **`simplify` is a genuine bundled skill** (`skills/bundled/simplify.ts`), so referencing it
   without a pack prefix is allowed and correct.

## The workflow surface policy, verbatim

Per ECC `AGENTS.upstream.md` §"Workflow Surface Policy":

> `skills/` is the canonical workflow surface. New workflow contributions should land in `skills/`
> first. `commands/` is a legacy slash-entry compatibility surface and should only be added or
> updated when a shim is still required for migration or cross-harness parity.

## Provenance of the project-local catalog

Phase 4 laid down 7 (`playwright-patterns` … `legal-escalation-patterns`); later added/imported:

- `claude-design-workflow` (2026-06-22);
- 4 design/a11y skills — `accessibility` / `design-system` (origin ECC),
  `frontend-design-direction` / `make-interfaces-feel-better` (origin community);
- `codebase-audit` (project-local, 2026-06-22 — read-only audit-fanout, see
  `orchestration-routing.md` Decision 2);
- `security-review` (project-local, 2026-07-28 — see the incident above);
- seven AFK-migration skills 2026-08-22: `decision-frontier`, `external-research` (project-local);
  `diagnosing-bugs`, `codebase-design`, `resolving-merge-conflicts`, `prototype`,
  `writing-for-agents` (adapted from `mattpocock/skills`, see
  `docs/architecture/2026-08-22-afk-pipeline-migration.md`);
- `decomposing-large-code` (project-local, 2026-10-05).

The PM dispatch skill was removed 2026-10-05 along with the PM agent, bringing the total to 23.

## Sources

- ECC `docs/architecture/ecc-reference/AGENTS.upstream.md` §"Workflow Surface Policy"
- Phase 4 deliverable: `docs/architecture/2026-06-03-phase4-deliverable.md`
- Phase 4 viability recon: `docs/architecture/2026-06-03-phase4-skills-viability.md`
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §2.4 (lessons → skills)
- `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` D2 (`when_to_use` mirror)
- Superpowers framework: `~/.claude/plugins/cache/claude-plugins-official/superpowers/`
