/**
 * notepad.js — игровой блокнот (сессионный текст).
 * Содержимое хранится в state.notepadText и сохраняется в сессии.
 */

import { t } from './settings.js';
import { state } from './state.js';

let open = false;

/** Общий z-index стек для блокнота / калькулятора */
let utilityZ = 1200;
export function nextUtilityZ() {
    utilityZ = Math.max(1200, utilityZ + 1);
    return utilityZ;
}
export function bringUtilityWindowToFront(modalId) {
    const el = document.getElementById(modalId);
    if (!el || el.style.display === 'none') return;
    el.style.zIndex = String(nextUtilityZ());
}

let bound = false;

function ensureState() {
    if (typeof state.notepadText !== 'string') state.notepadText = '';
    return state.notepadText;
}

export function getNotepadText() {
    return ensureState();
}

export function setNotepadText(text) {
    state.notepadText = text == null ? '' : String(text);
}

export function captureNotepadSnapshot() {
    return ensureState();
}

export function applyNotepadSnapshot(text) {
    state.notepadText = text == null ? '' : String(text);
    const ta = document.getElementById('notepad-textarea');
    if (ta && !open) {
        // подгрузим при следующем открытии
    } else if (ta) {
        ta.value = state.notepadText;
        updateStatusBar(ta);
    }
}

function updateStatusBar(ta) {
    const lineEl = document.getElementById('notepad-stat-line');
    const colEl = document.getElementById('notepad-stat-col');
    const charsEl = document.getElementById('notepad-stat-chars');
    if (!ta) return;
    const val = ta.value;
    const pos = ta.selectionStart ?? 0;
    const before = val.slice(0, pos);
    const line = before.split('\n').length;
    const lastNl = before.lastIndexOf('\n');
    const col = pos - lastNl;
    if (lineEl) lineEl.textContent = String(line);
    if (colEl) colEl.textContent = String(col);
    if (charsEl) charsEl.textContent = String(val.length);
}

function syncFromTextarea() {
    const ta = document.getElementById('notepad-textarea');
    if (!ta) return;
    setNotepadText(ta.value);
    updateStatusBar(ta);
}

export function isNotepadOpen() {
    return open;
}

export function openNotepad() {
    const modal = document.getElementById('notepad-modal');
    const ta = document.getElementById('notepad-textarea');
    if (!modal) return;
    ensureState();
    if (ta) {
        ta.value = state.notepadText;
        updateStatusBar(ta);
    }
    modal.style.display = 'flex';
    open = true;
    document.getElementById('notepad-btn')?.classList.add('active');
    bringUtilityWindowToFront('notepad-modal');
    requestAnimationFrame(() => {
        ta?.focus();
    });
}

export function closeNotepad() {
    const modal = document.getElementById('notepad-modal');
    const ta = document.getElementById('notepad-textarea');
    if (ta) setNotepadText(ta.value);
    if (modal) modal.style.display = 'none';
    open = false;
    document.getElementById('notepad-btn')?.classList.remove('active');
}

export function toggleNotepad() {
    if (open) closeNotepad();
    else openNotepad();
}

export function initNotepad() {
    if (bound) return;
    bound = true;
    ensureState();

    const btn = document.getElementById('notepad-btn');
    const closeBtn = document.getElementById('notepad-close');
    const ta = document.getElementById('notepad-textarea');
    const modal = document.getElementById('notepad-modal');

    btn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNotepad();
    });
    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeNotepad();
    });

    if (ta) {
        ta.addEventListener('input', syncFromTextarea);
        ta.addEventListener('keyup', () => updateStatusBar(ta));
        ta.addEventListener('click', () => updateStatusBar(ta));
        ta.addEventListener('select', () => updateStatusBar(ta));
    }

    // Escape закрывает
    document.addEventListener('keydown', (e) => {
        if (!open) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeNotepad();
        }
    });

    // клик по backdrop
    modal?.addEventListener('click', (e) => {
        if (e.target === modal) closeNotepad();
    });

    const win = modal?.querySelector('.notepad-window');
    win?.addEventListener('mousedown', () => bringUtilityWindowToFront('notepad-modal'));
    win?.addEventListener('focusin', () => bringUtilityWindowToFront('notepad-modal'));
}

