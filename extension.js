import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

// Both CLIs record the limits locally with every request they make, so the local
// files are the main source. They are read when inotify reports a change (Claude's
// status line file, the Codex turn mark written by hooks/session-hook.sh) and on
// the slow timer below as a safety net.
//
// The slow timer only runs while a CLI session is marked as running (or when the
// batteries are set to always show). It re-checks that the marked sessions are still
// alive, since a killed CLI never runs its SessionEnd hook, and reads the local data.
const SLOW_TICK_SECONDS = 60;
// File events come in bursts (write, rename, our own marker cleanup); handled once per burst
const DEBOUNCE_MS = 300;
// The usage APIs rate-limit (Anthropic's answered 429 at a 90 s poll), so they are
// only asked when no newer local data has shown up for this long
const API_POLL_SECONDS = 900;
// Opening the menu asks the API for every service whose newest data and last
// request are older than this, even one backing off after a rate limit
const STALE_SECONDS = 20;
// Batteries are dimmed when their data is older than this or the last request failed
const DIM_AFTER_SECONDS = 3600;
// After HTTP 429, a service's API is left alone for this long, doubling up to the max
const BACKOFF_MIN_SECONDS = 300;
const BACKOFF_MAX_SECONDS = 3600;

const HOME = GLib.get_home_dir();
const CACHE_DIR = `${GLib.get_user_cache_dir()}/token-batteries`;
const CACHE_PATH = `${CACHE_DIR}/state.json`;
// One empty file per running CLI session, named <service id>-<pid> (see hooks/session-hook.sh)
const RUNNING_DIR = `${CACHE_DIR}/running`;

class AuthError extends Error {}

class RateLimitError extends Error {
    constructor(retryAfter) {
        super('HTTP 429');
        this.retryAfter = retryAfter;
    }
}

const SERVICES = [
    {
        // Also the CLI's process name (/proc/<pid>/comm)
        id: 'claude',
        name: 'Claude',
        // Changes in CACHE_DIR to this file mean new local data
        trigger: 'claude-statusline.json',
        localName: 'Claude Code',
        loginHint: 'login expired — use claude once to refresh it',
        async fetch(getJson) {
            const creds = await readJson(`${HOME}/.claude/.credentials.json`);
            const data = await getJson('https://api.anthropic.com/api/oauth/usage', {
                'Authorization': `Bearer ${creds.claudeAiOauth.accessToken}`,
                'anthropic-beta': 'oauth-2025-04-20',
            });
            const win = w => w && {
                used: w.utilization,
                // null when no window is running (nothing used since the last reset)
                resetsAt: w.resets_at
                    ? GLib.DateTime.new_from_iso8601(w.resets_at, null)?.to_unix() ?? null
                    : null,
            };
            return [win(data.five_hour), win(data.seven_day)];
        },
        // Written by hooks/claude-statusline.py from Claude Code's status line input
        async readLocal() {
            let saved;
            try {
                saved = await readJson(`${CACHE_DIR}/claude-statusline.json`);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    return null;
                throw e;
            }
            // A window is left out while it is not running, i.e. nothing is used
            const win = w => ({used: w?.used_percentage ?? 0, resetsAt: w?.resets_at ?? null});
            const limits = saved.rate_limits;
            return {fetchedAt: saved.ts, windows: [win(limits.five_hour), win(limits.seven_day)]};
        },
    },
    {
        // The native binary; the codex command on PATH is a Node wrapper named node
        id: 'codex',
        name: 'Codex',
        // Touched by the Stop hook after every turn
        trigger: 'codex-turn',
        localName: 'Codex',
        loginHint: 'login expired — use codex once to refresh it',
        async fetch(getJson) {
            const {tokens} = await readJson(`${HOME}/.codex/auth.json`);
            const data = await getJson('https://chatgpt.com/backend-api/wham/usage', {
                'Authorization': `Bearer ${tokens.access_token}`,
                'ChatGPT-Account-Id': tokens.account_id,
            });
            const win = w => w && {used: w.used_percent, resetsAt: w.reset_at};
            return [win(data.rate_limit?.primary_window), win(data.rate_limit?.secondary_window)];
        },
        // Codex logs a token_count event with the limits into its session rollout files
        async readLocal() {
            const files = await listFiles(Gio.File.new_for_path(`${HOME}/.codex/sessions`), 3);
            files.sort((a, b) => b.mtime - a.mtime);
            // Resumed sessions append to old files, so go by mtime, not by name
            const key = files.slice(0, ROLLOUTS_CHECKED).map(f => `${f.file.get_path()}:${f.mtime}`).join();
            if (key === this._lastKey)
                return this._last;
            let newest = null;
            for (const {file, size} of files.slice(0, ROLLOUTS_CHECKED)) {
                const event = lastRateLimits(await readTail(file, size, ROLLOUT_TAIL_BYTES));
                if (event && (!newest || event.fetchedAt > newest.fetchedAt))
                    newest = event;
            }
            this._lastKey = key;
            this._last = newest;
            return newest;
        },
    },
];

const ROLLOUTS_CHECKED = 3;
const ROLLOUT_TAIL_BYTES = 256 * 1024;

const WINDOW_NAMES = ['5h', 'Week'];
// Settings key per battery: `${service.id}-${WINDOW_KEYS[i]}`, true when shown in the bar
const WINDOW_KEYS = ['five-hour', 'weekly'];
const WINDOW_TITLES = ['5-hour', 'weekly'];
// Plain text rows; reactive: false would render them greyed out
const INFO_ITEM = {activate: false, hover: false, can_focus: false};
// Batteries showing old or no data
const DIM_OPACITY = 110;

// Names and owners of the entries of dir
async function listDir(path, attributes = 'standard::name') {
    const found = [];
    const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
        attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, null);
    for (;;) {
        const infos = await enumerator.next_files_async(200, GLib.PRIORITY_LOW, null);
        if (infos.length === 0)
            break;
        found.push(...infos);
    }
    enumerator.close(null);
    return found;
}

// A process's name (comm), null once it is gone or a zombie waiting to be reaped
async function processName(pid) {
    try {
        const [bytes] = await Gio.File.new_for_path(`/proc/${pid}/stat`).load_contents_async(null);
        // "<pid> (<comm>) <state> ...", comm may itself contain spaces and parentheses
        const stat = new TextDecoder().decode(bytes);
        const end = stat.lastIndexOf(')');
        const state = stat[end + 2];
        return state === 'Z' || state === 'X' ? null : stat.slice(stat.indexOf('(') + 1, end);
    } catch {
        return null;
    }
}

// The pids of this user's processes
async function ownPids() {
    const uid = new Gio.Credentials().get_unix_user();
    return (await listDir('/proc', 'standard::name,unix::uid'))
        .filter(info => /^\d+$/.test(info.get_name()) &&
            info.get_attribute_uint32('unix::uid') === uid)
        .map(info => info.get_name());
}

// Codex's shared background server (codex app-server) runs the hooks of all its
// terminals and outlives them without a SessionEnd, so a mark on it says nothing
// about whether a session is still open
async function isCodexServer(pid) {
    try {
        const [bytes] = await Gio.File.new_for_path(`/proc/${pid}/cmdline`).load_contents_async(null);
        return new TextDecoder().decode(bytes).split('\0')[1] === 'app-server';
    } catch {
        return false;
    }
}

// Whether a Codex process other than the background server runs
async function codexClientRuns() {
    const pids = await ownPids();
    const names = await Promise.all(pids.map(processName));
    const codex = pids.filter((_pid, i) => names[i] === 'codex');
    return (await Promise.all(codex.map(isCodexServer))).includes(false);
}

async function readJson(path) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

// *.jsonl files below dir with their mtime and size, descending depth levels
async function listFiles(dir, depth) {
    const found = [];
    let enumerator;
    try {
        enumerator = await dir.enumerate_children_async(
            'standard::name,standard::type,standard::size,time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return found;
        throw e;
    }
    for (;;) {
        const infos = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, null);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            const child = dir.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                if (depth > 0)
                    found.push(...await listFiles(child, depth - 1));
            } else if (info.get_name().endsWith('.jsonl')) {
                const time = info.get_modification_date_time();
                found.push({
                    file: child,
                    size: info.get_size(),
                    mtime: time.to_unix() + time.get_microsecond() / 1e6,
                });
            }
        }
    }
    enumerator.close(null);
    return found;
}

async function readTail(file, size, maxBytes) {
    const stream = await file.read_async(GLib.PRIORITY_LOW, null);
    try {
        if (size > maxBytes)
            stream.seek(size - maxBytes, GLib.SeekType.SET, null);
        const chunks = [];
        let total = 0;
        while (total < maxBytes) {
            const bytes = await stream.read_bytes_async(maxBytes - total, GLib.PRIORITY_LOW, null);
            if (bytes.get_size() === 0)
                break;
            chunks.push(bytes.toArray());
            total += bytes.get_size();
        }
        const all = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
        }
        return new TextDecoder().decode(all);
    } finally {
        stream.close(null);
    }
}

// Newest Codex token_count event in a chunk of a rollout file (its first line may be cut off)
function lastRateLimits(text) {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits":{'))
            continue;
        let event;
        try {
            event = JSON.parse(lines[i]);
        } catch {
            continue;
        }
        const limits = event.payload?.rate_limits;
        if (!limits?.primary || (limits.limit_id ?? 'codex') !== 'codex')
            continue;
        const win = w => w && {used: w.used_percent, resetsAt: w.resets_at ?? null};
        return {
            fetchedAt: GLib.DateTime.new_from_iso8601(event.timestamp, null)?.to_unix() ?? 0,
            windows: [win(limits.primary), win(limits.secondary)],
        };
    }
    return null;
}

function formatReset(unix) {
    if (unix === null || unix === undefined)
        return '';
    const secs = unix - GLib.get_real_time() / 1e6;
    if (secs <= 0)
        return ' · resetting now';
    // Reset times jitter by a few seconds between polls; round to the minute
    const time = GLib.DateTime.new_from_unix_local(Math.round(unix / 60) * 60);
    if (secs < 24 * 3600) {
        const left = secs < 3600 ? `${Math.ceil(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
        return ` · resets ${time.format('%H:%M')} (${left})`;
    }
    return ` · resets ${time.format('%a %H:%M')}`;
}

// Rounded up, so it never reads 0m before the reset has happened
function formatCountdown(secs) {
    const minutes = Math.ceil(secs / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h)
        return `${m}m`;
    return m ? `${h}h ${m}m` : `${h}h`;
}

function formatTime(unix) {
    const time = GLib.DateTime.new_from_unix_local(Math.floor(unix));
    const now = GLib.DateTime.new_now_local();
    if (time.format('%F') === now.format('%F'))
        return time.format('%H:%M');
    if (time.format('%F') === now.add_days(-1).format('%F'))
        return time.format('yesterday %H:%M');
    return time.format('%a %e %b %H:%M');
}

// Icons are generated by make-icons.py in Yaru's battery style, one per 10% step
const Battery = GObject.registerClass(
class Battery extends St.Icon {
    _init(iconDir, name) {
        super._init({style_class: 'system-status-icon'});
        this._icons = Array.from({length: 11}, (_, i) => Gio.FileIcon.new(
            iconDir.get_child(`${name}-${i * 10}-symbolic.svg`)));
        this.setLevel(null);
    }

    setLevel(level) {
        this.gicon = this._icons[level === null ? 0 : Math.round(level / 10)];
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Token Batteries');
        const iconDir = Gio.File.new_for_path(extension.path).get_child('icons');
        this._settings = extension.getSettings();

        this._session = new Soup.Session({user_agent: 'token-batteries-gnome-extension', timeout: 20});
        this._cancellable = new Gio.Cancellable();
        this._cacheFile = Gio.File.new_for_path(CACHE_PATH);

        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box token-batteries-box'});
        this.add_child(box);

        // Shown instead of the batteries when all are unchecked, so the menu stays reachable
        this._placeholder = new Battery(iconDir, 'claude');
        this._placeholder.opacity = DIM_OPACITY;
        box.add_child(this._placeholder);

        this._rows = SERVICES.map((service, i) => {
            const gap = i > 0 ? new St.Widget({style_class: 'token-batteries-gap'}) : null;
            if (gap)
                box.add_child(gap);
            const cells = WINDOW_NAMES.map((_name, j) => {
                const battery = new Battery(iconDir, service.id);
                const label = new St.Label({
                    text: '…',
                    style_class: 'token-batteries-percent',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                box.add_child(battery);
                box.add_child(label);
                return {battery, label, key: `${service.id}-${WINDOW_KEYS[j]}`};
            });

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(service.name));
            const lines = WINDOW_NAMES.map(name => {
                const item = new PopupMenu.PopupMenuItem(`${name}: …`, INFO_ITEM);
                this.menu.addMenuItem(item);
                return item;
            });
            const status = new PopupMenu.PopupMenuItem('', INFO_ITEM);
            status.visible = false;
            this.menu.addMenuItem(status);

            // data: newest {fetchedAt, windows, source} from the CLI, the API or the cache
            // error: why the latest API request failed, cleared by newer data
            // backoff/retryAt: rate-limit pause, automatic API requests skip the row until retryAt
            // running: a live session of this CLI is marked; shown: a battery is in the bar
            return {
                service, gap, cells, lines, status,
                data: null, error: null, busy: false, localBusy: false,
                backoff: 0, retryAt: 0, lastAttempt: 0,
                running: false, shown: false,
            };
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Refresh now', () => this._fetchApi(this._rows, true));

        // Checkboxes for the batteries in the bar; same keys as the preferences window
        const shown = new PopupMenu.PopupSubMenuMenuItem('Show in top bar');
        this.menu.addMenuItem(shown);
        this._checks = this._rows.flatMap(row => row.cells.map((cell, j) => {
            const item = new PopupMenu.PopupMenuItem(`${row.service.name} ${WINDOW_TITLES[j]}`);
            // Toggle in place instead of closing the menu, so several can be changed at once
            item.activate = () => this._settings.set_boolean(cell.key, !this._settings.get_boolean(cell.key));
            shown.menu.addMenuItem(item);
            return {item, key: cell.key};
        }));
        this._checks.push({item: this._toggleItem('Only while a session runs', 'only-while-running'),
            key: 'only-while-running'});
        this.menu.addAction('Preferences', () => extension.openPreferences());

        this._markerCount = 0;
        this._pending = new Set();
        this._debounceId = 0;
        this._timeoutId = 0;
        this._monitors = [];
        this._settingsId = this._settings.connect('changed', () => {
            if (this._updateShown())
                this._tick();
        });
        // Every row starts as not running, so the bar stays empty until the first scan
        this._updateShown();

        this.menu.connect('open-state-changed', async (_menu, open) => {
            if (!open)
                return;
            await Promise.all(this._rows.map(row => this._readLocal(row)));
            if (this._cancellable.is_cancelled())
                return;
            const now = GLib.get_real_time() / 1e6;
            const due = this._rows.filter(row =>
                now - Math.max(row.data?.fetchedAt ?? 0, row.lastAttempt) > STALE_SECONDS);
            if (due.length > 0)
                this._fetchApi(due, true);
        });

        this._start();
    }

    // A menu item that flips a boolean setting in place, like the battery checkboxes
    _toggleItem(text, key) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.activate = () => this._settings.set_boolean(key, !this._settings.get_boolean(key));
        this.menu.addMenuItem(item);
        return item;
    }

    // Shows the checked batteries (of running CLIs only, if so set) and hides the whole
    // indicator when none is left. Returns true when a service has newly come into the bar.
    _updateShown() {
        const onlyRunning = this._settings.get_boolean('only-while-running');
        let anyChecked = false;
        let anyBefore = false;
        let added = false;
        for (const row of this._rows) {
            let any = false;
            for (const {battery, label, key} of row.cells) {
                const checked = this._settings.get_boolean(key);
                const on = checked && (!onlyRunning || row.running);
                battery.visible = label.visible = on;
                anyChecked ||= checked;
                any ||= on;
            }
            if (row.gap)
                row.gap.visible = any && anyBefore;
            anyBefore ||= any;
            added ||= any && !row.shown;
            row.shown = any;
        }
        // With everything unchecked the placeholder keeps the menu reachable
        this._placeholder.visible = !anyChecked;
        const visible = anyBefore || !anyChecked;
        if (!visible)
            this.menu.close();
        this.container.visible = visible;
        for (const {item, key} of this._checks) {
            item.setOrnament(this._settings.get_boolean(key)
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        this._updateTimer(onlyRunning);
        return added;
    }

    // The slow timer is only needed while sessions are marked or the bar always shows
    _updateTimer(onlyRunning) {
        const need = this._markerCount > 0 || !onlyRunning;
        if (need && !this._timeoutId) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SLOW_TICK_SECONDS, () => {
                this._slowTick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!need && this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    async _start() {
        await this._loadCache();
        try {
            GLib.mkdir_with_parents(RUNNING_DIR, 0o700);
            await this._adoptRunning();
        } catch (e) {
            console.warn(`token-batteries: looking for running sessions: ${e.message}`);
        }
        if (this._cancellable.is_cancelled())
            return;
        this._watch();
        await this._scanMarkers();
        if (!this._cancellable.is_cancelled())
            await this._tick();
    }

    // Marks the sessions that already run, started before the hooks were installed or
    // before the extension was enabled. Done once; after that the hooks keep the marks.
    async _adoptRunning() {
        const ids = new Set(this._rows.map(row => row.service.id));
        const pids = await ownPids();
        const names = await Promise.all(pids.map(processName));
        pids.forEach((pid, i) => {
            if (ids.has(names[i]))
                GLib.file_set_contents(`${RUNNING_DIR}/${names[i]}-${pid}`, '');
        });
    }

    // inotify on the session marks and on the files that announce new local data
    _watch() {
        const watch = (path, onChange) => {
            const monitor = Gio.File.new_for_path(path).monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', (_monitor, file, other) => onChange(file, other));
            this._monitors.push(monitor);
        };
        watch(RUNNING_DIR, () => this._queue('markers'));
        watch(CACHE_DIR, (file, other) => {
            const names = [file?.get_basename(), other?.get_basename()];
            for (const row of this._rows) {
                if (names.includes(row.service.trigger))
                    this._queue(row);
            }
        });
    }

    // job: 'markers' to rescan the sessions, or a row whose local data changed
    _queue(job) {
        this._pending.add(job);
        if (this._debounceId)
            return;
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            const jobs = this._pending;
            this._pending = new Set();
            if (jobs.delete('markers'))
                this._scanMarkers();
            for (const row of jobs)
                this._readLocal(row);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Counts the live marked sessions per CLI and deletes the marks of dead ones.
    // A mark counts only while its pid still runs under the CLI's name (pids get reused).
    async _scanMarkers() {
        if (this._scanning) {
            this._rescan = true;
            return;
        }
        this._scanning = true;
        try {
            const marks = (await listDir(RUNNING_DIR)).map(info => info.get_name());
            let clientRuns = null;
            const alive = await Promise.all(marks.map(async name => {
                const match = /^([a-z]+)-(\d+)$/.exec(name);
                if (match && await processName(match[2]) === match[1]) {
                    if (match[1] !== 'codex' || !await isCodexServer(match[2]))
                        return match[1];
                    clientRuns ??= codexClientRuns();
                    if (await clientRuns)
                        return match[1];
                }
                Gio.File.new_for_path(`${RUNNING_DIR}/${name}`)
                    .delete_async(GLib.PRIORITY_LOW, null).catch(() => {});
                return null;
            }));
            if (this._cancellable.is_cancelled())
                return;
            this._markerCount = alive.filter(id => id).length;
            for (const row of this._rows)
                row.running = alive.includes(row.service.id);
            if (this._updateShown())
                this._tick();
        } catch (e) {
            console.warn(`token-batteries: reading session marks: ${e.message}`);
        } finally {
            this._scanning = false;
            if (this._rescan && !this._cancellable.is_cancelled()) {
                this._rescan = false;
                this._scanMarkers();
            }
        }
    }

    async _slowTick() {
        if (this._markerCount > 0)
            await this._scanMarkers();
        if (!this._cancellable.is_cancelled())
            await this._tick();
    }

    // Reads the local data of the services in the bar, then asks the API for those
    // that have none recent
    async _tick() {
        const rows = this._rows.filter(row => row.shown);
        await Promise.all(rows.map(row => this._readLocal(row)));
        if (this._cancellable.is_cancelled())
            return;
        // Without new data the countdowns and reset times still have to move on
        rows.filter(row => row.data).forEach(row => this._render(row));
        const now = GLib.get_real_time() / 1e6;
        const due = rows.filter(row =>
            now - Math.max(row.data?.fetchedAt ?? 0, row.lastAttempt) > API_POLL_SECONDS);
        if (due.length > 0)
            await this._fetchApi(due, false);
    }

    async _readLocal(row) {
        if (row.localBusy)
            return;
        row.localBusy = true;
        try {
            const data = await row.service.readLocal();
            if (data && !this._cancellable.is_cancelled())
                this._accept(row, data, row.service.localName);
        } catch (e) {
            console.warn(`token-batteries: ${row.service.name} local data: ${e.message}`);
        } finally {
            row.localBusy = false;
        }
    }

    // Takes data if it is newer than what the row shows
    _accept(row, data, source) {
        if (row.data && data.fetchedAt <= row.data.fetchedAt)
            return;
        row.data = {...data, source};
        row.error = null;
        this._render(row);
        this._saveCache();
    }

    async _loadCache() {
        let saved;
        try {
            saved = await readJson(CACHE_PATH);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`token-batteries: reading cache: ${e.message}`);
            return;
        }
        if (this._cancellable.is_cancelled())
            return;
        for (const row of this._rows) {
            const data = saved[row.service.name];
            if (row.data || !Array.isArray(data?.windows))
                continue;
            row.data = data;
            this._render(row);
        }
    }

    async _saveCache() {
        const state = Object.fromEntries(
            this._rows.filter(row => row.data).map(row => [row.service.name, row.data]));
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o700);
            await this._cacheFile.replace_contents_bytes_async(
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(state))),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                console.warn(`token-batteries: writing cache: ${e.message}`);
        }
    }

    async _getJson(url, headers) {
        const msg = Soup.Message.new('GET', url);
        for (const [key, value] of Object.entries(headers))
            msg.request_headers.append(key, value);
        const bytes = await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        // Not get_status(): Soup.Status has no member for some codes (e.g. 429) and throws
        const status = msg.status_code;
        if (status === 401 || status === 403)
            throw new AuthError(`HTTP ${status}`);
        if (status === 429)
            throw new RateLimitError(Number(msg.response_headers.get_one('Retry-After')) || 0);
        if (status !== 200)
            throw new Error(`HTTP ${status}`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    // force: also ask for rows that are backing off after a rate limit
    async _fetchApi(rows, force) {
        await Promise.all(rows.map(row => this._fetchApiRow(row, force)));
    }

    async _fetchApiRow(row, force) {
        const now = GLib.get_real_time() / 1e6;
        if (row.busy || (!force && now < row.retryAt))
            return;
        row.busy = true;
        row.lastAttempt = now;
        try {
            const windows = await row.service.fetch((url, headers) => this._getJson(url, headers));
            row.backoff = row.retryAt = 0;
            this._accept(row, {fetchedAt: GLib.get_real_time() / 1e6, windows}, 'API');
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            if (e instanceof RateLimitError) {
                row.backoff = Math.min(Math.max(2 * row.backoff, BACKOFF_MIN_SECONDS, e.retryAfter),
                    BACKOFF_MAX_SECONDS);
                row.retryAt = GLib.get_real_time() / 1e6 + row.backoff;
                row.error = `API rate limited — next try ${formatTime(row.retryAt)}`;
            } else if (e instanceof AuthError) {
                row.error = row.service.loginHint;
            } else if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                row.error = 'not logged in';
            } else {
                row.error = e.message;
            }
            console.warn(`token-batteries: ${row.service.name}: ${e.message}`);
            this._render(row);
        } finally {
            row.busy = false;
        }
    }

    _render({cells, lines, status, data, error}) {
        const now = GLib.get_real_time() / 1e6;
        const dim = error !== null || !data || now - data.fetchedAt > DIM_AFTER_SECONDS;

        cells.forEach(({battery, label}, i) => {
            const win = data?.windows[i];
            if (!win || typeof win.used !== 'number') {
                battery.setLevel(null);
                battery.opacity = label.opacity = DIM_OPACITY;
                label.text = '?';
                lines[i].label.text = `${WINDOW_NAMES[i]}: ${error ?? 'no data'}`;
                return;
            }
            // Once the reset time has passed the window is full again, however old the data is
            const hasReset = typeof win.resetsAt === 'number' && win.resetsAt <= now;
            const left = hasReset ? 100 : Math.max(0, Math.min(100, Math.round(100 - win.used)));
            battery.setLevel(left);
            battery.opacity = label.opacity = dim ? DIM_OPACITY : 255;
            // An empty 5-hour window counts down to its reset instead of showing 0%
            const countdown = i === 0 && left === 0 && typeof win.resetsAt === 'number';
            label.text = countdown ? formatCountdown(win.resetsAt - now) : `${left}%`;
            lines[i].label.text =
                `${WINDOW_NAMES[i]}: ${left}% left${hasReset ? '' : formatReset(win.resetsAt)}`;
        });

        status.visible = data !== null;
        if (status.visible) {
            const via = data.source ? `via ${data.source} ` : '';
            status.label.text =
                `${via}at ${formatTime(data.fetchedAt)}${error ? ` · ${error}` : ''}`;
        }
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
        for (const id of ['_timeoutId', '_debounceId']) {
            if (this[id]) {
                GLib.Source.remove(this[id]);
                this[id] = 0;
            }
        }
        this._cancellable.cancel();
        this._session.abort();
        super.destroy();
    }
});

export default class TokenBatteriesExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
