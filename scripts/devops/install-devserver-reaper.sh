#!/bin/bash
# install-devserver-reaper.sh — install/refresh the launchd agent that runs
# reap-zombie-devservers.sh every 30 minutes (zombie dev-server backstop).
#
# Resolves the MAIN repo checkout even when invoked from a worktree, so the
# plist keeps working after worktree cleanup. Idempotent — safe to re-run
# (e.g. after moving the repo).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
# Re-anchor to the main repo if invoked from a worktree checkout.
COMMON_DIR="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$COMMON_DIR" ]; then
  MAIN_ROOT="$(dirname "$COMMON_DIR")"
  if [ -f "$MAIN_ROOT/scripts/devops/reap-zombie-devservers.sh" ]; then
    HERE="$MAIN_ROOT/scripts/devops"
  fi
fi
SCRIPT="$HERE/reap-zombie-devservers.sh"
[ -f "$SCRIPT" ] || {
  echo "reaper script not found: $SCRIPT" >&2
  exit 1
}
case "$SCRIPT" in
*/.claude/worktrees/*)
  echo "refusing to install from a worktree path (it will be deleted): $SCRIPT" >&2
  echo "merge to main first, then run scripts/devops/install-devserver-reaper.sh from the main checkout" >&2
  exit 1
  ;;
esac

LABEL="com.cheekycheeseit.devserver-reaper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/cheekycheeseit-devserver-reaper.log"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

UID_N="$(id -u)"
launchctl bootout "gui/$UID_N" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$PLIST"
launchctl kickstart "gui/$UID_N/$LABEL" 2>/dev/null || true
echo "installed: $PLIST -> $SCRIPT (every 30 min; log: $LOG)"
