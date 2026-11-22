import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SERVICES = [['claude', 'Claude'], ['codex', 'Codex']];
const WINDOWS = [['five-hour', '5-hour window'], ['weekly', 'Weekly window']];

export default class TokenBatteriesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const bar = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(bar);
        const onlyRunning = new Adw.SwitchRow({
            title: 'Only while a session runs',
            subtitle: 'Show a service only while claude or codex is running; ' +
                'needs the hooks from install-hooks.py',
        });
        settings.bind('only-while-running', onlyRunning, 'active', Gio.SettingsBindFlags.DEFAULT);
        bar.add(onlyRunning);

        for (const [id, name] of SERVICES) {
            const group = new Adw.PreferencesGroup({
                title: name,
                description: 'Batteries shown in the top bar',
            });
            page.add(group);
            for (const [windowId, windowName] of WINDOWS) {
                const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
                const row = new Adw.ActionRow({title: windowName, activatable_widget: check});
                row.add_prefix(check);
                settings.bind(`${id}-${windowId}`, check, 'active', Gio.SettingsBindFlags.DEFAULT);
                group.add(row);
            }
        }
    }
}
