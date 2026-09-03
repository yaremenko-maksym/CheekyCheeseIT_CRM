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

### Линковка (один раз)

```bash
cd /opt/signal-plus
docker compose -p signal-plus run --rm -it signal-plus signal-cli link -n "server-plus" | tee /tmp/link.txt
```

В другом окне, **пока `link` ждёт** (команда выше не завершится, пока
устройство не будет отсканировано или не истечёт таймаут):

```bash
docker compose -p signal-plus run --rm signal-plus sh -c 'qrencode -t ansiutf8 "$(grep -o "sgnl://[^ ]*" /tmp/link.txt)"'
```

Сканировать QR: **Signal на телефоне → Настройки → Связанные устройства →
«+» → навести камеру на код в терминале.**

Один пайп `signal-cli link -n server-plus | qrencode -t ansiutf8` вместо
двух команд выше, как изначально предлагалось, — по факту скорее всего
**не покажет QR вовремя**: `qrencode`, как большинство утилит, читающих
stdin без явного построчного режима, ждёт EOF (конец потока), а `link` не
закрывает свой stdout, пока сам не завершится (успехом или таймаутом) — то
есть код появился бы только ПОСЛЕ того, как сканировать уже поздно.
Двухоконный вариант с `tee` в файл этой проблемы не имеет: `grep`/`qrencode`
во второй команде читают уже дописанный на диск файл, а не живой поток.
(Не проверено вживую с реальным аккаунтом — команда `link` не выполнялась
в рамках шага 2, см. стоп-линию задания; рассуждение — из общего поведения
`qrencode`, не из наблюдения за `signal-cli` конкретно.)

`docker compose run` наследует `read_only: true` + том `signal_data` из
`docker-compose.yml` — сама привязанная идентичность (ключи, сессии) пишется
на том (`XDG_DATA_HOME=/data`, см. Dockerfile), не в слой контейнера, и
переживёт `docker compose up -d` после линковки.

### Выбор группы и первый тест

```bash
docker compose -p signal-plus run --rm signal-plus signal-cli --groups
```

(режим `--groups` — см. `build_arg_parser()` в `signal_plus/cli.py`; печатает
список групп с id, ничего не отправляет). Найти **пустую тестовую группу**
в выводе, скопировать её id.

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
