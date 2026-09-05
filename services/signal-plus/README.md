# signal-plus

Every morning, at a random moment inside a fixed window, send `+` to the
owner's Signal group via [`signal-cli`](https://github.com/AsamK/signal-cli)
(AsamK). One send per day, no matter what happens to the container.

This is **step 1 of 4** (see `.claude/tasks/task-signal-plus-service.md` in the
main repo): only the service and its tests. Dockerfile, docker-compose,
linking the account, and going live on the server are steps 2-4, each gated
on the owner explicitly confirming the previous step.

Not a pnpm workspace member — plain Python, `python -m pytest`, stdlib-first.

## What it does

- **Window:** a uniformly-random moment in **07:00-07:45 Europe/Kyiv**
  (`signal_plus/slot.py`, `zoneinfo`-based — correct across both DST
  transitions, never naive `datetime`).
- **Idempotent:** the date of the last successful send lives in a JSON state
  file, written atomically (temp file + `os.replace`). A restart after a
  successful send today does not send a second `+`.
- **Late but not too late:** miss the window (restart, crash, update) and the
  service still sends up to the handover cutoff (`HANDOVER_TIME`, default
  **08:00 Kyiv**), logging `WARNING late`. At the cutoff, with no successful
  send yet today, it sends a handover email (see "Alerting"), gives up on the
  day entirely (`ERROR` + the rest of the alert), and does not retry until
  tomorrow.
- **`receive` before every `send`** — otherwise the linked device goes stale.
- **Retries with exponential backoff** on a send failure; full exhaustion is
  an `ERROR` + alert.
- **Auto-updates signal-cli** if (and only if) the server rejects the client
  as too old — see "Auto-update" below. At most one attempt per day.
- **Four independent alert layers** at the handover cutoff (log, personal
  DM, GitHub issue, handover email); the retry-exhaustion `ERROR` before
  that point uses the first three — see "Alerting" below.

## Install & run

```bash
cd services/signal-plus
python3.11 -m venv .venv && source .venv/bin/activate   # or python3.12
pip install -e ".[dev]"
cp .env.example .env   # then fill in real values
```

```bash
signal-plus --groups   # list Signal groups with their ids, then exit
signal-plus --now       # send immediately, skipping the slot wait (idempotency still respected)
signal-plus --once      # run a single cycle (wait for the slot, send, exit)
signal-plus              # daemon: repeats forever, one cycle per day
```

## Configuration

Everything is env-driven (`signal_plus/config.py`) — nothing is hardcoded,
no secret is ever in source. Full reference: `.env.example`.

| Variable                     | Required | Purpose                                                            |
| ---------------------------- | -------- | ------------------------------------------------------------------ |
| `SIGNAL_ACCOUNT`             | yes      | the sending account (masked in logs)                               |
| `SIGNAL_GROUP_ID`            | yes      | target group                                                       |
| `SIGNAL_CLI_BIN`             | yes      | path to the `signal-cli` executable to run                         |
| `STATE_FILE`                 | yes      | path to the JSON idempotency/state file                            |
| `SIGNAL_DATA_DIR`            | no       | volume root for auto-update (unset = auto-update off)              |
| `SIGNAL_CLI_GPG_FINGERPRINT` | no       | required release-signature fingerprint (unset = auto-update off)   |
| `SIGNAL_ALERT_RECIPIENT`     | no       | personal DM alert recipient (unset = that layer skipped)           |
| `HANDOVER_TIME`              | no       | handover cutoff, `HH:MM` Kyiv, default `08:00`                     |
| `RESEND_API_KEY`             | no       | Resend API key for the handover email (unset = that layer skipped) |
| `ALERT_EMAIL_FROM`           | no       | sender, default `site@cheekycheese.tech`                           |
| `ALERT_EMAIL_TO`             | no       | handover email recipient (unset = that layer skipped)              |

## Testing

```bash
cd services/signal-plus
python3.11 -m pytest    # and separately:
python3.12 -m pytest
```

No test in this suite makes a real `signal-cli` call or a real network call
(AC6). `tests/conftest.py` enforces this suite-wide: `PATH` is emptied and
`socket.socket` is replaced with a function that raises, so even a test that
forgets to inject a fake `run`/`http_get` cannot reach a real binary or the
network — on top of every individual test already injecting its own fake.

## Architecture

```
signal_plus/config.py    env -> Config dataclass, validation, SIGNAL_ACCOUNT masking
signal_plus/slot.py      the 07:00-07:45 window, DST-safe (zoneinfo), the handover cutoff
signal_plus/state.py     atomic JSON state (temp file + os.replace)
signal_plus/signal.py    subprocess wrapper: receive / send / listGroups
signal_plus/updater.py   outdated-client detection, signed download, GPG verify, atomic swap
signal_plus/alert.py     the three alert layers + the "auto-updated, not an error" heads-up
signal_plus/cli.py       orchestration: modes, chunked sleep, retries, update wiring
```

## Auto-update

Triggered by **one specific signal**, nothing else: the literal string
`signal-cli version is too old for the Signal-Server, please update.`,
which is exactly what `signal-cli` itself throws
(`lib/src/main/java/org/asamk/signal/manager/SignalAccountFiles.java`,
lines 164-168 at tag `v0.14.7`, commit
`b01b6b370dc063599a1a2b9fde0f5ff4e2d78fe8`) when the Signal server rejects
the account/version check that runs before every command, `send` included.
Any other failure (network error, bad credentials, rate limiting, ...) never
triggers an update — see `signal_plus/updater.py`'s `is_outdated_client_error`
and its docstring for the full citation.

On trigger: download the latest `Linux-native` release + its `.asc` from
GitHub Releases, verify the GPG signature with `gpg --verify`, requiring
**both** a valid signature **and** that it was made by exactly
`SIGNAL_CLI_GPG_FINGERPRINT` (no trust-on-first-use — a valid signature from
some _other_ key in the keyring is still rejected). A bad signature deletes
the downloaded files and does not install or run them.

The fingerprint's default (`FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570`) was
**not** found documented in signal-cli's README or wiki (checked, zero
matches). Verified against three independent sources instead, all agreeing:
the release artifact's own PGP signature packet (`gpg --list-packets` on the
real `signal-cli-0.14.7-Linux-native.tar.gz.asc`), the GPG-signed git tag
`v0.14.7` (tagger `AsamK <asamk@gmx.de>`), and — independent of the release
artifact itself — GitHub's own `https://github.com/AsamK.gpg` (the same
mechanism as `.keys` for SSH), fetched fresh and imported into a scratch
keyring. This is still only a default — `SIGNAL_CLI_GPG_FINGERPRINT` is what
actually governs verification, so a maintainer key rotation is a config
change, not a code change.

On success: extract to `$SIGNAL_DATA_DIR/bin/<version>/`, atomically swap the
`bin/current` symlink, record the version in state, `receive` (lets any
pending data migrate forward on the new binary), then retry the send once.
At most one update attempt per calendar day (Kyiv), tracked in state and
persisted immediately so the guard survives a crash mid-attempt.

The image is expected to carry a pinned `signal-cli` binary as a fallback
copy at **`/opt/signal-cli-pinned/signal-cli`**
(`signal_plus.updater.DEFAULT_IMAGE_PINNED_BIN_DIR`) — on first start, if
`$SIGNAL_DATA_DIR/bin/current` doesn't exist yet, it's seeded from that path
(`signal_plus.updater.ensure_seed_binary`). The service always runs the
binary the volume's `current` symlink points to, never a path baked
directly into the image — that path is step 2's job to populate (build the
`Linux-native` binary into the image at that location) and step 3's to
mount the volume.

The tag announced by GitHub, the asset name, and both download URLs must
all literally agree before anything downloads (fix-round 2, SR-H-3) — a
release claiming to be `v9.9.9` while its assets are really the old,
validly-signed `v0.9.0` is rejected before the network call, not after. The
URL check is an **exact** match against the one correct
`.../releases/download/<tag>/<asset>` URL reconstructed from the
already-validated tag and asset name (fix-round 3, SR-M-10) — not merely a
prefix check, which a trailing `../../evil/payload.tar.gz` or `?query`
could still satisfy without actually being a URL under that tag's release.
After install, the binary that actually landed is run with `--version` and
must report the announced version, or the symlink swap is rolled back and
the attempt fails, and the mismatched extraction directory is removed —
the GPG signature only proves AsamK signed those bytes, not that they are
what they claim to be. A second, separate check (fix-round 4, SR-L-10)
then runs `listGroups` against the configured account, with the same
`-Djava.io.tmpdir` flag every other invocation gets — `--version` alone
never proves the binary can actually load its native libraries under this
container's hardening (that is exactly why the pre-round-3 smoke test
could not catch SR-H-4 either), so the swap is not trusted until something
that DOES load them has been run against the binary that actually landed.

**Native library extraction, and where it actually goes (fix-round 3,
SR-H-4).** signal-cli's native-image binary extracts and `dlopen`s its own
native libraries (`libsignal_jni`, and separately sqlite-jdbc's own
`libsqlitejdbc.so`) at startup — the container's own `/tmp`, which
`docker-compose.yml` mounts `noexec`, cannot serve that. Fix-round 2
(SR-M-8) tried to redirect this via the `TMPDIR`/`SQLITE_TMPDIR` env vars
alone, on the premise that `java.io.tmpdir` (the JVM property that actually
governs where `libsignal_jni` gets extracted) defaults to reading `TMPDIR`.
**That premise was wrong** — reproduced against the real `signal-cli 0.14.7`
binary in this exact hardening profile: with only the env vars set, it
still failed with `Can't load library: /tmp/libsignal.../libsignal_jni_amd64.so`,
i.e. it still tried (and had to fail) to use noexec `/tmp`. The fix that
actually works: `signal_plus/signal.py` passes `-Djava.io.tmpdir=<value>`
(from `SIGNAL_TMPDIR`, default `/data/tmp`) as the **first** argument to
`signal-cli` on **every** invocation — native-image accepts `-D` system
property flags before the subcommand, same as a plain `java` command line.
Proven: with the flag, the same failure changes to `User ... is not
registered` — the library loaded and the process reached the network.
`TMPDIR`/`SQLITE_TMPDIR` are still set too (sqlite-jdbc's own extraction
genuinely does respect them), but they are not what fixes `libsignal_jni`
loading — `SIGNAL_TMPDIR` is. All three default to the same path, and
`docker-entrypoint.sh` creates all three directories on every boot.

## Alerting

Three layers on any `ERROR` (retry exhaustion before the handover cutoff,
or the handover cutoff itself), each independent — one failing does not
prevent the others:

1. `ERROR` in the log, always.
2. A personal Signal DM to `SIGNAL_ALERT_RECIPIENT` via `signal-cli send`, if
   configured.
3. A GitHub issue via the existing `scripts/devops/post-merge-alert.sh`,
   called with `KIND=signal-plus`. **This script is not modified by
   signal-plus** — it is DevOps's zone. `signal_plus/alert.py` only shapes
   the call; see "Step 4" below for what's still missing to make this layer
   actually work end to end.

**At the handover cutoff specifically** (`HANDOVER_TIME`, default 08:00 —
requirement 9, rewritten in the task file 2026-09-03, owner decision quoted
verbatim there), a fourth independent layer fires alongside the three
above: a handover email via the Resend HTTP API (stdlib `urllib`, no SDK),
reusing the same `RESEND_API_KEY` already in the web app's deploy secrets.
No-ops (skipped, not an error) if `RESEND_API_KEY` or `ALERT_EMAIL_TO` is
unconfigured — same pattern as the personal-DM layer. Body text follows the
project's transactional-email convention (no thanks/framing, one thought):
"Утренний + не отправлен к `<HANDOVER_TIME>`. Напишите в группу вручную.
Причина: `<последняя ошибка>`. Сервис на сегодня остановлен." A Resend
failure logs `ERROR` but does not block the other three layers, and vice
versa (`signal_plus.alert.raise_handover_alert`).

A successful auto-update is explicitly **not** routed through the `ERROR`
alert (`signal_plus.alert.notify_stale_pin`): it logs `INFO old -> new` and
sends only the personal-DM layer (if configured), as a heads-up that the
image's pinned binary is now behind, not as an incident.

## Секреты: отзыв и скоуп

`RESEND_API_KEY` (SR-M-4, security review 5105061153) — **тот же ключ, что
у контактной формы веб-части CRM**, отдельного не заводили. `.env.example`
говорит об этом прямо. Практическое следствие: если контейнер
`signal-plus` скомпрометирован (например, через `SIGNAL_PLUS_ENV`), у
атакующего оказывается ключ, которым можно слать письма от имени
верифицированного `@cheekycheese.tech` — тот же ключ, что использует
контактная форма сайта. **Отзыв одного ключа в Resend отзывает канал у
обоих потребителей одновременно** — отдельно откатить только signal-plus,
оставив контактную форму работающей, сейчас нельзя.

Оба значения (веб-часть и signal-plus) в любом случае живут на одном VPS,
так что изоляция контейнеров друг от друга не была бы полной защитой сама
по себе — но отзываемость по отдельности всё равно ценна: send-only ключ с
ограниченным скоупом для signal-plus позволил бы откатить именно этот
канал, не выключая контактную форму. Отдельный ключ — решение владельца,
не код; вынесено как вопрос в «Допущения» этого PR.

## Step 4 (DevOps) — what's still needed for the GitHub-issue alert layer

**Done, in step 2 (this PR's own workflow-failure alert needed the same
switch anyway):** `post-merge-alert.sh` now recognizes `KIND=signal-plus`
(title/body text + default `LABEL=signal-plus-deploy-broken`), same
per-KIND pattern as `ci`/`deploy`/`backup`/`mutation`. Verified with
`DRY_RUN=1` for both the create and the recovery-close path.

**Still open** — this `KIND` addition only makes the SCRIPT accept the
value; it does nothing yet for THIS project's own layer 3 (the IN-CONTAINER
call `signal_plus.alert.send_github_issue_alert` makes at 08:00/on
retry-exhaustion), which is a separate concern from step 2's own deploy
workflow alerting (`.github/workflows/deploy-signal-plus.yml`'s own
"Alert on deploy failure" steps, which run on the GHA runner with the full
repo checked out and need none of this). For the in-container layer to
actually create/update/close an issue, a later step still needs to:

1. Decide how the signal-plus container reaches the script at all (bind
   mount the CRM checkout's `scripts/devops/`, copy the one file in, or
   something else) and set `signal_plus.alert.DEFAULT_POST_MERGE_ALERT_SCRIPT`
   (or override it at the `cli.run_cycle(..., alert_script_path=...)` call
   site) to wherever it actually ends up. Its default,
   `/opt/crm/scripts/devops/post-merge-alert.sh`, already matches the CRM
   compose project's real on-server path — bind-mounting that exact file
   read-only into the signal-plus container needs no code change at all.
2. Provide `ALERT_REPO` and `GH_TOKEN` in the container's environment —
   `signal_plus.cli._issue_alert_env` already reads them opportunistically
   from `os.environ` if present.
3. Decide what `COMMIT_SHA`/`RUN_URL` should reasonably be for a scheduled
   roll-call with no CI run behind it (this service currently sends
   clearly-marked placeholders — `"0" * 40"` / `"n/a (scheduled signal-plus
roll-call, not a CI run)"` — since there is no natural analog and
   fabricating a real-looking value seemed worse than an honest placeholder).

Until that lands, layers 1 and 2 (log + personal DM) work as designed;
layer 3 fails closed — not because of an unrecognized `KIND` anymore (fixed
above), but because the script isn't reachable from inside the container yet
and `ALERT_REPO`/`GH_TOKEN` aren't set there either — without blocking the
other two: `signal_plus.alert.raise_alert` treats every layer as
independent.

## Деплой и линковка

**Step 2** (`Dockerfile`, `docker-compose.yml`,
`.github/workflows/deploy-signal-plus.yml`) builds the image, pushes it to
GHCR, writes `/opt/signal-plus/.env` from the `SIGNAL_PLUS_ENV` secret, and
runs `docker compose -p signal-plus up -d` on the VPS — on every push to
`main` that touches `services/signal-plus/**`, or on
`gh workflow run deploy-signal-plus.yml --ref main`. It does **not** link
the account: linking needs an interactive QR scan on the owner's phone,
which no CI job can do. Everything below is **step 3**, run by the owner
directly on the VPS after step 2 has deployed at least once.

### Если `docker compose pull` падает на `lchown` — что это и как проверять

Run 33946345307 (первый реальный `workflow_dispatch` деплой на VPS) упал
именно на этом шаге, с точным текстом:

```
failed to extract layer (application/vnd.oci.image.layer.v1.tar+gzip sha256:76f191...) to overlayfs as "extract-... sha256:3cad0c43...":
failed to Lchown ".../opt/signal-cli-pinned/signal-cli" for UID 0, GID 0:
lchown .../opt/signal-cli-pinned/signal-cli: no such file or directory
```

`sha256:76f191...` — это слой, который добавляет `signal-cli` (372 МБ,
единственный большой бинарь в образе — самый крупный слой с большим
отрывом). `sha256:3cad0c43...` — НЕ другой слой: это chain ID (хеш всей
цепочки слоёв ДО и ВКЛЮЧАЯ этот), под которым containerd именует временный
снапшот на время распаковки именно ЭТОГО слоя — совпадает у всех, кто тянет
тот же тег. `UID 0, GID 0` тоже ни на что не намекает — это просто root,
владелец файла в образе (весь `/opt/signal-cli-pinned` root:root).

**Что уже проверено фактом (infra/signal-plus-pull-fix, эта же ветка/PR)** —
не повторять расследование заново, если это всплывёт снова:

1. **Слой сам по себе — не битый.** Скачан напрямую из GHCR по digest
   (`docker login ghcr.io` + `curl` на `/v2/.../blobs/sha256:76f191...`,
   БЕЗ `docker save`/`docker load` — они умеют перепаковывать слой и
   маскировать реальную структуру) и разобран Python'овским `tarfile`
   (авторитетный парсер, не полагается на то, что показывает `tar -tv` в
   конкретной реализации). Ровно 3 записи, в правильном порядке: каталог
   `opt`, каталог `opt/signal-cli-pinned`, обычный файл (`type='0'`)
   `opt/signal-cli-pinned/signal-cli`, 372377528 байт. **Ни symlink, ни
   hardlink, ни PAX/sparse-заголовков нет.** Гипотеза «hardlink на
   отсутствующую в этом слое цель» (типичная причина именно такой ошибки)
   этим фактом опровергнута для данного конкретного образа.
2. **Те же самые байты извлекаются чисто на containerd overlayfs
   snapshotter в двух независимых окружениях**, которые умеют то же самое
   `driver-type: io.containerd.snapshotter.v1`, что и VPS:
   - вложенный `docker:27-dind` (Docker 27.5.1) с
     `daemon.json`: `{"features":{"containerd-snapshotter":true}}`;
   - `ubuntu-latest` в GitHub Actions (Docker 28.0.4) — тем же способом,
     плюс отдельно свежая пересборка ЭТОГО Dockerfile, запушенная в
     одноразовый локальный `registry:2` и вытянутая обратно (см. шаг "Reproduce the VPS path" в `build-and-test`, `.github/workflows/deploy-signal-plus.yml` — это ПОСТОЯННЫЙ регресс-гвард, гоняется на каждом PR, трогающем этот сервис).
3. **Вывод: детерминированного, воспроизводимого структурного дефекта в
   Dockerfile не нашлось.** Самое вероятное объяснение из того, что
   осталось непроверяемым без SSH на VPS — версия `docker-ce`/
   `containerd.io`, которая туда ставилась: `docs/runbooks/deployment.md` ставит их БЕЗ фиксации версии (`apt install docker-ce docker-ce-cli containerd.io docker-compose-plugin` — что было текущим в APT на момент провижининга VPS, то и встало). Это правдоподобно давно пофикшенный
   баг конкретно в containerd overlayfs-снапшоттере, либо гонка,
   чувствительная к задержкам конкретно виртуализованного диска Hetzner
   (замер по прогрессу извлечения в упавшем логе: "Extracting" застряло
   на 1-2 байтах ~1.3 сек и тут же упало — похоже на сбой в САМОМ начале
   записи файла, а не посреди 372 МБ).

**Что сделано, раз структурная причина не подтвердилась:**

- Dockerfile всё равно защищён: два `COPY --from=signal-cli-fetch` заменены
  на один `RUN --mount=type=bind` + `cp` (см. комментарий на месте) — не
  подтверждённый фикс, а дешёвая страховка на случай, если дело было в
  BuildKit-специфичной оптимизации самого `COPY`, которую обычный `RUN`
  не делает. Итоговое содержимое образа не изменилось (тот же файл, тот же
  путь, тот же режим — проверено `docker run --entrypoint ls`).
- `docker compose -p signal-plus pull` на VPS (шаг "Pull and start
  signal-plus" в `deploy` job) теперь повторяет попытку до 4 раз с
  нарастающей паузой (10/20/30 сек) прежде чем считать деплой упавшим —
  та же форма, что и у фикса pnpm-audit gate (PR #654) для «медленного, но
  не мёртвого» реестра: если это была разовая заминка, повтор её
  переживёт; если проблема настоящая — деплой всё равно красный, просто
  не с первой попытки.

**Если упадёт снова с ЭТОЙ ЖЕ ошибкой** (все 4 попытки исчерпаны) — значит
дело либо не в разовой заминке, либо это Dockerfile-независимый баг
containerd на VPS. Проверить фактом, не гадать:

```bash
# на VPS, вручную
docker version --format '{{.Server.Version}}'
docker info --format '{{json .DriverStatus}}'   # ожидаем io.containerd.snapshotter.v1
containerd --version
```

Сравнить с подтверждённо-рабочими версиями выше (27.5.1 и 28.0.4). Если версия заметно старше — `apt update && apt install --only-upgrade docker-ce docker-ce-cli containerd.io` на VPS: единственное действие из
всего расследования, которое реально меняет то, что стояло на момент
падения run 33946345307, а не просто хеджирует вокруг него. Это ручной шаг
владельца (нет SSH-доступа у агентов вне `deploy` job, а в нём — только
секреты для деплоя, не для произвольного `apt upgrade`).

### Линковка (один раз)

**Перед первым запуском** (CR-M-4, code review 5105099737):
`SIGNAL_ACCOUNT` в `/opt/signal-plus/.env` должен УЖЕ быть номером
телефона того аккаунта, которым будет отсканирован QR ниже — это не
значение, которое владелец выбирает произвольно, а то, чей телефон
сканирует. `signal-cli -a $SIGNAL_ACCOUNT ...` во всех последующих
командах (`--groups`, `--now`, демон) ищет локальные данные аккаунта по
этому номеру — до линковки под неверным `SIGNAL_ACCOUNT` они там не
появятся, и `receive`/`send` не заработают осмысленно.

SR-M-5 (security review 5105061153): раньше это были ДВЕ команды — первая
писала device-link URI (`sgnl://linkdevice?uuid=...&pub_key=...` —
capability, кто им воспользуется, привяжет своё устройство к аккаунту)
файлом на диск VPS через `| tee` **на хосте**, с правами по умолчанию
(`umask 022` → `0644`) и без удаления после использования; вторая читала
файл уже из **нового** контейнера, чей `/tmp` — свой отдельный tmpfs
(`docker-compose.yml`), пустой — QR там показать было нечем. Ниже — одна
команда, один контейнер, ничего не касается диска VPS:

```bash
cd /opt/signal-plus
docker compose -p signal-plus run --rm -it signal-plus sh -c \
  'signal-cli link -n "server-plus" | grep -o -m 1 "sgnl://[^ ]*" | qrencode -t ansiutf8'
```

Механика пайпа проверена **исполнением**, не только рассуждением: живой
`link`-подобный процесс (печатает URI одной строкой, затем продолжает
работать, не закрывая stdout, имитируя ожидание скана) пропущен через
ровно этот конвейер. Наивный вариант без `-m 1`
(`... | grep -o "sgnl://[^ ]*" | qrencode ...`) на такой же имитации
**подтверждённо блокируется** — `qrencode` не печатает ничего, пока
`grep` не увидит EOF, а `grep` не увидит EOF, пока не завершится сам
`link`, то есть QR показался бы только после того, как сканировать уже
поздно (ровно то, что раньше было только предположением про
`qrencode`/`EOF`). С `-m 1` (первое совпадение — и `grep` сразу завершает
себя, закрывая пайп) QR рендерится за секунды, а сам `link`-подобный
процесс в это время **продолжает работать** (проверено: жив после того,
как QR уже напечатан) — то есть контейнер не выходит преждевременно,
`link` успевает дождаться реального скана.

**Что не проверено** (стоп-линия шага 2 — команда `link` не выполнялась
ни разу с реальным аккаунтом): печатает ли РЕАЛЬНЫЙ `signal-cli link`
строку `sgnl://...` через `System.out` сразу и с автосбросом буфера, или
буферизует вывод при обнаружении не-tty на своём stdout (что задержало бы
появление строки у `grep`, даже с `-m 1`). Если после реального запуска
на сервере окажется, что QR всё же не появляется вовремя — альтернатива
из задания: `signal-cli link` в фоне (`&`), читать его stdout в этом же
контейнере отдельной командой (`wait`/`jobs` для того же PID 1) вместо
пайпа.

Сканировать QR: **Signal на телефоне → Настройки → Связанные устройства →
«+» → навести камеру на код в терминале.**

`docker compose run` наследует `read_only: true` + том `signal_data` из
`docker-compose.yml` — сама привязанная идентичность (ключи, сессии) пишется
на том (`XDG_DATA_HOME=/data`, см. Dockerfile), не в слой контейнера, и
переживёт `docker compose up -d` после линковки.

### Выбор группы и первый тест

```bash
docker compose -p signal-plus run --rm signal-plus signal-plus --groups
```

(режим `--groups` — флаг ОБЁРТКИ, см. `build_arg_parser()` в
`signal_plus/cli.py`, а не самого `signal-cli` — у него такого флага нет,
список групп там только через подкоманду `listGroups`, которую наша
обёртка и вызывает; печатает список групп с id, ничего не отправляет).
Найти **пустую тестовую группу** в выводе, скопировать её id.

```bash
vi /opt/signal-plus/.env   # SIGNAL_GROUP_ID=<id пустой группы>
```

Отправить один `+` немедленно (идемпотентность всё равно уважается —
`--now` не даст второй `+`, если сегодняшний уже ушёл):

```bash
docker compose -p signal-plus run --rm signal-plus signal-plus --now
```

Проверить, что `+` пришёл в выбранную группу. Затем — обычный демон:

```bash
docker compose -p signal-plus up -d
```

### Что лежит в томе и как его стереть при отзыве

SR-L-4 (security review 5105061153): именованный том `signal_data`
(`docker-compose.yml`) — обычный диск-backed том (проверено в шаге 2:
`/opt/signal-plus` сидит на том же `/dev/sda1`, что и `/opt/crm`, не
`tmpfs`), и содержимое на нём **не шифруется** ничем в этом сервисе.
Внутри:

- ключи и сессия связанного устройства signal-cli (`XDG_DATA_HOME=/data`,
  см. Dockerfile) — это то, что даёт устройству право получать/отправлять
  сообщения от имени аккаунта, эквивалент отпечатка «Связанные устройства»
  на телефоне;
- `state.json` — идемпотентность, без секретов;
- GPG-кольцо доверия для проверки подписи автообновлений
  (`GNUPGHOME=/data/gnupg`) — публичный ключ мейнтейнера, не секрет сам по
  себе, но том целиком не разделён на «секретную» и «публичную» части;
- бинарь `signal-cli`, если сработало автообновление.

Практическое следствие: любой бэкап на уровне хоста (снапшот диска,
`/var/lib/docker/volumes` целиком) унесёт эти файлы **как есть**, без
шифрования. Компрометация сервера или его бэкапа — это и компрометация
связанного устройства, не только самого контейнера. Единственный способ
обесценить уже скомпрометированные ключи — отозвать устройство с телефона
(ниже) и стереть том; шифрование самого тома в этом PR не сделано
(отдельная задача, если понадобится).

### Отзыв (revoke)

Отвязать сервер от аккаунта **с телефона** (не с сервера — signal-cli не
умеет отзывать сам себя):

**Signal на телефоне → Настройки → Связанные устройства → найти
«server-plus» → смахнуть/удалить.**

После этого стереть на сервере том с привязанной идентичностью (иначе
контейнер продолжит пытаться работать со связью, которой Signal-сервер уже
не признаёт):

```bash
cd /opt/signal-plus
docker compose -p signal-plus down
docker volume rm signal-plus_signal_data
```

Следующий `docker compose -p signal-plus up -d` начнёт с чистого тома —
`ensure_seed_binary` пересеет пиненный бинарь из образа, но аккаунт нужно
будет линковать заново (раздел «Линковка» выше).
