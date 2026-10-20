#!/usr/bin/env bash
# test-pre-bash-devserver-ttl-gate.sh — proves .claude/hooks/pre-bash-devserver-ttl-gate.sh
# still demands the TTL wrapper for every real dev-server boot inside an agent
# worktree, and no longer fires on commands that merely name one.
#
# WHY THIS FILE EXISTS AT ALL. This hook was not in the original scope: the
# reported false positive named only pre-bash-live-db-guard. But both hooks
# carried the SAME launcher regex, copy-pasted, so narrowing one left
# `git show <ref>:pnpm-lock.yaml | grep -n vite` still blocked — reproduced on
# 2026-08-18 with the narrowed live-db-guard already in place. "The scoped hook
# now allows it" would have been a true statement and a useless fix.
#
# The wrapper check is per-SEGMENT on purpose: a mention of dev-ttl.sh in one
# segment must not whitelist an unwrapped boot in another. That decoy is the
# last red case below.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
. "$SELF_DIR/lib/hook-harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-devserver-ttl-gate.sh"
TTL="scripts/devops/dev-ttl.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

h() { hook_at "$HOOK" "$@"; }

echo "== test-pre-bash-devserver-ttl-gate.sh =="
echo

# ── green ─────────────────────────────────────────────────────────────────────
assert_green "READ: git show | grep -n vite (тот же ложный случай, что у соседа)" \
  -- h "git show HEAD:pnpm-lock.yaml | grep -n vite"

assert_green "READ: rg -n 'nest start' по apps/api" \
  -- h "rg -n 'nest start' apps/api"

assert_green "READ: ls node_modules/.bin/vite" \
  -- h "ls -la node_modules/.bin/vite"

assert_green "НЕ dev-сервер: vitest / playwright самозавершаются" \
  -- h "pnpm --filter @crm/e2e test"

assert_green "правильно обёрнутый запуск проходит" \
  -- h "$TTL --ttl 7200 -- pnpm --filter @crm/api dev"

assert_green "обёрнутый запуск с префиксом переменных окружения" \
  -- h "$TTL -- DATABASE_URL=postgresql://h:5432/crm_qa API_PORT=3011 pnpm --filter @crm/api dev"

assert_green "вне worktree/scratchpad — стек владельца не гейтится" \
  -- h "pnpm --filter @crm/api dev" "$WS"

# ── red ───────────────────────────────────────────────────────────────────────
assert_red "голый pnpm dev в worktree" \
  --contains '"decision": "block"' \
  --contains "[pre:bash:devserver-ttl-gate] BLOCK" \
  -- h "pnpm --filter @crm/api dev"

assert_red "vite после cd" \
  --contains '"decision": "block"' \
  -- h "cd apps/web && vite --port 3010"

assert_red "nest start через sh -c" \
  --contains '"decision": "block"' \
  -- h "sh -c 'cd apps/api && nest start'"

assert_red "собранный API: node apps/api/dist/main.js" \
  --contains '"decision": "block"' \
  -- h "node apps/api/dist/main.js"

assert_red "фоновый nohup" \
  --contains '"decision": "block"' \
  -- h "nohup pnpm --filter @crm/web dev &"

assert_red "ПРИМАНКА: dev-ttl.sh упомянут в другом сегменте, запуск не обёрнут" \
  --contains '"decision": "block"' \
  -- h "echo $TTL && pnpm --filter @crm/api dev"

assert_red "кавычки не парсятся — деградированный разбор всё равно ловит запуск" \
  --contains '"decision": "block"' \
  -- h "pnpm --filter @crm/api dev \"unbalanced"

# ── находки security-review PR #561 ──────────────────────────────────────────
# Систематическое покрытие — test-hook-command-corpus.sh; здесь именованные.
assert_red "REVIEW HIGH-1: env -i pnpm dev" \
  --contains '"decision": "block"' \
  -- h "env -i pnpm dev"

assert_red "REVIEW HIGH-2: ! pnpm dev (отрицание как командное слово)" \
  --contains '"decision": "block"' \
  -- h "! pnpm dev"

assert_red "REVIEW HIGH-2: подоболочка (pnpm dev)" \
  --contains '"decision": "block"' \
  -- h "(pnpm dev)"

assert_red "REVIEW HIGH-2: цикл while … do … done" \
  --contains '"decision": "block"' \
  -- h "while true; do pnpm dev; done"

assert_red "REVIEW HIGH-3: script -q /dev/null pnpm dev" \
  --contains '"decision": "block"' \
  -- h "script -q /dev/null pnpm dev"

assert_red "ОБХОД-2: обёртка внутри обёртки (nohup + script)" \
  --contains '"decision": "block"' \
  -- h "nohup script -q /dev/null pnpm dev &"

# Приманка наоборот: dev-ttl.sh должен ОБЁРТЫВАТЬ запуск, а не просто стоять
# рядом с ним. Здесь он в аргументах самого запуска — TTL не применяется.
assert_red "ПРИМАНКА-2: dev-ttl.sh аргументом запуска, а не обёрткой" \
  --contains '"decision": "block"' \
  -- h "script -q /dev/null pnpm dev -- $TTL"

# Обратная сторона той же проверки: когда обёртка стоит там, где надо, TTL
# действительно применяется — даже если внешняя обёртка разбирается неточно
# (`script` меняет грамматику между BSD и GNU). Хук не должен требовать
# обёртку дважды.
assert_green "неточная внешняя обёртка поверх настоящей TTL-обёртки — TTL применён" \
  -- h "script -q /dev/null $TTL -- pnpm dev"

# ── crash is not a verdict (AC6) ──────────────────────────────────────────────
BROKEN="$(hook_with_broken_lib "$WS" pre-bash-devserver-ttl-gate.sh)"

assert_red "СЛОМАННЫЙ анализатор + необёрнутый запуск: блок, помеченный ДЕГРАДИРОВАННЫМ" \
  --contains "INTERNAL ERROR" \
  --contains "ДЕГРАДИРОВАННЫЙ РЕЖИМ" \
  -- hook_at "$BROKEN" "pnpm --filter @crm/api dev"

assert_red "СЛОМАННЫЙ анализатор + безобидное чтение: НЕ вердикт" \
  --contains "INTERNAL ERROR" \
  --not-contains "decision" \
  -- hook_at "$BROKEN" "grep -rn 'pnpm dev' .claude/rules"

assert_red "ЛОВУШКА: хук со сломанным bash тоже даёт rc≠0 — но без decision-контракта" \
  --contains "syntax error" \
  --not-contains "decision" \
  -- hook_at "$(hook_with_broken_bash "$WS")" "pnpm --filter @crm/api dev"

# ── package scripts that boot a server: start / preview (SR-H-14) ──────────────
# The hot-path prefilter used to look only for vite|nest|dev|dist/main, so a command with
# none of those words never reached the analyzer. These pass the prefilter now.
for form in 'pnpm --filter @crm/api start' 'pnpm -C apps/api start' 'npm start' 'turbo start' \
            'pnpm -r dev' 'pnpm run-script dev' 'pnpm --filter @crm/web preview'; do
  assert_red "ТТЛ-гейт: без обёртки — отказ: $form" \
    --contains '"decision": "block"' \
    -- h "$form"
  assert_green "ТТЛ-гейт: с обёрткой проходит: $form" \
    -- h "$TTL -- $form"
done
assert_red "ТТЛ-гейт: интерпретатор + dev-ttl.sh не отменяет проверку обёртки у соседнего запуска" \
  --contains '"decision": "block"' \
  -- h "bash $TTL -- pnpm --filter @crm/api dev & pnpm --filter @crm/api start"

# ── SHARED LIBRARY: the comment stripper in lib/cmdscan.py ────────────────────
# Three hooks consume that library (this one, live-db-guard, safety), and the stripper
# decided a "#" starts a comment by reading the previous character. An ESCAPED space
# leaves a space there without ending the word, so `echo a\ # && <launch>` had everything
# after the # dropped as a comment - the launch included - for every one of them. bash's
# rule is stated plainly: "#" begins a comment only at a word start, and an escaped space
# does not end a word. Each hook carries its OWN case, because a test that only covered one
# consumer would leave the other two to chance. (This file exercises pre:bash:devserver-ttl-gate.)
assert_red "ТТЛ-гейт: запуск спрятан после экранированного пробела и #: echo a\\ # && ..." \
  --contains '"decision": "block"' \
  -- h "echo a\\ # && pnpm --filter @crm/api dev"

assert_red "ТТЛ-гейт: то же с ;" \
  --contains '"decision": "block"' \
  -- h "echo a\\ # ; pnpm --filter @crm/api dev"

assert_red "ТТЛ-гейт: кавычка, затем экранированный пробел" \
  --contains '"decision": "block"' \
  -- h "echo 'x'\\ # && pnpm --filter @crm/api dev"

assert_red "ТТЛ-гейт: экранированный перевод строки не заканчивает слово" \
  --contains '"decision": "block"' \
  -- h "echo a\\
# && pnpm --filter @crm/api dev"

assert_green "ТТЛ-гейт: настоящий комментарий по-прежнему не запуск" \
  -- h "echo hi # pnpm --filter @crm/api dev"

assert_green "ТТЛ-гейт: строка-комментарий целиком — не запуск" \
  -- h "# pnpm --filter @crm/api dev"

# ── SR-M-22: the word-boundary rule must be observable HERE, not masked ─────────
# The comment-free second reading finds a launch the stripper hid, so a regression in the
# stripper's word-boundary rule left every case above green (measured: with the backslash
# check disabled this file stayed 46/0). A launch found ONLY by the second reading carries
# the label "[comment-free reading]"; for the escaped-space cases the stripper must find
# the launch by itself, so the label must be ABSENT. That pins the rule, not its fallback.
for esc in "echo a\\ # && pnpm --filter @crm/api dev" "echo a\\ # ; pnpm --filter @crm/api dev" \
           "echo 'x'\\ # && pnpm --filter @crm/api dev"; do
  assert_red "ТТЛ-гейт: правило границы слова само находит запуск (метки второго чтения нет): $esc" \
    --contains '"decision": "block"' \
    --not-contains "comment-free reading" \
    -- h "$esc"
done

# ── SR-H-20: shapes the stripper cannot know about are caught by the second reading ──
# A parameter expansion whose default value holds a space then #, and a process
# substitution immediately followed by #, both run the next command in bash and zsh.
# They are refused here, and they carry the label - the second reading did the work.
assert_red "ТТЛ-гейт SR-H-20 форма 1: \${x:- #} затем запуск" \
  --contains '"decision": "block"' \
  --contains "comment-free reading" \
  -- h "echo \${x:- #}; pnpm --filter @crm/api dev"

assert_red "ТТЛ-гейт SR-H-20 форма 2: <(true)# затем запуск" \
  --contains '"decision": "block"' \
  --contains "comment-free reading" \
  -- h "cat <(true)# ; pnpm --filter @crm/api dev"

# ── SR-H-24 / SR-M-21: an interpreter in front of dev-ttl.sh ────────────────────
# A launch behind `bash -c '<payload>' dev-ttl.sh` has dev-ttl.sh as $0, NOT as the wrapper:
# the payload is a bare launch and must be refused. With any other interpreter flag before
# the wrapper (the PR #485 shapes) the wrapper is real and the launch is wrapped.
for form in "bash -c 'pnpm --filter @crm/api dev' dev-ttl.sh" "sh -c 'pnpm --filter @crm/api dev' x dev-ttl.sh" \
            "bash -ec 'pnpm --filter @crm/api dev' x dev-ttl.sh" \
            "bash -o pipefail -c 'pnpm --filter @crm/api dev' dev-ttl.sh"; do
  assert_red "ТТЛ-гейт: payload за -c — голый запуск, dev-ttl.sh здесь \$0: $form" \
    --contains '"decision": "block"' \
    -- h "$form"
done
for flags in '-o pipefail' '--norc' '--' '+x' '-O extglob' '--rcfile /tmp/rc'; do
  assert_green "ТТЛ-гейт: настоящая обёртка за флагами интерпретатора проходит: bash $flags" \
    -- h "bash $flags $TTL -- pnpm --filter @crm/api dev"
done

# ── SR-H-24, the FAMILY (this hook's consumer view) ─────────────────────────────
# A code flag's payload is never discarded, wherever the flag sits in the interpreter's option
# region (see the safety suite for the history: three attempts, only the position-independent
# one is an invariant). Here the payload is a bare launch; every placement must be refused.
for sh in bash sh dash zsh ksh; do
  for t in "-c '@P@' @W@" "@W@ -c '@P@'" "--rcfile @W@ -c '@P@'" "--init-file @W@ -c '@P@'" \
           "-o pipefail -c '@P@' @W@" "-o @W@ -c '@P@'" "-O extglob -c '@P@' @W@" "+O @W@ -c '@P@'" \
           "+o @W@ -c '@P@'" "-ec '@P@' x @W@" "-xc '@P@' @W@" "-c '@P@' -- @W@" "@W@ -- -c '@P@'" \
           "-x -e -c '@P@' @W@ -- ls" "@W@ -x -c '@P@'" "-c '@P@' -c '@P@' @W@" \
           "-c 'ls' -c '@P@' @W@" "-c 'ls' -c '@P@'" "-c 'ls' x -ec '@P@'"; do
    cmd="$sh ${t//@P@/pnpm --filter @crm/api dev}"; cmd="${cmd//@W@/dev-ttl.sh}"
    assert_red "ТТЛ-гейт SR-H-24 (семейство): $cmd" \
      --contains '"decision": "block"' \
      -- h "$cmd"
  done
done

# ══ 2026-10-21: the gate inspected text that is DATA, not launcher position ══
# Four refusals in one day, none of them a launch. The hook's own header claimed
# it "only looks at the command in launcher position"; that was false for a
# heredoc body and for a package-runner subcommand, and the header is corrected
# in the same change. Each repro is a GREEN case here, with its hit count in the
# label — the counts are what made the diagnosis specific (one defect would not
# produce three "launches" from one markdown note).
#
# The asymmetry is the whole point of this section: a false positive costs a
# retry, a false negative cost two minutes of an API on :3000 against the live
# database (PR #485, 2026-08-05). So every green below is paired with reds that
# pin the launch shape it must not have relaxed.

# ── repro 1: a read-only dependency query ─────────────────────────────────────
# `pnpm` is deliberately NOT in UNDERSTOOD (membership there sets confident=True
# and short-circuits readings(), which is how that list leaked in round 3). The
# grant is per-subcommand: a vetted print-and-exit query behind a flag grammar
# that is complete. Everything else about a runner stays uncertain.
assert_green "РЕПРО-1: pnpm why vite — запрос к зависимостям, не запуск (1 ложное срабатывание)" \
  -- h "pnpm why vite"

for q in "ls vite" "list vite" "info vite" "view vite" "audit" "outdated" \
         "licenses" "why --json vite" "ls --depth 2 vite" "--filter @crm/api why vite" \
         "-r why vite" "--depth=2 ls vite"; do
  assert_green "РЕПРО-1 (семейство read-only подкоманд): pnpm $q" \
    -- h "pnpm $q"
done

# The grant must not widen to a subcommand that DOES launch, nor survive a flag
# the grammar does not know. These are the reds that make the green honest.
assert_red "РЕПРО-1 обратная сторона: pnpm exec vite — подкоманда, которая ЗАПУСКАЕТ (без inline DATABASE_URL)" \
  --contains '"decision": "block"' \
  -- h "pnpm exec vite --port 3010"

assert_red "РЕПРО-1 обратная сторона: pnpm dlx vite (без inline порта)" \
  --contains '"decision": "block"' \
  -- h "pnpm dlx vite"

assert_red "РЕПРО-1 обратная сторона: npm exec -- vite (\`--\` раньше съедал командное слово)" \
  --contains '"decision": "block"' \
  -- h "npm exec -- vite"

for bad in "-c vite" "--call vite" "--unknown-flag why vite" "--filter dev"; do
  assert_red "РЕПРО-1 обратная сторона: грамматика флагов неполна → сегмент остаётся недостоверным: pnpm $bad" \
    --contains '"decision": "block"' \
    -- h "pnpm $bad"
done

# ── repros 2-4: a heredoc body is DATA, and a QUOTED delimiter proves it ───────
# Stage 2 of lib/cmdscan.py was always emphatic that a heredoc body is data,
# never code — and stage 1 (substitution extraction) ran FIRST and had already
# mined it. So a markdown bullet and a Python string literal were read as
# command substitutions. All three reported shapes used a quoted delimiter, i.e.
# exactly the case where bash itself guarantees the body is inert (verified by
# execution, not by reading: `cat <<'EOF'` with `$(echo X)` in the body prints
# the text, `cat <<EOF` prints X).
MD_NOTE=$'cat > notes.md <<\'EOF\'\n- `pnpm dev` boots the web app\n- `vite` is the bundler\n- `node dist/main` boots the api\nEOF'
assert_green "РЕПРО-2: markdown-заметка, три упоминания в обратных кавычках (3 ложных срабатывания)" \
  -- h "$MD_NOTE"

PR_BODY=$'gh pr create --title t --body "$(cat <<\'EOF\'\nBefore: the gate refused `pnpm why vite`.\nEOF\n)"'
assert_green "РЕПРО-3: текст описания PR в heredoc (1 ложное срабатывание)" \
  -- h "$PR_BODY"

PY_HEREDOC=$'python3 - <<\'PYEOF\'\nprint("- `vite` is the bundler")\nprint("- `pnpm dev` boots the web app")\nPYEOF'
assert_green "РЕПРО-4: строковые литералы python в heredoc (2 ложных срабатывания)" \
  -- h "$PY_HEREDOC"

# `<<\EOF` quotes the delimiter exactly as `<<'EOF'` does (checked by running
# bash, which prints the text unexpanded). HEREDOC_RE never matched this form,
# so such a body used to be read as ordinary code.
ESC_DELIM=$'cat > notes.md <<\\EOF\n$(pnpm --filter @crm/api dev)\nEOF'
assert_green "РЕПРО-2/4 родственная форма: <<\\\\EOF тоже экранирует разделитель — тело инертно" \
  -- h "$ESC_DELIM"

# ── the other direction: an UNQUOTED body really is expanded by the shell ─────
UNQ_SUBST=$'cat > out.txt <<EOF\n$(pnpm --filter @crm/api dev)\nEOF'
assert_red "НЕ ослаблено: <<EOF без кавычек — подстановка в теле реально исполняется" \
  --contains '"decision": "block"' \
  -- h "$UNQ_SUBST"

UNQ_BACKTICK=$'cat > out.txt <<EOF\n`vite --port 3010`\nEOF'
assert_red "НЕ ослаблено: <<EOF без кавычек, обратные кавычки в теле" \
  --contains '"decision": "block"' \
  -- h "$UNQ_BACKTICK"

UNQ_DASH=$'cat > out.txt <<-EOF\n\t$(pnpm dev)\n\tEOF'
assert_red "НЕ ослаблено: <<-EOF (срезание табов) без кавычек" \
  --contains '"decision": "block"' \
  -- h "$UNQ_DASH"

AFTER_HEREDOC=$'cat > note.md <<\'EOF\'\nnothing here\nEOF\npnpm --filter @crm/api dev'
assert_red "НЕ ослаблено: запуск ПОСЛЕ закрытого heredoc — защита тела не покрывает соседа" \
  --contains '"decision": "block"' \
  -- h "$AFTER_HEREDOC"

BEFORE_HEREDOC=$'pnpm --filter @crm/api dev\ncat > note.md <<\'EOF\'\nnothing here\nEOF'
assert_red "НЕ ослаблено: запуск ПЕРЕД heredoc" \
  --contains '"decision": "block"' \
  -- h "$BEFORE_HEREDOC"

# ── the parser differential: two readings of one text, failing closed ─────────
# _heredoc_literal_spans is a SECOND reading of the same line, and a span that
# the segmenter does not also treat as a body would exempt live code. Both of
# the following were reproduced as fail-OPEN leaks (a launch hidden from the
# gate) during this change and are the reason the three devices exist: the
# comment rule is shared, a span needs its terminator, and every span is
# confirmed against the bodies the segmenter actually captured.
CMT_SUBST=$'# cat > note.md <<\'EOF\'\n$(pnpm --filter @crm/api dev)\nEOF'
assert_red "ДИФФЕРЕНЦИАЛ: открывашка heredoc спрятана в комментарии — \$() форма" \
  --contains '"decision": "block"' \
  -- h "$CMT_SUBST"

CMT_BACKTICK=$'# cat > note.md <<\'EOF\'\n`vite --port 3010`\nEOF'
assert_red "ДИФФЕРЕНЦИАЛ: открывашка heredoc спрятана в комментарии — обратные кавычки" \
  --contains '"decision": "block"' \
  -- h "$CMT_BACKTICK"

UNTERMINATED=$'cat > note.md <<\'EOF\'\n$(pnpm --filter @crm/api dev)'
assert_red "ДИФФЕРЕНЦИАЛ: heredoc без терминатора — неопределённость не даёт освобождения" \
  --contains '"decision": "block"' \
  -- h "$UNTERMINATED"

DELIM_PAREN=$'echo "$(cat <<\'EOF\'\nnote\nEOF)" && $(pnpm --filter @crm/api dev)'
assert_red "ДИФФЕРЕНЦИАЛ: терминатор в форме \`EOF)\`, затем запуск" \
  --contains '"decision": "block"' \
  -- h "$DELIM_PAREN"

# ── PR #485: the shape the whole gate exists for ──────────────────────────────
# An inherited DATABASE_URL and API_PORT overrode a worktree .env and an API
# listened on :3000 against the owner's LIVE database for about two minutes. The
# launcher carries no inline environment at all in that shape, which is exactly
# why "it has no DATABASE_URL on the line" can never be a reason to allow.
assert_red "PR #485: запуск без inline DATABASE_URL" \
  --contains '"decision": "block"' \
  -- h "pnpm --filter @crm/api dev"

assert_red "PR #485: запуск без inline порта" \
  --contains '"decision": "block"' \
  -- h "DATABASE_URL=postgresql://h:5432/crm_qa pnpm --filter @crm/api dev"

assert_red "PR #485: собранный API, окружение целиком унаследовано" \
  --contains '"decision": "block"' \
  -- h "node apps/api/dist/main.js"

guard_test_summary "test-pre-bash-devserver-ttl-gate.sh"
