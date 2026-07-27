#!/usr/bin/env bash
#
# post-merge-alert.sh — open / update / close the "CI is red on main" issue.
#
# Called by the `post_merge_alert` job in .github/workflows/ci.yml after a
# post-merge validation run of `main` finishes. Extracted from the workflow so
# the alert logic can be dry-run locally (DRY_RUN=1) instead of being debugged
# by pushing commits — see scripts/devops/post-merge-ci-runbook.md §4.
#
# State model — exactly one open alert issue at a time, keyed by label:
#   RESULT=failure + no open issue  → create issue
#   RESULT=failure + open issue     → comment on it (no duplicate issue)
#   RESULT=success + open issue     → close it with a recovery comment
#   RESULT=success + no open issue  → no-op (the common, quiet path)
# Any other RESULT (cancelled / skipped) is a no-op: a run cancelled by
# `cancel-in-progress` when the next merge lands is not a red main.
#
# ГРАНИЦА КАНАЛА (не убирать): тело алерта — ТОЛЬКО метаданные прогона (SHA,
# subject, имена упавших job'ов, ссылка на run). Никаких выдержек из логов,
# stacktrace'ов, env или payload'ов. Причина: при недоступном PAT алерт уходит
# фолбэком в ПУБЛИЧНЫЙ репо, и всё, что попало в тело, становится публичным.
# Телеметрийные issue (stacktrace / route / userRole) живут в приватном репо
# через telemetry-digest.yml и сюда не переносятся.
#
# Required env:
#   ALERT_REPO   owner/name of the repo that receives the issue
#   GH_TOKEN     token with issues:write on ALERT_REPO
#   RESULT       failure | success | cancelled | skipped
#   COMMIT_SHA   the main commit that was validated
#   RUN_URL      link to the Actions run
# Optional env:
#   FAILED_LEGS    human list of failed jobs, e.g. "quality, e2e"
#   COMMIT_SUBJECT commit subject line (untrusted input — never eval'd)
#   LABEL          issue label (default: ci-main-broken)
#   DRY_RUN        1 → print the gh commands instead of running them
set -euo pipefail

LABEL="${LABEL:-ci-main-broken}"
DRY_RUN="${DRY_RUN:-0}"
FAILED_LEGS="${FAILED_LEGS:-unknown}"
COMMIT_SUBJECT="${COMMIT_SUBJECT:-}"

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
run_gh label create "$LABEL" --repo "$ALERT_REPO" \
  --color "b60205" --description "CI red on main after merge" 2>/dev/null || true

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

if [ "$RESULT" = "failure" ]; then
  # Untrusted values (commit subject) are passed as literal argv to gh — never
  # interpolated into a shell command — so a crafted commit message cannot
  # inject anything. Same reason the workflow passes them via env:.
  #
  # shellcheck disable=SC2016  # backticks below are markdown, not command
  #                            # substitution — single quotes are deliberate.
  BODY=$(
    printf '## CI упал на `main` после мержа\n\n'
    printf '**Commit:** `%s`\n' "$COMMIT_SHA"
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
      printf '**Subject:** `%s`\n' \
        "$(printf '%s' "$COMMIT_SUBJECT" | tr -d '`' \
           | python3 -c 'import sys; sys.stdout.write(sys.stdin.buffer.read().decode("utf-8", "replace")[:120])')"
    fi
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

  if [ -z "$OPEN" ]; then
    run_gh issue create --repo "$ALERT_REPO" \
      --title "🚨 CI красный на main ($SHORT_SHA)" \
      --label "$LABEL" \
      --body "$BODY"
    echo "post-merge-alert: created new alert issue"
  else
    run_gh issue comment "$OPEN" --repo "$ALERT_REPO" --body "$BODY"
    echo "post-merge-alert: main still red — commented on existing issue #$OPEN"
  fi
  exit 0
fi

# RESULT=success
if [ -n "$OPEN" ]; then
  run_gh issue close "$OPEN" --repo "$ALERT_REPO" \
    --comment "✅ post-merge CI на \`main\` снова зелёный (commit \`$COMMIT_SHA\`). Run: $RUN_URL"
  echo "post-merge-alert: closed recovered alert issue #$OPEN"
else
  echo "post-merge-alert: green, no open alert — nothing to do."
fi
