#!/usr/bin/env bash
# Non-blocking warn: флагует lessons.md файлы над 20-строчным cap (RULES.md §6.4).
# Exit 0 ВСЕГДА — это nudge к консолидации (promote-and-prune), НЕ блокер.
set -euo pipefail
CAP=20
over=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  n=$(wc -l <"$f" | tr -d ' ')
  if [ "$n" -gt "$CAP" ]; then
    echo "⚠️  lessons-cap: $f = $n строк (> $CAP) → консолидировать (promote-and-prune, RULES.md §6.4)"
    over=$((over + 1))
  fi
done < <(git ls-files '.claude/agents/memory/*/lessons.md')
[ "$over" -eq 0 ] || echo "⚠️  $over lessons.md над cap. Архива нет — история в git."
exit 0
