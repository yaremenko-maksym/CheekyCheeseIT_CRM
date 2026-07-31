# Origin-IP gate rollout (nginx) — runbook (fix/nginx-origin-gate-v2, PR #439,

# security review MED-6)

> **Скоуп:** origin-уровневая фильтрация по исходному IP на всех 4 реальных
> server-блоках (`crm.conf` :80/:443, `landing.conf` :80/:443) —
> `nginx/snippets/origin-gate.conf`. Первая попытка (`origin-access.conf`,
> PR #437) отфильтровала по `$remote_addr` — переменной, которую
> `ngx_http_realip_module` уже подменяет значением заголовка
> `CF-Connecting-IP` ДО того как гейт успевает его прочитать — блокировала
> реальных посетителей и пропускала атакующего, подключившегося напрямую с
> адреса внутри опубликованного диапазона Cloudflare без заголовка. PR #439
> — исправленная реализация (`$realip_remote_addr`, server-level `if`) +
> soft-launch режим наблюдения (`ORIGIN_GATE_MODE`). Этот файл описывает как
> читать окно наблюдения и как переключать режим — прямой аналог
> `scripts/devops/csp-report-only-rollout-runbook.md`, не дублируется здесь.

---

## 1. Что это НЕ делает (прочитать первым)

`nginx/snippets/origin-gate.conf`'s собственный header-комментарий несёт ту
же оговорку — повторено здесь намеренно (security review, MED-5): это
**снижение шума, а не контроль доступа**. Гейт фильтрует по диапазону
исходного IP (Cloudflare + небольшой local/intra-host allow-list) — он НЕ
проверяет, что запрос действительно пришёл через НАШУ Cloudflare-зону.
Cloudflare WARP, Cloudflare Workers, трафик ЛЮБОГО другого арендатора
Cloudflare — всё это проходит гейт наравне с реальным посетителем (диапазоны
публичны). Реальный контроль доступа — Cloudflare Authenticated Origin Pulls
(mTLS edge↔origin) + хостовый firewall, оба вне кода этого репо, ещё не
настроены на момент этого PR (владелец, операционная задача). Известное,
задокументированное ограничение (MED-7) — пир из CF-диапазона может
дополнительно подделать `CF-Connecting-IP`, влияя на "юридический" IP
(контракты/ToS) и ключ rate-limit'а — ещё один довод за mTLS, не за этот
фильтр.

## 2. Что сейчас в проде

| Параметр                         | Значение                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `ORIGIN_GATE_MODE`               | `observe` (по умолчанию, `.github/workflows/deploy.yml`'s top-level `env:`)                   |
| Блокирует ли что-то прямо сейчас | НЕТ — только логирует решение на каждый запрос (`nginx.conf`'s `log_format main`)             |
| Где смотреть решение per-запрос  | `origin_gate=0/1 mode=observe peer=$realip_remote_addr` — хвост каждой строки access-лога     |
| Пин docker-compose подсети       | `docker-compose.prod.yml`'s `frontend`/`backend` (`172.30.1.0/24`/`172.30.0.0/24`) — см. §3.1 |
| Runtime-discovery fallback       | `nginx/docker-entrypoint.d/25-origin-gate-runtime-trust.sh` — см. §3.1                        |

Механика — `nginx/conf.d/origin-gate-mode.conf`: тот же паттерн, что
`CRM_CSP_MODE` (build-arg → `map` → одна переменная `$origin_gate_enforce`).
`nginx/snippets/origin-gate.conf`'s server-level `if ($origin_gate_decision =
"01")` блокирует ТОЛЬКО когда `$origin_gate_allowed=0` (гейт отказал) И
`$origin_gate_enforce=1` (режим enforce) — в `observe` вторая цифра всегда
`0`, значит `01` недостижимо, блокировки не будет.

## 3. Как читать окно наблюдения

Ищи `origin_gate=0` в access-логе (Docker `json-file` driver, `docker
compose logs nginx` на VPS, или через существующий observability-путь) —
это ЗАПРОСЫ, КОТОРЫЕ ГЕЙТ ОТКЛОНИТ, как только режим станет `enforce`.
`peer=$realip_remote_addr` (добавлено security review, MED-2) — АДРЕС, ПО
КОТОРОМУ ГЕЙТ ПРИНЯЛ РЕШЕНИЕ (не путать с началом строки — это уже
пост-realip `$remote_addr`, адрес самого посетителя). Именно `peer=`
отвечает на развилку, ради которой окно наблюдения существует:

- **`peer=` похож на публичный IP, ПОХОЖИЙ на Cloudflare, но не совпадает ни
  с одним диапазоном в `nginx/cloudflare-ips.txt`** → скорее всего Cloudflare
  добавил новый диапазон, которого нет в файле → §3.2 (freshness check),
  дополнить файл, пересобрать.
- **`peer=` — произвольный публичный IP, никак не похожий на Cloudflare
  (сканер, прямое подключение к origin, минуя Cloudflare)** → ожидаемое
  поведение гейта, не требует действий (это ровно то, что гейт должен
  снижать по шуму).
- **`peer=` — адрес из `172.30.0.0/23` (пин) ИЛИ адрес, залогированный
  entrypoint-скриптом как "trusting default-route gateway"
  (`docker compose logs nginx` на старте контейнера) — но `origin_gate=0`**
  → противоречие (эти адреса ДОЛЖНЫ быть trusted) — это означает генератор/
  конфиг разошлись с ожиданием, расследовать ДО флипа, не игнорировать.

### 3.1 Проверка пина подсети (МЕД-1 — почему НЕ обязательна, но полезна)

`docker-compose.prod.yml`'s `ipam.config.subnet` пин — задокументированное
НАМЕРЕНИЕ топологии, но `deploy.yml`'s `docker compose up -d` никогда не
пересоздаёт уже существующую сеть — на деплое, где `frontend`/`backend` уже
существуют с ДРУГОЙ (авто-выделенной) подсетью, пин может молча не
примениться. `nginx/docker-entrypoint.d/25-origin-gate-runtime-trust.sh`
закрывает это НЕЗАВИСИМО от пина — на каждом старте контейнера читает
собственный default-route gateway (`/proc/net/route`, тот САМЫЙ адрес, с
которого реально придёт host-published-port трафик) и доверяет ЕМУ,
пин ли применился или нет. `docker compose logs nginx | grep
origin-gate-runtime-trust` покажет, какой адрес реально доверен на этом
конкретном деплое — **это самодостаточная защита, не требует ручной
проверки перед каждым флипом**, но при расследовании "почему `origin_gate=0`
на trusted-по-идее пире" — первый шаг.

Опционально (не блокирует флип): `docker network inspect crm_frontend
crm_backend | grep Subnet` на VPS — подтвердить, применился ли СТАТИЧЕСКИЙ
пин (документирует реальную топологию, полезно для аудита дрейфа сети со
временем).

### 3.2 Freshness-проверка `nginx/cloudflare-ips.txt` (MED-4 — MANDATORY)

```bash
scripts/devops/check-cloudflare-ips-freshness.sh
```

Диффает `nginx/cloudflare-ips.txt` против ЖИВЫХ `cloudflare.com/ips-v4` /
`ips-v6`. Fail-closed: сетевая ошибка / расхождение в ЛЮБУЮ сторону = ненулевой
exit — это НЕ рекомендация "иногда запускать", а **обязательное
предусловие §5 шаг 1** (не по календарю, не "as needed" — см. §1's
собственный header-комментарий скрипта за полным разбором, почему
устаревание бьёт УЖЕ СЕГОДНЯ, в `observe`, через `set_real_ip_from`,
независимо от `ORIGIN_GATE_MODE`).

### 3.3 Регресс-проверка переменной гейта (MED-3)

`scripts/devops/check-nginx-perimeter.sh`'s `check_gate_keyed_on_realip` —
СТАТИЧЕСКОЕ утверждение по `nginx -T`, что geo-блок гейта ключуется РОВНО на
`$realip_remote_addr` (не HTTP-проверка — см. функции собственный
header-комментарий за тем, почему чистый curl-тест НЕ способен поймать этот
класс регресса в контексте, в котором этот скрипт реально вызывается).
Гоняется автоматически на каждом деплое (`deploy.yml`'s FATAL smoke step,
`NGINX_EXEC_CMD` уже проброшен) — при локальном dry-run без `docker exec`
доступа явно SKIP (не silent PASS).

## 4. Когда переключать на enforce

Ориентир — **по сигналу, не по календарю**, тот же принцип, что CSP-рефёрс:

- §3 (`origin_gate=0` grep) не показывает НЕожидаемых записей (сверх
  подтверждённых "просто сканер/шум") за последние ~7 дней реального трафика.
- §3.2 freshness-check зелёный **на момент решения о флипе** (не "был зелёным
  когда-то").
- §3.3 регресс-проверка зелёная на последнем деплое (проверить в логе
  последнего прогона `deploy.yml`).
- Владелец подтвердил (обычная практика проекта — см. `.claude/agents/
memory/*/lessons.md` "Mandatory User Testing").

## 5. Как переключить на enforce (процедура)

**Одна переменная, одно место:** `.github/workflows/deploy.yml`'s top-level
`env:` блок — `ORIGIN_GATE_MODE: observe` → `ORIGIN_GATE_MODE: enforce`.

1. **Предусловия (все, не "хотя бы одно"):**
   - `scripts/devops/check-cloudflare-ips-freshness.sh` зелёный — см. §3.2.
     Если КРАСНЫЙ: обновить `nginx/cloudflare-ips.txt` (оба `ips-v4`/`ips-v6`),
     пересобрать, ПОВТОРИТЬ этот шаг с нуля.
   - §3 (окно наблюдения) не показывает необъяснённых `origin_gate=0` за
     последние ~7 дней.
   - Последний прогон `deploy.yml`'s "Smoke test — nginx perimeter" зелёный
     (косвенно подтверждает §3.3).
2. `.github/workflows/deploy.yml` — изменить `ORIGIN_GATE_MODE: observe` на
   `ORIGIN_GATE_MODE: enforce` в top-level `env:` блоке.
3. Локальный dry-run ПЕРЕД пушем (тот же паттерн, что CSP runbook §4 шаг 2):
   ```bash
   docker build -f nginx/Dockerfile -t crm-nginx-test \
     --build-arg VITE_API_URL=/api --build-arg ORIGIN_GATE_MODE=enforce .
   docker run -d --name crm-nginx-test -p 8080:80 \
     -v /path/to/dummy/certs:/etc/nginx/certs:ro crm-nginx-test
   NGINX_EXEC_CMD="docker exec crm-nginx-test" \
     scripts/devops/check-nginx-perimeter.sh http://localhost:8080
   ```
   Все кейсы, включая "gate-variable regression guard" (§3.3), PASS.
4. Обычный PR (не bootstrap-исключение) → review → `merge-approved` от
   владельца → CI squash-merge → auto-deploy подхватит на следующем цикле —
   `deploy.yml`'s build job передаёт `ORIGIN_GATE_MODE=enforce` как build-arg
   nginx-образу, deploy job's smoke step (§3.3, FATAL) верифицирует само
   переключение сразу на следующем деплое.

## 6. Откат (если после флипа что-то сломалось)

Тот же `env: ORIGIN_GATE_MODE:` — обратная операция (`enforce` →
`observe`, `git revert` коммита из §5 шаг 2 либо руками) → PR → merge →
redeploy — гейт снова только логирует, ничего не блокирует, пока причину
разрыва не найдут. НЕ откатывает `peer=`/`origin_gate=`/`mode=` поля в
логе — они пишутся в ОБОИХ режимах (§2), наблюдение продолжается без
перерыва.

## 7. Известные ограничения

- **MED-5 / §1 (это НЕ access control).** См. заголовок этого файла — не
  повторяется здесь целиком намеренно, но это САМОЕ важное ограничение,
  прочитать перед тем как опираться на этот гейт для чего-либо ещё.
- **MED-7 (pre-existing, не фиксится этим PR).** Пир из ЛЮБОГО диапазона
  Cloudflare может подделать `CF-Connecting-IP` — nginx ему поверит
  (`set_real_ip_from` доверяет диапазону, не конкретному IP внутри него).
  Влияет на "юридический" IP (контракты/ToS, `crm.conf`'s собственный
  комментарий "must be un-spoofable") и на ключ `limit_req_zone
$binary_remote_addr` (считается ПОСЛЕ realip-подстановки — ротация
  заголовка с пира внутри CF-диапазона обходит nginx-уровневый rate-limit).
  Единственный реальный контроль — Cloudflare Authenticated Origin Pulls
  (mTLS), не диапазонный фильтр — операционная задача владельца, вне кода.
- **Freshness — ручная операция.** `check-cloudflare-ips-freshness.sh`
  автоматизирует ПРОВЕРКУ, не САМО обновление — намеренно НЕ заведена как
  scheduled CI job (DevOps golden rule — нет лишних recurring jobs, см.
  `.claude/agents/devops.md` §"Golden rules" #4); это MANDATORY шаг
  процедуры флипа (§5 шаг 1), запускаемый по требованию, не по расписанию.

## 8. Связанные файлы

- `nginx/snippets/origin-gate.conf` — сама enforcement-логика + MED-5
  оговорка "noise reduction, not access control".
- `nginx/conf.d/origin-gate-mode.conf` — observe/enforce `map`-механика,
  `__ORIGIN_GATE_MODE__` placeholder.
- `nginx/cloudflare-ips.txt` — канонический источник CF-диапазонов (питает
  И `set_real_ip_from`, И allow-list гейта) + MED-4 freshness-требование.
- `scripts/devops/generate-cloudflare-nginx-snippets.sh` — генерирует
  `set_real_ip_from` + geo-блок гейта из `cloudflare-ips.txt` на build time.
- `nginx/docker-entrypoint.d/25-origin-gate-runtime-trust.sh` — runtime
  discovery (MED-1), belt-and-suspenders поверх статического пина.
- `docker-compose.prod.yml` — `frontend`/`backend` сети, `ipam.config.subnet`
  пин (MED-1 §3.1).
- `scripts/devops/check-nginx-perimeter.sh` — включает body-limit +
  default_server + real-visitor + gate-variable (MED-3) проверки.
- `scripts/devops/check-cloudflare-ips-freshness.sh` — MED-4 freshness gate.
- `.github/workflows/deploy.yml` — top-level `env: ORIGIN_GATE_MODE:`
  (single source of truth) + nginx build-arg + `NGINX_EXEC_CMD` + FATAL
  post-deploy smoke-test.
- `scripts/devops/csp-report-only-rollout-runbook.md` — аналогичный runbook
  для CSP-рефёрса, тот же паттерн одной переменной + окна наблюдения.
