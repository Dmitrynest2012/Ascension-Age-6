/**
 * Титры / Авторы главного меню.
 * Чёрный экран → прокрутка снизу вверх → возврат в меню.
 * Escape прерывает раньше.
 */
import { t, onLanguageChange, closeSettingsPanel } from './settings.js';

const FADE_IN_MS = 850;
const ROLL_MS = 18000;
const FADE_OUT_MS = 800;

let running = false;
let phaseTimer = 0;
let fadeOutTimer = 0;

export function isCreditsOpen() {
    return running;
}

function screenEl() {
    return document.getElementById('credits-screen');
}

function applyCreditsLocalization() {
    const set = (id, key, fallback) => {
        const el = document.getElementById(id);
        if (el) el.textContent = t(key) || fallback;
    };
    set('credits-title', 'game.titleMain', 'ВОЗНЕСЕНИЕ');
    set('credits-sub', 'game.titleSub', 'ЭПОХА-6');
    set('credits-role-code', 'credits.role.code', 'Код и геймдизайн');
    set('credits-name-code', 'credits.name.code', 'Нестеров Дмитрий');
    set('credits-role-music', 'credits.role.music', 'Музыка');
    set('credits-name-music', 'credits.value.music', 'создано в Suno');
    set('credits-role-graphics', 'credits.role.graphics', 'Графика');
    set('credits-name-graphics', 'credits.value.graphics', 'создано в ChatGPT, Grok, Kandinsky');
    set('credits-hint', 'credits.hint', 'Esc — выход');
}

function clearTimers() {
    if (phaseTimer) {
        clearTimeout(phaseTimer);
        phaseTimer = 0;
    }
    if (fadeOutTimer) {
        clearTimeout(fadeOutTimer);
        fadeOutTimer = 0;
    }
}

function finishCredits() {
    const el = screenEl();
    running = false;
    clearTimers();
    if (!el) return;
    el.classList.remove('open', 'fading-in', 'fading-out', 'rolling');
    el.setAttribute('aria-hidden', 'true');
}

export function closeCredits() {
    const el = screenEl();
    if (!el || !running) return;
    clearTimers();
    el.classList.remove('fading-in', 'rolling');
    el.classList.add('fading-out');
    fadeOutTimer = window.setTimeout(finishCredits, FADE_OUT_MS);
}

export function openCredits() {
    const el = screenEl();
    if (!el || running) return;
    running = true;
    applyCreditsLocalization();
    try { closeSettingsPanel(); } catch (_) {}
    try {
        import('./saveUI.js').then(m => {
            m.closeLoadPanel?.();
            m.closeSavePanel?.();
        }).catch(() => {});
    } catch (_) {}

    el.classList.remove('fading-out', 'rolling');
    el.classList.add('open', 'fading-in');
    el.setAttribute('aria-hidden', 'false');

    phaseTimer = window.setTimeout(() => {
        el.classList.remove('fading-in');
        el.classList.add('rolling');
        phaseTimer = window.setTimeout(() => {
            el.classList.remove('rolling');
            el.classList.add('fading-out');
            fadeOutTimer = window.setTimeout(finishCredits, FADE_OUT_MS);
        }, ROLL_MS);
    }, FADE_IN_MS);
}

export function initCreditsUI() {
    applyCreditsLocalization();
    onLanguageChange(applyCreditsLocalization);

    document.getElementById('btn-credits')?.addEventListener('click', () => {
        openCredits();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!running) return;
        e.preventDefault();
        e.stopPropagation();
        closeCredits();
    }, true);
}
