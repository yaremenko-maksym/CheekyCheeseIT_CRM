#!/usr/bin/env bash
# test-check-prod-ddl-wiring.sh — proves scripts/devops/check-prod-ddl-wiring.py
# goes RED when a manual DDL file is not really wired into deploy.yml.
#
# The headline case is `comment-only`: the filename appears in deploy.yml prose
# and nowhere else. That is precisely how the guard behaved for its entire life
# before 2026-08-07 (`wired = {f for f in all_files if f in deploy_yml_content}`),
# which means the guard created in response to the #422 prod outage would have
# stayed green through #422 itself.
#
# Every case runs the REAL, unmodified guard — copied into a fabricated repo root
# so that its `<script>/../..` path resolution points at fixtures instead of this
# repo.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="check-prod-ddl-wiring.py"
DDL="2099-01-01_fake_guard_fixture.sql"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# Builds a fake repo containing ONE manual DDL file plus the given deploy.yml
# body, and echoes its root.
# $1 = case name, $2 = deploy.yml content, $3 = (optional) DDL filename
make_case() {
  local name="$1" deploy_yml="$2" ddl="${3:-$DDL}"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/apps/api/drizzle/manual"
  printf 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;\n' >"$root/apps/api/drizzle/manual/$ddl"
  printf '%s' "$deploy_yml" >"$root/.github/workflows/deploy.yml"
  printf '%s' "$root"
}

run_guard() { python3 "$1/scripts/devops/$GUARD"; }

# ── hard-required file list mirror fixtures (task-infra-rollback-deploys-not-
# rebuilds, PR #615 round 4) ────────────────────────────────────────────────
# Like make_case, but ALSO writes docs/runbooks/deployment.md so the mirror
# check has both sides to compare. $3 unset (or "absent") omits the runbook
# file entirely — for the "one side has the step, the other side has no file
# at all" structural-error cases.
make_mirror_case() {
  local name="$1" deploy_yml="$2" runbook_md="${3-}"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/apps/api/drizzle/manual" "$root/docs/runbooks"
  printf 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;\n' >"$root/apps/api/drizzle/manual/$DDL"
  printf '%s' "$deploy_yml" >"$root/.github/workflows/deploy.yml"
  if [ "$runbook_md" != "absent" ]; then
    printf '%s' "$runbook_md" >"$root/docs/runbooks/deployment.md"
  fi
  printf '%s' "$root"
}

# ── manual-private reverse-invariant fixtures ───────────────────────────────────
# apps/api/drizzle/manual-private/ (task-guard-manual-private-ddl, 2026-08-12,
# PR #517 security review): the reverse of everything above — these files must
# NOT be wired anywhere in .github/workflows/**, since they print row-level
# financial detail into what would be a public CI log.
PRIVATE_DDL="2099-01-01_fake_private_fixture.sql"

# Builds a fake repo with NO apps/api/drizzle/manual/ file (the reverse
# invariant is independent of it) and, unless $3="absent", a
# manual-private/$PRIVATE_DDL fixture. $2's content becomes deploy.yml.
# $1 = case name, $2 = deploy.yml content, $3 = "absent" to omit the
#      manual-private directory entirely (proves the silent-skip case)
make_private_case() {
  local name="$1" deploy_yml="$2" mode="${3:-present}"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  if [ "$mode" != "absent" ]; then
    mkdir -p "$root/apps/api/drizzle/manual-private"
    printf -- '-- fixture, must never be wired\nSELECT 1;\n' \
      >"$root/apps/api/drizzle/manual-private/$PRIVATE_DDL"
  fi
  printf '%s' "$deploy_yml" >"$root/.github/workflows/deploy.yml"
  printf '%s' "$root"
}

# Same fixture file, but the leak lives in a SECOND workflow file, not
# deploy.yml — proves the scan is over .github/workflows/**, not one file.
make_private_other_workflow_case() {
  local name="$1"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/apps/api/drizzle/manual-private"
  printf -- '-- fixture, must never be wired\nSELECT 1;\n' \
    >"$root/apps/api/drizzle/manual-private/$PRIVATE_DDL"
  printf 'name: Deploy\non: {push: {branches: [main]}}\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo restart\n' \
    >"$root/.github/workflows/deploy.yml"
  printf 'name: Debug Dump\non: workflow_dispatch\njobs:\n  dump:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cat apps/api/drizzle/manual-private/%s\n' \
    "$PRIVATE_DDL" >"$root/.github/workflows/debug-dump.yml"
  printf '%s' "$root"
}

# ── fixtures ───────────────────────────────────────────────────────────────────
read -r -d '' WIRED_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            if [ ! -f "\$FIXTURE_FILE" ]; then
              echo "ERROR: DDL file not found at \$FIXTURE_FILE"
              exit 1
            fi
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# The cheat. Filename present three times — a step name, a `with:` comment and a
# SOURCE comment in the apply script — and copied/applied exactly zero times.
read -r -d '' COMMENT_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      # Copies the compose files and $DDL to the VPS.
      - name: Copy compose + $DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          # apps/api/drizzle/manual/$DDL
          #   -> /opt/crm/apps/api/drizzle/manual/$DDL
          source: 'docker-compose.prod.yml'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            # Source: apps/api/drizzle/manual/$DDL
            # Applied below (idempotent, ADD COLUMN IF NOT EXISTS).
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -c 'select 1'
YML

read -r -d '' COPY_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -c 'select 1'
YML

# Item 67 (task-ddl-guard-and-ci-noise, 2026-08-17). The guard's own module
# docstring named this gap without a test until now: $DDL is genuinely COPIED
# (real scp source:), and the apply step DOES run psql — but for a DIFFERENT
# file. $DDL only gets a DEAD assignment (never referenced by any psql
# invocation) sitting in the same step/script as that real, unrelated apply.
# Before the item-67 fix, ANY "/opt/crm/....sql" line inside a step that ran
# psql SOMEWHERE counted as applied, so this dead assignment alone flipped
# $DDL green with zero actual application.
read -r -d '' DEAD_ASSIGNMENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            DEAD_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            REAL_FILE="/opt/crm/apps/api/drizzle/manual/2026-01-01_other.sql"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$REAL_FILE"
YML

# Review round 2, MED-1. The apply assignment uses SINGLE quotes — ordinary,
# valid bash, and how this SAME file's scp `source:` values are routinely
# written — but VAR_ASSIGN_RE originally required double quotes. $DDL is
# genuinely copied AND applied; a guard that reports it unwired here is a
# FALSE RED on legitimate wiring.
read -r -d '' SINGLE_QUOTE_APPLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            DDL_FILE='/opt/crm/apps/api/drizzle/manual/$DDL'
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$DDL_FILE"
YML

# Review round 2, MED-2. Ordinary cross-step GitHub Actions data flow: step 1
# resolves DDL_FILE and publishes it via \$GITHUB_ENV (the apply-side
# equivalent of the copy-side's already-tested `steps.X.outputs.Y` idiom —
# "expr-source" case above), step 2 does the real scp copy, step 3 (a
# DIFFERENT step in the SAME job) applies it via psql reading \$DDL_FILE it
# never itself assigned. $DDL is genuinely copied AND applied; scoping var
# resolution to one Step object made this a false COPIED BUT NEVER APPLIED.
read -r -d '' CROSS_STEP_GITHUB_ENV_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve DDL file path
        run: |
          DDL_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
          echo "DDL_FILE=\$DDL_FILE" >> "\$GITHUB_ENV"
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$DDL_FILE"
YML

# Negative counterpart to cross-step resolution above: DDL_FILE is assigned
# in job "copy-compose" and read in job "deploy" — a DIFFERENT job. GitHub
# Actions env vars do NOT cross job boundaries (each job is a fresh runner),
# so this must NOT resolve — proving the MED-2 fix stops at job edges rather
# than becoming "resolve anywhere in the file" (which would trade the
# false-red MED-2 fixed for a false-green, the wrong direction per this
# guard's own doctrine).
read -r -d '' CROSS_JOB_NO_RESOLVE_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve DDL file path (wrong job — does not propagate)
        run: |
          DDL_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
          echo "DDL_FILE=\$DDL_FILE" >> "\$GITHUB_ENV"
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$DDL_FILE"
YML

read -r -d '' APPLY_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'docker-compose.prod.yml'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Review round 2, H1. Both zones carry the filename in a TRAILING comment and
# nowhere else. This was GREEN before the fix — the guard stripped whole comment
# lines but read `source:` to end-of-line and took apply lines whole, so prose to
# the RIGHT of code satisfied it while it printed "Comment-only mentions do NOT
# count".
read -r -d '' TRAILING_COMMENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'docker-compose.prod.yml'   # also ships $DDL
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            OTHER_FILE="/opt/crm/apps/api/drizzle/manual/2026-01-01_other.sql"   # supersedes $DDL
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$OTHER_FILE"
YML

# Review round 2, MED. The realistic shape of "copied but never applied": the scp
# entry is real, and the only trace in the deploy job is deploy.yml's OWN
# house-style comment block, copied verbatim from the real workflow. Pins the
# whole-line comment stripping that the H1 fix sits on top of.
read -r -d '' COPY_PLUS_HOUSE_COMMENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
          # scp-action preserves the source directory tree under target:
          # apps/api/drizzle/manual/$DDL
          #   → /opt/crm/apps/api/drizzle/manual/$DDL
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            # ── Step 2z: fixture columns (idempotent) ────────────────────────
            # Source: apps/api/drizzle/manual/$DDL
            #   → /opt/crm/apps/api/drizzle/manual/$DDL
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -c 'select 1'
YML

# Review round 2, MED. A `::notice::` line saying the file is ABSENT is the
# opposite of wiring, yet it lived on an executable line inside the step that
# builds the scp source list, so it counted as a copy.
read -r -d '' NOTICE_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Check for DDL file
        id: ddl-check
        run: |
          if [ -f apps/api/drizzle/manual/other.sql ]; then
            echo "source_list=apps/api/drizzle/manual/other.sql" >> "\$GITHUB_OUTPUT"
            echo "any_exist=true" >> "\$GITHUB_OUTPUT"
          else
            echo "::notice::apps/api/drizzle/manual/$DDL not found in checkout — skipping copy."
            echo "any_exist=false" >> "\$GITHUB_OUTPUT"
          fi
      - name: Copy DDL via SCP (only files present)
        uses: appleboy/scp-action@v0.1.7
        with:
          source: '\${{ steps.ddl-check.outputs.source_list }}'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Review round 2, MED. The "apply" step only PRINTS a psql command line — it
# runs nothing. Merely containing the string `psql` used to qualify a step as an
# apply step.
read -r -d '' PSQL_ECHOED_ONLY_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Print the manual apply instructions
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            echo "To apply by hand: psql -U \$PGUSER -d \$PGDB -f \$FIXTURE_FILE"
YML

# Review round 2, MED. A legitimately-wired file listed via a `|` block scalar —
# reading only the text on the `source:` line saw nothing and reported a FALSE
# RED, the failure mode that gets a guard switched off rather than fixed.
read -r -d '' BLOCK_SCALAR_SOURCE_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: |
            docker-compose.prod.yml
            apps/api/drizzle/manual/$DDL
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Review round 2 follow-up. Whole-line comment handling is NOT subsumed by the
# trailing-comment fix: a comment sitting at (or left of) the step marker's own
# indent would end the step early if comment lines were not skipped outright, so
# the real `source:` below it would never be seen — a FALSE RED on a genuinely
# wired file. deploy.yml is full of `# ── section ──` banners at exactly that
# indent, which is what makes this shape worth pinning rather than hypothetical.
read -r -d '' COMMENT_AT_STEP_INDENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
      # ── the guarded DDL block — see the runbook for the merge-order note ──
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Review round 3. The quote-tracking half of strip_trailing_comment was the last
# surviving mutant: deleting it left all 13 cases green, because every fixture
# happened to keep its `#` outside quotes, where the whitespace rule alone
# already saves it. Here the `#` is INSIDE a quoted psql argument and the
# server-side path comes AFTER it on the same line — so a comment-stripper that
# ignores quotes truncates the path away and reports a genuinely-wired file as
# never applied. A FALSE RED, which is the failure mode that gets a guard
# switched off rather than fixed.
read -r -d '' HASH_INSIDE_QUOTES_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 -c "SET application_name = 'deploy #1'" -f /opt/crm/apps/api/drizzle/manual/$DDL
YML

read -r -d '' ABSENT_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'docker-compose.prod.yml'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Restart
        run: echo restart
YML

# The guarded/conditional copy pattern the real deploy.yml uses for DDL that has
# not merged yet: scp's `source:` is an expression, and the file list is built by
# an earlier step. Must be recognised as a real copy, or the guard would go red
# on legitimately-wired files (and get "fixed" by weakening it back to substring).
read -r -d '' EXPR_SOURCE_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Check for DDL file
        id: ddl-check
        run: |
          FILES="apps/api/drizzle/manual/$DDL"
          PRESENT=""
          for f in \$FILES; do
            if [ -f "\$f" ]; then PRESENT="\$f"; fi
          done
          echo "source_list=\$PRESENT" >> "\$GITHUB_OUTPUT"
      - name: Copy DDL via SCP (only files present)
        uses: appleboy/scp-action@v0.1.7
        with:
          source: '\${{ steps.ddl-check.outputs.source_list }}'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# task-ddl-flag-audit (backlog item 141, 2026-08-19). A REAL psql invocation
# (the file is genuinely copied AND applied — the wiring half of this guard
# would report it green) that omits `-v ON_ERROR_STOP=1`. Proves the new
# invariant catches the gap even when the wiring check itself sees nothing
# wrong: a SQL error inside this file would leave psql exiting 0 and the
# migration half-applied while the guard, before this fix, said nothing.
read -r -d '' MISSING_ON_ERROR_STOP_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" < "\$FIXTURE_FILE"
YML

read -r -d '' PRIVATE_UNREFERENCED_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Restart
        run: echo restart
YML

read -r -d '' PRIVATE_LEAKED_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual-private/$PRIVATE_DDL'
          target: '/opt/crm'
YML

# ── hard-required file list mirror (task-infra-rollback-deploys-not-rebuilds,
# PR #615 round 4) ──────────────────────────────────────────────────────────
# A `build` job carrying the rollback preflight's `for FILE in \ ... ; do`
# list, on top of an otherwise normally-wired copy-compose/deploy pair (same
# shape as $WIRED_YML) so the pre-existing wiring invariants stay green and
# only the mirror invariant is what each assertion below is actually testing.
read -r -d '' MIRROR_BASE_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Verify rollback target commit has all hard-required files
        if: \${{ inputs.image_tag != '' }}
        run: |
          for FILE in \\
            docker-compose.prod.yml \\
            apps/api/drizzle/manual/$DDL \\
          ; do
            echo "check \$FILE"
          done
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            if [ ! -f "\$FIXTURE_FILE" ]; then
              echo "ERROR: DDL file not found at \$FIXTURE_FILE"
              exit 1
            fi
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Same DDL fixture as MIRROR_BASE_YML's preflight list, in deploy.yml's OWN
# job — a `for` loop of a different loop variable, which must NOT be mistaken
# for the preflight step's `for FILE in \` shape (proves the anchor regex is
# specific to the real step, not to "any for-loop over paths").
read -r -d '' MIRROR_OTHER_LOOP_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Sanity-check unrelated report paths
        run: |
          for REPORT in \\
            docker-compose.prod.yml \\
          ; do
            echo "unrelated: \$REPORT"
          done
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            if [ ! -f "\$FIXTURE_FILE" ]; then
              echo "ERROR: DDL file not found at \$FIXTURE_FILE"
              exit 1
            fi
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

read -r -d '' MIRROR_MATCH_MD <<MD || true
# Deployment runbook

\`\`\`bash
git log -1 --format='%h  %ad  %s' --date=short -- \\
  docker-compose.prod.yml \\
  apps/api/drizzle/manual/$DDL
\`\`\`
MD

read -r -d '' MIRROR_MISSING_DDL_MD <<MD || true
# Deployment runbook

\`\`\`bash
git log -1 --format='%h  %ad  %s' --date=short -- \\
  docker-compose.prod.yml
\`\`\`
MD

read -r -d '' MIRROR_EXTRA_FILE_MD <<MD || true
# Deployment runbook

\`\`\`bash
git log -1 --format='%h  %ad  %s' --date=short -- \\
  docker-compose.prod.yml \\
  apps/api/drizzle/manual/$DDL \\
  apps/api/drizzle/manual/2099-01-02_never_in_preflight.sql
\`\`\`
MD

# ── preflight-covers-unconditional-scp (task-infra-rollback-deploys-not-
# rebuilds, PR #615 round 5, SR-M-5) ────────────────────────────────────────
# Same preflight list and runbook mirror as MIRROR_BASE_YML/MIRROR_MATCH_MD
# (so the pre-existing mirror-vs-mirror invariant stays GREEN — drift 0 — on
# every fixture below; only the NEW coverage invariant is what each
# assertion is actually testing) — but copy-compose's UNCONDITIONAL scp step
# (no `if:` at all) copies one file neither list requires. This is the exact
# SR-M-5 shape: two manually-maintained copies that agree with EACH OTHER
# while both silently missing a file the pipeline actually treats as
# unconditionally present.
read -r -d '' MIRROR_SCP_UNCOVERED_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Verify rollback target commit has all hard-required files
        if: \${{ inputs.image_tag != '' }}
        run: |
          for FILE in \\
            docker-compose.prod.yml \\
            apps/api/drizzle/manual/$DDL \\
          ; do
            echo "check \$FILE"
          done
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL,scripts/devops/never-in-preflight.sh'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            if [ ! -f "\$FIXTURE_FILE" ]; then
              echo "ERROR: DDL file not found at \$FIXTURE_FILE"
              exit 1
            fi
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Same base, but the extra file lives on a GUARDED scp step (has an `if:`) —
# must NOT count against coverage. Proves the direction: only UNCONDITIONAL
# scp sources are required in the preflight list, never every scp source.
read -r -d '' MIRROR_SCP_GUARDED_EXTRA_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Verify rollback target commit has all hard-required files
        if: \${{ inputs.image_tag != '' }}
        run: |
          for FILE in \\
            docker-compose.prod.yml \\
            apps/api/drizzle/manual/$DDL \\
          ; do
            echo "check \$FILE"
          done
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
      - name: Copy guarded optional file via SCP (only if present)
        if: steps.optional-ddl-check.outputs.exists == 'true'
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'apps/api/drizzle/manual/2099-01-04_optional_never_required.sql'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            if [ ! -f "\$FIXTURE_FILE" ]; then
              echo "ERROR: DDL file not found at \$FIXTURE_FILE"
              exit 1
            fi
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# Preflight list (and its runbook mirror) NAME a file no scp step ever
# copies — the SUPERSET direction. Must stay green: the preflight list is
# allowed to require more than any single scp step provides.
read -r -d '' MIRROR_PREFLIGHT_EXTRA_NAME_MD <<MD || true
# Deployment runbook

\`\`\`bash
git log -1 --format='%h  %ad  %s' --date=short -- \\
  docker-compose.prod.yml \\
  apps/api/drizzle/manual/$DDL \\
  apps/api/drizzle/manual/2099-01-05_named_but_not_scpd.sql
\`\`\`
MD

read -r -d '' MIRROR_PREFLIGHT_EXTRA_NAME_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Verify rollback target commit has all hard-required files
        if: \${{ inputs.image_tag != '' }}
        run: |
          for FILE in \\
            docker-compose.prod.yml \\
            apps/api/drizzle/manual/$DDL \\
            apps/api/drizzle/manual/2099-01-05_named_but_not_scpd.sql \\
          ; do
            echo "check \$FILE"
          done
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            if [ ! -f "\$FIXTURE_FILE" ]; then
              echo "ERROR: DDL file not found at \$FIXTURE_FILE"
              exit 1
            fi
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# ── anchor-uniqueness (task-infra-rollback-deploys-not-rebuilds, PR #615
# round 5, LOW) ──────────────────────────────────────────────────────────
# A SECOND `for FILE in \` block, unrelated to the real preflight step,
# added ABOVE it. Extraction must refuse to silently pick "the first match"
# instead of comparing against the real step.
read -r -d '' MIRROR_DUPLICATE_PREFLIGHT_ANCHOR_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Some unrelated step that happens to share the anchor shape
        run: |
          for FILE in \\
            docker-compose.prod.yml \\
          ; do
            echo "unrelated: \$FILE"
          done
      - name: Verify rollback target commit has all hard-required files
        if: \${{ inputs.image_tag != '' }}
        run: |
          for FILE in \\
            docker-compose.prod.yml \\
            apps/api/drizzle/manual/$DDL \\
          ; do
            echo "check \$FILE"
          done
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Apply DDL on the VPS
        uses: appleboy/ssh-action@v1.2.3
        with:
          script: |
            FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
            if [ ! -f "\$FIXTURE_FILE" ]; then
              echo "ERROR: DDL file not found at \$FIXTURE_FILE"
              exit 1
            fi
            docker compose exec -T postgres \\
              psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
YML

# A SECOND \`git log -1 ... -- \\\` command in the runbook, shaped the same by
# coincidence, above the real rollback-depth-limit one.
read -r -d '' MIRROR_DUPLICATE_RUNBOOK_ANCHOR_MD <<MD || true
# Deployment runbook

Some unrelated command that happens to share the anchor shape:

\`\`\`bash
git log -1 --format='%h  %ad  %s' --date=short -- \\
  docker-compose.prod.yml
\`\`\`

\`\`\`bash
git log -1 --format='%h  %ad  %s' --date=short -- \\
  docker-compose.prod.yml \\
  apps/api/drizzle/manual/$DDL
\`\`\`
MD

echo "== test-check-prod-ddl-wiring.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "properly wired DDL (scp source: + psql apply step) passes" \
  --contains "Copied AND applied:      1" \
  --contains "OK: every manual DDL file" \
  -- run_guard "$(make_case wired "$WIRED_YML")"

assert_green "guarded copy via \${{ steps.X.outputs.source_list }} counts as copied" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case expr-source "$EXPR_SOURCE_YML")"

assert_green "a KNOWN_NOT_WIRED file stays green with no deploy.yml wiring at all" \
  --contains "OK: every manual DDL file" \
  -- run_guard "$(make_case allowlisted "$ABSENT_YML" "2026-07-15_settle_phantom_cleanup.sql")"

assert_green "source: | block scalar counts as a real copy (no false red)" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case block-scalar "$BLOCK_SCALAR_SOURCE_YML")"

assert_green "a comment banner at step indent does not truncate the step (no false red)" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case comment-at-step-indent "$COMMENT_AT_STEP_INDENT_YML")"

assert_green "a '#' inside a quoted psql argument is not a comment (no false red)" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case hash-inside-quotes "$HASH_INSIDE_QUOTES_YML")"

# ── negative — the case this whole task exists for ─────────────────────────────
assert_red "THE CHEAT: filename only in comments/step names -> red" \
  --contains "NEVER COPIED, NEVER APPLIED" \
  --contains "$DDL" \
  -- run_guard "$(make_case comment-only "$COMMENT_ONLY_YML")"

assert_red "copied to the VPS but never applied -> red" \
  --contains "COPIED BUT NEVER APPLIED" \
  -- run_guard "$(make_case copy-only "$COPY_ONLY_YML")"

assert_red "applied but never copied (apply step would 'file not found') -> red" \
  --contains "APPLIED BUT NEVER COPIED" \
  -- run_guard "$(make_case apply-only "$APPLY_ONLY_YML")"

assert_red "item 67: a dead \$VAR=/opt/crm/.../\$DDL assignment next to a REAL psql call for a DIFFERENT file -> red" \
  --contains "COPIED BUT NEVER APPLIED" \
  --contains "$DDL" \
  -- run_guard "$(make_case dead-assignment "$DEAD_ASSIGNMENT_YML")"

assert_green "review round 2, MED-1: single-quoted apply assignment (VAR='/opt/crm/...') counts as applied (no false red)" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case single-quote-apply "$SINGLE_QUOTE_APPLY_YML")"

assert_green "review round 2, MED-2: cross-step \$GITHUB_ENV apply assignment (assign step 1, apply step 3, same job) counts as applied (no false red)" \
  --contains "Copied AND applied:      1" \
  -- run_guard "$(make_case cross-step-github-env "$CROSS_STEP_GITHUB_ENV_YML")"

assert_red "review round 2, MED-2 boundary: \$GITHUB_ENV assignment in a DIFFERENT job does not propagate -> red (no false green)" \
  --contains "COPIED BUT NEVER APPLIED" \
  --contains "$DDL" \
  -- run_guard "$(make_case cross-job-no-resolve "$CROSS_JOB_NO_RESOLVE_YML")"

assert_red "DDL absent from deploy.yml entirely -> red" \
  --contains "NEVER COPIED, NEVER APPLIED" \
  -- run_guard "$(make_case absent "$ABSENT_YML")"

# ── review round 2 ─────────────────────────────────────────────────────────────
assert_red "H1: filename only in TRAILING comments beside real code -> red" \
  --contains "NEVER COPIED, NEVER APPLIED" \
  --contains "$DDL" \
  -- run_guard "$(make_case trailing-comment "$TRAILING_COMMENT_YML")"

assert_red "copied, but the apply step names it only in deploy.yml's house-style comment -> red" \
  --contains "COPIED BUT NEVER APPLIED" \
  -- run_guard "$(make_case copy-plus-house-comment "$COPY_PLUS_HOUSE_COMMENT_YML")"

assert_red "a ::notice:: saying the file is ABSENT is not evidence it was copied -> red" \
  --contains "APPLIED BUT NEVER COPIED" \
  -- run_guard "$(make_case notice-only "$NOTICE_ONLY_YML")"

assert_red "a step that only ECHOES a psql command has applied nothing -> red" \
  --contains "COPIED BUT NEVER APPLIED" \
  -- run_guard "$(make_case psql-echoed-only "$PSQL_ECHOED_ONLY_YML")"


# ── ON_ERROR_STOP invariant (task-ddl-flag-audit, item 141) ────────────────────
assert_green "every real psql invocation in a wired deploy.yml carries -v ON_ERROR_STOP=1 (no false positive)" \
  --contains "psql missing ON_ERROR_STOP: 0" \
  -- run_guard "$(make_case flag-present "$WIRED_YML")"

assert_red "a genuinely copied-and-applied DDL whose psql call omits -v ON_ERROR_STOP=1 -> red" \
  --contains "psql missing ON_ERROR_STOP: 1" \
  --contains "the following psql invocations in .github/workflows/deploy.yml do not" \
  --contains "pass \`-v ON_ERROR_STOP=1\`" \
  --contains "FIXTURE_FILE" \
  -- run_guard "$(make_case missing-on-error-stop "$MISSING_ON_ERROR_STOP_YML")"


# ── manual-private reverse invariant ────────────────────────────────────────────
assert_green "manual-private/ file present but unreferenced anywhere -> green, inventoried" \
  --contains "Manual-private files:    1" \
  --contains "$PRIVATE_DDL" \
  --contains "OK: every manual DDL file" \
  -- run_guard "$(make_private_case private-unreferenced "$PRIVATE_UNREFERENCED_YML")"

assert_green "manual-private/ directory absent entirely -> silently skipped, still green" \
  --contains "Manual-private files:    0" \
  --not-contains "FAIL: the following apps/api/drizzle/manual-private" \
  -- run_guard "$(make_private_case private-dir-absent "$PRIVATE_UNREFERENCED_YML" absent)"

assert_red "manual-private/ file wired into deploy.yml's scp source: -> red" \
  --contains "Manual-private LEAKED:   1" \
  --contains "FAIL: the following apps/api/drizzle/manual-private" \
  --contains "$PRIVATE_DDL referenced in .github/workflows/deploy.yml" \
  -- run_guard "$(make_private_case private-leaked-deploy "$PRIVATE_LEAKED_YML")"

assert_red "manual-private/ file referenced in a DIFFERENT workflow file (not deploy.yml) -> red" \
  --contains "FAIL: the following apps/api/drizzle/manual-private" \
  --contains "referenced in .github/workflows/debug-dump.yml" \
  -- run_guard "$(make_private_other_workflow_case private-leaked-other-workflow)"

# ── hard-required file list mirror (task-infra-rollback-deploys-not-rebuilds,
# PR #615 round 4) ──────────────────────────────────────────────────────────
assert_green "no rollback preflight step anywhere -> mirror check is a no-op (every other fixture in this suite stays unaffected)" \
  --contains "Hard-required list drift (preflight vs runbook): 0" \
  --not-contains "mirrored in only one place" \
  -- run_guard "$(make_case no-preflight "$WIRED_YML")"

assert_green "a differently-named for-loop (for REPORT in) is not mistaken for the preflight step's for FILE in -> no false positive" \
  --contains "Hard-required list drift (preflight vs runbook): 0" \
  --not-contains "mirrored in only one place" \
  -- run_guard "$(make_case other-loop-shape "$MIRROR_OTHER_LOOP_YML")"

assert_green "preflight list and runbook mirror command name the same files -> green" \
  --contains "Hard-required list drift (preflight vs runbook): 0" \
  -- run_guard "$(make_mirror_case mirror-match "$MIRROR_BASE_YML" "$MIRROR_MATCH_MD")"

assert_red "runbook mirror is missing a file the preflight list requires -> red, names the file and the fix" \
  --contains "IN deploy.yml's PREFLIGHT LIST, MISSING FROM THE RUNBOOK MIRROR" \
  --contains "apps/api/drizzle/manual/$DDL" \
  --contains "add these to docs/runbooks/deployment.md" \
  -- run_guard "$(make_mirror_case mirror-missing-in-runbook "$MIRROR_BASE_YML" "$MIRROR_MISSING_DDL_MD")"

assert_red "runbook mirror names a file the preflight list does not require -> red, names the file and the fix" \
  --contains "IN THE RUNBOOK MIRROR, MISSING FROM deploy.yml's PREFLIGHT LIST" \
  --contains "2099-01-02_never_in_preflight.sql" \
  --contains "add these to deploy.yml" \
  -- run_guard "$(make_mirror_case mirror-extra-in-runbook "$MIRROR_BASE_YML" "$MIRROR_EXTRA_FILE_MD")"

assert_red "deploy.yml has the preflight list but docs/runbooks/deployment.md has no mirror at all -> red" \
  --contains "mirrored in only one place" \
  --contains "has no matching \`git log -1 -- <paths>\` command" \
  -- run_guard "$(make_mirror_case mirror-runbook-absent "$MIRROR_BASE_YML" absent)"

assert_red "docs/runbooks/deployment.md has the mirror command but deploy.yml has no preflight step -> red" \
  --contains "mirrored in only one place" \
  --contains "has no matching 'Verify rollback target commit has all hard-required files' step" \
  -- run_guard "$(make_mirror_case mirror-preflight-absent "$WIRED_YML" "$MIRROR_MATCH_MD")"

# ── preflight-covers-unconditional-scp (task-infra-rollback-deploys-not-
# rebuilds, PR #615 round 5, SR-M-5) ────────────────────────────────────────
# The exact SR-M-5 shape: preflight and runbook mirror agree with EACH OTHER
# (drift 0 — the pre-existing mirror check alone would stay green here) while
# an unconditional scp step copies a file NEITHER of them lists. Asserting
# BOTH lines in one fixture is the regression proof: without the new check,
# this exact input passes.
assert_red "an unconditional scp step copies a file the preflight list does not require -> red, names the file and the fix (mirror check alone would have stayed green)" \
  --contains "Hard-required list drift (preflight vs runbook): 0" \
  --contains "Preflight missing unconditional scp files: 1" \
  --contains "scripts/devops/never-in-preflight.sh" \
  --contains "SR-M-5" \
  --contains "add these to BOTH deploy.yml" \
  -- run_guard "$(make_mirror_case mirror-scp-uncovered "$MIRROR_SCP_UNCOVERED_YML" "$MIRROR_MATCH_MD")"

assert_green "a GUARDED scp step (has an if:) copying an extra file does not count against coverage -> no false positive" \
  --contains "Preflight missing unconditional scp files: 0" \
  -- run_guard "$(make_mirror_case mirror-scp-guarded-extra "$MIRROR_SCP_GUARDED_EXTRA_YML" "$MIRROR_MATCH_MD")"

assert_green "preflight list (and its runbook mirror) name a file no scp step ever copies -> superset direction stays green" \
  --contains "Preflight missing unconditional scp files: 0" \
  -- run_guard "$(make_mirror_case mirror-preflight-extra-name "$MIRROR_PREFLIGHT_EXTRA_NAME_YML" "$MIRROR_PREFLIGHT_EXTRA_NAME_MD")"

# ── anchor-uniqueness (task-infra-rollback-deploys-not-rebuilds, PR #615
# round 5, LOW) ──────────────────────────────────────────────────────────
assert_red "deploy.yml has two lines matching the for FILE in \\ anchor -> red, refuses to silently pick the first" \
  --contains "deploy.yml has 2 lines matching" \
  --contains "expected at most one" \
  -- run_guard "$(make_mirror_case mirror-duplicate-preflight-anchor "$MIRROR_DUPLICATE_PREFLIGHT_ANCHOR_YML" "$MIRROR_MATCH_MD")"

assert_red "docs/runbooks/deployment.md has two lines matching the git log -1 ... -- \\ anchor -> red, refuses to silently pick the first" \
  --contains "deployment.md has 2 lines matching" \
  --contains "expected at most one" \
  -- run_guard "$(make_mirror_case mirror-duplicate-runbook-anchor "$MIRROR_BASE_YML" "$MIRROR_DUPLICATE_RUNBOOK_ANCHOR_MD")"

# ── apply-order invariants (PR #1027 fix round): grants after every relation
# creator, privileges check last. Order is derived from deploy.yml's apply step,
# relation creators from the SQL file contents — no list of file names.
ORD_CREATOR="2099-01-01_order_creator.sql"
ORD_PLAIN="2099-01-02_order_plain.sql"
ORD_GRANTS="2026-10-18_db_grants.sql"
ORD_CHECK="2026-10-18_db_privileges_check.sql"

# $1 = case name, remaining args = file names in apply order (repeats allowed).
make_order_case() {
  local name="$1"; shift
  local root="$WS/$name" dir f i=0
  guard_test_fake_repo "$root" "$GUARD"
  dir="$root/apps/api/drizzle/manual"
  mkdir -p "$dir"
  local uniq="" src=""
  for f in "$@"; do
    case " $uniq " in *" $f "*) ;; *) uniq="$uniq $f" ;; esac
  done
  for f in $uniq; do
    case "$f" in
      "$ORD_CREATOR") printf -- '-- creates a relation\nCREATE TABLE IF NOT EXISTS order_fixture (id int);\n' >"$dir/$f" ;;
      "$ORD_PLAIN") printf 'ALTER TABLE order_fixture ADD COLUMN IF NOT EXISTS c text;\n' >"$dir/$f" ;;
      "$ORD_GRANTS") printf 'GRANT SELECT ON order_fixture TO PUBLIC;\n' >"$dir/$f" ;;
      *) printf 'SELECT 1;\n' >"$dir/$f" ;;
    esac
    src="${src:+$src,}apps/api/drizzle/manual/$f"
  done
  {
    printf 'name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  copy-compose:\n    runs-on: ubuntu-latest\n    steps:\n'
    printf '      - name: Copy DDL via SCP\n        uses: appleboy/scp-action@v0.1.7\n        with:\n          host: ${{ secrets.VPS_HOST }}\n'
    printf "          source: '%s'\n" "$src"
    printf "          target: '/opt/crm'\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n"
    printf '      - name: Apply DDL on the VPS\n        uses: appleboy/ssh-action@v1.2.3\n        with:\n          script: |\n'
    for f in "$@"; do
      i=$((i + 1))
      printf '            F%s="/opt/crm/apps/api/drizzle/manual/%s"\n' "$i" "$f"
      printf '            docker compose exec -T postgres \\\n'
      printf '              psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 < "$F%s"\n' "$i"
    done
  } >"$root/.github/workflows/deploy.yml"
  printf '%s' "$root"
}

assert_green "apply order: creator, grants, plain, check last -> green" \
  --contains "Apply-order violations (grants / privileges check): 0" \
  -- run_guard "$(make_order_case order-ok "$ORD_CREATOR" "$ORD_GRANTS" "$ORD_PLAIN" "$ORD_CHECK")"

assert_green "apply order: check before the swap AND last, creator re-run between them (first application is above the grants) -> green" \
  --contains "Apply-order violations (grants / privileges check): 0" \
  -- run_guard "$(make_order_case order-rerun-ok "$ORD_CREATOR" "$ORD_GRANTS" "$ORD_CHECK" "$ORD_CREATOR" "$ORD_CHECK")"

assert_red "apply order: a CREATE TABLE file applied after the grants -> red, names the file and GRANTS-AFTER-CREATORS" \
  --contains "[GRANTS-AFTER-CREATORS] $ORD_CREATOR" \
  --contains "ends the deploy ungranted" \
  -- run_guard "$(make_order_case order-creator-after-grants "$ORD_GRANTS" "$ORD_CREATOR" "$ORD_CHECK")"

assert_red "apply order: a file applied after the last privileges check -> red, names the file and CHECK-LAST" \
  --contains "[CHECK-LAST] $ORD_PLAIN" \
  --contains "not the end state of the deploy" \
  -- run_guard "$(make_order_case order-check-not-last "$ORD_CREATOR" "$ORD_GRANTS" "$ORD_CHECK" "$ORD_PLAIN")"

assert_green "apply order: no grants file in the sequence -> invariants not applicable, still green" \
  --contains "Apply-order violations (grants / privileges check): 0" \
  -- run_guard "$(make_order_case order-no-grants "$ORD_PLAIN" "$ORD_CREATOR")"

# ── script_path: expansion (task-infra-deploy-arglist-too-long, 2026-10-19) ────
# The DDL apply steps used to sit in deploy.yml as one 2358-line inline
# `script:`. That block crossed Linux MAX_ARG_STRLEN (appleboy/ssh-action passes
# `script:` as the single env string INPUT_SCRIPT), the runner could no longer
# spawn bash, and `main` became undeployable for every commit. The body moved to
# scripts/devops/deploy-stack-on-vps.sh behind `script_path:`.
#
# The danger that move created is this guard, not the deploy: with the applies
# out of deploy.yml, the guard's inventory would have gone to ZERO APPLY STEPS
# and reported OK — the 2026-07-25 incident shape all over again, with every DDL
# file on prod silently unwatched. expand_script_paths() is what prevents that,
# so these cases hold it down from both directions: the expansion must find a
# real apply, and must NOT invent one.

# $1 = case name, $2 = deploy.yml content, $3 = content of the referenced script
make_script_path_case() {
  local name="$1" deploy_yml="$2" script="$3"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/apps/api/drizzle/manual" "$root/scripts/devops"
  printf 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;\n' >"$root/apps/api/drizzle/manual/$DDL"
  printf '%s' "$deploy_yml" >"$root/.github/workflows/deploy.yml"
  if [ "$script" != "absent" ]; then
    printf '%s' "$script" >"$root/scripts/devops/deploy-stack-on-vps.sh"
  fi
  printf '%s' "$root"
}

read -r -d '' SCRIPT_PATH_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Pull, up, migrate, health-check via SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          script_path: \${{ github.workspace }}/scripts/devops/deploy-stack-on-vps.sh
YML

# Same deploy.yml, but the path is a form the guard cannot resolve. It must
# refuse rather than skip: a step it cannot read is a step it cannot audit.
SCRIPT_PATH_UNRESOLVABLE_YML="${SCRIPT_PATH_YML//\$\{\{ github.workspace \}\}\/scripts/\$\{\{ runner.temp \}\}\/scripts}"

read -r -d '' APPLY_SCRIPT <<SH || true
#!/usr/bin/env bash
# This header is a comment and must be stripped exactly as it was when the
# same text lived inline — a filename mentioned here must still not count.
set -euo pipefail
FIXTURE_FILE="/opt/crm/apps/api/drizzle/manual/$DDL"
if [ ! -f "\$FIXTURE_FILE" ]; then
  echo "ERROR: DDL file not found at \$FIXTURE_FILE"
  exit 1
fi
docker compose exec -T postgres \\
  psql -U "\$PGUSER" -d "\$PGDB" -v ON_ERROR_STOP=1 < "\$FIXTURE_FILE"
SH

# The file exists and runs a deploy, but never applies the DDL. Expansion must
# not turn "copied, never applied" into a pass.
read -r -d '' NO_APPLY_SCRIPT <<SH || true
set -euo pipefail
# SOURCE: apps/api/drizzle/manual/$DDL — mentioned, never applied.
docker compose up -d
SH

# The shape after `script_path:` also turned out to ship the body as a command
# string (deploy of 3928ba00e, "/bin/bash: Argument list too long" on the VPS):
# the file is scp'd and the step's whole script is a dispatch to the VPS path.
# The guard must translate /opt/crm/<rel> back to the REPOSITORY file — the VPS
# copy comes from the repo — or it goes blind on every apply again.
read -r -d '' DISPATCH_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Copy the deploy script to the VPS via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'scripts/devops/deploy-stack-on-vps.sh'
          target: '/opt/crm'
      - name: Pull, up, migrate, health-check via SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          script: bash /opt/crm/scripts/devops/deploy-stack-on-vps.sh
YML

# Same dispatch, but to a path with no repository file behind it: unauditable, so
# it must refuse rather than quietly contribute nothing.
read -r -d '' DISPATCH_UNKNOWN_YML <<YML || true
name: Deploy
on:
  push:
    branches: [main]
jobs:
  copy-compose:
    runs-on: ubuntu-latest
    steps:
      - name: Copy DDL via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: 'docker-compose.prod.yml,apps/api/drizzle/manual/$DDL'
          target: '/opt/crm'
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Pull, up, migrate, health-check via SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          script: bash /opt/crm/scripts/devops/not-in-this-repo.sh
YML

assert_green "dispatch via 'bash /opt/crm/<path>' is followed to the repo file -> counted as applied" \
  --contains "Copied AND applied:      1" \
  --contains "BROKEN WIRING:           0" \
  -- run_guard "$(make_script_path_case disp-wired "$DISPATCH_YML" "$APPLY_SCRIPT")"

assert_red "dispatch whose script never applies the DDL -> still red (no false green)" \
  --contains "COPIED BUT NEVER APPLIED" \
  -- run_guard "$(make_script_path_case disp-copy-only "$DISPATCH_YML" "$NO_APPLY_SCRIPT")"

assert_red "dispatch to a /opt/crm path with no repository file -> red, not silently unaudited" \
  --contains "no " \
  -- run_guard "$(make_script_path_case disp-unknown "$DISPATCH_UNKNOWN_YML" "$APPLY_SCRIPT")"

assert_green "the apply lives in the script_path: file (post-split real shape) -> counted as applied" \
  --contains "Copied AND applied:      1" \
  --contains "BROKEN WIRING:           0" \
  -- run_guard "$(make_script_path_case sp-wired "$SCRIPT_PATH_YML" "$APPLY_SCRIPT")"

assert_red "script_path: file exists but never applies the DDL -> still red (expansion invents nothing)" \
  --contains "COPIED BUT NEVER APPLIED" \
  --contains "$DDL" \
  -- run_guard "$(make_script_path_case sp-copy-only "$SCRIPT_PATH_YML" "$NO_APPLY_SCRIPT")"

assert_red "script_path: points at a file that does not exist -> red, not silently skipped" \
  --contains "does not exist" \
  -- run_guard "$(make_script_path_case sp-missing "$SCRIPT_PATH_YML" absent)"

assert_red "script_path: in a form the guard cannot resolve -> red, not silently skipped" \
  --contains "cannot resolve" \
  -- run_guard "$(make_script_path_case sp-unresolvable "$SCRIPT_PATH_UNRESOLVABLE_YML" "$APPLY_SCRIPT")"

# ── single-transaction invariant (backlog 337, 2026-10-25) ──────────────────────
# A file whose header carries `--   psql ... --single-transaction < <this file>`
# must be applied by a psql command that carries the flag. Before this, the only
# check was a drift spec over the file's DOCUMENTED apply line; the real psql call
# could drop the flag and nothing went red.
SINGLE_TX_HEADER='--   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>'
SINGLE_TX_DASH1_HEADER='--   psql -v ON_ERROR_STOP=1 -1 < <this file>'
NO_TX_PROSE_HEADER='-- MUST NOT be applied with `psql -1` / `--single-transaction`'

# $1 = case name, $2 = header line written into the DDL file, $3 = extra psql
# flags inserted after `-v ON_ERROR_STOP=1` (may be empty), $4 = optional text
# appended after the apply line (a trailing comment, for the cheat case).
# $5 = optional DDL file name (default $DDL), for the pinned-name cases.
make_single_tx_case() {
  local name="$1" header="$2" flags="$3" trailer="${4-}" ddl="${5:-$DDL}"
  local root="$WS/$name" yml
  yml="${WIRED_YML//ON_ERROR_STOP=1 </ON_ERROR_STOP=1 ${flags:+$flags }<}"
  yml="${yml//$DDL/$ddl}"
  # The apply line is WIRED_YML's last line, so a trailer lands beside the call.
  [ -n "$trailer" ] && yml="$yml   $trailer"
  root="$(make_case "$name" "$yml" "$ddl")"
  printf '%s\nUPDATE t SET c = c;\n' "$header" >"$root/apps/api/drizzle/manual/$ddl"
  printf '%s' "$root"
}

assert_green "single-transaction: a file declaring it, applied with --single-transaction -> green" \
  --contains "Files requiring a --single-transaction apply: 1" \
  --contains "Applies missing --single-transaction: 0" \
  -- run_guard "$(make_single_tx_case stx-ok "$SINGLE_TX_HEADER" "--single-transaction")"

assert_green "single-transaction: psql's short form -1 counts as the flag -> green" \
  --contains "Files requiring a --single-transaction apply: 1" \
  --contains "Applies missing --single-transaction: 0" \
  -- run_guard "$(make_single_tx_case stx-dash1 "$SINGLE_TX_DASH1_HEADER" "-1")"

assert_red "single-transaction: a file declaring it, applied WITHOUT the flag -> red, names the file" \
  --contains "Applies missing --single-transaction: 1" \
  --contains "$DDL: psql" \
  --contains "half-applied migration" \
  -- run_guard "$(make_single_tx_case stx-missing "$SINGLE_TX_HEADER" "")"

assert_red "single-transaction: the flag only in a trailing comment beside the call -> still red" \
  --contains "Applies missing --single-transaction: 1" \
  -- run_guard "$(make_single_tx_case stx-comment-cheat "$SINGLE_TX_HEADER" "" "# --single-transaction")"

assert_green "single-transaction: prose that FORBIDS -1 is not a declaration (CONCURRENTLY-style files) -> green" \
  --contains "Files requiring a --single-transaction apply: 0" \
  --contains "Applies missing --single-transaction: 0" \
  -- run_guard "$(make_single_tx_case stx-prose "$NO_TX_PROSE_HEADER" "")"

# SR-M-1 (security review PR #1155): header discovery fails open. A pinned file
# whose header was reformatted so the pattern no longer matches must go red,
# even though it is still applied WITH the flag.
PINNED_DDL="2026-10-24_job_sources_manifest_delta.sql"
REFORMATTED_HEADER='-- How to apply: run psql with ON_ERROR_STOP and single-transaction on this file'

assert_green "single-transaction: a pinned file with its apply-line header, applied with the flag -> green" \
  --contains "Applies missing --single-transaction: 0" \
  -- run_guard "$(make_single_tx_case stx-pinned-ok "$SINGLE_TX_HEADER" "--single-transaction" "" "$PINNED_DDL")"

assert_red "single-transaction: a pinned file whose header was reformatted (pattern no longer matches) -> red, not a silent 0" \
  --contains "Files requiring a --single-transaction apply: 1" \
  --contains "Applies missing --single-transaction: 1" \
  --contains "$PINNED_DDL: pinned in PINNED_SINGLE_TX_FILES" \
  -- run_guard "$(make_single_tx_case stx-pinned-reformatted "$REFORMATTED_HEADER" "--single-transaction" "" "$PINNED_DDL")"

assert_red "single-transaction: a pinned file with a reformatted header AND no flag -> red" \
  --contains "Applies missing --single-transaction: 2" \
  -- run_guard "$(make_single_tx_case stx-pinned-reformatted-noflag "$REFORMATTED_HEADER" "" "" "$PINNED_DDL")"

# SR-M-3 (security review PR #1155): the pin is by name, not by presence in manual/.
# A pinned file the deploy still applies, but which left manual/, must go red even
# when its psql call carries the flag (before the fix the pin silently dropped out).
make_pinned_moved_out_case() {
  local root
  root="$(make_single_tx_case "$1" "$SINGLE_TX_HEADER" "$2" "" "$PINNED_DDL")"
  rm "$root/apps/api/drizzle/manual/$PINNED_DDL"
  printf '%s' "$root"
}

assert_red "single-transaction: a pinned file moved out of manual/ but still applied (with the flag) -> red, names the file" \
  --contains "not a wired file in manual/" \
  --contains "$PINNED_DDL" \
  -- run_guard "$(make_pinned_moved_out_case stx-pinned-moved-flag "--single-transaction")"

assert_red "single-transaction: a pinned file moved out of manual/ AND applied without the flag -> red" \
  --contains "not a wired file in manual/" \
  --contains "Applies missing --single-transaction: 2" \
  -- run_guard "$(make_pinned_moved_out_case stx-pinned-moved-noflag "")"

# ── hard-required list continuation (2026-10-25) ────────────────────────────────
# Both lists are one backslash-continued shell command. A blank line inside one
# was on main in both copies at once (so the mirror check stayed green) and made
# the rollback preflight a bash syntax error.
BLANK_PREFLIGHT_YML="${MIRROR_BASE_YML/docker-compose.prod.yml \\$'\n'/docker-compose.prod.yml \\$'\n\n'}"
BLANK_RUNBOOK_MD="${MIRROR_MATCH_MD/docker-compose.prod.yml \\$'\n'/docker-compose.prod.yml \\$'\n\n'}"

assert_green "continuation: both hard-required lists unbroken -> green" \
  --contains "Broken line continuations in hard-required lists: 0" \
  -- run_guard "$(make_mirror_case cont-ok "$MIRROR_BASE_YML" "$MIRROR_MATCH_MD")"

assert_red "continuation: a blank line inside deploy.yml's preflight list -> red (bash syntax error), mirror drift still 0" \
  --contains "Broken line continuations in hard-required lists: 1" \
  --contains "Hard-required list drift (preflight vs runbook): 0" \
  --contains "deploy.yml preflight line" \
  --contains "(blank line)" \
  -- run_guard "$(make_mirror_case cont-preflight-blank "$BLANK_PREFLIGHT_YML" "$MIRROR_MATCH_MD")"

assert_red "continuation: a blank line inside the runbook's git log list -> red (later paths silently dropped)" \
  --contains "Broken line continuations in hard-required lists: 1" \
  --contains "runbook mirror line" \
  -- run_guard "$(make_mirror_case cont-runbook-blank "$MIRROR_BASE_YML" "$BLANK_RUNBOOK_MD")"

guard_test_summary "test-check-prod-ddl-wiring.sh"
