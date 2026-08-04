#!/usr/bin/env bash
#
# interpret-backup-freshness.sh — turn an SSH result into an alert verdict.
#
# task-infra-prod-backup-safety-net (round 2, 2026-08-03). Runs on the
# GitHub Actions RUNNER (deploy.yml's `deploy` job, step "Interpret backup
# freshness result") — the counterpart to scripts/devops/check-backup-
# freshness.sh, which runs ON THE VPS over SSH and can only communicate back
# through stdout (captured by `capture_stdout: true`) or by the SSH step
# itself failing. This script turns those two raw signals into exactly one
# of THREE verdicts the caller (post-merge-alert.sh, KIND=backup) can act on:
#
#   ok            a fresh backup was found — close any open alert.
#   alert         a determinate PROBLEM was found (not configured, or
#                 stale/missing objects) — open/update an alert.
#   inconclusive  the check itself could not run (SSH failed, the remote
#                 script hit an unexpected internal error, or it returned
#                 something this script doesn't recognize) — do NOT touch
#                 the alert issue either way. This project does not assert
#                 "backups are missing" when it genuinely could not look;
#                 see check-backup-freshness.sh's own header for the same
#                 principle applied on the VPS side.
#
# Extracted into its own file (matching post-merge-alert.sh's own rationale)
# so the SSH_OUTCOME/SSH_STDOUT → verdict/detail mapping can be dry-run
# locally against a stubbed SSH result instead of being debugged by pushing
# commits and waiting for a real deploy.
#
# Required env:
#   SSH_OUTCOME   the "Check backup freshness on VPS (SSH)" step's
#                 `steps.<id>.outcome` — "success" or "failure" (raw result,
#                 unaffected by that step's own `continue-on-error: true`).
# Optional env:
#   SSH_STDOUT    that step's captured stdout (check-backup-freshness.sh's
#                 STATUS=/AGE_HOURS=/OBJECTS= lines) — only read when
#                 SSH_OUTCOME=success.
#   MAX_AGE_HOURS threshold used only for the human-readable `detail` text
#                 (default: 24 — must match check-backup-freshness.sh's own
#                 default unless the caller overrides both together).
#
# Writes (if $GITHUB_OUTPUT is set — printed to stdout as `key=value`
# instead when run locally, so this is fully dry-runnable):
#   verdict   ok | alert | inconclusive
#   detail    one-line human-readable summary (feeds post-merge-alert.sh's
#             FAILED_LEGS input for KIND=backup)
#
# Exit code: always 0 — this script itself never fails the job; "could not
# determine" is expressed as verdict=inconclusive, not a non-zero exit.
set -euo pipefail

MAX_AGE_HOURS="${MAX_AGE_HOURS:-24}"
SSH_OUTCOME="${SSH_OUTCOME:?SSH_OUTCOME is required}"
SSH_STDOUT="${SSH_STDOUT:-}"

write_output() {
  # $1=key $2=value
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1=$2" >> "$GITHUB_OUTPUT"
  else
    echo "$1=$2"
  fi
}

VERDICT="inconclusive"
DETAIL="Проверка не выполнена: SSH к VPS не удался или скрипт check-backup-freshness.sh завершился с ошибкой (не значит, что бэкапов нет — значит, что проверить не удалось)."

if [ "$SSH_OUTCOME" = "success" ]; then
  # `|| true` on all three extractions: under `set -e -o pipefail`, `grep -m1`
  # finding no match exits 1, and pipefail propagates that as the whole
  # pipeline's (and thus the `VAR=$(...)` assignment's) exit status — which
  # `set -e` treats as a command failure and aborts the script right here,
  # BEFORE `write_output verdict` ever runs (bug found in production: the SSH
  # step's outputs.stdout is empty whenever the pinned appleboy/ssh-action
  # version predates `capture_stdout` support — see the version-pin comment
  # on the "Check backup freshness on VPS (SSH)" step in deploy.yml — so
  # SSH_OUTCOME=success but SSH_STDOUT="" was not a hypothetical, it was the
  # exact shape of every real run). An empty/malformed SSH_STDOUT is
  # precisely the "could not determine" case this script exists to turn into
  # verdict=inconclusive, not a crash — so a missing line in ANY of the three
  # extractions must fall through to the `*)` unrecognized-STATUS branch
  # below (STATUS="" matches nothing else there) instead of killing the
  # script.
  STATUS=$(printf '%s\n' "$SSH_STDOUT" | grep -m1 '^STATUS=' | cut -d= -f2- || true)
  AGE_HOURS=$(printf '%s\n' "$SSH_STDOUT" | grep -m1 '^AGE_HOURS=' | cut -d= -f2- || true)
  OBJECTS=$(printf '%s\n' "$SSH_STDOUT" | grep -m1 '^OBJECTS=' | cut -d= -f2- || true)

  case "$STATUS" in
    not_configured)
      VERDICT="alert"
      DETAIL="Бэкапы не настроены на сервере (/etc/crm-backup.env отсутствует или в нём не хватает переменных) — см. docs/runbooks/deployment.md §8."
      ;;
    stale)
      VERDICT="alert"
      if [ "$OBJECTS" = "none" ]; then
        DETAIL="В бакете не найдено ни одного объекта резервной копии."
      else
        DETAIL="Последняя резервная копия — ${AGE_HOURS}ч назад (порог ${MAX_AGE_HOURS}ч)."
      fi
      ;;
    fresh)
      VERDICT="ok"
      DETAIL="Последняя резервная копия — ${AGE_HOURS}ч назад (порог ${MAX_AGE_HOURS}ч)."
      ;;
    *)
      echo "::warning::interpret-backup-freshness.sh: unrecognized STATUS='${STATUS}' from check-backup-freshness.sh — treating as inconclusive." >&2
      VERDICT="inconclusive"
      DETAIL="Проверка вернула нераспознанный статус — не значит, что бэкапов нет, значит, что результат не удалось разобрать."
      ;;
  esac
else
  echo "::warning::Backup freshness check inconclusive — SSH to the VPS failed or the remote script hit an unexpected error. This does NOT mean backups are missing; see the 'Check backup freshness on VPS (SSH)' step's own log above." >&2
fi

write_output verdict "$VERDICT"
write_output detail "$DETAIL"
exit 0
