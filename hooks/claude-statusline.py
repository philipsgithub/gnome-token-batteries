#!/usr/bin/env python3
"""Claude Code status line command that saves the rate limits for the extension.

Claude Code passes `rate_limits` to its status line command on stdin. Only that part
is written to ~/.cache/token-batteries/claude-statusline.json. Prints nothing, so it can be
the whole status line or be called from an existing status line script.
"""
import json
import os
import sys
import tempfile
import time


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
    # Replaced atomically: the extension reads this file as soon as it changes
    fd, tmp = tempfile.mkstemp(dir=directory, prefix='.claude-statusline.')
    with os.fdopen(fd, 'w') as f:
        json.dump({'ts': time.time(), 'rate_limits': limits}, f)
    os.replace(tmp, os.path.join(directory, 'claude-statusline.json'))


if __name__ == '__main__':
    try:
        main()
    except OSError:
        pass  # A status line must never break the CLI
