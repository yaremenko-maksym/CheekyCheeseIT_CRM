# CRM Telemetry — Design Spec (ошибки прода + UX-аналитика)

**Дата:** 2026-07-24 · **Статус:** APPROVED (решения владельца в чате)
**Цель:** (1) прод-ошибки автоматически доезжают до ассистента → фиксы без участия
владельца; (2) статистика использования CRM сотрудниками → UX-улучшения без фидбека.

## Решения владельца

| Вопрос              | Решение                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| Архитектура         | Своя лёгкая система в нашей Postgres (никаких SaaS/self-hosted трекеров)       |
| Канал до ассистента | Авто-GitHub-issues через scheduled workflow + защищённый digest-endpoint       |
| Глубина UX          | События+роуты+тайминги+брошенные формы; БЕЗ session replay, БЕЗ значений полей |
| Приватность         | Ошибки — с userId/ролью (для репро); UX-события — только роль + хэш сессии     |

## 1. БД (2 таблицы, миграция + прод-DDL через deploy.yml)

**`telemetry_errors`** — группировка по fingerprint:
id · fingerprint (sha256 от normalized message+top-frames+source) UNIQUE · source
(`WEB|API`) · message (truncated 500) · stack (truncated 4000, санитизация) · route/
endpoint · user_id nullable FK · user_role nullable · meta jsonb (ua, viewport, appVersion
— БЕЗ тел запросов) · count int · first_seen · last_seen · status (`NEW|NOTIFIED|RESOLVED`)
· github_issue_number nullable.
Повтор ошибки → count++, last_seen; RESOLVED+повтор → снова NEW (регресс, новый issue-коммент).

**`telemetry_events`** — сырые UX-события (лёгкие строки):
id · session_hash (sha256(userId+суточная соль) — паттерны видны, личность нет) · user_role ·
event (`route_enter|route_leave|feature_click|form_abandon|form_submit`) · route ·
target nullable (data-track идентификатор фичи) · duration_ms nullable (для route_leave —
время на экране) · created_at. Индексы по (event, created_at), (route, created_at).

## 2. API (`apps/api/src/telemetry/`)

- `POST /api/telemetry/errors` — JwtGuard (сотрудники залогинены), Zod-схема, жёсткий
  rate-limit (10/мин/юзер), fingerprint-упсерт. НЕ доступен публично (лендинг вне скоупа v1).
- `POST /api/telemetry/events` — JwtGuard, batch (до 50 событий), rate-limit, fire-and-forget
  (ошибки трекинга никогда не ломают UX — swallow+лог).
- Серверные ошибки: глобальный exception-interceptor Nest (5xx + необработанные) → тот же
  upsert напрямую (без HTTP), source=API; исключить каскад (ошибка в телеметрии не роняет
  запрос и не трекает сама себя — guard от рекурсии).
- `GET /api/telemetry/digest?since=<iso>` — БЕЗ JwtGuard, вместо него header
  `X-Telemetry-Token` = env `TELEMETRY_DIGEST_TOKEN` (32+ байт, constant-time сравнение);
  отдаёт: новые/регресснувшие ошибки (полный контекст) + weekly-аггрегаты UX (по флагу
  `&ux=1`): топ-роуты по времени/визитам per роль, феатуре-клики, form_abandon-рейты,
  медианные тайминги. Помечает отданные ошибки NOTIFIED (идемпотентно через since).
- **Retention cron (требование владельца: данные регулярно стираются, БД не раздувается)**,
  ежесуточно, fail-loud лог количества: `telemetry_events` старше **90 дней** — удалять
  (долгосрочные аггрегаты живут в weekly-issues, сырьё не нужно); `telemetry_errors` с
  `last_seen` старше **180 дней** — удалять НЕЗАВИСИМО от статуса (не повторялась полгода —
  неактуальна); дополнительный защитный кап: если `telemetry_events` превысила 1 млн строк —
  удалять старейшие сверх капа немедленно (страховка от всплеска). Показатели размера — в
  weekly UX-digest (мониторю тренд).

## 3. Web SDK-слой (`apps/web/app/lib/telemetry/`)

- Ошибки: ErrorBoundary (уже есть? — интегрировать) + `window.onerror` +
  `unhandledrejection` → dedupe в памяти (1 отправка/fingerprint/сессию) → POST.
- События: подписка на router (route_enter/leave + duration), делегированный клик-хендлер
  по `[data-track]` (проставить data-track на ключевые фичи: создание вакансии/юзера/
  транзакции, publish, settle, фильтры, downloads — список в task-файле), form_abandon
  (открыл Sheet/Dialog с формой + ввёл что-то + закрыл без submit — БЕЗ содержимого).
- Батчинг: буфер 10 событий или 15с → `navigator.sendBeacon` (уходит и при закрытии вкладки);
  выключатель `VITE_TELEMETRY=off` для dev/E2E (в тестах не шумим).

## 4. Канал автономных фиксов (`.github/workflows/telemetry-digest.yml`)

- Hourly cron + workflow_dispatch: curl digest-endpoint с токеном из GH secrets →
  для каждой новой/регресснувшей ошибки — `gh issue create` (title = fingerprint-заголовок,
  label `prod-error` + `severity:auto`, body: message/stack/route/роль/count/first-last seen,
  чеклист для фикса); дедуп: issue_number пишется обратно?? — нет обратного канала → дедуп
  на стороне API (NOTIFIED) + поиск открытых issues по fingerprint в title.
- Weekly (понедельник): UX-digest issue с лейблом `ux-insights` — аггрегаты + место для
  моих выводов. Ассистент разбирает issues в сессиях по стоячему мандату.

## 5. Безопасность (security-reviewer ОБЯЗАТЕЛЕН)

Санитизация stack/message от секретов (уже нет секретов в клиенте, но паттерн-фильтр
Bearer/cookie на всякий); digest-token constant-time; rate-limits; никакие значения форм/
финансовые суммы НЕ попадают в события; телеметрия fail-silent (не ломает прод);
телеметрия НЕ трекает лендинг (только CRM, залогиненные сотрудники).

## 6. План (порядок задач)

1. **T1 coder** `feature/telemetry-api`: shared-схемы + таблицы + ingest/digest + interceptor
   - retention + unit/integration (RBAC digest-token 401/403, рекурсия-guard, rate-limit).
2. **T2 coder** `feature/telemetry-web` (после T1 в main): SDK-слой + data-track разметка +
   тесты; **T3 devops** `infra/telemetry-digest` (параллельно T2): workflow + секреты
   (TELEMETRY_DIGEST_TOKEN в GH+prod env, fail-loud) + DDL-шаг + runbook.
3. Ревью: code (все) + security (T1, T3); merge по мандату; прод-smoke: искусственная
   ошибка (?debug-throw за ADMIN) → issue появился.

Out of scope v1: session replay, лендинг-телеметрия, алерты в Telegram, дашборд в CRM
(канал — issues; дашборд добавим отдельным циклом при желании).
