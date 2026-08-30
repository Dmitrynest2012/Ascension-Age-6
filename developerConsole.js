/**
 * Консоль разработчика (внутриигровой чит/отладка).
 * Разблок: Ctrl/Cmd+Shift+H  |  Тогл окна: ` / ё / § (Backquote)
 * Состояние unlocked пишется в сессию; runtime-override (скорость/тех/энергия) — нет.
 */
import { state } from './state.js';
import { setOpticalFogEnabled, isOpticalFogEnabled } from './opticalScan.js';
import { getLang, t as uiT } from './settings.js';
import { setLocationTotalPopulation, redistributePopulation } from './population.js';
import { getStockMap, addResourceClamped } from './resourceStorage.js';
import { getResource } from './recipes.js';

let catalog = null;
let unlocked = false;
let open = false;
let panel = null;
let logEl = null;
let inputEl = null;
let caretEl = null;
let titleEl = null;

/** Runtime overrides — сбрасываются при загрузке сейва (не пишутся в snapshot). */
export const devOverrides = {
    unitSpeedMult: null, // number | null
    techPerMin: null,
    elecPerMin: null
};
function syncDevOverridesToState() {
    state.devOverrides = devOverrides;
}
syncDevOverridesToState();

export function isDevConsoleUnlocked() {
    return !!unlocked || !!state.devConsoleUnlocked;
}

export function getDevUnitSpeedMult() {
    const m = Number(devOverrides.unitSpeedMult);
    return Number.isFinite(m) && m > 0 ? m : 1;
}

export function getDevTechPerMinOverride() {
    const v = devOverrides.techPerMin;
    return v == null ? null : Number(v);
}

export function getDevElecPerMinOverride() {
    const v = devOverrides.elecPerMin;
    return v == null ? null : Number(v);
}

/** Вызов из saveSystem при apply snapshot */
export function applyDevConsoleFromSave(snap) {
    unlocked = !!(snap && snap.devConsoleUnlocked);
    state.devConsoleUnlocked = unlocked;
    // runtime overrides всегда сброс при загрузке
    devOverrides.unitSpeedMult = null; syncDevOverridesToState();
    devOverrides.techPerMin = null; syncDevOverridesToState();
    devOverrides.elecPerMin = null; syncDevOverridesToState();
    if (!unlocked) closePanel(true);
}

export function captureDevConsoleForSave() {
    return { devConsoleUnlocked: !!unlocked };
}

async function loadCatalog() {
    if (catalog) return catalog;
    try {
        const res = await fetch('developerConsole.json');
        catalog = await res.json();
    } catch (e) {
        console.warn('developerConsole.json', e);
        catalog = { commands: {}, ui: {} };
    }
    return catalog;
}

function lang() {
    try { return getLang() || 'ru'; } catch (_) { return 'ru'; }
}

function L(key, vars) {
    const ui = catalog?.ui || {};
    const node = ui[key];
    let s;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
        const lg = lang();
        s = node[lg] || node.ru || node.en || key;
    } else {
        s = String(node || key);
    }
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
    }
    return s;
}

function inGameSession() {
    if (window.__gameStarted || state?.gameStarted) return true;
    // запасной признак: главное меню скрыто
    try {
        const mm = document.getElementById('main-menu');
        if (mm && (mm.classList.contains('hidden') || mm.style.display === 'none')) return true;
    } catch (_) {}
    return false;
}

function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'dev-console';
    panel.innerHTML = `
      <div id="dev-console-header"><span id="dev-console-title"></span></div>
      <div id="dev-console-log"></div>
      <div id="dev-console-input-row">
        <span id="dev-console-prompt">&gt;</span>
        <input id="dev-console-input" type="text" autocomplete="off" spellcheck="false" />
        <span id="dev-console-caret" aria-hidden="true"></span>
      </div>`;
    document.body.appendChild(panel);
    logEl = panel.querySelector('#dev-console-log');
    inputEl = panel.querySelector('#dev-console-input');
    caretEl = panel.querySelector('#dev-console-caret');
    titleEl = panel.querySelector('#dev-console-title');
    inputEl.addEventListener('keydown', onInputKey);
    inputEl.addEventListener('focus', () => caretEl?.classList.add('is-blink'));
    inputEl.addEventListener('blur', () => caretEl?.classList.remove('is-blink'));
    return panel;
}

function refreshChrome() {
    ensurePanel();
    if (titleEl) titleEl.textContent = L('title');
    if (inputEl) inputEl.placeholder = L('placeholder');
}

function appendLog(text, kind = 'info') {
    ensurePanel();
    const line = document.createElement('div');
    line.className = `dev-line ${kind}`;
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

function openPanel() {
    if (!unlocked) return;
    if (!inGameSession()) {
        console.warn('[dev-console] not in game session');
        return;
    }
    ensurePanel();
    refreshChrome();
    panel.classList.add('is-open');
    panel.style.display = 'flex';
    open = true;
    setTimeout(() => {
        try { inputEl?.focus(); } catch (_) {}
    }, 0);
}

function closePanel(silent = false) {
    if (panel) {
        panel.classList.remove('is-open');
        panel.style.display = 'none';
    }
    open = false;
    try { inputEl?.blur(); } catch (_) {}
}

function togglePanel() {
    if (!unlocked) return;
    if (!inGameSession()) return;
    if (open) closePanel();
    else openPanel();
}

function setUnlocked(v) {
    unlocked = !!v;
    state.devConsoleUnlocked = unlocked;
    if (!unlocked) closePanel(true);
}

function matchCommand(raw) {
    const text = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!text) return null;
    const lower = text.toLowerCase();
    const cmds = catalog?.commands || {};
    const lg = lang();

    // multi-word resets first
    for (const id of ['speed_reset', 'tech_reset', 'power_reset']) {
        const aliases = cmds[id]?.[lg] || cmds[id]?.ru || [];
        for (const a of aliases) {
            if (lower === a.toLowerCase()) return { id, args: [] };
        }
    }

    // help
    for (const a of (cmds.help?.[lg] || cmds.help?.ru || [])) {
        if (lower === a.toLowerCase()) return { id: 'help', args: [] };
    }

    // single-token commands + rest args
    const parts = text.split(' ');
    const head = parts[0].toLowerCase();
    for (const id of ['population', 'resource', 'speed', 'tech', 'power', 'optics']) {
        const aliases = cmds[id]?.[lg] || cmds[id]?.ru || [];
        for (const a of aliases) {
            if (head === a.toLowerCase()) {
                return { id, args: parts.slice(1) };
            }
        }
    }
    return { id: null, args: parts, raw: text };
}

function parseMultiplier(s) {
    if (s == null) return NaN;
    const t = String(s).trim().toLowerCase().replace(',', '.');
    const m = t.match(/^(\d+(?:\.\d+)?)\s*x?$/);
    if (m) return Number(m[1]);
    return Number(t);
}

function bodyCtx() {
    let loc = null;
    try {
        // camera.js тянет THREE — только в рантайме браузера
        loc = window.__currentLocation || null;
    } catch (_) {}
    if (!loc) {
        try {
            // fallback: state / UI
            const id = state?.currentLocationId ?? state?.trackedBodyId;
            const bodies = state?.celestialBodies;
            if (id != null && bodies) loc = bodies[id] || bodies[Number(id)] || null;
        } catch (_) {}
    }
    const body = loc?.data || loc;
    if (!body) return null;
    const id = Number(body.id);
    if (!Number.isFinite(id)) return null;
    return { body, id };
}

function runCommand(raw) {
    const parsed = matchCommand(raw);
    if (!parsed || parsed.id === null) {
        appendLog(L('err_unknown'), 'err');
        return;
    }
    const { id, args } = parsed;

    if (id === 'help') {
        appendLog(L('help_body'), 'info');
        return;
    }

    if (id === 'population') {
        const n = Number(String(args[0] || '').replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) {
            appendLog(L('err_args'), 'err');
            return;
        }
        const ctx = bodyCtx();
        if (!ctx) {
            appendLog(L('err_no_location'), 'err');
            return;
        }
        setLocationTotalPopulation(ctx.body, Math.floor(n));
        try { redistributePopulation(ctx.id, ctx.body); } catch (_) {}
        appendLog(L('msg_population', { n: Math.floor(n) }), 'ok');
        return;
    }

    if (id === 'resource') {
        const rid = args[0];
        const n = Number(String(args[1] || '').replace(',', '.'));
        if (!rid || !Number.isFinite(n) || n < 0) {
            appendLog(L('err_args'), 'err');
            return;
        }
        const ctx = bodyCtx();
        if (!ctx) {
            appendLog(L('err_no_location'), 'err');
            return;
        }
        // проверка существования (если каталог загружен)
        try {
            const meta = getResource?.(rid);
            if (!meta && !String(rid).startsWith('RES_')) {
                appendLog(L('err_resource'), 'err');
                return;
            }
        } catch (_) {}
        const stock = getStockMap(ctx.body);
        stock[rid] = n;
        // clamp если есть вместимость
        try {
            addResourceClamped(ctx.id, ctx.body, rid, 0);
        } catch (_) {}
        appendLog(L('msg_resource', { id: rid, n }), 'ok');
        return;
    }

    if (id === 'speed') {
        const mult = parseMultiplier(args[0]);
        if (!Number.isFinite(mult) || mult <= 0) {
            appendLog(L('err_args'), 'err');
            return;
        }
        devOverrides.unitSpeedMult = mult; syncDevOverridesToState();
        appendLog(L('msg_speed', { n: mult }), 'ok');
        return;
    }

    if (id === 'speed_reset') {
        devOverrides.unitSpeedMult = null; syncDevOverridesToState();
        appendLog(L('msg_speed_reset'), 'ok');
        return;
    }

    if (id === 'tech') {
        const n = Number(String(args[0] || '').replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) {
            appendLog(L('err_args'), 'err');
            return;
        }
        devOverrides.techPerMin = n; syncDevOverridesToState();
        appendLog(L('msg_tech', { n }), 'ok');
        return;
    }

    if (id === 'tech_reset') {
        devOverrides.techPerMin = null; syncDevOverridesToState();
        appendLog(L('msg_tech_reset'), 'ok');
        return;
    }

    if (id === 'power') {
        const n = Number(String(args[0] || '').replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) {
            appendLog(L('err_args'), 'err');
            return;
        }
        devOverrides.elecPerMin = n; syncDevOverridesToState();
        appendLog(L('msg_power', { n }), 'ok');
        return;
    }

    if (id === 'power_reset') {
        devOverrides.elecPerMin = null; syncDevOverridesToState();
        appendLog(L('msg_power_reset'), 'ok');
        return;
    }

    if (id === 'optics') {
        const a = String(args[0] || '').toLowerCase();
        let on;
        if (['выкл', 'off', 'aus', '0', 'false'].includes(a)) on = false;
        else if (['вкл', 'on', 'an', '1', 'true'].includes(a)) on = true;
        else on = !isOpticalFogEnabled();
        setOpticalFogEnabled(on);
        appendLog(L(on ? 'msg_optics_on' : 'msg_optics_off'), 'ok');
        return;
    }
}

function onInputKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const v = inputEl.value;
        if (v.trim()) {
            appendLog('> ' + v, 'cmd');
            runCommand(v);
        }
        inputEl.value = '';
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
    }
    // не отдавать Space/WASD игре
    e.stopPropagation();
}

function onGlobalKey(e) {
    // Ctrl/Cmd+Shift+H — тогл разблокировки (Win/Linux: Ctrl, Mac: Cmd или Ctrl)
    const isH = e.code === 'KeyH' || e.key === 'H' || e.key === 'h' || e.key === 'р' || e.key === 'Р';
    const mod = !!(e.ctrlKey || e.metaKey); // metaKey = Cmd на Mac
    if (mod && e.shiftKey && isH) {
        e.preventDefault();
        e.stopPropagation();
        if (!inGameSession()) {
            console.warn('[dev-console] unlock ignored — not in session');
            return;
        }
        loadCatalog().then(() => {
            setUnlocked(!unlocked);
            refreshChrome();
            ensurePanel();
            appendLog(unlocked ? L('unlocked') : L('locked'), 'info');
            if (unlocked) openPanel();
            else closePanel(true);
            console.log('[dev-console] unlocked=', unlocked, 'open=', open);
        }).catch((err) => console.error('[dev-console] unlock failed', err));
        return;
    }

    // Тильда / Backquote: Win/Mac, EN/RU. На части Mac-клавиатур Section (§) рядом.
    const isTilde = e.code === 'Backquote'
        || e.code === 'IntlBackslash'
        || e.key === '`' || e.key === '~'
        || e.key === 'ё' || e.key === 'Ё'
        || e.key === '§' || e.key === '±';
    if (isTilde) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
            if (e.target === inputEl) {
                e.preventDefault();
                e.stopPropagation();
                closePanel();
            }
            return;
        }
        if (!unlocked) return;
        if (!inGameSession()) return;
        e.preventDefault();
        e.stopPropagation();
        loadCatalog().then(() => togglePanel()).catch((err) => console.error('[dev-console] toggle failed', err));
    }
}

export async function initDeveloperConsole() {
    await loadCatalog();
    unlocked = !!state.devConsoleUnlocked;
    ensurePanel();
    refreshChrome();
    document.addEventListener('keydown', onGlobalKey, true);
}

// auto-init
if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initDeveloperConsole().catch(e => console.warn(e));
        });
    } else {
        initDeveloperConsole().catch(e => console.warn(e));
    }
}
