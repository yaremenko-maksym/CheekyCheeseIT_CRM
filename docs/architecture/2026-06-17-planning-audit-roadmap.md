# ADR 2026-06-17 — Planning audit, process-debt enforcement matrix & prioritized roadmap

**Status:** Proposed (planning cycle — НЕ исполнение; ноль продакшн-кода, ноль merge)
**Type:** Planning / Process / Roadmap
**Author:** PM planning session
**Scope:** read-only аудит состояния + письменный роадмап. Решения по развилкам — за владельцем (AskUserQuestion).

> Этот документ self-contained. Источники для каждого вывода указаны inline. Где сужу по
> артефактам (task-файлы, память), а не по прямому факту в коде — помечено явно.

---

## Context

Ревизия текущего состояния CRM перед выбором направления ближайших итераций. Три вопроса:
(1) что реально сделано vs «в полёте»; (2) закрыты ли структурно рекуррентные инциденты из
ADR 2026-06-16 (FM-1..FM-7); (3) каким должен быть Phase 8 и как безопасно его реализовать.

---

## Decisions (resolved 2026-06-17 — владелец)

Три развилки Part 7 разрешены владельцем — план обновлён под них:

1. **Порядок: process-долг ПЕРВЫМ.** Закрыть FM-5 guard-test CI-гейт + FM-2 worktree→main hook
   ДО Phase 8 (он — ровно того finance/RBAC-класса, под который гейт и нужен).
2. **Phase 8 ПЕРЕОПРЕДЕЛЁН: смарт-контракты ОТМЕНЕНЫ.** Вместо on-chain PaymentSplitter —
   фича **«Счёт компании»** (USDT ERC-20): единый кошелёк компании, куда SENIOR'ы и DROP'ы
   перечисляют деньги; приход подтверждается **ссылкой на транзакцию** (Etherscan-верификация,
   `etherscan.service.ts` уже есть); pending-tx → **прогресс-бар резолва блоков**; ADMIN выводит
   средства как **дивиденды** (бизнес-логика на странице Финансы); сохраняется 50/50 между ADMIN'ами
   - появляется **общий счёт компании** на зарплаты/расходы. Дизайн — на высоте.
     → Нет Solidity / Hardhat / mainnet-деплоя / внешнего аудита / multisig. **Риск H → M.** Остаётся
     реальная money/RBAC/crypto-кастодиан поверхность → Legal + FM-5-гейт обязательны.
3. **Резать процессный вес — да, по списку Part 6** (архив завершённого ECC-плейбука `architect.md`,
   удаление `reviewer.md` shim, архив 8 stale task-файлов).

---

## Part 1 — Реконсиляция состояния (что НА САМОМ ДЕЛЕ в полёте)

**Вывод: genuinely in-flight работы НЕТ.** 0 открытых PR (`gh pr list --state open` пусто),
0 свежих unmerged feature-веток (все unmerged-remote-ветки отстают от main на 70–210 коммитов —
старьё: `assets/*`, `chore/dispatch-*`, `polish/platform-audit`).

8 task-файлов в `.claude/tasks/` — **stale-артефакты завершённой работы**, не backlog. Их branch-SHA
не являются предками `origin/main` именно потому, что work был **squash-merged** (squash создаёт новый
коммит на main, оригинальный SHA ветки осиротевает). Сверка по merged-PR подтверждает:

| Task-файл                         | Реально смержено как      |
| --------------------------------- | ------------------------- |
| `task-admin-as-senior`            | #227 / #232               |
| `task-drop-phase3-frontend`       | #198                      |
| `task-fix-contract-real-pdf-size` | #195 / #196               |
| `task-fix-junior-ut-round5`       | #188 / #174 (junior-цикл) |
| `task-fix-missed-pages-layout`    | #238                      |
| `task-hr-dashboard-tweaks`        | #239                      |
| `task-hr-rbac-teammate-access`    | #210 / #211 (HR RBAC)     |
| `task-senior-dashboard-enhance`   | #234 / #235 / #236        |

→ Эти 8 файлов нужно **заархивировать** (`.claude/tasks/archive/` — там уже 123 записи, архивация
есть норма; эти просто проскользнули). Это первый и самый дешёвый кусок doc-долга. См. Part 6.

**Статус ролей (из памяти `project-drop-accountant-2026-06-14` + merged-PR #234–245):**

| Роль       | Статус                                                                          |
| ---------- | ------------------------------------------------------------------------------- |
| ADMIN      | full (+ admin-as-senior #227/#232)                                              |
| JUNIOR     | done (#170/#172/#174 + UT-раунды)                                               |
| DROP       | done (user подтвердил после #208)                                               |
| ACCOUNTANT | **feature-complete** (#207–#230)                                                |
| SENIOR     | дашборд существенно построен (#234/#235/#236/#243/#245) — нужен лишь QA-аудит   |
| HR         | дашборд + RBAC есть (#210/#211/#212/#239); **scope «build-out» НЕ определён** ⚠ |

**Главный вывод Part 1:** «доделки HR/accountant-S2/senior» из брифа — в основном **уже в main**.
Единственный недо-определённый кусок — что значит «HR build-out» (дашборд есть; дальше — пусто без BA-скоупинга).
Реальный фронт работ = **Phase 8** + **process-долг** + **doc-энтропия** + горстка LOW-букмарков.

---

## Part 2 — Process-debt: матрица принуждения (FM-1..FM-7)

Для каждого класса инцидента из ADR 2026-06-16: есть ли **принуждающий** контрол (CI/hook),
или только урок-в-промпте? Проверено по факту (`.github/workflows/`, `.claude/hooks/`, `.husky/pre-push`,
`vitest.config.mts` история).

| FM   | Класс / реальная цена                                                         | Принуждающий контрол сегодня                                                                                                       | Статус                                                      |
| ---- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| FM-1 | over-параллелизм → 529-смерти на старте + CPU-starvation pre-push флаки       | `.husky/pre-push` теперь **последовательный** прогон пакетов (ADR follow-up #3 ✅ сделано); concurrency-cap ≈3-4 — **только урок** | **PARTIAL** (CPU-сторона enforced; cap по природе advisory) |
| FM-2 | MAIN-contamination worktree-агентом (~5-6×/сессия; 1× переключил живой :3000) | zone-hook `pre-edit-write-zone-of-write.sh` — но **документированный gap**: НЕ ловит worktree→main `apps/**`; + ручная PM-проверка | **UNCLOSED** (infra-gap, ADR follow-up #2)                  |
| FM-3 | flaky-E2E маскируется `retries:2` (зелёный re-run прячет нестабильность)      | `playwright-patterns` skill — **только урок**                                                                                      | **NOT enforced**                                            |
| FM-4 | integration concurrency-флак на shared CI-postgres                            | `fileParallelism:false` для integration (#216) + `globalSetup`-guard блокирует локальный `crm_db` (#233)                           | **CLOSED** ✅ (enforced)                                    |
| FM-5 | **mocked-E2E пропускает global guards → реальные PII/finance утечки**         | security-reviewer обязателен + Manual QA — **только дисциплина агента**                                                            | **NOT enforced — самый дорогой незакрытый риск** ⚠          |
| FM-6 | «completed» ≠ done (агент обрезался mid-flight)                               | `pre-bash-coder-push-gate.sh` (ac_verified gate) ✅ частично; RULES §4.2 чеклист — дисциплина                                      | **PARTIAL**                                                 |
| FM-7 | stacked-PR rebase после squash (закрывает, не ретаргетит стек)                | рецепт в памяти — **только урок**                                                                                                  | **NOT enforced** (редкий)                                   |

### Headline вывода Part 2

**Самый рекуррентный и самый дорогой класс — FM-5 — имеет НОЛЬ принуждающих контролов, только
дисциплину.** Он 3× давал реальные OWASP A01 дыры (#157 identity-leak JUNIOR→SENIOR, #158 finance-leak
любому залогиненному), и **обе были на main** (отгружены в прод). Front-only gating (`enabled: isAdmin`)
= UX, не security; mocked-E2E self-fulfilling зелёный даже без guard'а. Это — приоритет №1 для гейта,
**особенно перед входом в Phase 8** (money-эндпоинты — ровно тот же класс поверхности).

FM-2 — второй незакрытый: hook существует, но имеет точно описанный gap, и бил ~5-6×/сессию.
FM-4 — образец того, как надо: класс закрыт ДВУМЯ enforced-контролами, инциденты прекратились.

---

## Part 3 — Приоритизированный роадмап

Формат: {что · зачем · риск · зависимости · agent-тип · грубая длительность}. Развёл по 4 бакетам.

### (d) Process-долг (CI/hook-гейты) — РЕКОМЕНДУЮ ПЕРВЫМ

> Дёшево, высокий рычаг, и Phase 8 опасно начинать без FM-5-гейта. Детали реализации — Part 4.

| #   | Что                                                                                             | Риск               | Зависимости        | Agent     | Длит.    |
| --- | ----------------------------------------------------------------------------------------------- | ------------------ | ------------------ | --------- | -------- |
| d1  | **FM-5 guard-test gate** (CI): controller-diff на security-путях требует real-backend 403-теста | — (снимает H-риск) | —                  | DevOps    | 0.5–1 ит |
| d2  | **FM-2 worktree→main hardening** в zone-hook (block write по main-абс-пути из worktree)         | —                  | —                  | Architect | 0.5 ит   |
| d3  | Удалить `reviewer.md` shim (ADR follow-up #1) + проредить агент-доки (см. Part 6)               | L                  | развилка владельца | Architect | 0.5 ит   |
| d4  | `testing`-правило: integration-инвариант (серийно / уникально-маркир. ассерты, FM-4)            | L                  | —                  | Architect | 0.3 ит   |
| d5  | Перенести stacked-PR recovery рецепт в `git-policy.md` (FM-7)                                   | L                  | —                  | Architect | 0.2 ит   |

### (a) In-flight доделки — почти всё в main; остаётся:

| #   | Что                                                                                                                                    | Риск | Зависимости          | Agent     | Длит.        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------- | --------- | ------------ |
| a1  | **HR build-out scoping** — определить, что значит «достроить HR» (дашборд есть)                                                        | L    | BA-бриф              | BA → PM   | 0.5 ит       |
| a2  | SENIOR QA-аудит (дашборд построен #234–245; нужен manual-QA проход)                                                                    | L    | —                    | manual-qa | 0.3 ит       |
| a3  | Accountant S3 — аналитика/отчёты (deferred S2)                                                                                         | L–M  | a-бриф               | BA→Coder  | 1–2 ит       |
| a4  | LOW-букмарки: lint-rule на profile-`<Link>` (#208) · DROP-баннер hover-cosmetic · index tech-debt (composite index accountant-summary) | L    | —                    | Coder     | 0.5 ит batch |
| a5  | crm_db residue cleanup (~118 stale DROP-команд) — **деструктивно, по слову USER**                                                      | M    | явное «да» владельца | DevOps    | 0.2 ит       |

### (b) Phase 8 — «Счёт компании» (USDT ERC-20) — ПЕРЕОПРЕДЕЛЕНО (смарт-контракты отменены)

**Риск M — реальные деньги отслеживаются, но нет автономного on-chain кода / mainnet-деплоя.**
Не on-chain split, а: контракторы шлют USDT на кошелёк компании → верификация tx по ссылке →
ADMIN распределяет (дивиденды 50/50 + общий счёт на зарплаты/расходы). Safety-gate — Part 5.

| #   | Что                                                                                                                                                                                                                                                              | Риск | Зависимости                   | Agent                | Длит.  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------- | -------------------- | ------ |
| b0  | **Brainstorm + BA-бриф** фичи (разрешить open-вопросы ниже: пороги, кастодиан, сверка, миграция старой финмодели)                                                                                                                                                | M    | —                             | BA + brainstorming   | 0.5 ит |
| b0b | **Legal pre-check**: компания-кастодиан USDT + дивиденды ADMIN (UA crypto/AML/налоги — `ua-crypto-compliance` + `ua-tax-compliance`)                                                                                                                             | M    | —                             | legal                | 0.5 ит |
| b1  | DB-модель: `company_account` (баланс/ledger) · inbound deposits (`txHash`+статус+confirmations) · withdrawals/dividends · связь с 50/50 + общий счёт. Ревизия устаревших полей (`payout_requests`/`pending_obligations`/`seniorSharePercent`/`dropSharePercent`) | M    | b0                            | architect + coder    | 1 ит   |
| b2  | Backend: submit-tx endpoint → Etherscan-верификация (confirmed/pending/N confirmations) · **idempotent** (один `txHash` ≠ двойной credit) · RBAC · сверка адреса/суммы                                                                                           | M    | b1, **d1 (guard-gate готов)** | coder + security     | 1–2 ит |
| b3  | Frontend: форма «прислать ссылку на транзакцию» + **прогресс-бар резолва блоков** (live confirmations) + страница счёта компании. Дизайн **Mode A до верстки**                                                                                                   | M    | b2                            | ui-ux + coder        | 1–2 ит |
| b4  | Финансы: ADMIN **дивиденды-вывод** + **общий счёт** (зарплаты/расходы) + сохранение 50/50; separation-of-duties (вывод только ADMIN, ср. #222)                                                                                                                   | M    | b1                            | coder + security     | 1–2 ит |
| b5  | Manual QA на живом стеке + security-review (finance/RBAC/money) + integration guard-тесты (403)                                                                                                                                                                  | M    | b2,b3,b4                      | manual-qa + security | 1 ит   |

**Open-вопросы для brainstorm b0 (genuine ambiguities — НЕ решать дефолтом):**

- Адрес кошелька компании — один общий (владелец сказал «общий счёт»); откуда берётся (config / отдельная таблица)?
- Порог подтверждений = «зачтено» (дефолт-кандидат 12 блоков ETH). Подтвердить.
- Кто подтверждает приход: авто по Etherscan-confirmed, или ACCOUNTANT валидирует (текущий `PENDING→VALIDATED` workflow)?
- Сверка: tx идёт на адрес компании + сумма == ожидаемой; mismatch → ручная валидация, не авто-credit?
- «Доступно к выводу» для дивидендов = общий баланс − резерв на зарплаты/расходы? Как считать?
- Судьба старой финмодели (`payout_requests`/`pending_obligations`/смарт-контракт-поля) — что переиспользуется, что устаревает.
- Сеть для верификации: USDT ERC-20 = Ethereum mainnet (читаем чужие переводы, контракт НЕ деплоим); Etherscan API mainnet.

### (c) Phase 9 — дашборд: **РЕКОМЕНДУЮ ПЕРЕОПРЕДЕЛИТЬ**

Per-role дашборды уже живут на `/crm` (#223 консолидация). Исходный Phase 9 «дашборд = placeholder»
частично **устарел**. Переопределить как:

| #   | Что                                                                                                           | Риск | Зависимости | Agent | Длит.  |
| --- | ------------------------------------------------------------------------------------------------------------- | ---- | ----------- | ----- | ------ |
| c1  | Достроить generic ADMIN/SENIOR дашборд (#231 MED-defer: header fixed-model + реальные KPI вместо placeholder) | L    | —           | coder | 1 ит   |
| c2  | Cross-role аналитика/отчётность (пересекается с a3 accountant S3)                                             | M    | a3          | coder | 1–2 ит |

---

## Part 4 — Топ-3 self-enforcing process-улучшения (конкретика)

Не «улучшить тесты» — а: какой чек, на какие пути, что ассертит.

### 1. FM-5 «guard-test gate» — новый CI job (приоритет №1)

- **Где:** новый job в `ci.yml` (или отдельный workflow), trigger `pull_request: [main]`.
- **На какие пути:** изменённые файлы `apps/api/src/{users,finance,transactions,auth,projects,teams,legends,documents}/**/*.controller.ts`.
- **Что ассертит:** если diff трогает route-handler в этих путях — PR-diff ОБЯЗАН содержать также
  изменение `*.integration.spec.ts` (real backend, без моков) с хотя бы одним ассертом
  «caller без прав → 403» (греп `.expect(403)` / `ForbiddenException` / `toBe(403)` / `status).toBe(403`).
- **Поведение:** нет такого теста → label `needs-guard-test` + комментарий-ремайндер (мягкий блок,
  Reviewer резолвит) ИЛИ hard-fail (развилка строгости). Opt-out: маркер `guard-test-na: <причина>`
  в PR-body, который reviewer обязан обосновать.
- **Зачем именно это:** единственный класс, отгрузивший реальные уязвимости в прод 3× (#157/#158).
  Гейт делает «mocked-E2E на security-пути» = explicit failure, а не silent false-confidence.

### 2. FM-2 worktree→main hardening — ужесточить PreToolUse zone-hook

- **Где:** `.claude/hooks/pre-edit-write-zone-of-write.sh` (live PreToolUse).
- **Что ассертит:** резолвит абсолютный путь цели Edit/Write; если он под MAIN-repo-корнем
  (`…/CheekyCheeseIT_CRM/apps/**` | `…/packages/**`) И cwd сессии = worktree (`…/.claude/worktrees/*`) →
  **BLOCK** с явным сообщением «пиши внутрь своего worktree».
- **Зачем:** закрывает точно описанный infra-gap (ADR follow-up #2), который бил ~5-6×/сессию и
  однажды переключил живой :3000-стек пользователя на feature-ветку. Сейчас — только ручная PM-проверка.

### 3. Doc-entropy auto-trigger — принудительная архивация stale-артефактов

- **Где:** scheduled workflow (еженедельно) ИЛИ шаг в `auto-merge-on-label.yml` post-merge.
- **Что ассертит:** грепает `.claude/tasks/task-*.md` по `last_push:`/`last_commit:`; если ветка
  больше не существует на origin (squash-merged + auto-deleted) → файл — кандидат на архив →
  комментарий/issue со списком «заархивировать N файлов». Опц.: флагать агент-доки завершённой фазы
  (architect.md ECC-плейбук) когда фаза помечена done в `project-state.md`.
- **Зачем:** 8 stale task-файлов прямо доказывают, что консолидация сейчас ad-hoc и проскакивает.
  Триггер делает энтропию видимой и принудительной.

---

## Part 5 — Phase 8 («Счёт компании»): safety-gate-набор

Смарт-контракты отменены → mainnet/audit/multisig-гейты **не применимы**. Но реальные USDT движутся
(приход от контракторов + дивиденды ADMIN) → money/RBAC/crypto-кастодиан дисциплина обязательна.
Money-movement = **human + legal** (жёсткое правило брифа). Ни один пункт не обходится дефолтом.

1. **Никакого авто-credit без confirmed tx.** Бэк засчитывает приход на счёт компании ТОЛЬКО когда
   Etherscan вернул confirmed (≥ порог блоков). Pending → только UI-прогресс резолва блоков, НЕ баланс.
2. **Idempotency.** Один `txHash` = один приход. Повторная отправка той же ссылки не дублирует credit
   (UNIQUE на txHash + проверка перед записью).
3. **Верификация на реальном бэке (FM-5).** submit-tx + dividend-withdrawal + company-account эндпоинты —
   ровно finance/RBAC-класс → ОБЯЗАТЕЛЬНЫ integration guard-тесты (caller без прав → 403), НЕ mocked-E2E.
   Это и есть d1-гейт в действии (потому d1 идёт ПЕРЕД Phase 8).
4. **RBAC + separation-of-duties.** Вывод/дивиденды со счёта компании = только ADMIN; ACCOUNTANT видит/
   валидирует, но не выводит (ср. security MED #222 SALARY self-pay). Явно зафиксировать инициатора вывода.
5. **Сверка адреса/суммы.** tx должна идти НА адрес счёта компании + сумма сверяется с ожидаемой;
   mismatch → флаг на ручную валидацию (ACCOUNTANT), не авто-credit.
6. **Etherscan-надёжность.** Rate-limit/timeout/ошибка API → graceful (прогресс-бар не «зависает»);
   polling с backoff; явный статус «не удалось проверить — повторить».
7. **Legal sign-off (крипто-кастодиан).** Компания принимает USDT от контракторов + ADMIN выводит как
   дивиденды → UA crypto/VASP/AML + налоговая квалификация дивидендов (`ua-crypto-compliance` +
   `ua-tax-compliance`, закон 2074-IX не введён, ДПС-заборона крипто на ЄП). Legal-ревью до релиза (b0b/b5).
8. **Релиз = явное человеческое решение** (owner + legal) для money-flow. PM не приближается к релизу
   фичи без Legal-ревью и Manual QA на живом стеке.

---

## Part 6 — Doc-энтропия & вес процесса

**Факт:** ~5816 строк agent-доков. Крупнейшие: `pm-snippets.md` 1044, `architect.md` 705, `pm.md` 637.

**Конкретные кандидаты на упразднение/архив (не лозунги):**

- **`architect.md` (705 строк)** — это полностью **плейбук завершённой ECC-миграции** («Migration to ECC»,
  фазы 0–6). Миграция done (память `project_ecc_migration_done`). → **Архивировать** в
  `docs/architecture/archive/` и заменить тонким `architect.md` (роль для ADR/рефакторов, ~80 строк).
  Минус ~620 строк без потери контроля.
- **`reviewer.md` (45 строк)** — deprecated shim, ADR follow-up #1 прямо предписывает удаление. → Удалить.
- **8 stale task-файлов** → архив (Part 1).
- **`pm-snippets.md` (1044)** — самый тяжёлый; **НЕ резать вслепую** (loaded on-demand через
  `pm-dispatching` skill, не в системном промпте PM). Кандидат на ревизию-дедуп, но низкий приоритет.

**Принудительный триггер консолидации** — см. Part 4 №3 (вместо ad-hoc).

---

## Part 7 — Развилки владельцу — РАЗРЕШЕНЫ 2026-06-17

1. **Что планировать первым** → **process-долг сначала** (d1 FM-5-гейт + d2 FM-2-hook), затем Phase 8.
2. **Phase 8** → **смарт-контракты отменены**; вместо — фича «Счёт компании» (USDT, верификация tx по
   ссылке + дивиденды ADMIN + общий счёт). Внешний аудит более не нужен (нет on-chain кода). См. Decisions §2.
3. **Резать процессный вес** → **да, по списку Part 6** (архив `architect.md` ECC-плейбука + удаление
   `reviewer.md` shim + архив 8 stale task-файлов).

### Рекомендованная последовательность исполнения (после этого плана)

1. **Doc-cut** (Q3, docs-only light-track, владелец одобрил) — самое дешёвое, можно сразу: d3 + Part 6.
2. **Process-гейты** d1 (FM-5 guard-test CI) + d2 (FM-2 worktree-hook) — DevOps/Architect dispatch.
3. **Phase 8 «Счёт компании»** — старт с b0 brainstorm + b0b Legal pre-check (разрешить open-вопросы),
   далее b1→b5 по роадмапу. Полный pipeline (security-reviewer обязателен — finance/RBAC/money).
4. Параллельно по желанию: a1 HR-scoping (BA), a2 SENIOR QA, a4 LOW-букмарки batch.

---

## Consequences

- Чёткая картина: in-flight ≈ пусто, фронт = Phase 8 + process-долг + doc-энтропия.
- FM-5 идентифицирован как самый дорогой незакрытый риск (0 enforcement, 3× прод-утечки) → приоритет №1.
- Phase 8 получил минимальный gate-набор с явными human+legal точками.
- Roadmap — единый приоритизированный источник с risk-тегами (этот файл = кандидат на «живой roadmap»).

## Follow-ups (зависят от ответов на Part 7)

- Реализовать выбранный первый бакет.
- Если «резать процесс» = да → отдельный Architect-dispatch на архивацию (docs-only, light-track).
- Phase 8 — только после явного старта + Legal pre-check.

## Sources

- `gh pr list` (open=0, merged #232–246), `git branch -r --no-merged`, `.claude/tasks/*` сверка SHA.
- ADR `docs/architecture/2026-06-16-agent-infra-wisdom-transfer.md` (FM-1..FM-7).
- `.github/workflows/*`, `.claude/hooks/*`, `.husky/pre-push`, `vitest.config.mts` (#216/#233) — enforcement-факт.
- `.claude/agents/project-state.md` §1/§1.1 (фазы, Phase 8 план).
- Память: `project-drop-accountant-2026-06-14`, `session-ops-lessons-2026-06-15`,
  `feedback-mocked-e2e-guards`, `feedback-agent-completion-verification`, `project-push-and-stacked-pr-gotchas`.
