# Rule: Russian language for user-facing output

**Status:** Always-on
**Applies to:** All agents (PM, BA, Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus any ECC-imported agents invoked in this project)
**Source:** Project hard requirement (CLAUDE.md), confirmed via ADR Q7 = Option C (per-agent prepend + shared rule, belt-and-suspenders)

---

## The rule

Все агенты ОБЯЗАНЫ общаться с пользователем **исключительно на русском языке**.

- Все assistant-сообщения в чате
- Все toast / notification / error messages в UI
- Все Telegram / email / in-app уведомления
- Все PM dispatches к sub-agent'ам (на русском, чтобы user мог читать transcript)
- Все agent self-descriptions / status updates

## Запрещено

- Украинский язык — никогда (project-specific constraint, не путать с UA legal context)
- English в user-facing output (за исключениями ниже)

## Допустимый English

- **Code comments** — international future-proof team
- **Commit messages** — Conventional Commits в английском (`feat(scope): description`)
- **Variable names, function names, type names** — английский
- **PR titles + body** — английский
- **Log strings** для server-side observability — английский (machine-readable)
- **Imported library names, API endpoints, technical identifiers** — английский (Zod schema names, NestJS module names, Drizzle table names)

## ECC-imported agents

Если PM / Architect / Coder invoke ECC catalog agent (e.g. `tdd-guide`, `code-reviewer`, `security-reviewer`), и output этого agent попадает к user — переводить в русский.

**Implementation strategy:**

- Phase 3 миграции — каждый ported agent имеет prepend `**ВАЖНО: Всегда отвечай на русском языке.**` в начале role section
- Эта rule (rules/common/russian-language.md) — single shared source of truth
- Через ECC `@rule` reference syntax (доступно в Phase 5 миграции) — агенты будут ссылаться сюда вместо inline директивы
- До Phase 5 — оба паттерна (prepend + rule) работают параллельно (belt-and-suspenders per Q7)

## Проверка соблюдения

При обнаружении user-facing output на английском или украинском:

- Reviewer agent → BLOCK verdict
- Self-check: переписать на русский перед отправкой пользователю

## Источники

- CLAUDE.md project memory bank
- Memory: `feedback_user_profile.md` — общение на русском языке
- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` Section 4.1 (Russian language adaptation)
- Q7 decision: Option C — Both per-agent prepend AND shared rule
