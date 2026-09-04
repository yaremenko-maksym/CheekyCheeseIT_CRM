#!/usr/bin/env bash
#
# post-merge-alert.sh — open / update / close the "<something> is red" issue.
#
# Called by the `post_merge_alert` job in .github/workflows/ci.yml after a
# post-merge validation run of `main` finishes (KIND=ci, the original/default
# caller), by the `alert` job in .github/workflows/deploy-alert.yml after
# a `Deploy` workflow run completes (KIND=deploy, task-infra-silent-failures
# 2026-08-01 — Deploy failed 2026-07-27 21:22 and stayed red until 2026-07-31
# with nobody alerted), AND by the `deploy` job's backup-freshness steps in
# .github/workflows/deploy.yml (KIND=backup, task-infra-prod-backup-safety-net
# 2026-08-03 — the owner found prod had been running with ZERO DB backups
# since the first deploy, and nothing ever noticed either), AND by the nightly
# .github/workflows/mutation-nightly.yml (KIND=mutation, task-mutation-gate
# 2026-08-11 — the PR gate only ever sees CHANGED lines, so everything that
# accumulated before it existed is invisible to it; the nightly full sweep is
# what surfaces that, and it needs a channel someone actually reads), AND by
# the `deploy` job in .github/workflows/deploy-signal-plus.yml (KIND=signal-plus,
# task-signal-plus-step2-deploy 2026-09-03 — a separate compose project/VPS
# directory from the CRM stack, deployed by its own workflow; this only
# alerts on THAT WORKFLOW'S OWN build/push/SSH-deploy failure, not on whether
# the running signal-plus daemon actually sent a "+" — see that workflow's
# own comments for why the text must not overclaim either direction). Same
# channel, same open/comment/close mechanic, same script — only the issue
# title/body text and the dedup LABEL differ per KIND, kept as an explicit
# switch below rather than as separate copy-pasted scripts, so the alert paths
# cannot silently drift apart.
#
# Extracted from the workflow so the alert logic can be dry-run locally
# (DRY_RUN=1) instead of being debugged by pushing commits — see
# scripts/devops/post-merge-ci-runbook.md §4.
#
# State model — exactly one open alert issue at a time, keyed by LABEL:
#   RESULT=failure + no open issue  → create issue
#   RESULT=failure + open issue     → comment on it (no duplicate issue)
#   RESULT=success + open issue     → close it with a recovery comment
#   RESULT=success + no open issue  → no-op (the common, quiet path)
# Any other RESULT (cancelled / skipped) is a no-op: a run cancelled by
# `cancel-in-progress` when the next merge/deploy lands is not a red state.
#
# ГРАНИЦА КАНАЛА (не убирать): тело алерта — ТОЛЬКО метаданные прогона (SHA,
# subject, имена упавших job'ов, ссылка на run). Никаких выдержек из логов,
# stacktrace'ов, env или payload'ов. Причина: при недоступном PAT алерт уходит
# фолбэком в ПУБЛИЧНЫЙ репо, и всё, что попало в тело, становится публичным.
# Телеметрийные issue (stacktrace / route / userRole) живут в приватном репо
# через telemetry-digest.yml и сюда не переносятся. Это правило одинаково
# применяется к обоим KIND — не только к ci.
#
# Required env:
#   ALERT_REPO   owner/name of the repo that receives the issue
#   GH_TOKEN     token with issues:write on ALERT_REPO
#   RESULT       failure | success | cancelled | skipped
#   COMMIT_SHA   the main commit that was validated / deployed
#   RUN_URL      link to the Actions run
# Optional env:
#   KIND           ci (default) | deploy | backup | mutation | resume-perf |
#                   signal-plus — selects title/body text below
#   FAILED_LEGS    human list of failed jobs, e.g. "quality, e2e" or "deploy";
#                   for KIND=backup, the one-line freshness-check detail
#                   (scripts/devops/check-backup-freshness.sh's `detail` output);
#                   for KIND=mutation, the one-line detail from
#                   check-mutation-tally.mjs — a survivor tally OR a reason the
#                   sweep produced no evidence at all, see MUTATION_REASON;
#                   for KIND=signal-plus, always "build/push/SSH-deploy" (that
#                   workflow is one job, not several named legs)
#   MUTATION_REASON KIND=mutation only. check-mutation-tally.mjs's `reason`
#                   output: `survivors` (the sweep completed and found some —
#                   today's body/title) or `incomplete` (a leg failed, a
#                   report could not be parsed, or no reports were produced —
#                   nothing was verified, and the alert says so instead of
#                   reading like accumulated mutant debt). Unset/unrecognised
#                   → `survivors`, so a caller that predates this var (or a
#                   manual DRY_RUN) keeps today's text rather than silently
#                   losing its body. task-mutation-gate nightly-alert-fidelity,
#                   2026-09-03 — see mutation-gate-runbook.md "PR gate vs
#                   nightly" for why this distinction exists at all: the
#                   nightly was red for 20+ consecutive nights and every one
#                   of them read as "mutants survived", not "the check is down".
#   MUTATION_MISSING_PACKAGES  KIND=mutation + MUTATION_REASON=incomplete only.
#                   Comma-joined package names (check-mutation-tally.mjs's
#                   `missing_packages` output) that produced NO report at all —
#                   named in the body so "which leg" does not require opening
#                   the run first. May be empty (e.g. reports parsed but were
#                   corrupt, or the whole matrix job errored before any leg
#                   started) — the body handles that case too.
#   COMMIT_SUBJECT commit subject line (untrusted input — never eval'd)
#   LABEL          issue label (default: ci-main-broken for KIND=ci,
#                   deploy-broken for KIND=deploy, backup-stale for KIND=backup,
#                   mutants-surviving for KIND=mutation, signal-plus-deploy-broken
#                   for KIND=signal-plus)
#   DRY_RUN        1 → print the gh commands instead of running them
set -euo pipefail

KIND="${KIND:-ci}"
case "$KIND" in
  ci | deploy | backup | mutation | resume-perf | signal-plus) ;;
  *)
    echo "::error::post-merge-alert.sh: unknown KIND='$KIND' (expected ci|deploy|backup|mutation|resume-perf|signal-plus) — refusing to guess which alert text to use" >&2
    exit 2
    ;;
esac

case "$KIND" in
  deploy) LABEL="${LABEL:-deploy-broken}" ;;
  backup) LABEL="${LABEL:-backup-stale}" ;;
  mutation) LABEL="${LABEL:-mutants-surviving}" ;;
  resume-perf) LABEL="${LABEL:-resume-perf-broken}" ;;
  signal-plus) LABEL="${LABEL:-signal-plus-deploy-broken}" ;;
  *) LABEL="${LABEL:-ci-main-broken}" ;;
esac
DRY_RUN="${DRY_RUN:-0}"
FAILED_LEGS="${FAILED_LEGS:-unknown}"
COMMIT_SUBJECT="${COMMIT_SUBJECT:-}"
# Default `survivors`, not `incomplete`: an unset/unrecognised value must keep
# TODAY's body (see the env-doc comment above), not switch to the new one —
# the new text names a specific reason the run failed, which would be a lie
# for a caller that never told us one.
case "${MUTATION_REASON:-survivors}" in
  incomplete) MUTATION_REASON=incomplete ;;
  *) MUTATION_REASON=survivors ;;
esac
MUTATION_MISSING_PACKAGES="${MUTATION_MISSING_PACKAGES:-}"

for var in ALERT_REPO RESULT COMMIT_SHA RUN_URL; do
  if [ -z "${!var:-}" ]; then
    echo "::error::post-merge-alert.sh: required env \$$var is empty" >&2
    exit 2
  fi
done

# Short SHA for titles/comments; the full SHA stays in the body.
SHORT_SHA="${COMMIT_SHA:0:8}"

run_gh() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] gh'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  gh "$@"
}

case "$RESULT" in
  failure | success) ;;
  *)
    echo "::notice::post-merge-alert: result='$RESULT' (not failure/success) — nothing to do."
    exit 0
    ;;
esac

# Label may not exist yet on a fresh alert repo. Non-fatal: if the token lacks
# label-create rights the subsequent issue create/list still works as long as
# the label already exists there.
case "$KIND" in
  deploy) LABEL_DESC="Deploy workflow red after a merge to main" ;;
  backup) LABEL_DESC="Prod DB backup missing or stale (> threshold) after a Deploy run" ;;
  mutation) LABEL_DESC="Nightly mutation sweep found tests that cannot fail" ;;
  resume-perf) LABEL_DESC="Resume-extraction PDF content-stream guard timed out outside Stryker instrumentation" ;;
  signal-plus) LABEL_DESC="Deploy Signal Plus workflow red (build/push/SSH-deploy)" ;;
  *) LABEL_DESC="CI red on main after merge" ;;
esac
run_gh label create "$LABEL" --repo "$ALERT_REPO" \
  --color "b60205" --description "$LABEL_DESC" 2>/dev/null || true

if [ "$DRY_RUN" = "1" ]; then
  # Dry-run cannot query the API, so the "an alert is already open" state is
  # supplied by hand — this is what makes the dedup / auto-close branches
  # locally verifiable (runbook §4).
  OPEN="${DRY_RUN_OPEN_ISSUE:-}"
else
  # Явная проверка вместо голого `set -e` (review PR #441, MED): под
  # `set -euo pipefail` любой сбой этого вызова (истёкший токен, недоступный
  # репо, 5xx от GitHub) обрывал скрипт ЗДЕСЬ — то есть до create/comment/close.
  # Красный main не породил бы issue, а починенный — не закрыл бы открытый.
  # Теперь сбой вызова = громкая ошибка с ненулевым кодом, а не тихий обрыв.
  #
  # stderr уводится в отдельный файл, а НЕ подмешивается в $OPEN через `2>&1`
  # (re-review PR #446, MED): $OPEN используется и на успешном пути — как номер
  # issue в `gh issue comment/close`. Любой безобидный warning от `gh` на
  # иначе-успешном вызове замусорил бы номер, и следующая команда упала бы уже
  # под `set -e`, без внятного объяснения.
  GH_ERR="$(mktemp -t post-merge-alert-err.XXXXXX)"
  trap 'rm -f "$GH_ERR"' EXIT
  if ! OPEN=$(gh issue list --repo "$ALERT_REPO" --label "$LABEL" --state open \
    --json number --jq '.[0].number // empty' 2>"$GH_ERR"); then
    echo "::error::post-merge-alert: не удалось получить список issue из $ALERT_REPO — алерт НЕ доставлен. Ответ: $(cat "$GH_ERR")" >&2
    exit 3
  fi
fi

# Номер обязан быть числом или пустым — дальше он поедет в
# `gh issue comment/close` как аргумент. Проверка снаружи if/else СПЕЦИАЛЬНО:
# в dry-run она тоже должна срабатывать, иначе dry-run перестаёт быть точной
# моделью боевого пути и «проверено локально» перестаёт что-либо значить.
if [ -n "$OPEN" ] && ! printf '%s' "$OPEN" | grep -Eq '^[0-9]+$'; then
  echo "::error::post-merge-alert: ожидался номер issue, получено: '$OPEN'" >&2
  exit 4
fi
echo "post-merge-alert: repo=$ALERT_REPO result=$RESULT open_issue=${OPEN:-none}"

# Untrusted values (commit subject) are passed as literal argv to gh — never
# interpolated into a shell command — so a crafted commit message cannot
# inject anything. Same reason the workflow passes them via env:. Shared
# between both KIND branches — the subject-handling rules (fence, trim,
# encoding) do not depend on what broke, only on the fact that the string is
# untrusted input read by an assistant. See history below for why each
# individual choice is made this way (re-review PR #441/#446).
if [ -n "$COMMIT_SUBJECT" ]; then
  # В бэктиках и обрезанный (review PR #441, LOW). Subject = заголовок
  # смерженного PR, т.е. недоверенная строка, а issue читает ассистент:
  # без фенса туда пролезает markdown-инъекция (трекинг-пиксель
  # `![](https://attacker/x.png)`, фейковая ссылка) и prompt-инъекция в
  # AI-читаемый канал. Правило проекта — «issues = UNTRUSTED input».
  # Внутренние бэктики выкусываем, иначе они рвут фенс.
  #
  # Обрезка через python3 с ЯВНЫМ декодированием, а не `${VAR:0:120}` и не
  # `cut -c` (re-review PR #446, LOW + проверка фактом):
  #   - bash-подстрока режет БАЙТЫ везде, кроме локали вида `en_US.UTF-8`
  #     (под `C` и даже под `C.UTF-8` — байты; проверено);
  #   - `cut -c` символьный только в GNU coreutils, в BSD/macOS — байтовый,
  #     т.е. решение зависело бы от того, где запущен скрипт (ровно грабли
  #     из урока devops про GNU `timeout`/`mktemp` на macOS).
  # Кириллический subject при побайтовой резке рвётся посреди символа и даёт
  # невалидный UTF-8 в теле issue. python3 — жёсткая зависимость этого репо
  # (ci.yml гоняет guard-скрипты через `python3`), декодирование задано явно,
  # поэтому результат одинаков и на раннере, и на macOS при любой локали.
  SUBJECT_LINE=$(printf '**Subject:** `%s`\n' \
    "$(printf '%s' "$COMMIT_SUBJECT" | tr -d '`' \
       | python3 -c 'import sys; sys.stdout.write(sys.stdin.buffer.read().decode("utf-8", "replace")[:120])')")
else
  SUBJECT_LINE=""
fi

if [ "$RESULT" = "failure" ]; then
  # shellcheck disable=SC2016  # backticks below are markdown, not command
  #                            # substitution — single quotes are deliberate.
  if [ "$KIND" = "deploy" ]; then
    BODY=$(
      printf '## Деплой на прод упал (`Deploy` workflow)\n\n'
      printf '**Commit:** `%s`\n' "$COMMIT_SHA"
      # `$()` above strips the trailing newline `printf '...\n'` produced, so
      # it has to come back here — otherwise this line runs straight into
      # the next `printf` with no line break (caught by the dry-run smoke
      # test below, not by eye).
      [ -n "$SUBJECT_LINE" ] && printf '%s\n' "$SUBJECT_LINE"
      printf '**Упавший этап:** %s\n' "$FAILED_LEGS"
      printf '**Run:** %s\n\n' "$RUN_URL"
      printf '`Deploy` завершился с `failure` — выкатка на прод НЕ прошла.\n\n'
      printf '> ⚠️ Прод продолжает работать на предыдущем успешно задеплоенном образе —\n'
      printf '> все изменения, влитые в `main` с момента последнего успешного деплоя,\n'
      printf '> на прод **не попали**, пока это не починят.\n\n'
      printf '## Что делать\n\n'
      printf '1. Открыть run выше, найти упавший job/шаг.\n'
      printf '2. Починить и перезапустить (`gh workflow run deploy.yml --ref main`), либо хотфикс-PR.\n'
      printf '3. Issue закроется автоматически, когда следующий `Deploy` прогон станет зелёным.\n'
    )
  elif [ "$KIND" = "backup" ]; then
    BODY=$(
      printf '## Нет свежей резервной копии БД (`crm-backups`)\n\n'
      printf '**Commit:** `%s`\n' "$COMMIT_SHA"
      [ -n "$SUBJECT_LINE" ] && printf '%s\n' "$SUBJECT_LINE"
      printf '**Что обнаружено:** %s\n' "$FAILED_LEGS"
      printf '**Run:** %s\n\n' "$RUN_URL"
      printf 'scripts/devops/check-backup-freshness.sh не нашёл свежий объект в бакете\n'
      printf '`crm-backups` после этого деплоя.\n\n'
      printf '> ⚠️ Пока это не починено, потеря сервера означает ПОЛНУЮ потерю данных\n'
      printf '> (финансы, контракты, персональные данные) — резервных копий нет.\n\n'
      printf '## Что делать\n\n'
      printf '1. Зайти на VPS, проверить `crontab -l`, `/etc/crm-backup.env` и\n'
      printf '   `/opt/crm/scripts/devops/pg-backup.sh` — см. `docs/runbooks/deployment.md` §8.\n'
      printf '2. Прогнать `pg-backup.sh` вручную и убедиться, что новый объект появился в бакете.\n'
      printf '3. Issue закроется автоматически, когда следующая проверка после `Deploy` найдёт\n'
      printf '   свежую резервную копию.\n'
    )
  elif [ "$KIND" = "mutation" ] && [ "$MUTATION_REASON" = "incomplete" ]; then
    # task-mutation-gate nightly-alert-fidelity, 2026-09-03: a SEPARATE title
    # and body from the survivors case below — see MUTATION_REASON's env-doc
    # comment for why this split exists. Nothing here talks about closing
    # mutants; there is nothing to close, because nothing ran.
    BODY=$(
      printf '## Ночной мутационный прогон НЕ выполнился\n\n'
      printf '**Commit:** `%s`\n' "$COMMIT_SHA"
      [ -n "$SUBJECT_LINE" ] && printf '%s\n' "$SUBJECT_LINE"
      printf '**Что обнаружено:** %s\n' "$FAILED_LEGS"
      if [ -n "$MUTATION_MISSING_PACKAGES" ]; then
        printf '**Пакеты без отчёта:** %s\n' "$MUTATION_MISSING_PACKAGES"
      fi
      printf '**Run:** %s\n\n' "$RUN_URL"
      printf 'Сбор не дошёл до конца — упал раньше (проверка/тест/бюджет), поэтому список\n'
      printf 'выживших ниже НЕ появится: смотреть в этом run нечего, кроме упавшего шага.\n\n'
      printf '> Пакет(ы) выше сегодня не получили НИКАКОЙ проверки: PR-гейт по\n'
      printf '> конструкции видит только строки, изменённые самим PR-запросом (весь\n'
      printf '> код, написанный раньше, ему не виден), а ночной full-прогон —\n'
      printf '> единственный, кто покрывает написанное раньше, — сегодня для них\n'
      printf '> не доехал.\n\n'
      printf '## Что делать\n\n'
      printf '1. Открыть run выше → job `Sweep` (пакет из строки «Пакеты без отчёта») → найти\n'
      printf '   первый красный шаг (обычно `Gate self-check` или `Full mutation sweep`).\n'
      printf '2. Починить ЭТОТ шаг — это задача о самом прогоне, не о мутантах.\n'
      printf '3. Перезапустить вручную (`gh workflow run mutation-nightly.yml --ref main`) и\n'
      printf '   убедиться, что все три ноги дошли до отчёта.\n'
      printf '4. Issue закроется автоматически, когда прогон завершится и не найдёт выживших\n'
      printf '   (сам факт завершения — success; список выживших, если он появится, — уже\n'
      printf '   отдельный алерт с другим текстом).\n\n'
      printf 'Подробности — `scripts/devops/mutation-gate-runbook.md` "PR gate vs nightly".\n'
    )
  elif [ "$KIND" = "mutation" ]; then
    BODY=$(
      printf '## Ночной мутационный прогон нашёл тесты, которые не умеют падать\n\n'
      printf '**Commit:** `%s`\n' "$COMMIT_SHA"
      [ -n "$SUBJECT_LINE" ] && printf '%s\n' "$SUBJECT_LINE"
      printf '**Что обнаружено:** %s\n' "$FAILED_LEGS"
      printf '**Run:** %s\n\n' "$RUN_URL"
      printf 'Выживший мутант — это изменение в рабочем коде, которое проходит весь набор\n'
      printf 'тестов. Значит, поведение в этом месте не закреплено ничем: его можно удалить,\n'
      printf 'и ни одна проверка не покраснеет.\n\n'
      printf '> Гейт на PR смотрит ТОЛЬКО изменённые строки, поэтому он это не ловит —\n'
      printf '> здесь накопленное до его появления. Список выживших мутантов и путь к нему\n'
      printf '> — в артефактах прогона (`mutation-report-*`).\n\n'
      printf '## Что делать\n\n'
      printf '1. Открыть артефакт прогона, взять список выживших мутантов.\n'
      printf '2. Закрывать по одному: добавить утверждение, которое краснеет на мутанте.\n'
      printf '3. Эквивалентный мутант (никакой тест не может его отличить) — заглушить\n'
      printf '   строкой `// Stryker disable next-line <мутатор>: <почему>`; без причины\n'
      printf '   заглушка не принимается (`scripts/devops/check-mutation-suppressions.mjs`).\n'
      printf '4. Issue закроется автоматически, когда ночной прогон не найдёт выживших.\n\n'
      printf 'Подробности — `scripts/devops/mutation-gate-runbook.md`.\n'
    )
  elif [ "$KIND" = "resume-perf" ]; then
    BODY=$(
      printf '## Resume-extraction PDF content-stream guard упал без Stryker\n\n'
      printf '**Commit:** `%s`\n' "$COMMIT_SHA"
      [ -n "$SUBJECT_LINE" ] && printf '%s\n' "$SUBJECT_LINE"
      printf '**Упавшая проверка:** %s\n' "$FAILED_LEGS"
      printf '**Run:** %s\n\n' "$RUN_URL"
      printf 'Это отдельный job на голом `vitest`, БЕЗ Stryker: тот же тест в\n'
      printf '`resume-text-extraction.service.spec.ts` под Stryker даёт ложный красный\n'
      printf '(инструментация покрытия превращает 250 мс в ~1.6 с) — поэтому его не\n'
      printf 'проверяет мутационный гейт, а проверяет этот job. Красный здесь\n'
      printf 'инструментацией не объясняется.\n\n'
      printf '> Этот тест чувствителен к нагрузке раннера/машины (event-loop lag —\n'
      printf '> свойство параллельного окружения, не только кода). Один красный\n'
      printf '> прогон — не обязательно регресс; см. "Что делать" ниже.\n\n'
      printf '## Что делать\n\n'
      printf '1. Открыть run выше → лог упавшего теста.\n'
      printf '2. Перезапустить job вручную — если позеленел, это была нагрузка раннера,\n'
      printf '   не регресс; issue закроется само на следующем зелёном прогоне.\n'
      printf '3. Если падает стабильно — искать регресс в PDF-парсинге\n'
      printf '   (`apps/api/src/resumes/resume-text-extraction.service.ts`,\n'
      printf '   `inspectPdfContent`), не увеличивать порог вслепую (см. комментарии\n'
      printf '   самого теста).\n'
      printf '4. Issue закроется автоматически, когда прогон снова станет зелёным.\n\n'
      printf 'Тест: `resume-text-extraction.service.spec.ts` >\n'
      printf '"refuses the amplified bomb without a visible stall" (`RESUME_PERF=1`).\n'
      printf 'Только он — другой опциональный `RESUME_PERF=1`-тест в этом файле\n'
      printf '(DOCX-пропорциональность) по собственному докстрингу «it is not a gate»\n'
      printf 'и в этот job намеренно не входит (`-t`-фильтр).\n'
    )
  elif [ "$KIND" = "signal-plus" ]; then
    # Honest about what this workflow does and does NOT know (task
    # requirement: "текст — правдивый: не «прод задеплоен»"). It knows
    # whether ITS OWN build/push/write-env/copy-compose/pull+up steps
    # succeeded — it does not know whether a signal-plus container was
    # already running before this run (so it cannot claim "prod keeps
    # running on the old image" the way KIND=deploy's body does for the
    # CRM stack, which IS always already live), and it does not know
    # whether the daemon inside actually sent today's "+" (a separate
    # concern entirely, currently only visible via the container's own
    # logs/personal-DM alert layer — see services/signal-plus/README.md).
    BODY=$(
      printf '## Деплой signal-plus упал (`Deploy Signal Plus` workflow)\n\n'
      printf '**Commit:** `%s`\n' "$COMMIT_SHA"
      [ -n "$SUBJECT_LINE" ] && printf '%s\n' "$SUBJECT_LINE"
      printf '**Упавший этап:** %s\n' "$FAILED_LEGS"
      printf '**Run:** %s\n\n' "$RUN_URL"
      printf '`Deploy Signal Plus` завершился с `failure` — сборка/публикация образа\n'
      printf 'или деплой на VPS не прошли. Отдельный workflow, отдельный compose-проект\n'
      printf '(`signal-plus`, `/opt/signal-plus`) — CRM (`crm`, `/opt/crm`) этот сбой\n'
      printf 'не затрагивает.\n\n'
      printf '> ⚠️ Если контейнер signal-plus уже был запущен раньше — он продолжает\n'
      printf '> работать на прежнем образе, пока это не починят. Если это первый\n'
      printf '> деплой (контейнер ещё не создан) — утренний «+» сегодня не уйдёт.\n\n'
      printf '## Что делать\n\n'
      printf '1. Открыть run выше, найти упавший шаг.\n'
      printf '2. Починить и перезапустить (`gh workflow run deploy-signal-plus.yml --ref main`),\n'
      printf '   либо хотфикс-PR.\n'
      printf '3. Issue закроется автоматически, когда следующий `Deploy Signal Plus`\n'
      printf '   прогон станет зелёным.\n'
    )
  else
    BODY=$(
      printf '## CI упал на `main` после мержа\n\n'
      printf '**Commit:** `%s`\n' "$COMMIT_SHA"
      # `$()` above strips the trailing newline `printf '...\n'` produced, so
      # it has to come back here — otherwise this line runs straight into
      # the next `printf` with no line break (caught by the dry-run smoke
      # test below, not by eye).
      [ -n "$SUBJECT_LINE" ] && printf '%s\n' "$SUBJECT_LINE"
      printf '**Упавшие проверки:** %s\n' "$FAILED_LEGS"
      printf '**Run:** %s\n\n' "$RUN_URL"
      printf 'Это прогон **после** мержа — валидируется фактическое состояние `main`,\n'
      printf 'а не merge-коммит PR. Красный прогон здесь при зелёных PR обычно значит\n'
      printf 'семантический конфликт двух PR, каждый из которых был зелёным отдельно.\n\n'
      printf '> ⚠️ Прод деплоится сразу после мержа, параллельно с этим прогоном, —\n'
      printf '> то есть сломанное состояние, скорее всего, **уже задеплоено**.\n\n'
      printf '## Что делать\n\n'
      printf '1. Открыть run выше, найти упавшую проверку.\n'
      printf '2. Решить: откат (`git revert` последнего мержа + деплой) или хотфикс-PR.\n'
      printf '3. Issue закроется автоматически, когда следующий post-merge прогон `main` станет зелёным.\n\n'
      printf 'Подробности процесса — `scripts/devops/post-merge-ci-runbook.md`.\n'
    )
  fi

  if [ "$KIND" = "mutation" ] && [ "$MUTATION_REASON" = "incomplete" ]; then
    TITLE="🧬 Ночной мутационный прогон не выполнился ($SHORT_SHA)"
  else
    case "$KIND" in
      deploy) TITLE="🚨 Деплой упал на прод ($SHORT_SHA)" ;;
      backup) TITLE="🚨 Нет свежего бэкапа БД ($SHORT_SHA)" ;;
      mutation) TITLE="🧬 Выжившие мутанты на main ($SHORT_SHA)" ;;
      resume-perf) TITLE="🐌 Resume-extraction perf guard упал ($SHORT_SHA)" ;;
      signal-plus) TITLE="🚨 Деплой signal-plus упал ($SHORT_SHA)" ;;
      *) TITLE="🚨 CI красный на main ($SHORT_SHA)" ;;
    esac
  fi

  if [ -z "$OPEN" ]; then
    run_gh issue create --repo "$ALERT_REPO" \
      --title "$TITLE" \
      --label "$LABEL" \
      --body "$BODY"
    echo "post-merge-alert: created new alert issue"
  else
    run_gh issue comment "$OPEN" --repo "$ALERT_REPO" --body "$BODY"
    echo "post-merge-alert: still red — commented on existing issue #$OPEN"
  fi
  exit 0
fi

# RESULT=success
if [ -n "$OPEN" ]; then
  case "$KIND" in
    deploy) RECOVERY_COMMENT="✅ Деплой на прод снова прошёл успешно (commit \`$COMMIT_SHA\`). Run: $RUN_URL" ;;
    backup) RECOVERY_COMMENT="✅ В бакете \`crm-backups\` снова есть свежая резервная копия (commit \`$COMMIT_SHA\`). Run: $RUN_URL" ;;
    mutation) RECOVERY_COMMENT="✅ Ночной мутационный прогон не нашёл выживших мутантов (commit \`$COMMIT_SHA\`). Run: $RUN_URL" ;;
    resume-perf) RECOVERY_COMMENT="✅ Resume-extraction perf guard снова зелёный без Stryker (commit \`$COMMIT_SHA\`). Run: $RUN_URL" ;;
    signal-plus) RECOVERY_COMMENT="✅ Деплой signal-plus снова прошёл успешно (commit \`$COMMIT_SHA\`). Run: $RUN_URL" ;;
    *) RECOVERY_COMMENT="✅ post-merge CI на \`main\` снова зелёный (commit \`$COMMIT_SHA\`). Run: $RUN_URL" ;;
  esac
  run_gh issue close "$OPEN" --repo "$ALERT_REPO" --comment "$RECOVERY_COMMENT"
  echo "post-merge-alert: closed recovered alert issue #$OPEN"
else
  echo "post-merge-alert: green, no open alert — nothing to do."
fi
