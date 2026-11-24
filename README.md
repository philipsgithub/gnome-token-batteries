# Token Batteries

A GNOME Shell extension that shows how much of your Claude and Codex subscription limits
is left, as battery icons in the top bar. Each service has a 5-hour and a weekly battery.

- Shows the **remaining** quota, and when a 5-hour limit is empty, the time until it
  resets (`2h 16m`, `45m`).
- Appears only while a `claude` or `codex` session runs, and hides otherwise (optional).
- Uses the logins your CLIs already have. There are no API keys to enter.
- Event driven: it reacts to file changes through inotify instead of polling.

This is an unofficial project, not affiliated with Anthropic or OpenAI.

## Requirements

- GNOME Shell 46 to 50
- `python3` and `git`
- At least one of:
  - [Claude Code](https://code.claude.com/docs) logged in with a Claude subscription
  - [Codex CLI](https://github.com/openai/codex) logged in with a ChatGPT account

Accounts that use a pay-as-you-go API key have no 5-hour or weekly limits to show.

## Install

```sh
UUID=token-batteries@gnome-token-batteries
git clone <url-of-this-repository> ~/.local/share/gnome-shell/extensions/$UUID
~/.local/share/gnome-shell/extensions/$UUID/install-hooks.py
```

Log out and back in so GNOME Shell finds the new extension, then enable it:

```sh
gnome-extensions enable token-batteries@gnome-token-batteries
```

## Connect your accounts

The extension has no account settings of its own. It shows whichever account `claude` and
`codex` are logged in to for your desktop user.

### Claude

1. Log in, if you have not yet: run `claude` and use `/login`, choosing your subscription.
2. `install-hooks.py` has added the session hooks to `~/.claude/settings.json`. If you had
   no status line, it also set one that saves your limits.
3. Start `claude` and send a message. Claude Code reports the limits after a response, and
   the batteries fill in.

#### Keep your own status line

If you already use a status line, `install-hooks.py` leaves it alone and prints the command
to add. Claude Code passes its data on stdin, so read it once and hand a copy over:

```sh
#!/bin/sh
input=$(cat)
printf '%s' "$input" | python3 ~/.local/share/gnome-shell/extensions/token-batteries@gnome-token-batteries/hooks/claude-statusline.py

# ... the rest of your status line, using "$input"
```

### Codex

1. Log in, if you have not yet: `codex login`, choosing your ChatGPT account.
2. `install-hooks.py` has added the hooks to `~/.codex/hooks.json`.
3. Start `codex` and **accept the prompt to trust the new hooks**. Until then Codex does not
   run them. `codex features list` should show `hooks` as `true`.
4. Send a message. The batteries update when the turn ends.

### Switching accounts

Log in to the other account with the CLI (`/login` in Claude Code, `codex login`). The
batteries follow with the next response. The extension reads `~/.claude` and `~/.codex`, so
a custom `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is not supported.

## Using it

Click the indicator to see the exact values and reset times. These options are in the menu
and in the preferences (`gnome-extensions prefs token-batteries@gnome-token-batteries`):

- **Show in top bar**: choose which of the four batteries appear.
- **Only while a session runs** (on by default): turn it off to always show the batteries.

A dimmed battery means its data is over an hour old or the last request failed.

## How it works

- **Claude**: Claude Code passes `rate_limits` to its status line command, which saves them
  to `~/.cache/token-batteries/claude-statusline.json`.
- **Codex**: Codex logs the limits as `token_count` events in `~/.codex/sessions`. Its `Stop`
  hook tells the extension when to read the newest one.
- **Running sessions**: `SessionStart` and `SessionEnd` hooks keep one empty file per session
  in `~/.cache/token-batteries/running/`. Sessions that already run when the extension starts are
  found once in `/proc`. While sessions run, a 60 s check drops those that were killed.
- **API fallback**: the usage endpoints are asked when you open the menu and the data is
  Codex runs `SessionStart` with the first prompt, so its batteries appear then. Its shared
  background server sends no `SessionEnd` when a terminal closes, so they hide at the next
  check after the last Codex terminal is gone.
  older than 20 s, or every 15 minutes for a service in the bar without newer local data.
  After HTTP 429 a service backs off for 5 minutes, doubling up to 1 hour.

## Privacy and security

- Nothing is sent anywhere except the two usage requests below. There is no telemetry.
- Your login tokens are read from `~/.claude/.credentials.json` and `~/.codex/auth.json`, and
  are sent only to the service they belong to:
  - `https://api.anthropic.com/api/oauth/usage`
  - `https://chatgpt.com/backend-api/wham/usage`
- Tokens are never stored, logged or refreshed by the extension.
- `~/.cache/token-batteries/` holds only usage percentages, reset times and session marks.
- Codex session logs contain your conversations. The extension reads only the rate limit
  events from them, and that data stays on your machine.

These usage endpoints are undocumented and may change without notice. Local data keeps working
if they do.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No indicator | Start `claude` or `codex`, or turn off "Only while a session runs". Check with `gnome-extensions info token-batteries@gnome-token-batteries`. |
| Extension not found | Log out and back in once after cloning. |
| `?` on a battery | No data yet: send a message in that CLI. |
| "login expired" | Use that CLI once. Only the CLIs refresh their tokens. |
| Codex batteries do not appear | Accept the hook trust prompt in `codex`. |
| Claude values never change | Check that your status line passes its input to `claude-statusline.py`. |

Extension errors are logged with the prefix `token-batteries`:

```sh
journalctl -b -o cat /usr/bin/gnome-shell | grep token-batteries
```

## Uninstall

```sh
UUID=token-batteries@gnome-token-batteries
~/.local/share/gnome-shell/extensions/$UUID/install-hooks.py --remove
gnome-extensions disable $UUID
rm -rf ~/.local/share/gnome-shell/extensions/$UUID ~/.cache/token-batteries
dconf reset -f /org/gnome/shell/extensions/token-batteries/
```

`install-hooks.py` keeps the previous version of each file it changes as `*.bak-token-batteries`.

## Development

- After editing `schemas/*.gschema.xml`, run `glib-compile-schemas schemas`.
- `make-icons.py` regenerates `icons/`.
- GNOME Shell caches extension code, so changes need a log out and back in.

## License

The code is licensed under [GPL-2.0-or-later](LICENSE). The icons are adapted from the
[Yaru](https://github.com/ubuntu/yaru) icon theme and licensed under CC BY-SA 4.0. See
[NOTICE](NOTICE).
