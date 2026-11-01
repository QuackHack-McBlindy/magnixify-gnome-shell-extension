import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

let Atspi = null;
try {
    try { imports.gi.versions.Atspi = '2.0'; } catch (_) { }
    Atspi = imports.gi.Atspi;
} catch (e) {
    log('magnixify: Atspi unavailable, focus tracking disabled: ' + e.message);
}

const DBUS_IFACE_NAME = 'org.gnome.Shell.Extensions.Magnixify';
const DBUS_OBJECT_PATH = '/org/gnome/Shell/Extensions/Magnixify';
const DBUS_IFACE_XML = `
<node>
  <interface name="${DBUS_IFACE_NAME}">
    <method name="ZoomIn"/>
    <method name="ZoomOut"/>
    <method name="Toggle"/>
    <method name="SetZoom">
      <arg type="d" direction="in"/>
    </method>
    <method name="GetZoom">
      <arg type="d" direction="out"/>
    </method>
  </interface>
</node>`;

const ZOOM_MIN = 1.0;
const ZOOM_MAX = 8.0;
const ZOOM_STEP = 0.50;
const FOLLOW_TICK_MS = 16;
const POINTER_STOP_DELAY_MS = 450;
const CARET_POLL_MS = 40;
const FOLLOW_WINDOW_MS = 250;
const CARET_EPSILON = 2;

const PEEK_WATCH_MS = 30;

const POST_MODAL_GRACE_MS = 1500;

function plainLabel(text, style = '') {
    const lbl = new St.Label({ text: String(text), style });
    if (lbl.clutter_text) lbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return lbl;
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function monitorIndexForPoint(x, y) {
    const monitors = Main.layoutManager.monitors;
    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        if (x >= m.x && x < m.x + m.width &&
            y >= m.y && y < m.y + m.height)
            return i;
    }
    return Main.layoutManager.primaryIndex;
}

const MagnixifyIndicator = GObject.registerClass(
class MagnixifyIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('magnixify'));

        this._zoomLevel       = 2.5;
        this._zoomDurationMs  = 150;
        this._followSmoothing = 0.16;

        this._followMouseEnabled = true;
        this._followFocusEnabled = true;

        this._peekOnOverview = false;

        this._autoStart = true;
        this._loadPrefs();

        this._state          = 'IDLE';
        this._container      = null;
        this._zoomActor      = null;
        this._clone          = null;
        this._mon            = null;
        this._pivotX         = 0;
        this._pivotY         = 0;
        this._followTimer    = 0;
        this._peekWatchTimer = 0;
        this._peeking        = false;
        this._lastModalTime  = 0;

        this._cursorSizeBase   = 24;
        this._cursorSizeMax    = 124;
        this._cursorSavedSize  = 0;
        this._cursorSettings   = null;

        this._lastPx              = -1;
        this._lastPy              = -1;
        this._lastPointerMoveTime = 0;
        this._pointerStationarySince = 0;

        this._focusX             = -1;
        this._focusY             = -1;
        this._lastFocusEventTime = 0;
        this._atspiListener      = null;
        this._caretPollTimer     = 0;
        this._activeTextObject   = null;

        this._superHeld = false;
        this._altHeld   = false;

        this._focusWindowSignalId = 0;
        this._stageFocusSignalId  = 0;
        this._capturedEventId     = 0;
        this._overviewShowingId   = 0;
        this._overviewHiddenId    = 0;

        this._dbus        = null;
        this._dbusNameId  = 0;

        this._syncingSlider = false;
        this._panelIconBox  = null;
        this._zoomRow       = null;
        this._mouseRow      = null;
        this._focusRow      = null;
        this._autoStartRow  = null;
        this._overviewPeekRow = null;
        this._statusLabel   = null;
        this._actionBtn     = null;

        this._panelIconBox = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._panelIconBox.add_child(this._buildPanelIcon());
        this.add_child(this._panelIconBox);

        this._initAtspi();
        this._checkAccessibilitySetting();
        this._initShellFocusTracking();
        this._initDbus();
        this._buildPopup();
    }

    _prefsPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(), 'magnixify-extension', 'prefs.json',
        ]);
    }

    _loadPrefs() {
        try {
            const [ok, data] = GLib.file_get_contents(this._prefsPath());
            if (!ok) return;
            const parsed = JSON.parse(new TextDecoder('utf-8').decode(data));
            if (typeof parsed.autoStart === 'boolean')
                this._autoStart = parsed.autoStart;
            if (typeof parsed.peekOnOverview === 'boolean')
                this._peekOnOverview = parsed.peekOnOverview;
        } catch (_) { }
    }

    _savePrefs() {
        try {
            const path = this._prefsPath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            GLib.file_set_contents(path, JSON.stringify({
                autoStart: this._autoStart,
                peekOnOverview: this._peekOnOverview,
            }));
        } catch (e) {
            log('magnixify: failed to save prefs: ' + e.message);
        }
    }

    _checkAccessibilitySetting() {
        try {
            const settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            if (!settings.get_boolean('toolkit-accessibility')) {
                settings.set_boolean('toolkit-accessibility', true);
                log('magnixify: enabled toolkit-accessibility');
            }
        } catch (e) {
            log('magnixify: could not check toolkit-accessibility: ' + e.message);
        }
    }

    
    _cursorSettingsInstance() {
        if (!this._cursorSettings) {
            try {
                this._cursorSettings = new Gio.Settings({
                    schema_id: 'org.gnome.desktop.interface',
                });
            } catch (e) {
                log('magnixify: cursor settings: ' + e.message);
                return null;
            }
        }
        return this._cursorSettings;
    }
    
    _cursorSizeForZoom(zoom) {
        const span  = this._cursorSizeMax - this._cursorSizeBase;
        const zspan = ZOOM_MAX - ZOOM_MIN;
        const raw   = this._cursorSizeBase + (zoom - ZOOM_MIN) * span / zspan;

        const NICE = [16, 24, 32, 48, 64, 96, 124, 128];
        let best = NICE[0];
        let bestDelta = Math.abs(NICE[0] - raw);
        for (const n of NICE) {
            const d = Math.abs(n - raw);
            if (d < bestDelta) { best = n; bestDelta = d; }
        }
        return Math.max(this._cursorSizeBase, best);
    }
    
    _applyCursorSize(zoom) {
        const s = this._cursorSettingsInstance();
        if (!s) return;
        const target = this._cursorSizeForZoom(zoom);
        if (s.get_int('cursor-size') === target) return;
        try { s.set_int('cursor-size', target); }
        catch (e) { log('magnixify: set cursor-size: ' + e.message); }
    }
    
    _rememberCursorSize() {
        if (this._cursorSavedSize) return;
        const s = this._cursorSettingsInstance();
        if (!s) return;
        try { this._cursorSavedSize = s.get_int('cursor-size'); }
        catch (_) { this._cursorSavedSize = this._cursorSizeBase; }
    }
    
    _restoreCursorSize() {
        if (!this._cursorSavedSize) return;
        const s = this._cursorSettingsInstance();
        if (!s) return;
        try { s.set_int('cursor-size', this._cursorSavedSize); }
        catch (e) { log('magnixify: restore cursor-size: ' + e.message); }
        this._cursorSavedSize = 0;
    }

    _initAtspi() {
        if (!Atspi) return;
        try { Atspi.init(); } catch (_) { }
        try {
            this._atspiListener = Atspi.EventListener.new(e => this._onAtspiEvent(e));
            this._atspiListener.register('object:text-caret-moved');
            this._atspiListener.register('object:state-changed:focused');
        } catch (e) {
            logError(e, 'magnixify: failed to register AT-SPI listener');
            this._atspiListener = null;
        }
    }

    _onAtspiEvent(event) {
        if (!this._mon || !event || !event.source || this._peeking) return;
        try {
            if (event.type === 'object:state-changed:focused' && event.detail1 === 1) {
                let textIface = null;
                try { textIface = event.source.get_text_iface(); } catch (_) {}
                this._activeTextObject = textIface ? event.source : null;
                this._updateFocus(event);
            } else if (event.type === 'object:text-caret-moved') {
                this._updateCaret(event);
            }
        } catch (_) {}
    }

    _updateFocus(event) {
        let component = null;
        try { component = event.source.get_component_iface(); } catch (_) { return; }
        if (!component || event.detail1 != 1) return;

        let extents;
        try {
            extents = component.get_extents(Atspi.CoordType.WINDOW);
            extents = this._convertExtentsToScreenSpace(event.source, extents);
            if (!extents) return;
        } catch (_) { return; }
        this._setFocusPoint(extents.x + extents.width / 2,
                            extents.y + extents.height / 2);
    }

    _updateCaret(event) {
        let text = null;
        try { text = event.source.get_text_iface(); } catch (_) { return; }
        if (!text) return;

        const offset = text.get_caret_offset();
        if (offset === undefined || offset < 0) return;

        let extents;
        try {
            if (offset > 0) {
                extents = text.get_character_extents(offset - 1, Atspi.CoordType.WINDOW);
                if (extents && extents.width > 0) extents.x += extents.width;
                else extents = text.get_character_extents(offset, Atspi.CoordType.WINDOW);
            } else {
                extents = text.get_character_extents(offset, Atspi.CoordType.WINDOW);
            }
            extents = this._convertExtentsToScreenSpace(event.source, extents);
            if (!extents) return;
        } catch (_) { return; }

        if (extents.width === 0 && extents.height === 0) return;
        this._setFocusPoint(extents.x + extents.width / 2,
                            extents.y + extents.height / 2);
    }

    _convertExtentsToScreenSpace(accessible, extents) {
        const toplevelWindowTypes = new Set([
            Atspi.Role.FRAME,
            Atspi.Role.DIALOG,
            Atspi.Role.WINDOW,
        ]);

        let app = null;
        let parentWindow = null;
        let iter = accessible;
        while (iter) {
            if (iter.get_role() === Atspi.Role.APPLICATION) {
                app = iter;
                break;
            } else if (toplevelWindowTypes.has(iter.get_role())) {
                parentWindow = iter;
            }
            iter = iter.get_parent();
        }

        if (app && app.get_name() === 'gnome-shell')
            return extents;

        const windowActive = parentWindow &&
            parentWindow.get_state_set().contains(Atspi.StateType.ACTIVE);
        const accessibleFocused =
            accessible.get_state_set().contains(Atspi.StateType.FOCUSED);
        if (!windowActive || !accessibleFocused)
            return null;

        const rect = global.display.focus_window?.get_frame_rect();
        if (!rect) return null;

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return {
            x: rect.x + (scale * extents.x),
            y: rect.y + (scale * extents.y),
            width: scale * extents.width,
            height: scale * extents.height,
        };
    }

    _setFocusPoint(x, y) {
        if (x < this._mon.x || x >= this._mon.x + this._mon.w ||
            y < this._mon.y || y >= this._mon.y + this._mon.h)
            return;

        if (this._focusX >= 0 && this._focusY >= 0 &&
            Math.abs(x - this._focusX) < CARET_EPSILON &&
            Math.abs(y - this._focusY) < CARET_EPSILON)
            return;

        this._focusX = x;
        this._focusY = y;
        this._lastFocusEventTime = Date.now();
    }

    _initShellFocusTracking() {
        this._focusWindowSignalId = global.display.connect(
            'notify::focus-window', () => this._onFocusWindowChanged());

        this._stageFocusSignalId = global.stage.connect(
            'notify::key-focus', () => this._onStageKeyFocusChanged());

        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._peekTick();
        });
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            this._peekTick();
        });

        this._capturedEventId = global.stage.connect(
            'captured-event', (actor, event) => this._onCapturedEvent(actor, event));
    }

    _onFocusWindowChanged() {
        this._reconcileModifiers();
        this._peekTick();

        if (!this._mon || this._peeking) return;
        const win = global.display.focus_window;
        if (!win) return;
        try {
            const rect = win.get_frame_rect();
            this._setFocusPoint(rect.x + rect.width / 2,
                                rect.y + rect.height / 2);
        } catch (_) {}
    }

    _onStageKeyFocusChanged() {
        if (!this._mon || this._peeking) return;
        try {
            const actor = global.stage.get_key_focus();
            if (!actor || this.contains(actor)) return;
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            if (w <= 0 || h <= 0) return;
            this._setFocusPoint(x + w / 2, y + h / 2);
        } catch (_) {}
    }

    _onCapturedEvent(actor, event) {
        let type;
        try { type = event.type(); } catch (_) { return Clutter.EVENT_PROPAGATE; }
        if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;

        let sym;
        try { sym = event.get_key_symbol(); } catch (_) { return Clutter.EVENT_PROPAGATE; }

        const isPress = type === Clutter.EventType.KEY_PRESS;

        if (isPress && (sym === Clutter.KEY_KP_Add || sym === Clutter.KEY_KP_Subtract)) {
            const delta = sym === Clutter.KEY_KP_Add ? ZOOM_STEP : -ZOOM_STEP;
            this._setZoomLevel(this._zoomLevel + delta);
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Super_L || sym === Clutter.KEY_Super_R) {
            this._superHeld = isPress;
            this._peekTick();
            return Clutter.EVENT_PROPAGATE;
        }
        if (sym === Clutter.KEY_Alt_L || sym === Clutter.KEY_Alt_R) {
            this._altHeld = isPress;
            this._peekTick();
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _reconcileModifiers() {
        let mods = 0;
        let ok = true;
        try {
            const result = global.get_pointer();
            mods = result[2] || 0;
        } catch (_) {
            ok = false;
        }
        this._superHeld = ok && !!(mods & Clutter.ModifierType.MOD4_MASK);
        this._altHeld   = ok && !!(mods & Clutter.ModifierType.MOD1_MASK);
    }

    _modalActive() {
        try {
            const group = Main.layoutManager?.modalDialogGroup;
            if (group && typeof group.get_n_children === 'function' &&
                group.get_n_children() > 0) {
                this._lastModalTime = Date.now();
                return true;
            }
        } catch (_) {}
        return false;
    }

    _startPeekWatch() {
        if (this._peekWatchTimer) return;
        this._peekWatchTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, PEEK_WATCH_MS,
            () => { this._peekTick(); return GLib.SOURCE_CONTINUE; });
    }

    _stopPeekWatch() {
        if (this._peekWatchTimer) {
            GLib.source_remove(this._peekWatchTimer);
            this._peekWatchTimer = 0;
        }
    }

    _peekTick() {
        if (!this._zoomActor || this._state !== 'ZOOMED') {
            this._peeking = false;
            return;
        }

        const now = Date.now();
        const modalActive = this._modalActive();
        const recentModal = !modalActive &&
            (now - this._lastModalTime) < POST_MODAL_GRACE_MS;

        this._reconcileModifiers();
        const modDown = this._superHeld || this._altHeld;

        const overviewWantsPeek = this._peekOnOverview &&
            Main.overview.visible && !recentModal;

        const shouldPeek = modDown || overviewWantsPeek;

        if (shouldPeek !== this._peeking) {
            log(`magnixify: peek ${shouldPeek ? 'ON' : 'OFF'} — ` +
                `super=${this._superHeld} alt=${this._altHeld} ` +
                `overview=${Main.overview.visible} ` +
                `modal=${modalActive} recentModal=${recentModal} ` +
                `peekOnOverview=${this._peekOnOverview}`);
            this._peeking = shouldPeek;
            this._applyCursorSize(shouldPeek ? ZOOM_MIN : this._zoomLevel);
            this._zoomActor.remove_all_transitions();
            this._zoomActor.ease({
                scale_x: shouldPeek ? 1.0 : this._zoomLevel,
                scale_y: shouldPeek ? 1.0 : this._zoomLevel,
                duration: shouldPeek ? 120 : this._zoomDurationMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return;
        }

        if (this._zoomActor.get_transition('scale-x')) return;
        const target = this._peeking ? 1.0 : this._zoomLevel;
        if (Math.abs(this._zoomActor.scale_x - target) > 0.01 ||
            Math.abs(this._zoomActor.scale_y - target) > 0.01) {
            this._zoomActor.set_scale(target, target);
        }
    }

    _setZoomLevel(v) {
        v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v));
        this._zoomLevel = v;

        if (this._zoomActor && this._state === 'ZOOMED' && !this._peeking &&
            !this._zoomActor.get_transition('scale-x'))
            this._zoomActor.set_scale(v, v);

        if (this._zoomRow) {
            const norm = (v - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN);
            this._syncingSlider = true;
            this._zoomRow.slider.value = clamp01(norm);
            this._syncingSlider = false;
            this._zoomRow.val.set_text(`x${v.toFixed(1)}`);
        }
        if (this._state === 'ZOOMED')
            this._applyCursorSize(this._peeking ? ZOOM_MIN : v);
    }
    
    _startCaretPolling() {
        if (this._caretPollTimer || !this._activeTextObject) return;
        this._caretPollTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, CARET_POLL_MS,
            () => {
                if (!this._activeTextObject) return GLib.SOURCE_REMOVE;
                if (this._peeking) return GLib.SOURCE_CONTINUE;
                try {
                    const text = this._activeTextObject.get_text_iface();
                    if (!text) return GLib.SOURCE_CONTINUE;
                    const offset = text.get_caret_offset();
                    if (offset === undefined || offset < 0) return GLib.SOURCE_CONTINUE;

                    let extents;
                    if (offset > 0) {
                        extents = text.get_character_extents(offset - 1, Atspi.CoordType.WINDOW);
                        if (extents && extents.width > 0) extents.x += extents.width;
                        else extents = text.get_character_extents(offset, Atspi.CoordType.WINDOW);
                    } else {
                        extents = text.get_character_extents(offset, Atspi.CoordType.WINDOW);
                    }
                    extents = this._convertExtentsToScreenSpace(this._activeTextObject, extents);
                    if (!extents) return GLib.SOURCE_CONTINUE;
                    if (extents.width === 0 && extents.height === 0) return GLib.SOURCE_CONTINUE;
                    this._setFocusPoint(extents.x + extents.width / 2,
                                        extents.y + extents.height / 2);
                } catch (_) {}
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopCaretPolling() {
        if (this._caretPollTimer) {
            GLib.source_remove(this._caretPollTimer);
            this._caretPollTimer = 0;
        }
        this._activeTextObject = null;
    }

    _initDbus() {
        try {
            this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE_XML, this);
            this._dbus.export(Gio.DBus.session, DBUS_OBJECT_PATH);
            this._dbusNameId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                DBUS_IFACE_NAME,
                Gio.BusNameOwnerFlags.NONE,
                null, null, null);
        } catch (e) {
            logError(e, 'magnixify: failed to export D-Bus interface');
            this._dbus = null;
            this._dbusNameId = 0;
        }
    }

    ZoomIn()       { this._setZoomLevel(this._zoomLevel + ZOOM_STEP); }
    ZoomOut()      { this._setZoomLevel(this._zoomLevel - ZOOM_STEP); }
    Toggle()       { this._toggle(); }
    SetZoom(level) { this._setZoomLevel(Number(level)); }
    GetZoom()      { return this._zoomLevel; }

    _buildPopup() {
        const popupWidth = Math.round(400 * 0.55);

        const root = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const content = new St.BoxLayout({
            vertical: true, x_expand: true,
            style: `min-width: ${popupWidth}px; max-width: ${popupWidth}px; `
                 + 'spacing: 8px; padding: 6px;',
        });
        root.add_child(content);
        this.menu.addMenuItem(root);

        const topRow = new St.BoxLayout({ x_expand: true, style: 'spacing: 6px;' });
        topRow.add_child(new St.Widget({ x_expand: true }));
        topRow.add_child(plainLabel('magnixify',
            'font-weight: bold; font-size: 1.1em; opacity: 0.9;'));
        topRow.add_child(new St.Widget({ x_expand: true }));
        content.add_child(topRow);

        this._zoomRow = this._buildZoomSliderRow();
        content.add_child(this._zoomRow.container);

        this._mouseRow = this._buildToggleRow({
            label: 'follow mouse',
            value: this._followMouseEnabled,
            onToggled: on => { this._followMouseEnabled = on; },
        });
        content.add_child(this._mouseRow.container);

        this._focusRow = this._buildToggleRow({
            label: 'follow focus',
            value: this._followFocusEnabled,
            onToggled: on => { this._followFocusEnabled = on; },
        });
        content.add_child(this._focusRow.container);

        this._autoStartRow = this._buildToggleRow({
            label: 'start on login',
            value: this._autoStart,
            onToggled: on => {
                this._autoStart = on;
                this._savePrefs();
            },
        });
        content.add_child(this._autoStartRow.container);

        this._overviewPeekRow = this._buildToggleRow({
            label: 'peek on overview',
            value: this._peekOnOverview,
            onToggled: on => {
                this._peekOnOverview = on;
                this._savePrefs();
                this._peekTick();
            },
        });
        content.add_child(this._overviewPeekRow.container);

        const statusRow = new St.BoxLayout({ x_expand: true, style: 'padding-left: 2px;' });
        this._statusLabel = plainLabel(
            this._atspiListener
                ? '· caret/focus tracking active'
                : '· caret/focus tracking unavailable',
            'font-size: 0.75em; opacity: 0.55;');
        statusRow.add_child(this._statusLabel);
        content.add_child(statusRow);

        const actionRow = new St.BoxLayout({
            x_expand: true, style: 'spacing: 6px; padding-top: 4px;',
        });
        actionRow.add_child(new St.Widget({ x_expand: true }));
        this._actionBtn = new St.Button({ can_focus: true });
        this._actionBtn.connect('clicked', () => this._toggle());
        actionRow.add_child(this._actionBtn);
        actionRow.add_child(new St.Widget({ x_expand: true }));
        content.add_child(actionRow);

        this._updateActionButton();
    }

    _buildZoomSliderRow() {
        const container = new St.BoxLayout({
            vertical: true, x_expand: true, style: 'spacing: 4px;',
        });
        const headerRow = new St.BoxLayout({ x_expand: true, style: 'spacing: 6px;' });
        headerRow.add_child(plainLabel('zoom',
            'font-weight: bold; font-size: 0.95em; opacity: 0.9;'));
        headerRow.add_child(new St.Widget({ x_expand: true }));
        container.add_child(headerRow);

        const row = new St.BoxLayout({ x_expand: true, style: 'spacing: 8px;' });
        const initial = (this._zoomLevel - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN);
        const slider = new Slider.Slider(clamp01(initial));
        slider.x_expand = true;
        slider.y_align  = Clutter.ActorAlign.CENTER;
        row.add_child(slider);

        const val = plainLabel(`x${this._zoomLevel.toFixed(1)}`,
            'width: 44px; text-align: right; font-size: 0.85em; opacity: 0.85;');
        row.add_child(val);

        slider.connect('notify::value', () => {
            if (this._syncingSlider) return;
            const v = ZOOM_MIN + slider.value * (ZOOM_MAX - ZOOM_MIN);
            val.set_text(`x${v.toFixed(1)}`);
            this._setZoomLevel(v);
        });

        container.add_child(row);
        return { container, slider, val };
    }

    _buildToggleRow({label, value, onToggled}) {
        const container = new St.BoxLayout({
            x_expand: true, style: 'spacing: 8px;',
        });
        container.add_child(plainLabel(label,
            'font-weight: bold; font-size: 0.95em; opacity: 0.9;'));
        container.add_child(new St.Widget({ x_expand: true }));

        const btn = new St.Button({ can_focus: true });
        const rec = { container, btn, on: value, setStyle: null };

        const applyStyle = () => {
            const base = 'padding: 2px 12px; border-radius: 6px; '
                       + 'font-size: 0.85em; font-weight: bold; ';
            if (rec.on) {
                btn.set_style(base
                  + 'border: 1px solid rgba(139, 92, 246, 0.9); '
                  + 'background-color: rgba(139, 92, 246, 0.20); '
                  + 'box-shadow: 0 0 10px rgba(139, 92, 246, 0.75);');
                btn.set_child(plainLabel('on', 'font-weight: bold;'));
            } else {
                btn.set_style(base
                  + 'border: 1px solid rgba(255,255,255,0.30); '
                  + 'background-color: rgba(255,255,255,0.06);');
                btn.set_child(plainLabel('off', 'font-weight: bold;'));
            }
        };
        rec.setStyle = applyStyle;
        applyStyle();

        btn.connect('clicked', () => {
            rec.on = !rec.on;
            applyStyle();
            onToggled(rec.on);
        });

        container.add_child(btn);
        return rec;
    }

    _buildPanelIcon() {
        const active = this._state !== 'IDLE';
        const style = active
            ? 'font-size: 14px; color: rgba(139, 92, 246, 1); '
            + 'text-shadow: 0 0 6px rgba(139, 92, 246, 0.75);'
            : 'font-size: 14px; opacity: 0.7;';
        return plainLabel('🔍', style);
    }

    _updatePanelIcon() {
        if (!this._panelIconBox) return;
        this._panelIconBox.destroy_all_children();
        this._panelIconBox.add_child(this._buildPanelIcon());
    }

    _updateActionButton() {
        if (!this._actionBtn) return;
        const base = 'font-size: 0.9em; font-weight: bold; '
                   + 'padding: 3px 10px; border-radius: 6px; ';
        const showStop = this._state === 'ZOOMED' || this._state === 'ZOOMING_IN';
        if (showStop) {
            this._actionBtn.set_style(base
              + 'border: 1px solid rgba(139, 92, 246, 0.9); '
              + 'background-color: rgba(139, 92, 246, 0.20); '
              + 'box-shadow: 0 0 10px rgba(139, 92, 246, 0.75);');
            this._actionBtn.set_child(plainLabel('stop', 'font-weight: bold;'));
        } else {
            this._actionBtn.set_style(base
              + 'border: 1px solid rgba(255,255,255,0.30); '
              + 'background-color: rgba(255,255,255,0.06);');
            this._actionBtn.set_child(plainLabel('start', 'font-weight: bold;'));
        }
    }

    _toggle() {
        if (this._state === 'IDLE' || this._state === 'ZOOMING_OUT')
            this._zoomIn();
        else
            this._zoomOut();
    }

    _zoomIn() {
        const [px, py] = global.get_pointer();
        const monIdx   = monitorIndexForPoint(px, py);
        const mon      = Main.layoutManager.monitors[monIdx];
        if (!mon) return;

        if (this._container) {
            this._stopFollow();
            this._stopCaretPolling();
            this._stopPeekWatch();
            if (this._zoomActor) this._zoomActor.remove_all_transitions();
            this._container.destroy();
            this._container = null;
            this._zoomActor = null;
            this._clone     = null;
        }

        this._focusX = -1;
        this._focusY = -1;
        this._lastFocusEventTime = 0;
        this._lastPx = -1;
        this._lastPy = -1;
        this._lastPointerMoveTime = 0;
        this._pointerStationarySince = 0;
        this._activeTextObject = null;
        this._peeking = false;

        this._mon = { x: mon.x, y: mon.y, w: mon.width, h: mon.height };

        this._container = new Clutter.Actor({
            x: mon.x, y: mon.y,
            width: mon.width, height: mon.height,
            clip_to_allocation: true, reactive: false,
        });
        Shell.util_set_hidden_from_pick(this._container, true);

        this._zoomActor = new Clutter.Actor({
            x: 0, y: 0,
            width: mon.width, height: mon.height,
            reactive: false,
        });
        this._pivotX = clamp01((px - mon.x) / mon.width);
        this._pivotY = clamp01((py - mon.y) / mon.height);
        this._zoomActor.set_pivot_point(this._pivotX, this._pivotY);
        this._zoomActor.set_scale(1.0, 1.0);
        this._container.add_child(this._zoomActor);

        this._clone = new Clutter.Clone({
            source: Main.uiGroup,
            x: -mon.x, y: -mon.y,
            clip_to_allocation: true, reactive: false,
        });
        this._zoomActor.add_child(this._clone);

        global.stage.add_child(this._container);

        this._rememberCursorSize();
        this._setState('ZOOMING_IN');
        this._zoomActor.ease({
            scale_x: this._zoomLevel,
            scale_y: this._zoomLevel,
            duration: this._zoomDurationMs,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._state === 'ZOOMING_IN') {
                    this._setState('ZOOMED');
                    this._startFollow();
                    this._startCaretPolling();
                    this._peekTick();
                }
            },
        });
    }

    _zoomOut() {
        if (!this._container || !this._zoomActor) return;
        this._stopFollow();
        this._stopCaretPolling();
        this._stopPeekWatch();
        this._peeking = false;
        this._setState('ZOOMING_OUT');
        const container = this._container;
        const zoomActor = this._zoomActor;
        zoomActor.remove_all_transitions();
        zoomActor.ease({
            scale_x: 1.0, scale_y: 1.0,
            duration: this._zoomDurationMs,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._container === container) this._teardown();
            },
        });
    }

    _teardown() {
        this._restoreCursorSize();
        this._stopFollow();
        this._stopCaretPolling();
        this._stopPeekWatch();
        if (this._zoomActor) this._zoomActor.remove_all_transitions();
        if (this._container) this._container.destroy();
        this._container = null;
        this._zoomActor = null;
        this._clone     = null;
        this._mon       = null;
        this._peeking   = false;
        this._lastModalTime = 0;
        this._setState('IDLE');
    }

    _setState(s) {
        this._state = s;
        this._updatePanelIcon();
        this._updateActionButton();
        if (s === 'ZOOMED') {
            this._startPeekWatch();
            this._applyCursorSize(this._peeking ? ZOOM_MIN : this._zoomLevel);
        } else if (s === 'IDLE' || s === 'ZOOMING_OUT') {
            this._stopPeekWatch();
        }
    }

    _startFollow() {
        if (this._followTimer) return;
        this._followTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, FOLLOW_TICK_MS,
            () => { this._followTick(); return GLib.SOURCE_CONTINUE; });
    }

    _stopFollow() {
        if (this._followTimer) {
            GLib.source_remove(this._followTimer);
            this._followTimer = 0;
        }
    }

    _followTick() {
        if (!this._zoomActor || !this._mon || !this._container || this._peeking)
            return;

        const now      = Date.now();
        const [px, py] = global.get_pointer();

        const pointerMoved = (px !== this._lastPx || py !== this._lastPy);
        if (pointerMoved) {
            this._lastPx = px;
            this._lastPy = py;
            this._lastPointerMoveTime = now;
            this._pointerStationarySince = 0;
        } else if (this._pointerStationarySince === 0) {
            this._pointerStationarySince = now;
        }

        const pointerMoving = (now - this._lastPointerMoveTime) < FOLLOW_WINDOW_MS;
        const pointerStationary = !pointerMoving
            && this._pointerStationarySince > 0
            && (now - this._pointerStationarySince) >= POINTER_STOP_DELAY_MS;
        const focusRecent = (now - this._lastFocusEventTime) < FOLLOW_WINDOW_MS;

        let tx = this._pivotX;
        let ty = this._pivotY;

        const mouseWins = this._followMouseEnabled && pointerMoving;
        const focusWins = this._followFocusEnabled && pointerStationary && focusRecent;

        if (mouseWins) {
            tx = clamp01((px - this._mon.x) / this._mon.w);
            ty = clamp01((py - this._mon.y) / this._mon.h);
        } else if (focusWins) {
            tx = clamp01((this._focusX - this._mon.x) / this._mon.w);
            ty = clamp01((this._focusY - this._mon.y) / this._mon.h);
        } else if (this._followMouseEnabled && !this._followFocusEnabled) {
            tx = clamp01((px - this._mon.x) / this._mon.w);
            ty = clamp01((py - this._mon.y) / this._mon.h);
        } else if (this._followFocusEnabled && !this._followMouseEnabled && focusRecent) {
            tx = clamp01((this._focusX - this._mon.x) / this._mon.w);
            ty = clamp01((this._focusY - this._mon.y) / this._mon.h);
        }

        this._pivotX += (tx - this._pivotX) * this._followSmoothing;
        this._pivotY += (ty - this._pivotY) * this._followSmoothing;
        this._zoomActor.set_pivot_point(this._pivotX, this._pivotY);
    }

    cleanup() {
        this._stopCaretPolling();
        this._stopFollow();
        this._stopPeekWatch();

        if (this._focusWindowSignalId) {
            global.display.disconnect(this._focusWindowSignalId);
            this._focusWindowSignalId = 0;
        }
        if (this._stageFocusSignalId) {
            global.stage.disconnect(this._stageFocusSignalId);
            this._stageFocusSignalId = 0;
        }
        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }

        if (this._dbus) {
            try { this._dbus.unexport(); } catch (_) {}
            this._dbus = null;
        }
        if (this._dbusNameId) {
            Gio.bus_unown_name(this._dbusNameId);
            this._dbusNameId = 0;
        }

        if (this._atspiListener) {
            try {
                this._atspiListener.deregister('object:text-caret-moved');
                this._atspiListener.deregister('object:state-changed:focused');
            } catch (_) {}
            this._atspiListener = null;
        }
        this._teardown();
    }
});

export default class MagnixifyExtension extends Extension {
    enable() {
        try {
            this._indicator = new MagnixifyIndicator();
        } catch (e) {
            logError(e, 'magnixify: indicator construction failed');
            this._indicator = this._makeErrorIndicator(e);
        }
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._scheduleAutoStart();
    }

    _scheduleAutoStart() {
        if (!this._indicator || !this._indicator._autoStart) return;
        let attempts = 0;
        const tryStart = () => {
            if (!this._indicator) return GLib.SOURCE_REMOVE;
            if (this._indicator._state !== 'IDLE') return GLib.SOURCE_REMOVE;
            if (Main.layoutManager.monitors.length === 0) {
                attempts++;
                return attempts < 40 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            }
            this._indicator._zoomIn();
            return GLib.SOURCE_REMOVE;
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, tryStart);
    }

    disable() {
        this._indicator?.cleanup();
        this._indicator?.destroy();
        this._indicator = null;
    }

    _makeErrorIndicator(err) {
        const btn = new PanelMenu.Button(0.0, 'magnixify');
        btn.add_child(new St.Icon({
            icon_name: 'dialog-error-symbolic',
            style_class: 'system-status-icon',
        }));
        const item = new PopupMenu.PopupMenuItem(
            `magnixify failed to load:\n${err.message}`
        );
        item.reactive = false;
        btn.menu.addMenuItem(item);
        return btn;
    }
}
