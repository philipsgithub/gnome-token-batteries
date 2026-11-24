#!/usr/bin/env python3
"""Claude Code status line command that saves the rate limits for the extension.

Claude Code passes `rate_limits` to its status line command on stdin. Only that part
is written to ~/.cache/token-batteries/claude-statusline.json. Prints nothing, so it can be
the whole status line or be called from an existing status line script.

Every session passes the limits from its own last request, so an idle session redraws
its status line with old values. Those must not replace newer ones from an active
session: within a window the usage only grows, and a later reset time means a later
window, so the stored values are only replaced by ones that are at least as recent.
"""
import fcntl
import json
import os
import sys
import tempfile
import time

WINDOWS = ('five_hour', 'seven_day')


def recency(window):
    return (window.get('resets_at') or 0, window.get('used_percentage') or 0)


def merge(new, old, now):
    """The newest value of each window, and whether new was older than old anywhere"""
    merged, stale = {}, False
    for name in WINDOWS:
        n, o = new.get(name), old.get(name)
        if o and (o.get('resets_at') or 0) <= now:
            o = None  # That window is over, so anything is newer
        if n and (not o or recency(n) >= recency(o)):
            merged[name] = n
        elif o:
            # Older, or no window running here while the stored one still runs
            merged[name] = o
            stale = True
    return merged, stale


def main():
    try:
        limits = json.load(sys.stdin).get('rate_limits') or {}
    except (ValueError, AttributeError):
        return
    if not (limits.get('five_hour') or limits.get('seven_day')):
        return
    cache = os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache')
    directory = os.path.join(cache, 'token-batteries')
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, 'claude-statusline.json')
    # Sessions redraw at the same time; the lock keeps one from undoing another's merge
    with open(os.path.join(directory, '.claude-statusline.lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(path) as f:
                old = json.load(f).get('rate_limits') or {}
        except (OSError, ValueError, AttributeError):
            old = {}
        now = time.time()
        merged, stale = merge(limits, old, now)
        if stale and merged == old:
            return  # Nothing newer than what is stored
        # Replaced atomically: the extension reads this file as soon as it changes
        fd, tmp = tempfile.mkstemp(dir=directory, prefix='.claude-statusline.')
        with os.fdopen(fd, 'w') as f:
            json.dump({'ts': now, 'rate_limits': merged}, f)
        os.replace(tmp, path)


if __name__ == '__main__':
    try:
        main()
    except OSError:
        pass  # A status line must never break the CLI
