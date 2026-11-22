#!/usr/bin/env python3
"""Connects Claude Code and Codex to the extension, next to existing hooks.

Adds the session hooks, and for Claude Code the status line command unless one is
already set. Safe to run again: entries that are already there are left alone.
Each changed file is backed up as <file>.bak-token-batteries first.
  --remove   takes the entries out again
"""
import json
import os
import shlex
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, 'hooks', 'session-hook.sh')
STATUSLINE = os.path.join(HERE, 'hooks', 'claude-statusline.py')
HOME = os.path.expanduser('~')
TARGETS = [
    (os.path.join(HOME, '.claude', 'settings.json'), 'claude',
     {'SessionStart': 'start', 'SessionEnd': 'end'}),
    (os.path.join(HOME, '.codex', 'hooks.json'), 'codex',
     {'SessionStart': 'start', 'SessionEnd': 'end', 'Stop': 'turn'}),
]


def ours(group):
    return any(HOOK in h.get('command', '') for h in group.get('hooks', []))


def update_statusline(data, remove):
    """Returns True if the settings changed. An existing status line is never replaced."""
    current = data.get('statusLine')
    mine = bool(current) and STATUSLINE in current.get('command', '')
    if remove:
        if mine:
            del data['statusLine']
        return mine
    if not current:
        data['statusLine'] = {'type': 'command', 'command': f'python3 {shlex.quote(STATUSLINE)}'}
        return True
    if not mine:
        print('Claude Code already has a status line. Unless it already does, make it pass its '
              f'input to:\n  python3 {shlex.quote(STATUSLINE)}\n(see "Keep your own status line" '
              'in the README)')
    return False


def update(path, cli, events, remove):
    if not os.path.exists(os.path.dirname(path)):
        print(f'skip {path}: {cli} is not set up')
        return
    data = {}
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
    hooks = data.setdefault('hooks', {})
    changed = False
    for event, arg in events.items():
        groups = hooks.setdefault(event, [])
        mine = [g for g in groups if ours(g)]
        if remove and mine:
            hooks[event] = [g for g in groups if not ours(g)]
            changed = True
        elif not remove and not mine:
            # Appended, so the index-based trust keys Codex keeps for the others stay valid
            groups.append({'hooks': [{
                'type': 'command',
                'command': f'sh {shlex.quote(HOOK)} {cli} {arg}',
                'timeout': 5,
            }]})
            changed = True
        if not hooks[event]:
            del hooks[event]
    if not hooks:
        del data['hooks']
    if cli == 'claude' and update_statusline(data, remove):
        changed = True
    if not changed:
        print(f'{path}: nothing to do')
        return
    if os.path.exists(path):
        shutil.copy2(path, path + '.bak-token-batteries')
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.token-batteries-')
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    os.replace(tmp, path)
    print(f'{path}: {"removed" if remove else "added"} the token-batteries entries')


if __name__ == '__main__':
    remove = '--remove' in sys.argv[1:]
    for target in TARGETS:
        update(*target, remove)
