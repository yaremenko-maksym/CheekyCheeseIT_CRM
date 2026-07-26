# CSP Report-Only rollout (CRM) — runbook (fix/csp-allow-turnstile, PR #429;

# report collection + single-variable flip, task-csp-reports-and-flip)

> **Скоуп:** CRM (`app.cheekycheese.tech`) впервые в истории проекта получает
> `Content-Security-Policy` в PR #429 — до него `crm.conf`'а add_header-баг
> (см. `nginx/conf.d/crm.conf`'s шапка-комментарий) полностью ронял ВСЕ
> security-заголовки на статике CRM, включая CSP. Security review round 1
> (PR #429, HIGH-1/MED-1) нашёл и исправил реальные разрывы политики
> (Cloudflare R2 для документов/инвойсов/чеков, `blob:` для превью чека при
> загрузке) и потребовал первый rollout сделать **Report-Only**, а не сразу
> enforcing. `task-csp-reports-and-flip` добавляет `report-uri`/`report-to` +
> серверный коллектор (`csp_reports` таблица, Part A — Coder) и сводит режим
> report-only/enforcing к ОДНОЙ переменной (Part B — DevOps, security review
> round 2 LOW fix). Этот файл описывает как читать собранные нарушения и как
> переключить режим.

---

## 1. Что сейчас в проде (после мержа обоих PR)

| Домен                         | `Content-Security-Policy` (enforcing) | `Content-Security-Policy-Report-Only`                    | `report-uri`/`report-to`/`Reporting-Endpoints` | Остальные 5 заголовков (HSTS/XFO/nosniff/Referrer-Policy/Permissions-Policy) |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `cheekycheese.tech` (landing) | ✅ да (боевая с PR #423)              | — не отправляется                                        | — не отправляется (коллектор не заведён)       | ✅ enforcing                                                                 |
| `app.cheekycheese.tech` (CRM) | — НЕ отправляется (по умолчанию)      | ✅ да — политика та же, что enforcing вернёт после флипа | ✅ да — оба, `POST /api/public/csp-report`     | ✅ enforcing (ничего не ломают, закрывают clickjacking СРАЗУ)                |

Механика — `nginx/conf.d/csp-map.conf`: единственный источник правды на
текст политики — `$csp_value` (per-domain `map $server_name`), включающий
`report-uri`/`report-to` для CRM. Режим (report-only/enforcing) больше НЕ
хардкожен в двух отдельных maps — единственный источник правды теперь
**одна переменная `CRM_CSP_MODE`** (см. §4). nginx `add_header` с пустым
значением заголовок вообще не отправляет (задокументированное поведение
`ngx_http_headers_module`, проверено эмпирически против этого конкретного
конфига) — поэтому на CRM сегодня (`CRM_CSP_MODE=report-only`) энфорсящего
`Content-Security-Policy` в ответах нет вообще, только `-Report-Only`;
`report-uri`/`report-to` работают одинаково в ОБОИХ режимах (нарушения
собираются независимо от того, блокирует ли политика что-то реально).

## 2. Как читать собранные нарушения

Два независимых канала — используй оба, они дополняют друг друга.

### 2.1 Telemetry-дайджест (автоматический, основной)

Новые/выросшие агрегаты `csp_reports` попадают отдельной секцией в
существующий `GET /api/telemetry/digest` (тот же токен-гард
`TELEMETRY_DIGEST_TOKEN`, тот же hourly/weekly workflow
`.github/workflows/telemetry-digest.yml`) — см.
`scripts/devops/telemetry-digest-runbook.md` за общей механикой дайджеста
(дедуп, формат issue, приватность). CSP-нарушения доезжают до приватного
репо `cheekycheese-telemetry` тем же путём, что и прод-ошибки/UX-события.

### 2.2 Прямой запрос к БД (ручная проверка / расследование конкретного случая)

```sql
SELECT effective_directive, blocked_uri, document_uri, disposition,
       count, first_seen, last_seen, user_agent
FROM csp_reports
ORDER BY last_seen DESC
LIMIT 50;
```

Полезные срезы:

```sql
-- Топ нарушений по частоте (что чаще всего блокируется/наблюдается)
SELECT effective_directive, blocked_uri, count
FROM csp_reports
ORDER BY count DESC
LIMIT 20;

-- Только НОВЫЕ за последние 24 часа (кандидаты на срочное расследование)
SELECT effective_directive, blocked_uri, document_uri, count, first_seen
FROM csp_reports
WHERE first_seen > now() - interval '24 hours'
ORDER BY first_seen DESC;
```

### 2.3 Ручной DevTools-проход (дополнительно, historical)

До этого PR это был ЕДИНСТВЕННЫЙ способ наблюдения — теперь дополнительный,
полезен при живой отладке конкретного экрана (мгновенная обратная связь без
ожидания следующего дайджест-прогона):

1. Открыть `app.cheekycheese.tech` в Chrome/Firefox, DevTools → Console.
2. Report-only-нарушения печатаются как `[Report Only]` предупреждения —
   формат Chromium: `... violates the following Content Security Policy
directive: "..." The policy is report-only, so the violation has been
logged but no further action has been taken.`
3. Пройти вручную (или попросить QA/manual-qa пройти) основные CRM-пути,
   особенно те, что PR #429's security review явно называл: превью/скачивание
   документа (`document-detail-dialog`), превью инвойса (`invoice-detail-
dialog`), превью/загрузка чека (`receipt-panel`, `ReceiptInput`).
4. Любое НЕ ожидаемое (не упомянутое в `nginx/conf.d/csp-map.conf`'s
   комментарии к политике CRM) нарушение — завести issue / task-файл,
   расследовать и исправить (либо в CSP, либо в коде) ДО флипа на enforcing.

### 2.4 Ретеншн

90 дней, через существующий retention-крон (Part A, зона Coder) — старые
агрегаты не накапливаются бесконечно.

## 3. Когда переключать на enforcing

Ориентир — **не по календарю, а по сигналу**: report-only-период можно
закрыть, когда:

- §2.1/§2.2 не показывают новых/растущих НЕожидаемых агрегатов
  (сверх уже известных/зафиксированных в `nginx/conf.d/csp-map.conf`'s
  комментариях к политике CRM) за последние ~7 дней реального трафика.
- Ручной проход по документам/инвойсам/чекам (§2.3) не даёт новых
  нарушений сверх уже известных/фиксированных.
- `scripts/devops/check-security-headers.sh` зелёный на проде (гоняется
  автоматически на каждом деплое, `deploy.yml`'s post-deploy smoke, FATAL —
  см. §4 ниже).
- Владелец подтвердил (обычная user-testing практика проекта — ЛЮБАЯ фича
  фиксится живым тестом в браузере ДО «готово», см. `.claude/agents/memory/
*/lessons.md` "Mandatory User Testing").

## 4. Как переключить CRM на enforcing (процедура)

**Одна переменная, одно место:** `.github/workflows/deploy.yml`'s
top-level `env:` блок — `CRM_CSP_MODE: report-only` → `CRM_CSP_MODE:
enforcing`. Больше НИЧЕГО в `nginx/conf.d/csp-map.conf` или
`scripts/devops/check-security-headers.sh` трогать не нужно — оба читают
из этого единственного источника (build-arg в nginx-образ +
env-передача в post-deploy smoke-шаг).

1. `.github/workflows/deploy.yml` — изменить `CRM_CSP_MODE: report-only` на
   `CRM_CSP_MODE: enforcing` в top-level `env:` блоке (см. комментарий там).
   **Текст политики (`$csp_value` в csp-map.conf) трогать не нужно** — он
   уже финальный, report-only использовался только как safety net на
   период наблюдения, а не как черновик политики.
2. Локальный dry-run ПЕРЕД пушем (тот же паттерн, что и в PR #429):
   ```bash
   docker build -f nginx/Dockerfile -t crm-nginx-test \
     --build-arg VITE_API_URL=/api --build-arg CRM_CSP_MODE=enforcing .
   docker run -d --name crm-nginx-test -p 8080:80 crm-nginx-test
   CRM_CSP_MODE=enforcing scripts/devops/check-security-headers.sh http://localhost:8080
   ```
   Все кейсы, включая "Report-Only rollout" (который под `CRM_CSP_MODE=enforcing`
   проверяет обратное: CRM ДОЛЖНА слать `Content-Security-Policy` и НЕ
   слать `-Report-Only` — тот же скрипт, оба направления, без правки),
   должны быть PASS.
3. Обычный PR (не bootstrap-исключение) → review → `merge-approved` от
   владельца → CI squash-merge → auto-deploy подхватит на следующем цикле
   (`deploy.yml`'s build job передаёт `CRM_CSP_MODE=enforcing` как build-arg
   nginx-образу; deploy job передаёт то же значение
   `scripts/devops/check-security-headers.sh` через SSH env — оба из ОДНОГО
   `env:` блока, drift невозможен).

## 5. Откат (если после флипа что-то сломалось)

Тот же `env: CRM_CSP_MODE:` — обратная операция (`enforcing` → `report-only`,
`git revert` коммита из §4 шаг 1 либо руками) → PR → merge → redeploy — CRM
снова report-only, ничего не блокирует, пока причину разрыва не найдут. Это
НЕ откатывает остальные 5 заголовков (HSTS/XFO/nosniff/Referrer-Policy/
Permissions-Policy) — они остаются enforcing независимо от режима CSP (см.
§1 таблицу) — и не откатывает `report-uri`/`report-to` (те работают
одинаково в обоих режимах, см. §1).

## 6. Связанные файлы

- `nginx/conf.d/csp-map.conf` — единственный источник текста политики
  (включая `report-uri`/`report-to`) + `$csp_mode`/`$csp_enforcing`/
  `$csp_report_only`/`$reporting_endpoints_header` maps (механика
  переключения, управляется `__CRM_CSP_MODE__` placeholder).
- `nginx/conf.d/security-headers.conf` — куда реально уходят
  `$csp_enforcing`/`$csp_report_only`/`$reporting_endpoints_header`
  (`add_header` строки).
- `nginx/Dockerfile` — `ARG CRM_CSP_MODE` (build-time substitution of the
  `__CRM_CSP_MODE__` placeholder, validated to be exactly "report-only" or
  "enforcing").
- `.github/workflows/deploy.yml` — top-level `env: CRM_CSP_MODE:` (single
  source of truth) + nginx build-arg + post-deploy smoke-test env-passthrough
  - guarded `csp_reports` DDL apply step (copy-compose "Check for CSP
    reports DDL file" + deploy job "Step 2i").
- `scripts/devops/check-security-headers.sh` — guard, гоняется на каждом
  деплое (`deploy.yml`, FATAL шаг «Smoke test — security headers»).
  Derives the expected header name from `CRM_CSP_MODE` (no separate
  hardcoded constant), plus negative assertions (no `unsafe-eval`/
  `unsafe-inline` in `script-src`, no wildcard `default-src`) and
  report-directive presence checks.
- `scripts/devops/telemetry-digest-runbook.md` — общая механика дайджеста
  (§2.1 above), секции/дедуп/приватность.
- `docs/runbooks/s3-storage.md` — почему презайненные R2-ссылки
  cross-origin для CRM (контекст для HIGH-1).
- Task: `.claude/tasks/task-csp-reports-and-flip.md` (Part A — Coder,
  endpoint + `csp_reports` table; Part B — DevOps, этот файл).
