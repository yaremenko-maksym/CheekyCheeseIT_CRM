# CSP Report-Only rollout (CRM) — runbook (fix/csp-allow-turnstile, PR #429)

> **Скоуп:** CRM (`app.cheekycheese.tech`) впервые в истории проекта получает
> `Content-Security-Policy` в этом PR — до него `crm.conf`'а add_header-баг
> (см. `nginx/conf.d/crm.conf`'s шапка-комментарий) полностью ронял ВСЕ
> security-заголовки на статике CRM, включая CSP. Security review round 1
> (PR #429, HIGH-1/MED-1) нашёл и исправил реальные разрывы политики
> (Cloudflare R2 для документов/инвойсов/чеков, `blob:` для превью чека при
> загрузке) и потребовал первый rollout сделать **Report-Only**, а не сразу
> enforcing — этот файл описывает как читать наблюдения и как переключить.

---

## 1. Что сейчас в проде (после мержа этого PR)

| Домен                         | `Content-Security-Policy` (enforcing) | `Content-Security-Policy-Report-Only`                    | Остальные 5 заголовков (HSTS/XFO/nosniff/Referrer-Policy/Permissions-Policy) |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `cheekycheese.tech` (landing) | ✅ да (боевая с PR #423)              | — не отправляется                                        | ✅ enforcing                                                                 |
| `app.cheekycheese.tech` (CRM) | — НЕ отправляется (намеренно)         | ✅ да — политика та же, что enforcing вернёт после флипа | ✅ enforcing (ничего не ломают, закрывают clickjacking СРАЗУ)                |

Механика — `nginx/conf.d/csp-map.conf`: единственный источник правды на
текст политики — `$csp_value` (per-domain `map $server_name`). Отдельные
маленькие maps `$csp_enforcing`/`$csp_report_only` решают ТОЛЬКО в какой
ИМЕННО заголовок эта строка попадёт для данного домена — `app.cheekycheese.
tech` сейчас явно захардкожен в report-only ветку в обоих maps. nginx
`add_header` с пустым значением заголовок вообще не отправляет (задокументированное
поведение `ngx_http_headers_module`, проверено эмпирически против этого
конкретного конфига) — поэтому на CRM сегодня энфорсящего `Content-Security-
Policy` в ответах нет вообще, только `-Report-Only`.

## 2. Как наблюдать нарушения сейчас (до report-uri)

**У политики нет `report-uri`/`report-to`** — это осознанное решение этого
PR (P0-фикс прод-регресса, зона DevOps — `nginx/**`, `scripts/devops/**`).
Добавление серверного коллектора нарушений — это новый NestJS endpoint +
telemetry-пайплайн (`apps/api/src/telemetry/**`, уже есть с #412/#415-417) —
зона Coder, отдельная задача, не блокирующая этот P0-фикс. Пока endpoint не
заведён, наблюдение — **вручную**:

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

**Follow-up (не в этом PR, зона Coder):** завести `report-uri`/`report-to` на
`/api/telemetry/csp-report` (или аналогичный same-origin endpoint), чтобы
собирать нарушения автоматически со всех реальных пользовательских сессий,
а не только с ручных QA-проходов. До тех пор ручной DevTools-проход — это
все, что доступно, и его достаточно для короткого report-only-периода
(политика уже статически верифицирована review + Playwright/Chromium
тестом в PR #429's body — report-only ловит только "неизвестное неизвестное",
не базовый набор путей).

## 3. Когда переключать на enforcing

Ориентир — **не по календарю, а по сигналу**: report-only-период можно
закрыть, когда:

- Ручной проход по документам/инвойсам/чекам (п. 2 выше) не даёт новых
  нарушений сверх уже известных/фиксированных.
- `scripts/devops/check-security-headers.sh` зелёный на проде (гоняется
  автоматически на каждом деплое, `deploy.yml`'s post-deploy smoke, FATAL —
  см. §4 ниже).
- Владелец подтвердил (обычная user-testing практика проекта — ЛЮБАЯ фича
  фиксится живым тестом в браузере ДО «готово», см. `.claude/agents/memory/
*/lessons.md` "Mandatory User Testing").

## 4. Как переключить CRM на enforcing (процедура)

1. `nginx/conf.d/csp-map.conf` — удалить ДВЕ строки
   `app.cheekycheese.tech "";` /`app.cheekycheese.tech $csp_value;`
   (по одной из `$csp_enforcing` и `$csp_report_only` maps). После удаления
   `default` в обоих maps сам подхватывает `app.cheekycheese.tech`
   (`$csp_value` для enforcing, `""` для report-only) — CRM начинает вести
   себя ровно как landing сегодня. **Текст политики (`$csp_value`) трогать
   не нужно** — он уже финальный, report-only использовался только как
   safety net на период наблюдения, а не как черновик политики.
2. `scripts/devops/check-security-headers.sh` — сменить константу
   `CRM_CSP_HEADER="Content-Security-Policy-Report-Only"` на
   `CRM_CSP_HEADER="Content-Security-Policy"` (комментарий над константой
   в самом скрипте прямо на это указывает). Без этой правки guard продолжит
   проверять заголовок, который CRM больше не отправляет, — молча перестанет
   что-либо ловить на CSP-кейсах.
3. Локальный dry-run ПЕРЕД пушем (тот же паттерн, что и в этом PR):
   `nginx:1.27-alpine` контейнер с новым конфигом →
   `scripts/devops/check-security-headers.sh http://localhost:<port>` — все
   кейсы, включая "Report-Only rollout" (переименовать/обновить под
   enforcing-состояние, если проверка на ABSENT enforcing-заголовка больше
   не применима), должны быть PASS.
4. Обычный PR (не bootstrap-исключение) → review → `merge-approved` от
   владельца → CI squash-merge → auto-deploy подхватит на следующем цикле.

## 5. Откат (если после флипа что-то сломалось)

Тот же файл, обратная операция: вернуть `app.cheekycheese.tech "";` /
`app.cheekycheese.tech $csp_value;` строки в `$csp_enforcing`/
`$csp_report_only` maps соответственно (т.е. `git revert` коммита из §4
шаг 1, либо руками) — CRM снова report-only, ничего не блокирует, пока
причину третьего разрыва не найдут. Это НЕ откатывает остальные 5
заголовков (HSTS/XFO/nosniff/Referrer-Policy/Permissions-Policy) — они
остаются enforcing независимо от режима CSP (см. §1 таблицу).

## 6. Связанные файлы

- `nginx/conf.d/csp-map.conf` — единственный источник текста политики +
  механика report-only/enforcing переключения (маркирован комментариями).
- `nginx/conf.d/security-headers.conf` — куда реально уходят
  `$csp_enforcing`/`$csp_report_only` (`add_header` строки).
- `scripts/devops/check-security-headers.sh` — guard, гоняется на каждом
  деплое (`deploy.yml`, FATAL шаг «Smoke test — security headers»).
- `docs/runbooks/s3-storage.md` — почему презайненные R2-ссылки
  cross-origin для CRM (контекст для HIGH-1).
