# Rule: Language policy — English in the repo, Russian only in the owner chat

**Status:** Always-on
**Applies to:** All agents (Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus any ECC-imported agents invoked in this project) + Master (orchestrator)
**Source:** Owner decision 2026-10-05 — a colleague collaborates in English, so the shared repo and all agent output are English. Supersedes the prior Russian-output policy (ADR Q7 Option C). The filename stays `russian-language.md` because many files reference it; the rule it holds is now the language policy below.

> **The flip, in one line.** Everything written into the repository or produced by a sub-agent is **English**. Russian survives in exactly one place — the owner↔Claude direct chat — and that chat lives in the owner's personal memory, not in this repository.

---

## The rule

English is the language of **collaboration and the repository**. Ukrainian and English are the languages of the **product** (unchanged — see below).

**English (required) — everything an agent writes or that lands in the repo:**

- Every assistant / agent message, status update, report, and the body of every PR review
- Every Master dispatch prompt to a sub-agent
- PR titles and bodies, commit message bodies, code comments
- Task files, briefs, ADRs, the backlog, agent memory, and everything under `.claude/**`
- `CLAUDE.md` and `CONTEXT.md`

**Russian (the one exception) — the owner↔Claude direct chat only:**

- The owner talks to Claude in Russian in the personal session, and Claude answers in Russian there.
- That conversation is personal and out-of-repo; it is recorded in the owner's personal memory, never committed to this repository.

If an agent's output is destined for the repository, a PR, another agent, or the shared transcript, it is English — no exceptions. The Russian exception covers only the owner's own private chat.

## Product i18n — unchanged

The product ships in **`uk` (default) and `en`** through Lingui catalogs (owner decision 2026-09-19, spec `docs/superpowers/specs/2026-09-19-crm-i18n-design.md`). Catalogs live in `packages/shared/src/i18n/locales` (`en`, `uk`). This policy flip does **not** touch any of it:

- All visible text in `apps/web` (headings, buttons, toasts, empty states, `aria-label`, `title`, `placeholder`)
- Emails and in-app notifications — by the recipient's locale
- Invoice PDFs — by the recipient's locale
- API error texts — codes live in `packages/shared/src/schemas/api-errors.ts`; the displayed text comes from the client-side catalog

Russian product text is **removed module by module** (stage 3 of the spec). Until a module is migrated, its existing Russian strings are left untouched; **new and changed** strings are written in `uk` + `en` and wrapped in Lingui macros right away — a literal string in any language inside a migrated module is a review finding.

### Forbidden in the product

- A literal or Russian visible string inside a **migrated** module (caught by `no-unlocalized-strings` and the guard on the letters `ы э ъ ё` — stage 6)
- A hardcoded visible string bypassing the catalog inside a migrated module

## Landing

`apps/landing` ships in five languages (en/uk/ru/es/pt) through its own dictionary mechanism; this file does not change it.

## ECC-imported agents

If Master / Architect / Coder invoke an ECC catalog agent and its output reaches the repo or the owner, that output is English — the same rule as every other agent. (English is already these agents' default, so this is a restatement, not a special case.)

## Enforcement and verification

- An agent report or message written in any language other than English → rewrite before sending.
- A visible string inside a migrated module left as a literal or in Russian → `copy-reviewer` / `code-reviewer` → `Verdict: BLOCK`.
- `uk` / `en` catalogs — `copy-reviewer` gives a verdict per language separately ("two originals", skill `copywriting` §5).

## Sources

- Owner decision 2026-10-05: English collaboration (colleague works in English); Russian only in the owner's personal chat.
- Owner decision 2026-09-19: product i18n `uk` + `en` via Lingui — spec `docs/superpowers/specs/2026-09-19-crm-i18n-design.md`.
- Superseded: ADR `docs/architecture/2026-05-31-ecc-migration-design.md` Section 4.1 (Russian-output adaptation) and its Q7 Option C decision.
