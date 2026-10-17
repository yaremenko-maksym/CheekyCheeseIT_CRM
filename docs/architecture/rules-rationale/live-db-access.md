# Rationale: live-db-access

Rationale layer for `.claude/rules/common/live-db-access.md`. Not auto-loaded — read on demand.

**Source:** Owner decision 2026-08-22 following an observation incident (backlog item 166).

---

## Why the rule was rewritten, not tightened

The prior wording was absolute — "**never** connect to `crm_db`" — and lived **only in prompt text**:
no canonical file existed, and scraps were scattered across `git-policy.md`, `light-track.md` and
`agent-isolation.md`.

The rule was broken, and not out of carelessness. The triggering observation (backlog item 166):
`security-reviewer` connected to `crm_db` for reading in order to verify a finding — **and that is
exactly what produced two HIGH findings on PR #589 that no test caught.** Read-only access to real
data was the only way to tell a real finding from a hypothetical one.

A rule broken for the sake of useful work breeds circumvention and devalues itself entirely. That is
the same argument by which the guards were narrowed in PR #561, and the same false-positive doctrine
recorded in `docs/architecture/rules-rationale/agent-isolation.md`.

So the boundary was redrawn where it is meaningful: **not "connect / don't connect", but "read /
write"**.

## The incident the inline-`DATABASE_URL` clause comes from

**2026-08-18:** the live `crm_db` was wiped by a seed because of an **inherited environment
variable** — an `export DATABASE_URL=...` that outlived the command it was set for (item 140, closed
by PR #576 / #579).

This is why the core rule insists the variable is set **inline in the command itself** and why the
`SEED_CONFIRM_LIVE_DB_NAME` escape hatch is inline-only. An `export` lives until the end of the
session and reproduces precisely that hole.

## Why read hygiene is in the rule at all

From the #589 report: the employees' real full names ended up in the transcript **without necessity**
— for the conclusion "the report shows the whole population" a count was enough. Permitting reads
creates a second, quieter risk (personal data in an agent transcript) that the destructive-operation
guards do not touch, so the mitigation has to be procedural and stated next to the permission.

## Sources

- Owner decision 2026-08-22 (in response to backlog item 166).
- PR #589 — two HIGH findings only verifiable against real data; also the PII-in-report lapse.
- Incident 2026-08-18: the live `crm_db` wiped by a seed via an inherited environment variable (item 140, closed by PR #576/#579).
- PR #561 — the precedent for narrowing a guard rather than tightening it.
