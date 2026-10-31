# Rationale: russian-language (language policy)

Rationale layer for `.claude/rules/common/russian-language.md`. Not auto-loaded — read on demand.

---

## Why the filename does not match the rule

The file is named `russian-language.md` but now holds an **English-first** policy. The name was kept
deliberately: many files reference this rule by path (hooks, agent docs, other rules, runbooks), and
renaming it would have meant a mass reference update whose only benefit is tidiness. The rule the file
holds is the policy; the filename is an address.

## The flip (owner decision 2026-10-05)

A colleague collaborates in English, so the shared repo and all agent output became English. This
**supersedes** the prior Russian-output policy — ADR
`docs/architecture/2026-05-31-ecc-migration-design.md` §4.1 (Russian-output adaptation) and its Q7
Option C decision.

What changed: assistant/agent messages, reports, PR review bodies, dispatch prompts, task files,
briefs, ADRs, backlog, agent memory, `.claude/**`, `CLAUDE.md`, `CONTEXT.md`.

What did not change: product i18n, and the owner's own chat. The latter is the single exception
because that conversation is personal and out-of-repo — it is recorded in the owner's personal memory,
not committed here, so it never reaches the colleague.

## Why product i18n is a separate axis

The product's languages are a **product** decision (owner decision 2026-09-19: `uk` default + `en` via
Lingui, spec `docs/superpowers/specs/2026-09-19-crm-i18n-design.md`), while this rule is about the
language of **collaboration**. They are frequently conflated, which is why the core rule restates the
product rules rather than merely linking them — an agent that reads "everything is English" and then
writes an English `uk` catalog string has followed one rule into a review finding.

The module-by-module removal of Russian product text is stage 3 of that spec; the `ы э ъ ё` glyph
guard is stage 6. The canonical literal glyphs live in the core rule because `copy-reviewer` on haiku
needs them inline (see `docs/architecture/rules-rationale/model-routing.md`).

## Sources

- Owner decision 2026-10-05: English collaboration (colleague works in English); Russian only in the owner's personal chat.
- Owner decision 2026-09-19: product i18n `uk` + `en` via Lingui — spec `docs/superpowers/specs/2026-09-19-crm-i18n-design.md`.
- Superseded: ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §4.1 and its Q7 Option C decision.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

**ECC-imported agents:** if their output reaches the repo or the owner, it is English — the same rule
as every other agent.
