#!/bin/bash
# usage: fetch.sh <url> <outbase>   -> <outbase>.raw (body), <outbase>.hdr (headers)
cd /private/tmp/claude-501/-Users-maksym-Desktop-programming-CheekyCheeseIT-CRM--claude-worktrees-clever-meitner-2bd3e9/7717916c-b96b-4996-91c1-e315cd3c5f71/scratchpad/ac71 || exit 1
curl -sS --max-time 30 -A "CheekyCheeseCRM-vacancy-sourcing/1.0" -D "$2.hdr" -o "$2.raw" -w "%{http_code} %{size_download} $1\n" "$1"
grep -i -e '^date' -e '^content-type' -e '^x-ratelimit' -e '^retry' "$2.hdr"
