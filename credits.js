/**
 * Титры / Авторы главного меню.
 * Чёрный экран → прокрутка снизу вверх → возврат в меню.
 * Escape прерывает раньше.
 */
import { t, onLanguageChange, closeSettingsPanel } from './settings.js';

const FADE_IN_MS = 850;
const ROLL_MS = 18000;
const TEXT_FADE_MS = 700;
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

function resetCreditsInline() {
    const roll = document.getElementById('credits-roll');
    const hint = document.getElementById('credits-hint');
    if (roll) {
        roll.style.animation = '';
        roll.style.animationPlayState = '';
        roll.style.transform = '';
        roll.style.opacity = '';
        roll.style.transition = '';
        roll.style.left = '';
        roll.style.top = '';
        roll.style.width = '';
    }
    if (hint) {
        hint.style.opacity = '';
        hint.style.transition = '';
    }
}

function finishCredits() {
    const el = screenEl();
    running = false;
    clearTimers();
    if (!el) return;
    el.classList.remove('open', 'fading-in', 'fading-out', 'rolling', 'text-out');
    el.setAttribute('aria-hidden', 'true');
    resetCreditsInline();
}

function fadeCreditsTextThenScreen() {
    const el = screenEl();
    if (!el) return;
    clearTimers();
    el.classList.remove('fading-in', 'fading-out');

    const roll = document.getElementById('credits-roll');
    const hint = document.getElementById('credits-hint');
    let alreadyGone = true;
    if (roll) {
        const cs = getComputedStyle(roll);
        const op = parseFloat(cs.opacity);
        if (Number.isFinite(op) && op > 0.04) alreadyGone = false;
        const hostBox = el.getBoundingClientRect();
        const box = roll.getBoundingClientRect();
        roll.style.animationPlayState = 'paused';
        roll.style.left = (box.left - hostBox.left) + 'px';
        roll.style.top = (box.top - hostBox.top) + 'px';
        roll.style.width = box.width + 'px';
        roll.style.transform = 'none';
        roll.style.opacity = String(Number.isFinite(op) ? op : 1);
        roll.style.animation = 'none';
        void roll.offsetWidth;
        roll.style.transition = `opacity ${TEXT_FADE_MS}ms ease`;
        roll.style.opacity = '0';
    }
    if (hint) {
        const hop = parseFloat(getComputedStyle(hint).opacity);
        if (Number.isFinite(hop) && hop > 0.04) alreadyGone = false;
        hint.style.transition = `opacity ${TEXT_FADE_MS}ms ease`;
        hint.style.opacity = '0';
    }
    el.classList.remove('rolling');
    el.classList.add('text-out');

    const wait = alreadyGone ? 80 : TEXT_FADE_MS;
    phaseTimer = window.setTimeout(() => {
        el.classList.add('fading-out');
        fadeOutTimer = window.setTimeout(finishCredits, FADE_OUT_MS);
    }, wait);
}

export function closeCredits() {
    const el = screenEl();
    if (!el || !running) return;
    if (el.classList.contains('text-out') || el.classList.contains('fading-out')) return;
    fadeCreditsTextThenScreen();
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

    resetCreditsInline();
    el.classList.remove('fading-out', 'rolling', 'text-out');
    el.classList.add('open', 'fading-in');
    el.setAttribute('aria-hidden', 'false');

    const roll = document.getElementById('credits-roll');
    if (roll) {
        roll.style.animation = 'none';
        void roll.offsetWidth;
        roll.style.animation = '';
    }

    // чёрный экран уже держит opacity:1 через .open; fading-in только на вход
    requestAnimationFrame(() => {
        el.classList.add('rolling');
    });

    phaseTimer = window.setTimeout(() => {
        fadeCreditsTextThenScreen();
    }, FADE_IN_MS + ROLL_MS);
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
