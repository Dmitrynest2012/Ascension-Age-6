
function ensureSessionsFirmScroll() {
    document.querySelectorAll('.sessions-body').forEach(el => {
        if (el.dataset.firmScroll === '1') {
            try { updateFirmScroll(el); } catch (_) {}
            return;
        }
        el.dataset.firmScroll = '1';
        try {
            attachFirmScroll(el, { axis: 'y', host: 'self', fillHost: true, mirrorV: true });
        } catch (e) { console.warn('sessions firmScroll', e); }
    });
}

/**
 * UI загрузки / сохранения игровых сессий.
 */
import {
    listSessions,
    deleteSession,
    getSession,
    getAutosaveSibling,
    saveCurrentGame,
    overwriteSession,
    beginNewSession,
    applySessionSnapshot,
    formatPlayDuration,
    avatarSrcForGender,
    resolveMainQuestTitle,
    getCurrentSessionId,
    setSessionNameMemory,
    getSessionNameMemory,
    startAutosaveTimer,
    resyncAutosaveTimer,
    tickAutosave
} from './saveSystem.js';
import { t, applyUiLocalization } from './settings.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';

let loadHoldTimer = null;
let loadHoldRaf = null;
let loadHoldStart = 0;
let loadHoldId = null;
const HOLD_MS = 1200;

function $(id) { return document.getElementById(id); }

export function openLoadPanel() {
    const p = $('main-menu-load');
    if (!p) return;
    p.style.display = 'block';
    // async render — titles подтянутся из questsLocalization даже на холодном старте
    renderSessionCards('load-session-list', { mode: 'load' });
    ensureSessionsFirmScroll();
    applyUiLocalization();
}

export function closeLoadPanel() {
    const p = $('main-menu-load');
    if (p) p.style.display = 'none';
    cancelHold();
}

export function openSavePanel() {
    const p = $('main-menu-save');
    if (!p) return;
    p.style.display = 'block';
    renderSessionCards('save-session-list', { mode: 'save' });
    ensureSessionsFirmScroll();
    applyUiLocalization();
}

export function closeSavePanel() {
    const p = $('main-menu-save');
    if (p) p.style.display = 'none';
}

function cancelHold() {
    if (loadHoldRaf) cancelAnimationFrame(loadHoldRaf);
    loadHoldRaf = null;
    loadHoldTimer = null;
    loadHoldId = null;
    document.querySelectorAll('.session-card.holding').forEach(el => {
        el.classList.remove('holding');
        const ring = el.querySelector('.session-hold-ring');
        if (ring) ring.style.strokeDashoffset = String(ring.dataset.len || 100);
    });
}

async function buildCardHtml(snap, mode) {
    const title = snap.name || t('save.unnamed');
    const gender = snap.gender;
    const av = avatarSrcForGender(gender);
    const unknown = !gender ? ' gender-unknown' : '';
    const start = snap.realStartLabel || '—';
    const play = formatPlayDuration(snap.playMs);
    const gameTime = snap.gameTimeLabel || '—';
    const questTitle = await resolveMainQuestTitle(snap);

    const isAuto = !!snap.isAutosave;
    const autoClass = isAuto ? ' session-card-autosave' : '';
    return `
    <div class="session-card${autoClass}" data-sid="${snap.id}" data-mode="${mode}" data-autosave="${isAuto ? '1' : '0'}">
        <button type="button" class="session-card-delete" data-sid="${snap.id}" title="×">×</button>
        <div class="session-card-main">
            <div class="session-avatar-frame${unknown}">
                <img src="${av}" alt="" class="session-avatar-img">
            </div>
            <div class="session-card-info">
                <div class="session-card-name">${escapeHtml(title)}</div>
                <div class="session-card-line"><span class="session-card-label">${t('save.started')}</span> ${escapeHtml(start)}</div>
                <div class="session-card-line"><span class="session-card-label">${t('save.played')}</span> ${escapeHtml(play)}</div>
                <div class="session-card-line"><span class="session-card-label">${t('save.gameTime')}</span> ${escapeHtml(gameTime)}</div>
                <div class="session-card-line"><span class="session-card-label">${t('save.quest')}</span> ${escapeHtml(questTitle)}</div>
            </div>
        </div>
        <svg class="session-hold-svg" viewBox="0 0 36 36" aria-hidden="true">
            <circle class="session-hold-track" cx="18" cy="18" r="15.5" fill="none" stroke-width="2.5"/>
            <circle class="session-hold-ring" cx="18" cy="18" r="15.5" fill="none" stroke-width="2.5"
                stroke-dasharray="97.4" stroke-dashoffset="97.4" data-len="97.4"
                transform="rotate(-90 18 18)"/>
        </svg>
    </div>`;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export async function renderSessionCards(containerId, { mode }) {
    const box = $(containerId);
    if (!box) return;
    const sessions = listSessions({ includeAutosaves: false });
    const rows = [];
    for (const s of sessions) {
        const mainHtml = await buildCardHtml(s, mode);
        const sibling = getAutosaveSibling(s.id);
        let autoHtml = '';
        if (sibling) {
            autoHtml = await buildCardHtml(sibling, mode);
        }
        rows.push(`<div class="session-row">${mainHtml}${autoHtml}</div>`);
    }
    if (mode === 'save') {
        rows.push(`
        <div class="session-row">
            <div class="session-card session-card-ghost" data-mode="save-new">
                <div class="session-card-ghost-plus">+</div>
                <div class="session-card-ghost-label">${t('save.newSlot')}</div>
            </div>
        </div>`);
    }
    if (!rows.length && mode === 'load') {
        box.innerHTML = `<div class="session-empty">${t('save.empty')}</div>`;
    } else {
        box.innerHTML = rows.join('');
    }
    bindCardEvents(box, mode);
}

function bindCardEvents(box, mode) {
    box.querySelectorAll('.session-card-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.sid;
            openDeleteConfirm(id, () => {
                deleteSession(id);
                renderSessionCards(box.id, { mode });
                // динамически скрыть «Продолжить», если сейвов больше нет
                try {
                    updateMenuButtonsForGameState(!!window.__gameStarted);
                } catch (_) {}
            });
        });
    });

    if (mode === 'load') {
        box.querySelectorAll('.session-card[data-sid]').forEach(card => {
            const startHold = (e) => {
                if (e.button != null && e.button !== 0) return;
                e.preventDefault();
                beginHold(card, 'load');
            };
            const endHold = () => cancelHold();
            card.addEventListener('mousedown', startHold);
            card.addEventListener('mouseup', endHold);
            card.addEventListener('mouseleave', endHold);
            card.addEventListener('touchstart', (e) => { e.preventDefault(); beginHold(card, 'load'); }, { passive: false });
            card.addEventListener('touchend', endHold);
            card.addEventListener('touchcancel', endHold);
        });
    }

    if (mode === 'save') {
        box.querySelectorAll('.session-card[data-sid]').forEach(card => {
            const startHold = (e) => {
                if (e.target.closest('.session-card-delete')) return;
                if (e.button != null && e.button !== 0) return;
                e.preventDefault();
                beginHold(card, 'save');
            };
            const endHold = () => cancelHold();
            card.addEventListener('mousedown', startHold);
            card.addEventListener('mouseup', endHold);
            card.addEventListener('mouseleave', endHold);
            card.addEventListener('touchstart', (e) => {
                if (e.target.closest('.session-card-delete')) return;
                e.preventDefault();
                beginHold(card, 'save');
            }, { passive: false });
            card.addEventListener('touchend', endHold);
            card.addEventListener('touchcancel', endHold);
        });
        box.querySelector('.session-card-ghost')?.addEventListener('click', () => {
            openNewSlotName();
        });
    }
}

function beginHold(card, action = 'load') {
    cancelHold();
    const id = card.dataset.sid;
    loadHoldId = id;
    loadHoldStart = performance.now();
    card.classList.add('holding');
    const ring = card.querySelector('.session-hold-ring');
    const len = Number(ring?.dataset.len) || 97.4;
    if (ring) {
        ring.style.strokeDashoffset = String(len);
        ring.style.opacity = '1';
    }

    const tick = (now) => {
        if (loadHoldId !== id) return;
        const p = Math.min(1, (now - loadHoldStart) / HOLD_MS);
        if (ring) ring.style.strokeDashoffset = String(len * (1 - p));
        if (p >= 1) {
            const act = action;
            cancelHold();
            if (act === 'save') {
                const name = getSession(id)?.name;
                overwriteSession(id, name);
                // обновить карточки и показать индикатор
                renderSessionCards('save-session-list', { mode: 'save' }).then(() => {
                    ensureSessionsFirmScroll();
                    flashSaved(t('save.overwritten') || 'Игровая сессия перезаписана');
                });
            } else {
                startLoadSession(id);
            }
            return;
        }
        loadHoldRaf = requestAnimationFrame(tick);
    };
    loadHoldRaf = requestAnimationFrame(tick);
}

let onLoadSessionCb = null;
export function setLoadSessionHandler(fn) {
    onLoadSessionCb = fn;
}

function startLoadSession(id) {
    closeLoadPanel();
    if (typeof onLoadSessionCb === 'function') onLoadSessionCb(id);
}

function openDeleteConfirm(id, onYes) {
    const modal = $('session-delete-modal');
    if (!modal) {
        if (confirm(t('save.deleteConfirm'))) onYes();
        return;
    }
    modal.classList.add('open');
    const yes = $('session-delete-yes');
    const no = $('session-delete-no');
    const cleanup = () => {
        modal.classList.remove('open');
        yes?.removeEventListener('click', onY);
        no?.removeEventListener('click', onN);
    };
    const onY = () => { cleanup(); onYes(); };
    const onN = () => cleanup();
    yes?.addEventListener('click', onY);
    no?.addEventListener('click', onN);
}

function openNewSlotName() {
    const modal = $('session-save-name-modal');
    const input = $('session-save-name-input');
    if (!modal || !input) {
        const name = prompt(t('save.namePrompt'), getSessionNameMemory() || '');
        if (name && name.trim()) {
            saveCurrentGame({ asNew: true, name: name.trim() });
            closeSavePanel();
            flashSaved();
        }
        return;
    }
    input.value = getSessionNameMemory() || '';
    modal.classList.add('open');
    const ok = $('session-save-name-ok');
    const cancel = $('session-save-name-cancel');
    const cleanup = () => modal.classList.remove('open');
    const onOk = () => {
        const name = input.value.trim();
        if (!name) return;
        setSessionNameMemory(name);
        saveCurrentGame({ asNew: true, name });
        cleanup();
        renderSessionCards('save-session-list', { mode: 'save' }).then(() => {
                    ensureSessionsFirmScroll();
            flashSaved(t('save.savedToast'));
        });
        // оставляем панель открытой с обновлённым списком

    };
    ok.onclick = onOk;
    cancel.onclick = cleanup;
}

function flashSaved(msg) {
    const toast = $('save-toast');
    if (!toast) return;
    toast.textContent = msg || t('save.savedToast');
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2200);
}

export function updateMenuButtonsForGameState(gameStarted) {
    const btnSave = $('btn-save-game');
    const btnLoad = $('btn-load-game');
    const btnContinue = $('btn-continue');
    const btnNew = $('btn-new-game');
    if (btnSave) btnSave.style.display = gameStarted ? '' : 'none';
    if (btnLoad) btnLoad.style.display = '';
    if (btnNew) {
        btnNew.style.display = '';
        btnNew.dataset.mode = 'new';
        try {
            const { t } = require ? null : null;
        } catch (_) {}
    }
    // Продолжить:
    // - в сессии: всегда (вернуться в текущую игру)
    // - на старте сайта: только если есть хотя бы один сейв (включая авто)
    if (btnContinue) {
        if (gameStarted) {
            btnContinue.style.display = '';
            btnContinue.dataset.mode = 'resume';
        } else {
            let has = false;
            try {
                has = listSessions({ includeAutosaves: true }).length > 0;
            } catch (_) { has = false; }
            btnContinue.style.display = has ? '' : 'none';
            btnContinue.dataset.mode = 'latest';
        }
    }
}

export function initSaveUI() {
    $('btn-load-game')?.addEventListener('click', () => openLoadPanel());
    $('btn-save-game')?.addEventListener('click', () => openSavePanel());
    $('load-close')?.addEventListener('click', closeLoadPanel);
    $('save-close')?.addEventListener('click', closeSavePanel);
    updateMenuButtonsForGameState(!!window.__gameStarted);
}
