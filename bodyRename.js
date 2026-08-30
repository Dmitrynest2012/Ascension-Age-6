/**
 * bodyRename.js — переименование небесных тел (кастомное имя поверх локализации).
 *
 * Кастомное имя хранится в state.bodyCustomNames[bodyId] = string.
 * Если ключа нет / null / '' — снова используется locName(data.name).
 * Сохраняется в сессии как bodyCustomNames.
 */

import { t, locName } from './settings.js';
import { state } from './state.js';
import { isOpticallyUnknownBody, getOpticalUnknownName } from './opticalScan.js';

/** Актуальная локация (выставляет camera.applyLocationToUI) */
let _locRef = null;

/** camera вызывает при смене локации (до/вместо cancel) */
export function notifyLocationForRename(body) {
    const nextId = body?.data?.id;
    if (editing && editingBodyId != null && (nextId == null || String(nextId) !== String(editingBodyId))) {
        // смена тела — правки не сохраняются
        setEditMode(false, null);
    }
    _locRef = body || null;
}

let editing = false;
let editingBodyId = null;
let bound = false;

function ensureMap() {
    if (!state.bodyCustomNames || typeof state.bodyCustomNames !== 'object') {
        state.bodyCustomNames = {};
    }
    return state.bodyCustomNames;
}

/** Отображаемое имя тела: кастомное или локализованное */
export function getBodyDisplayName(bodyOrData, fallback = '') {
    const data = bodyOrData?.data || bodyOrData;
    if (!data) return fallback;
    try {
        if (isOpticallyUnknownBody(bodyOrData?.data ? bodyOrData : { data })) {
            return getOpticalUnknownName();
        }
    } catch (_) {}
    const id = data.id != null ? String(data.id) : null;
    if (id != null) {
        const custom = ensureMap()[id];
        if (typeof custom === 'string' && custom.trim()) return custom.trim();
    }
    return locName(data.name, fallback || t('common.unknown') || '—');
}

export function hasCustomBodyName(bodyId) {
    const id = String(bodyId);
    const v = ensureMap()[id];
    return typeof v === 'string' && v.trim().length > 0;
}

export function setCustomBodyName(bodyId, name) {
    const id = String(bodyId);
    const map = ensureMap();
    const trimmed = (name == null ? '' : String(name)).trim();
    if (!trimmed) {
        delete map[id];
    } else {
        map[id] = trimmed.slice(0, 64);
    }
}

export function clearCustomBodyName(bodyId) {
    const id = String(bodyId);
    delete ensureMap()[id];
}

export function captureBodyCustomNamesSnapshot() {
    return { ...ensureMap() };
}

export function applyBodyCustomNamesSnapshot(snap) {
    state.bodyCustomNames = {};
    if (!snap || typeof snap !== 'object') return;
    for (const [id, v] of Object.entries(snap)) {
        if (typeof v === 'string' && v.trim()) {
            state.bodyCustomNames[String(id)] = v.trim().slice(0, 64);
        }
    }
    refreshAllBodyNameDisplays();
}

function getEls() {
    return {
        bar: document.getElementById('title-bar'),
        nameSpan: document.getElementById('location-name'),
        input: document.getElementById('location-name-input'),
        editBtn: document.getElementById('location-rename-edit'),
        confirmBtn: document.getElementById('location-rename-confirm'),
        resetBtn: document.getElementById('location-rename-reset')
    };
}

function setEditMode(on, body) {
    const { nameSpan, input, editBtn, confirmBtn, resetBtn } = getEls();
    if (!nameSpan || !input || !editBtn || !confirmBtn) return;

    editing = !!on;
    if (on && body?.data && canRenameBody(body)) {
        editingBodyId = body.data.id;
        const current = getBodyDisplayName(body);
        input.value = current;
        nameSpan.style.display = 'none';
        input.style.display = 'block';
        editBtn.style.display = 'none';
        confirmBtn.style.display = 'inline-flex';
        if (resetBtn) resetBtn.style.display = 'inline-flex';
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    } else {
        editingBodyId = null;
        nameSpan.style.display = '';
        input.style.display = 'none';
        editBtn.style.display = 'inline-flex';
        confirmBtn.style.display = 'none';
        if (resetBtn) resetBtn.style.display = 'none';
    }
}

/** Сброс режима редактирования без сохранения (смена локации) */
export function cancelBodyRenameIfEditing() {
    if (!editing) return;
    setEditMode(false, null);
}

export function canRenameBody(body) {
    const d = body?.data || body;
    if (!d) return false;
    return !!(d.colonized || d.developed);
}

function updateMapLabel(bodyId, text) {
    const label = state.labels?.[bodyId] || state.labels?.[String(bodyId)] || state.labels?.[Number(bodyId)];
    if (label) label.innerText = text;
}

function updateInfoName(text) {
    const el = document.getElementById('info-name');
    if (el) el.textContent = text;
}

/** Обновить бар + табло + info-name для текущего тела */
export function refreshLocationNameDisplay(body) {
    const { nameSpan } = getEls();
    const b = body || _locRef;
    if (!b?.data) {
        if (nameSpan) nameSpan.textContent = '';
        return;
    }
    if (editing && String(editingBodyId) === String(b.data.id)) {
        // не трогаем input во время набора
        return;
    }
    const text = getBodyDisplayName(b);
    try {
        const { editBtn } = getEls();
        if (editBtn && !editing) editBtn.style.display = canRenameBody(b) ? 'inline-flex' : 'none';
    } catch (_) {}

    if (nameSpan) nameSpan.textContent = text;
    updateMapLabel(b.data.id, text);
    updateInfoName(text);
}

export function refreshAllBodyNameDisplays() {
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const body = bodies[id];
        if (!body?.data) continue;
        updateMapLabel(body.data.id, getBodyDisplayName(body));
    }
    refreshLocationNameDisplay(_locRef);
}

function confirmRename() {
    const { input } = getEls();
    const body = _locRef;
    if (!body?.data || editingBodyId == null) {
        setEditMode(false, null);
        return;
    }
    if (String(body.data.id) !== String(editingBodyId)) {
        // локация уже сменилась — не сохраняем
        setEditMode(false, null);
        return;
    }
    const val = (input?.value || '').trim();
    if (val) {
        setCustomBodyName(body.data.id, val);
    } else {
        // пустое = сброс к локализации
        clearCustomBodyName(body.data.id);
    }
    setEditMode(false, null);
    refreshLocationNameDisplay(body);
}

function resetToLocalized() {
    const body = _locRef;
    if (!body?.data) return;
    clearCustomBodyName(body.data.id);
    const { input } = getEls();
    if (input) input.value = locName(body.data.name, '');
    // остаёмся в режиме редактирования — сохранение только галочкой
}

export function initBodyRename() {
    if (bound) return;
    bound = true;
    ensureMap();

    const { editBtn, confirmBtn, resetBtn, input } = getEls();
    if (!editBtn || !confirmBtn || !input) {
        console.warn('bodyRename: DOM not ready');
        return;
    }

    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!_locRef?.data) return;
        setEditMode(true, _locRef);
    });

    confirmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmRename();
    });

    resetBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        resetToLocalized();
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirmRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditMode(false, null);
            refreshLocationNameDisplay(_locRef);
        }
    });

    // начальное состояние UI
    setEditMode(false, null);
}
