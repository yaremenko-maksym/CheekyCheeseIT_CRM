# Рунбук: закрыть origin по-настоящему — файрвол + Authenticated Origin Pulls

**Кому:** владельцу (шаги требуют панели Cloudflare, консоли Hetzner и доступа к хосту —
у ассистента их нет).
**Зачем:** фильтр по источнику (`nginx/snippets/origin-gate.conf`) в своей же шапке
честно говорит, что он **не** контроль доступа: он проверяет, пришёл ли запрос из
публичных диапазонов Cloudflare, а не из **нашей** зоны. Его проходят пользователи
Cloudflare WARP, Cloudflare Workers и трафик любого другого клиента Cloudflare —
в любом режиме, включая блокирующий.

**Что реально закрывается этими двумя шагами:**

| Угроза                                                          | Файрвол | AOP (зона) | AOP (по хосту) |
| --------------------------------------------------------------- | ------- | ---------- | -------------- |
| Сканеры и боты стучат прямо по IP сервера мимо Cloudflare       | ✅ да   | ✅ да      | ✅ да          |
| Обход WAF и ограничителей Cloudflare прямым обращением к origin | ✅ да   | ✅ да      | ✅ да          |
| Подделка `CF-Connecting-IP` **другим клиентом Cloudflare**      | ❌ нет  | ❌ нет     | ✅ да          |

Третья строка — та, что касается данных: этот заголовок питает IP на подписи контракта
и согласия с условиями (мы храним его как юридическое доказательство) и ключ
ограничителя частоты запросов.

**Порядок важен.** Шаг 1 (файрвол) даёт больше всего и не может уронить посетителей.
Шаг 2 (mTLS) при неверном порядке действий роняет сайт целиком — поэтому там
наблюдательная фаза.

---

## Шаг 1 — Файрвол Hetzner Cloud (сеть, а не хост)

### Почему не `ufw`

Docker публикует 80/443 своими правилами в цепочках `nat`/`DOCKER`, которые
отрабатывают **раньше** цепочки `INPUT`. Поэтому `ufw deny 443` на таком хосте
не блокирует ничего — порт остаётся открытым, а в панели `ufw status` при этом
написано «deny». Это классическая ловушка, и у нас именно эта конфигурация
(`docker-compose.prod.yml`: `ports: - '80:80'`, `- '443:443'`).

Файрвол Hetzner Cloud фильтрует **до** попадания пакета на машину, поэтому правила
Docker его обойти не могут.

### Что сделать

1. Возьми актуальные диапазоны Cloudflare — **из первоисточника**, не из нашего файла:
   - https://www.cloudflare.com/ips-v4
   - https://www.cloudflare.com/ips-v6

   Их около 15 (IPv4) и 7 (IPv6).

2. Консоль Hetzner Cloud → **Firewalls** → **Create Firewall**.

3. Входящие правила — ровно три:

   | Протокол | Порт | Источник                       |
   | -------- | ---- | ------------------------------ |
   | TCP      | 80   | все диапазоны Cloudflare v4+v6 |
   | TCP      | 443  | все диапазоны Cloudflare v4+v6 |
   | TCP      | 22   | **Any IPv4 + Any IPv6**        |

   **Порт 22 оставить открытым.** Выкатка ходит на VPS по SSH из GitHub Actions
   (`.github/workflows/deploy.yml`, `appleboy/ssh-action`), а адреса раннеров
   динамические. Ограничение 22 сломает деплой. Защита там — ключи, не адрес.

   Исходящие правила не задавать (Hetzner при пустом списке исходящих разрешает всё;
   если задать — сломается вытягивание образов из GHCR и обращения к НБУ/Etherscan).

4. Применить файрвол к серверу (Apply to → выбрать VPS).

5. **Проверить парой команд** — обе обязательны, одна без другой ничего не доказывает:

   ```bash
   # через Cloudflare — должно работать
   curl -sS -o /dev/null -w '%{http_code}\n' https://cheekycheese.tech/

   # напрямую по IP сервера, мимо Cloudflare — должно ВИСНУТЬ и упасть по таймауту
   curl -sS --max-time 10 --resolve cheekycheese.tech:443:<IP_СЕРВЕРА> \
        -o /dev/null -w '%{http_code}\n' https://cheekycheese.tech/
   ```

   Первая даёт `200`. Вторая — `curl: (28) Connection timed out`. Если вторая
   вернула код ответа, файрвол не применился.

6. Прогнать выкатку один раз (любой merge в `main` либо `workflow_dispatch` для
   `deploy.yml`) и убедиться, что она зелёная. Это проверка, что SSH не задет.

### Цена этого шага, о которой надо знать заранее

После включения файрвола **устаревание диапазонов Cloudflare начинает ронять сайт**,
а не просто шуметь в логах: если Cloudflare добавит диапазон, а в файрволе его нет,
часть посетителей получит таймаут. Раньше такое устаревание было безобидным.

Поэтому: при каждом изменении списка Cloudflare правило в Hetzner обновляется вместе
с `nginx/cloudflare-ips.txt`. Проверка свежести уже есть —
`scripts/devops/check-cloudflare-ips-freshness.sh`. После этого шага она перестаёт
быть необязательной.

---

## Шаг 2 — Authenticated Origin Pulls (mTLS)

Cloudflare предъявляет нашему nginx клиентский сертификат, nginx его проверяет.
Прямое соединение без этого сертификата отвергается на уровне TLS.

### 2а. Зонный AOP (быстро, закрывает прямой доступ)

**Порядок строго такой — обратный роняет сайт.**

1. Положи публикуемый Cloudflare CA на хост, рядом с нашими сертификатами
   (каталог уже смонтирован в контейнер как `/etc/nginx/certs`, пересборка образа
   не нужна):

   ```bash
   sudo curl -fsS -o /etc/nginx/certs/cloudflare-origin-pull-ca.pem \
     https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem
   sudo openssl x509 -in /etc/nginx/certs/cloudflare-origin-pull-ca.pem -noout -subject -dates
   ```

   Вторая команда обязательна: она доказывает, что скачался сертификат, а не
   HTML-страница ошибки. Ожидаемо увидеть subject с `CloudFlare` и срок действия.

2. Панель Cloudflare → зона `cheekycheese.tech` → **SSL/TLS** → **Origin Server** →
   включить **Authenticated Origin Pulls** (зонный переключатель).
   **На этом шаге для нас не меняется ничего** — nginx пока не проверяет сертификат,
   уронить сайт этим нельзя. То же самое для зоны `app.cheekycheese.tech`, если она
   отдельная зона, а не запись внутри той же.

3. Скажи мне — я делаю PR, добавляющий в блоки `listen 443 ssl` (`crm.conf`,
   `landing.conf`, `default-server.conf`):

   ```nginx
   ssl_client_certificate /etc/nginx/certs/cloudflare-origin-pull-ca.pem;
   ssl_verify_client optional;     # НАБЛЮДЕНИЕ: отсутствие/валидный сертификат — не отвергает
   ```

   плюс `$ssl_client_verify` в формат лога. Это ровно тот же приём наблюдательной
   фазы, что у нас уже применён к фильтру по источнику и к CSP.

   **Точность формулировки «не отвергает» (сделано в PR #555, security review):**
   `optional` не отвергает ровно ДВА случая, которые и имеют значение на практике —
   отсутствие сертификата (`NONE`) и валидный сертификат (`SUCCESS`), оба получают
   обычный ответ (проверено живыми прогонами). Предъявленный, но НЕ верифицируемый
   сертификат — исключение: nginx отвечает автоматическим `400` ещё до попадания
   запроса в любой `location` — это собственное поведение nginx для
   `ssl_verify_client optional`, не баг конфига. За файрволом (шаг 1) и зонным AOP
   этот случай не ожидается на реальном трафике (край всегда предъявляет свой
   валидный сертификат) — полный разбор и живые прогоны см. в комментарии над
   `log_format main` в `nginx/nginx.conf`.

4. Сутки читаем лог: у **всего** реального трафика должно стоять `SUCCESS`.
   Ни одного `NONE`/`FAILED` от живых посетителей.

   **Команда (добавлено в PR #555, security review AOP-5 — проверена на живом
   контейнере, не выдумана).** Наивная `docker compose logs | grep client_verify=
| ... | sort | uniq -c` считает верно, но вводит в заблуждение тремя
   способами: не показывает, ЧТО конкретно было `NONE` (главный вопрос при
   решении о флипе); `docker compose logs` видит только ТЕКУЩИЙ контейнер, то
   есть любая выкатка молча обнуляет окно наблюдения; ротация json-file
   (`max-size: 10m` × `max-file: 5`, `docker-compose.prod.yml`) может усечь
   сутки без предупреждения. Команда ниже честно проверяет покрытие ДО того
   как выводит распределение, и печатает примеры строк `NONE`, а не только
   счётчик:

   ```bash
   cd /opt/crm
   docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml \
     logs --since 24h --timestamps --no-log-prefix nginx > /tmp/nginx-24h.log 2>&1

   CONTAINER_ID=$(docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml \
     --env-file .env.production ps -q nginx)
   STARTED_AT=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER_ID")
   FIRST_LINE_TS=$(grep -a 'client_verify=' /tmp/nginx-24h.log | head -n1 | awk '{print $1}')

   echo "nginx container started at: $STARTED_AT"
   echo "earliest client_verify= log line retrieved: ${FIRST_LINE_TS:-<none>}"

   STARTED_EPOCH=$(date -u -d "$STARTED_AT" +%s)
   NOW_EPOCH=$(date -u +%s)
   CONTAINER_AGE_HOURS=$(( (NOW_EPOCH - STARTED_EPOCH) / 3600 ))

   if [ -z "$FIRST_LINE_TS" ]; then
     echo "WARNING: no client_verify= lines at all in the requested window."
   elif [ "$CONTAINER_AGE_HOURS" -lt 24 ]; then
     echo "WARNING: nginx container is only ~${CONTAINER_AGE_HOURS}h old (redeployed since) — observation window is AT MOST ${CONTAINER_AGE_HOURS}h, not the requested 24h. A container swap resets what 'docker compose logs' can see."
   else
     FIRST_EPOCH=$(date -u -d "$FIRST_LINE_TS" +%s)
     COVERAGE_HOURS=$(( (NOW_EPOCH - FIRST_EPOCH) / 3600 ))
     if [ "$COVERAGE_HOURS" -lt 23 ]; then
       echo "WARNING: container up >=24h, but earliest available line is only ~${COVERAGE_HOURS}h old — json-file rotation (max-size=10m x5) likely truncated older entries. Treat as PARTIAL window."
     else
       echo "Coverage OK: ~${COVERAGE_HOURS}h of log available."
     fi
   fi

   echo ""
   echo "--- client_verify= distribution ---"
   grep -a 'client_verify=' /tmp/nginx-24h.log \
     | sed -n 's/.*client_verify=\(.*\)$/\1/p' | cut -d: -f1 | sort | uniq -c | sort -rn

   echo ""
   echo "--- sample NONE lines (up to 5) — inspect these to see WHAT presented no cert ---"
   if MATCHES=$(grep -a 'client_verify=NONE' /tmp/nginx-24h.log); then
     echo "$MATCHES" | head -5
   else
     echo "(none)"
   fi

   echo ""
   echo "--- sample FAILED lines (up to 5, if any) — anomalous, see the caveat above ---"
   if MATCHES=$(grep -a 'client_verify=FAILED' /tmp/nginx-24h.log); then
     echo "$MATCHES" | head -5
   else
     echo "(none)"
   fi
   ```

   (LOW-1, security review round 2, PR #555: `grep ... | head -5 || echo
   "(none)"` looks like it prints a fallback on zero matches, but does not —
   `$?` after a pipe is `head`'s exit code, and `head` exits `0` even after
   reading nothing from an empty/exhausted pipe. Verified: the old form
   silently prints NOTHING on zero matches, not `(none)` — the `if
   MATCHES=$(...)` form above branches on `grep`'s own exit code, which IS
   `1` on zero matches, and was verified against both an empty-match and a
   matching case.)

   GNU `date`/coreutils (matches the VPS's Ubuntu host — this is NOT meant to
   run on macOS/BSD). `--no-log-prefix` matters: without it, `docker compose
logs` prepends `nginx-1  | ` to every line, which shifts `awk '{print $1}'`
   onto the wrong field — found by actually running the command, not by
   reading `docker compose logs --help`. A clean `Coverage OK: ~24h of log
available` plus zero `FAILED`/`NONE` samples from real visitor traffic
   (health-checks and internal probes are expected `-`/occasional `NONE` and
   are not "real traffic") is the precondition for step 5 below.

5. По чистому окну я делаю однострочный PR `optional` → `on`. С этого момента
   прямое соединение без сертификата Cloudflare получает `400` на уровне TLS.

   **Чего этот флип НЕ даёт (см. §2б ниже для полного разбора):** зонный AOP
   использует общий сертификат Cloudflare — один и тот же у всех клиентов
   Cloudflare, не привязанный к нашей зоне. `on` доказывает «пришло из сети
   Cloudflare», а не «от края, реально обслуживающего `cheekycheese.tech`» —
   подделка `CF-Connecting-IP` ДРУГИМ клиентом Cloudflare этим шагом не
   закрывается. Закрывает её только §2б (свой сертификат, привязанный к
   хосту).

### Откат — два независимых режима (лекарства разные)

Добавлено в PR #555 (security review, AOP-4) — до этого рунбук не описывал откат
вообще. Симптом решает, какой режим:

**Режим А — трафик получает `400`.** Клиент предъявляет сертификат, который не
верифицируется против `cloudflare-origin-pull-ca.pem` (см. разбор в шаге 3 выше
и в `nginx/nginx.conf`'s комментарии над `log_format main`) — это встроенное
поведение `ssl_verify_client optional`, не отказ старта nginx: сам nginx жив и
исправно обслуживает всё остальное. **Лекарство — выключить Global Authenticated
Origin Pulls в панели Cloudflare** (`SSL/TLS` → `Origin Server`): край перестаёт
предъявлять сертификат вообще, `optional` резолвит запрос в `NONE`, ответ —
обычный `200`. Ни повторной выкатки, ни отката PR не нужно — чисто зонный
переключатель на стороне Cloudflare, эффект мгновенный.

**Режим Б — nginx не стартовал.** Причина: файл `cloudflare-origin-pull-ca.pem`
отсутствует или повреждён НА ХОСТЕ — `ssl_client_certificate` не может его
прочитать, nginx падает при загрузке конфига, контейнер не поднимается вообще
(это уже другой класс отказа, чем Режим А — до TLS-рукопожатия дело не доходит).
Панель Cloudflare здесь не поможет вовсе — проблема на нашей стороне. Два пути:

1. **Ремонт файла на хосте** — переприменить шаг 1 выше (`sudo curl ... -o
/etc/nginx/certs/cloudflare-origin-pull-ca.pem` + проверочный `openssl x509
... -subject -dates`), затем `docker compose -f docker-compose.prod.yml -f
docker-compose.ghcr.yml --env-file .env.production up -d nginx` на VPS.
   Быстрее, но требует ручного входа владельца на хост.
2. **`workflow_dispatch` `deploy.yml` с прежним рабочим `image_tag`** —
   пересобирает и передеплоивает известно-рабочий образ целиком. У ассистента
   нет интерактивного SSH к VPS (`appleboy/ssh-action` работает только внутри
   самого workflow-прогона), поэтому на практике это единственный путь,
   доступный без ручного входа владельца на VPS.

С PR #555 `deploy.yml` также получил preflight-шаг (прямо перед container-swap'ом,
Step 3): новый деплой падает ДО сноса текущего работающего контейнера, если
`cloudflare-origin-pull-ca.pem` отсутствует на хосте — это ловит Режим Б РАНЬШЕ
для будущих деплоев, но НЕ защищает от файла, удалённого/повреждённого на хосте
ПОСЛЕ последнего успешного деплоя (уже работающий контейнер продолжит падать при
рестарте) — тот случай всё ещё Режим Б выше, ремонт файла обязателен.

### 2б. AOP по хосту, со своим сертификатом (полностью закрывает третью строку таблицы)

Зонный AOP использует **общий** сертификат Cloudflare — один и тот же у всех клиентов
Cloudflare. Он доказывает «пришло от края Cloudflare», но не «от края, обслуживающего
нашу зону». Чтобы закрыть подделку `CF-Connecting-IP` другим клиентом Cloudflare,
нужен **свой** клиентский сертификат, загруженный в Cloudflare и привязанный к хосту;
nginx проверяет его против нашего же CA.

Это делается только через API Cloudflare (в панели такого переключателя нет) и требует
токена с правами на зону. **Токен никуда не вставляй в переписку** — команды запускаешь
сам, у себя.

Если решишь идти до конца — скажи, я подготовлю точную последовательность: генерация
пары, загрузка сертификата в зону, привязка к двум хостам, замена CA в nginx и та же
наблюдательная фаза. Это отдельная задача на полдня, и делать её осмысленно **после**
того как шаги 1 и 2а отработали.

---

## Что это меняет в бэклоге

- Пункты **A/B/C** остаются как договорено: чиню находки, режим фильтра не переключаю.
  После шага 1 ценность самого переключения падает почти до нуля — файрвол отсекает
  тот же трафик раньше и надёжнее. Фильтр остаётся вторым рубежом.
- Появляется новое требование к операциям: свежесть диапазонов Cloudflare становится
  способной уронить прод (см. цену шага 1).
- Утверждение «origin закрыт» станет правдой только после шага 2а. До него так писать
  в документации нельзя — сейчас в шапке `origin-gate.conf` про это сказано честно,
  и эту честность надо сохранить.
