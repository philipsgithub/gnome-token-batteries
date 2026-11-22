#!/bin/sh
# Session hook for Claude Code and Codex, installed by install-hooks.py.
# Tells the token-batteries GNOME extension which CLI sessions run, so it can show their
# batteries only then, and when Codex has logged new limits. The extension watches
# these files with inotify instead of polling.
#
#   session-hook.sh <claude|codex> start   SessionStart: marks the session as running
#   session-hook.sh <claude|codex> end     SessionEnd: removes the mark
#   session-hook.sh codex turn             Stop: a turn ended, new limits are in the log
#
# Never fails and never blocks the CLI.

cli=$1
event=$2
cat >/dev/null 2>&1

dir="${XDG_CACHE_HOME:-$HOME/.cache}/token-batteries"

if [ "$event" = turn ]; then
    mkdir -p "$dir" 2>/dev/null && touch "$dir/$cli-turn" 2>/dev/null
    exit 0
fi

# The hook runs in a shell below the CLI; the mark is named after the CLI's own pid,
# so the extension can tell a crashed session (no SessionEnd) from a running one
pid=$$
depth=0
while [ "$depth" -lt 12 ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = "$cli" ] && break
    pid=$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$pid/status" 2>/dev/null)
    [ -n "$pid" ] || exit 0
    depth=$((depth + 1))
done
[ "$(cat "/proc/$pid/comm" 2>/dev/null)" = "$cli" ] || exit 0

case $event in
    start) mkdir -p "$dir/running" 2>/dev/null && : >"$dir/running/$cli-$pid" 2>/dev/null ;;
    end) rm -f "$dir/running/$cli-$pid" 2>/dev/null ;;
esac
exit 0
