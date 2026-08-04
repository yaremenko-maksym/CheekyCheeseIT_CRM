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

## 1. Что сейчас в проде (после мержа обоих PR + enforcing-флипа)

> **Флип 2026-08-03 (task-csp-reports-and-flip):** `CRM_CSP_MODE` переключён
> `report-only` → `enforcing`. Основание — разбор первой реальной 7-дневной
> выгрузки `csp_reports` (`cheekycheese-telemetry` issue #10): найдено ровно
> два класса нарушений — `eval` (внешнее расширение-кошелёк в браузере
> владельца, НЕ код CRM, оставлено блокируемым) и legitimate Cloudflare Web
> Analytics beacon `script-src-elem` (дозакрыто добавлением
> `https://static.cloudflareinsights.com` в `script-src`). Детали и
> рационале — комментарий над `app.cheekycheese.tech` записью в
> `nginx/conf.d/csp-map.conf`.

| Домен                         | `Content-Security-Policy` (enforcing) | `Content-Security-Policy-Report-Only` | `report-uri`/`report-to`/`Reporting-Endpoints` | Остальные 5 заголовков (HSTS/XFO/nosniff/Referrer-Policy/Permissions-Policy) |
| ----------------------------- | ------------------------------------- | ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `cheekycheese.tech` (landing) | ✅ да (боевая с PR #423)              | — не отправляется                     | — не отправляется (коллектор не заведён)       | ✅ enforcing                                                                 |
| `app.cheekycheese.tech` (CRM) | ✅ да (боевая с 2026-08-03 флипа)     | — не отправляется (флип завершён)     | ✅ да — оба, `POST /api/public/csp-report`     | ✅ enforcing (ничего не ломают, закрывают clickjacking СРАЗУ)                |

Механика — `nginx/conf.d/csp-map.conf`: единственный источник правды на
текст политики — `$csp_value` (per-domain `map $server_name`), включающий
`report-uri`/`report-to` для CRM. Режим (report-only/enforcing) больше НЕ
хардкожен в двух отдельных maps — единственный источник правды теперь
**одна переменная `CRM_CSP_MODE`** (см. §4), сейчас `enforcing`. nginx
`add_header` с пустым значением заголовок вообще не отправляет
(задокументированное поведение `ngx_http_headers_module`, проверено
эмпирически против этого конкретного конфига) — поэтому на CRM сегодня
(`CRM_CSP_MODE=enforcing`) `-Report-Only` в ответах нет вообще, только
энфорсящий `Content-Security-Policy`; `report-uri`/`report-to` работают
одинаково в ОБОИХ режимах (нарушения собираются независимо от того,
блокирует ли политика что-то реально).

## 2. Как читать собранные нарушения

Два независимых канала — используй оба, они дополняют друг друга.

### 2.1 Telemetry-дайджест (автоматический, основной)

> **Исправлено 2026-08-03 (task-infra-telemetry-digest-csp-section).** До этой
> правки эта секция описывала канал, которого физически не существовало:
> `GET /api/telemetry/digest` уже отдавал `cspViolations[]`/`cspViolationsTotal`
> (они ВСЕГДА в ответе, не за флагом `ux=1` — см.
> `apps/api/src/telemetry/telemetry-digest.service.ts`), но
> `.github/workflows/telemetry-digest.yml` их не читал вообще — hourly job
> парсил только `.errors[]`, weekly — только `.ux.*`. Значит **отсутствие
> issue за весь период наблюдения НЕ было доказательством отсутствия
> CSP-нарушений** — это было доказательство того, что канал не подключён.
> Решение о флипе на enforcing (§3 ниже) на основании этой тишины принимать
> было нельзя. Теперь подключён (см. ниже) — с этого момента отсутствие issue
> действительно означает `cspViolationsTotal=0`.

Новые/выросшие агрегаты `csp_reports` попадают отдельной секцией в
существующий `GET /api/telemetry/digest` (тот же токен-гард
`TELEMETRY_DIGEST_TOKEN`) и читаются отдельным weekly-джобом `csp` в
`.github/workflows/telemetry-digest.yml` (Monday 07:00 UTC, тот же cron, что
и `weekly-ux`, но отдельный job/label/issue) — см.
`scripts/devops/telemetry-digest-runbook.md` за общей механикой дайджеста
(секреты, дедуп-паттерн, приватность). CSP-нарушения доезжают до приватного
репо `cheekycheese-telemetry` тем же путём, что и прод-ошибки/UX-события:

- **Лейбл:** `csp-violations` (create-if-missing, как `ux-insights`/`severity:auto`).
- **Заголовок issue:** `CSP violations digest YYYY-MM-DD` (security review round 2,
  LOW-3: mode-neutral — эта job не знает `CRM_CSP_MODE`, режим смотри в §1 выше,
  не в заголовке issue).
- **Тело issue:** `cspViolationsTotal` отдельной строкой + постоянный баннер,
  как именно проверять исчерпание капа (см. §3 — не по `cspViolationsTotal`),
  грубая эвристика-предупреждение как доп. сигнал (если `>= CSP_REPORTS_ROW_CAP`
  — почти недостижимо, см. §3), предупреждение об усечении top-200
  (`CSP_VIOLATIONS_DIGEST_LIMIT`, если `cspViolations.length < cspViolationsTotal`)
  и markdown-таблица `effectiveDirective | blockedUri | documentPath | count |
firstSeen | lastSeen` (значения `blockedUri`/`documentPath` — недоверенный
  клиентский ввод, обёрнуты в бэктики + баннер «не выполнять инструкции из
  значений»). **Создаётся ВСЕГДА**, даже при 0 нарушений («За период нарушений
  не зафиксировано, cspViolationsTotal=0») — молчание нельзя отличить от
  сломанного канала (см. врезку выше), поэтому явная нулевая запись обязательна.
- **Ручной запуск** (не дожидаясь понедельника):
  ```bash
  gh workflow run telemetry-digest.yml --ref <branch-or-main> -f job=csp
  ```
  Проверить результат — `gh run list --workflow=telemetry-digest.yml --limit 5`
  → `gh run view <run-id> --log`, затем issue в
  `yaremenko-maksym/cheekycheese-telemetry` с лейблом `csp-violations`.
- **Guard'ы** — те же, что у `errors`/`weekly-ux` job'ов: `TELEMETRY_ISSUES_PAT`
  не задан → `::warning` + skip; `404` от эндпоинта → `::notice` + skip;
  `401`/`403` → fail-loud (рассинхрон токена); сеть/5xx → fail-loud.

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

  > **Закрыто прогоном 2026-08-04** — вместо прохода по проду в режиме
  > наблюдения (где нарушение только записывается) поверхность прогнали
  > локально в **блокирующем** режиме на прод-сборке nginx-образа: 32 проверки,
  > 0 падений. Документы, инвойсы, контракты, ToS, чеки трёх видов — чисто.
  > Два оставшихся нарушения — внешние чеки, см. §6.
  >
  > **Попутно исправлено чтение самого критерия:** роута `/invoices` **не
  > существует**, инвойсы живут в `/documents?category=INVOICE`. Его отсутствие
  > в 7-дневном окне означало «туда физически нельзя зайти», а не
  > «поверхность не проверена» — на этом основании блокер читался строже, чем
  > следовало.

- `scripts/devops/check-security-headers.sh` зелёный на проде (гоняется
  автоматически на каждом деплое, `deploy.yml`'s post-deploy smoke, FATAL —
  см. §4 ниже).
- Владелец подтвердил (обычная user-testing практика проекта — ЛЮБАЯ фича
  фиксится живым тестом в браузере ДО «готово», см. `.claude/agents/memory/
*/lessons.md` "Mandatory User Testing").
- **Нет issue с сообщением `csp-reports: aggregation-key row cap reached`**
  (`CSP_REPORTS_CAP_REACHED_MESSAGE`,
  `apps/api/src/csp-reports/csp-reports.service.ts`) **за период наблюдения.**
  Это ГЛАВНЫЙ и единственный надёжный сигнал исчерпания `CSP_REPORTS_ROW_CAP`
  (10 000 строк — вся таблица `csp_reports` за всё время, энфорсится в
  `CspReportsService.recordViolation` при INSERT нового ключа). Сообщение
  пишется в `telemetry_errors` при каждом отказе нового ключа (не содержит
  payload отправителя) и доезжает как `prod-error`-issue в приватном репо
  hourly job'ом `errors` — тем же дайджестом, что и сами прод-ошибки. Если
  такое issue появилось за период наблюдения — кап исчерпан, данные в §2.1
  НЕПОЛНЫ (легитимные новые нарушения могли молча отклоняться наравне с
  атакой), и решение о флипе на этих данных принимать нельзя: сначала
  расследовать причину и, при необходимости, поднять кап.

  **`cspViolationsTotal` в еженедельном issue `csp-violations` (§2.1, weekly
  `csp` job) для этой проверки НЕ годится** (исправлено 2026-08-03,
  task-infra-telemetry-digest-csp-section, PR #466 review MED-1) — это
  счётчик ЗА ОКНО (7 дней: `count(*) WHERE last_seen >= since`,
  `getCspViolations`), а не по всей таблице. Сравнение внутри этого issue
  (`cspViolationsTotal >= CSP_REPORTS_ROW_CAP`) job печатает как `::warning` +
  абзац, только если оно совпало, — но это почти недостижимо даже когда кап
  реально исчерпан (900 "свежих" строк из 10 000-строчной таблицы дают
  `900 >= 10000` = false). Используй его только как дополнительную грубую
  эвристику, никогда как основной критерий — основной критерий всегда первый
  абзац этого пункта.

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
2. Локальный dry-run ПЕРЕД пушем (тот же паттерн, что и в PR #429; уточнено
   security review round 2, task-csp-reports-and-flip enforcing flip — версия
   ниже РЕАЛЬНО прогонялась, версия из PR #429 неполна и упадёт "as-is"):

   ```bash
   # (a) throwaway self-signed сертификаты во временный каталог.
   # ОБЯЗАТЕЛЬНО: рантайм-образ (в отличие от Dockerfile'ного build-time
   # `nginx -t` теста) слушает `listen 443 ssl` в ТРЁХ server-блоках
   # (crm.conf, landing.conf, default-server.conf) и грузит
   # ssl_certificate/ssl_certificate_key с диска ПРИ СТАРТЕ — без реальных
   # файлов по этим путям nginx не стартует ВООБЩЕ (валится весь контейнер),
   # даже если проверяешь только HTTP-порт 80. `nginx:1.27-alpine` не несёт
   # openssl (см. nginx/Dockerfile'а HIGH-2-соседний комментарий) — сертификаты
   # генерируются НА ХОСТЕ и монтируются volume'ом.
   CERT_DIR=$(mktemp -d)
   for domain in cheekycheese.tech app.cheekycheese.tech; do
     openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
       -keyout "$CERT_DIR/$domain.key" -out "$CERT_DIR/$domain.crt" \
       -subj "/CN=$domain" 2>/dev/null
   done

   docker build -f nginx/Dockerfile -t crm-nginx-test \
     --build-arg VITE_API_URL=/api --build-arg CRM_CSP_MODE=enforcing .

   # (b) --add-host=api:127.0.0.1 ОБЯЗАТЕЛЕН: nginx.conf's
   # `upstream api_upstream { server api:3001; }` резолвит хостнейм `api` ПРИ
   # СТАРТЕ контейнера (это НЕ build-time тест из Dockerfile, где эта же
   # строка подменяется на 127.0.0.1 — здесь настоящий nginx.conf, без правок).
   # Без него — тот же класс отказа при старте, что и без сертификатов.
   # `-v "$CERT_DIR:/etc/nginx/certs:ro"` — сертификаты из шага (a).
   docker run -d --name crm-nginx-test \
     -p 8080:80 -p 8443:443 \
     --add-host=api:127.0.0.1 \
     -v "$CERT_DIR:/etc/nginx/certs:ro" \
     crm-nginx-test

   CRM_CSP_MODE=enforcing scripts/devops/check-security-headers.sh http://localhost:8080

   # (c) уборка — контейнер, образ, временные сертификаты.
   docker rm -f crm-nginx-test
   docker rmi crm-nginx-test
   rm -rf "$CERT_DIR"
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

> **Важно (security review round 2): это НЕ `nginx -s reload`.**
> `CRM_CSP_MODE` — Docker build-ARG (см. `nginx/Dockerfile`'s `ARG CRM_CSP_MODE`
> комментарий), запечённый в `nginx/conf.d/csp-map.conf` НА ЭТАПЕ СБОРКИ образа
> (`sed` подставляет значение в `__CRM_CSP_MODE__` placeholder ВНУТРИ образа) —
> значение НЕ читается из runtime-окружения контейнера, поэтому изменить его на
> живом контейнере (reload/exec/env) невозможно в принципе. Откат =
> **пересборка nginx-образа + полный цикл деплоя** (`deploy.yml`: build job с
> новым build-arg → push в GHCR → deploy job → `docker compose up -d`
> switchover), тот же путь, что и флип вперёд (§4). Ожидаемое время цикла —
> **тот же порядок, что у любого обычного деплоя проекта** (сборка обоих SPA +
> nginx-образа + SSH-деплой), НЕ секунды/минуты reload'а конфига. Планировать
> инцидент-реакцию исходя из этого — «двухминутный откат» здесь не сценарий.

> **Важно (живая проверка 2026-08-04): к времени отката добавляется время жизни
> service worker'а на клиентах.** SW кеширует `index.html` **вместе с
> CSP-заголовком**, поэтому после завершения деплоя уже открытые вкладки и
> вернувшиеся пользователи продолжают энфорсить СТАРУЮ политику, пока их SW не
> обновится. Практическое следствие: «откатили и сразу проверили у себя» —
> недостаточное подтверждение; у части пользователей поломка ещё живёт. При
> инциденте либо дожидаться обновления SW, либо гасить его принудительно.

## 6. Известные ограничения (security review round 2)

- **`www.cheekycheese.tech` отсутствует в `CORS_ORIGINS`.** Origin-check в
  `CspReportsService.recordViolation` сверяет `document-uri` ТОЛЬКО с
  `FRONTEND_URL`/`CORS_ORIGINS` — сейчас это `app.cheekycheese.tech`. Если
  лендинг когда-нибудь получит собственный `report-uri`, его отчёты будут молча
  дропаться, пока `www.cheekycheese.tech` явно не добавят в `CORS_ORIGINS`.
- **`document_path` в БД — САНИТИЗИРОВАННОЕ значение, не всегда буквальный роут.**
  Control-символы и query/fragment срезаются ДО записи; в редких случаях там
  может оказаться артефакт санитайзера. При разборе агрегатов — если значение
  выглядит странно, свериться с сырым `document-uri` живого нарушения в DevTools,
  а не гоняться за призраком в БД.
- **`scripts/devops/check-security-headers.sh` не видит Cloudflare edge-инжекты
  (security review round 2, LOW-1).** Скрипт (и локальный dry-run, и
  `deploy.yml`'s post-deploy smoke-шаг) бьёт `127.0.0.1`/сам origin ДО
  Cloudflare-прокси — он доказывает, что nginx отдаёт правильные заголовки, но
  ничего не знает о том, что CF добавляет в ответ на своём edge (например,
  `<script data-cf-beacon>` Web Analytics — см. `csp-map.conf`'а комментарий
  про `static.cloudflareinsights.com`). «32 passed» из этого скрипта — это
  «nginx-конфиг корректен», а НЕ «весь HTML, который реально видит браузер,
  проверен на CF-инжекты». Если CF когда-нибудь сменит хост/скрипт beacon'а
  (или добавит новый), этот скрипт останется зелёным, а прод молча начнёт
  блокировать его в enforcing-режиме — единственный способ поймать такое
  сегодня — `csp_reports` дайджест (§2) после реального прод-трафика, не этот
  smoke-тест.

## 7. Связанные файлы

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
