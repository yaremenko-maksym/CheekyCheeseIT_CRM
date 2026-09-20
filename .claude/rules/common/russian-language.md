# Rule: Russian language for user-facing output

**Status:** Always-on
**Applies to:** All agents (PM, BA, Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus any ECC-imported agents invoked in this project)
**Source:** Project hard requirement (CLAUDE.md), confirmed via ADR Q7 = Option C (per-agent prepend + shared rule, belt-and-suspenders)

---

## The rule

Русский — язык **общения**, украинский и английский — языки **продукта**.

**Русский (обязательно):**

- Все assistant-сообщения в чате с владельцем
- Все PM dispatches к sub-agent'ам (чтобы владелец мог читать transcript)
- Все agent self-descriptions / status updates / отчёты / тела review в PR
- Task-файлы, брифы, ADR, бэклог, память

**Продукт — `uk` (дефолт) и `en`, через каталоги Lingui (решение владельца 2026-09-19, спека
`docs/superpowers/specs/2026-09-19-crm-i18n-design.md`):**

- Весь видимый текст `apps/web` (заголовки, кнопки, тосты, пустые состояния, `aria-label`, `title`, `placeholder`)
- Письма и in-app уведомления — по локали получателя
- PDF счетов — по локали получателя
- Тексты ошибок API — коды (`packages/shared/src/schemas/api-errors.ts`), текст — из каталога на клиенте

Русский текст в продукте **убирается по модулям** (этап 3 спеки). До миграции модуля его существующие
русские строки не трогаются; **новые и изменённые** строки пишутся сразу на `uk` + `en` и оборачиваются
макросами Lingui — литерал на любом языке в мигрированном модуле = находка ревью.

Прежняя редакция этого файла запрещала украинский вообще. Запрет относился к языку общения
владельца с агентами и остаётся в силе там; на продукт он никогда не должен был распространяться.

## Запрещено

- Украинский или английский в сообщениях владельцу и в отчётах агентов
- Русский в продуктовом тексте **мигрированного** модуля (см. `no-unlocalized-strings` и guard на буквы `ы э ъ ё` — этап 6)
- Хардкод видимой строки в обход каталога в мигрированном модуле

## Допустимый English

- **Code comments** — international future-proof team
- **Commit messages** — Conventional Commits в английском (`feat(scope): description`)
- **Variable names, function names, type names** — английский
- **PR titles + body** — английский
- **Log strings** для server-side observability — английский (machine-readable)
- **Fallback `message` в конверте ошибки API** — английский (для логов и клиентов без каталога)
- **Imported library names, API endpoints, technical identifiers** — английский

## Лендинг

`apps/landing` — пять языков (en/uk/ru/es/pt) своим словарным механизмом; этот файл его не меняет.

## ECC-imported agents

Если PM / Architect / Coder invoke ECC catalog agent, и output этого agent попадает к владельцу —
переводить в русский. Каждый ported agent имеет prepend `**ВАЖНО: Всегда отвечай на русском языке.**`;
этот файл — single shared source of truth (belt-and-suspenders per ADR Q7).

## Проверка соблюдения

- Отчёт или сообщение владельцу не на русском → переписать перед отправкой
- Видимый текст в мигрированном модуле литералом или по-русски → `copy-reviewer` / `code-reviewer` → BLOCK
- Каталоги `uk`/`en` — вердикт `copy-reviewer` по каждому языку отдельно («два оригинала», скилл `copywriting` §5)

## Источники

- CLAUDE.md project memory bank
- Memory: `feedback_user_profile.md` — общение на русском языке
- ADR: `docs/architecture/2026-05-31-ecc-migration-design.md` Section 4.1 (Russian language adaptation)
- Q7 decision: Option C — Both per-agent prepend AND shared rule
