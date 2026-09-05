/**
 * epochalMusic.js — эпохальная музыка (OST).
 *
 * Потоки не предзагружаются: в памяти один текущий Audio.
 * Громкость = master × music из настроек.
 * Во время интро этот плеер молчит (интро играет своё).
 */

import { getLang, getEffectiveVolume, onVolumeChange, onLanguageChange } from './settings.js';
import { isChapter2Done } from './uiMasks.js';

const OST = 'assets/audio/OST/';

const TRACKS = {
    dark_wind: OST + 'snd_bgs_dark_wind.mp3',
    chrome_orchard: OST + 'Chrome_Orchard.mp3',
    power_of_science: OST + 'The_power_of_science.mp3',
    chrome_comet: OST + 'Chrome_Comet.mp3',
    salt_satellite: OST + 'Salt_Satellite.mp3',
    sail_ru: OST + 'Through_the_silent_void_we_sail_ru.mp3',
    sail_en: OST + 'Through_the_silent_void_we_sail_en.mp3',
    sand_of_the_epochs: OST + 'Sand_of_the_Epochs.mp3',
    lunar_winds: OST + 'Lunar_winds_in_hearts.mp3',
    boulder_in_space: OST + 'A_boulder_in_space.mp3',
    cosmos: OST + 'A_cosmos_of_possibilities.mp3',
    magnetic_neon: OST + 'Magnetic_fields_of_neon_fields.mp3',
    production_chains: OST + 'Production_chains.mp3'
};

/** Случайный пул внутри сессии (после главы 2). sail — логический id. */
const GAME_POOL = [
    'chrome_orchard',
    'power_of_science',
    'chrome_comet',
    'salt_satellite',
    'sail',
    'sand_of_the_epochs',
    'lunar_winds',
    'boulder_in_space',
    'cosmos',
    'magnetic_neon',
    'production_chains'
];

/** Пул главного меню (и холодный старт сайта). */
const MENU_POOL = [
    'salt_satellite',
    'cosmos',
    'sail'
];

const FADE_LANG_MS = 3000;
const FADE_CTX_MS = 700;

let audio = null;
let currentLogical = null;   // 'dark_wind' | 'sail' | 'cosmos' | ...
let currentFileKey = null;   // реальный ключ TRACKS
let lastLogical = null;
let wantedLogical = null;
let fading = false;
let pausedForIntro = false;
let unlocked = false;
let fadeTimer = null;
let pollTimer = null;
let inited = false;

function isMenuActive() {
    return document.body.classList.contains('main-menu-active');
}

function isSessionLive() {
    return !!window.__gameStarted;
}

function sailFileKey() {
    return getLang() === 'ru' ? 'sail_ru' : 'sail_en';
}

function resolveFileKey(logical) {
    if (logical === 'sail') return sailFileKey();
    return logical;
}

function targetVolume() {
    return getEffectiveVolume('music');
}

function applyVolumeNow() {
    if (!audio) return;
    if (fading) return;
    audio.volume = Math.max(0, Math.min(1, targetVolume()));
}

function clearFade() {
    if (fadeTimer) {
        clearInterval(fadeTimer);
        fadeTimer = null;
    }
    fading = false;
}

function fadeTo(vol, ms) {
    return new Promise((resolve) => {
        if (!audio) { resolve(); return; }
        clearFade();
        const start = audio.volume;
        const dest = Math.max(0, Math.min(1, vol));
        const dur = Math.max(40, ms || 400);
        const t0 = performance.now();
        fading = true;
        fadeTimer = setInterval(() => {
            if (!audio) { clearFade(); resolve(); return; }
            const k = Math.min(1, (performance.now() - t0) / dur);
            audio.volume = start + (dest - start) * k;
            if (k >= 1) {
                clearFade();
                audio.volume = dest;
                resolve();
            }
        }, 40);
    });
}

function destroyAudio() {
    clearFade();
    if (!audio) return;
    try { audio.pause(); } catch (_) {}
    try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
    audio.onended = null;
    audio.onerror = null;
    audio = null;
}

function pickNext(pool) {
    const list = (pool || []).filter(Boolean);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    const avoid = lastLogical || currentLogical;
    const filtered = list.filter(id => id !== avoid);
    const src = filtered.length ? filtered : list;
    return src[Math.floor(Math.random() * src.length)];
}

function neededMode() {
    if (pausedForIntro || window.__introActive) return 'intro';
    const session = isSessionLive();
    const menu = isMenuActive();
    let ch2 = false;
    try { ch2 = isChapter2Done(); } catch (_) { ch2 = false; }

    if (session && !ch2) return 'wind';
    if (!session) return 'menu';
    if (menu) return 'menu';
    return 'game';
}

function playLogical(logical, { loop = false, onFailNext = true } = {}) {
    if (!logical) return;
    const fileKey = resolveFileKey(logical);
    const src = TRACKS[fileKey];
    if (!src) return;

    destroyAudio();
    currentLogical = logical;
    currentFileKey = fileKey;
    lastLogical = logical;
    wantedLogical = logical;

    const a = new Audio();
    a.preload = 'none';
    a.src = src;
    a.loop = !!loop;
    a.volume = targetVolume();
    a.onended = () => {
        if (a.loop) return;
        currentLogical = null;
        syncEpochalMusic({ reason: 'ended' });
    };
    a.onerror = () => {
        console.warn('[epochalMusic] missing/failed', src);
        currentLogical = null;
        if (onFailNext) {
            lastLogical = logical;
            setTimeout(() => syncEpochalMusic({ reason: 'error', skip: logical }), 200);
        }
    };
    audio = a;
    if (!unlocked) return;
    a.play().catch(() => {});
}

function startWind() {
    if (currentLogical === 'dark_wind' && audio && !audio.paused) {
        applyVolumeNow();
        return;
    }
    playLogical('dark_wind', { loop: true, onFailNext: false });
}

function isTrackPlaying() {
    return !!(audio && currentLogical && !audio.paused && !audio.ended);
}

function startPool(pool, skipId) {
    const next = pickNext(pool.filter(id => id !== skipId));
    if (!next) return;
    if (currentLogical === next && audio && !audio.paused) {
        if (next === 'sail' && currentFileKey !== sailFileKey()) {
            switchSailLanguage();
            return;
        }
        applyVolumeNow();
        return;
    }
    playLogical(next, { loop: false });
}

async function switchSailLanguage() {
    if (!audio || currentLogical !== 'sail') return;
    const nextKey = sailFileKey();
    if (currentFileKey === nextKey) return;
    const keepTime = audio.currentTime || 0;
    await fadeTo(0, FADE_LANG_MS);
    if (currentLogical !== 'sail') return;
    destroyAudio();
    currentLogical = 'sail';
    currentFileKey = nextKey;
    lastLogical = 'sail';
    const a = new Audio();
    a.preload = 'none';
    a.src = TRACKS[nextKey];
    a.loop = false;
    a.volume = 0;
    a.onended = () => {
        currentLogical = null;
        syncEpochalMusic({ reason: 'ended' });
    };
    a.onerror = () => {
        currentLogical = null;
        syncEpochalMusic({ reason: 'error' });
    };
    audio = a;
    const playP = unlocked ? a.play().catch(() => {}) : Promise.resolve();
    Promise.resolve(playP).then(async () => {
        try { if (Number.isFinite(keepTime)) a.currentTime = keepTime; } catch (_) {}
        await fadeTo(targetVolume(), 800);
    });
}

export function pauseEpochalMusic() {
    pausedForIntro = true;
    window.__introActive = true;
    // Интро и его пропуск: меню-трек не доигрываем
    destroyAudio();
    currentLogical = null;
    currentFileKey = null;
}

export function resumeEpochalMusic() {
    pausedForIntro = false;
    window.__introActive = false;
    syncEpochalMusic({ reason: 'intro-end' });
}

export function syncEpochalMusic(opts = {}) {
    const mode = neededMode();
    if (mode === 'intro') {
        if (audio && !audio.paused) {
            try { audio.pause(); } catch (_) {}
        }
        return;
    }
    if (!unlocked && mode !== 'intro') {
        wantedLogical = mode === 'wind' ? 'dark_wind' : null;
    }
    if (mode === 'wind') {
        // Холодная загрузка сейва без главы 2 — обрываем меню-трек и сразу ставим ветер
        const forceWind = opts.reason === 'session-loaded' || opts.reason === 'intro-end';
        if (!forceWind && isTrackPlaying() && currentLogical !== 'dark_wind') {
            applyVolumeNow();
            return;
        }
        startWind();
        return;
    }
    // После главы 2: текущий трек доигрывается при выходе в меню и при возврате в игру
    const force = opts.reason === 'ended' || opts.reason === 'error' || opts.reason === 'ch2-done';
    if (!force && isTrackPlaying() && currentLogical !== 'dark_wind') {
        applyVolumeNow();
        return;
    }
    const pool = mode === 'menu' ? MENU_POOL : GAME_POOL;
    startPool(pool, opts.skip);
}

function tryUnlock() {
    unlocked = true;
    if (pausedForIntro || window.__introActive) return;
    if (audio && currentLogical) {
        audio.volume = targetVolume();
        audio.play().catch(() => {});
        return;
    }
    syncEpochalMusic({ reason: 'unlock' });
}

export function initEpochalMusic() {
    if (inited) return;
    inited = true;
    window.__introActive = !!window.__introActive;

    onVolumeChange(() => applyVolumeNow());
    onLanguageChange(() => {
        if (currentLogical === 'sail') switchSailLanguage();
    });

    const unlock = () => tryUnlock();
    document.addEventListener('pointerdown', unlock, { once: false });
    document.addEventListener('keydown', unlock, { once: false });

    pollTimer = setInterval(() => {
        if (pausedForIntro || window.__introActive) return;
        const mode = neededMode();
        if (mode === 'wind' && currentLogical !== 'dark_wind' && !isTrackPlaying()) {
            syncEpochalMusic({ reason: 'ch2-poll' });
        } else if (mode !== 'wind' && currentLogical === 'dark_wind') {
            fadeTo(0, FADE_CTX_MS).then(() => {
                destroyAudio();
                currentLogical = null;
                syncEpochalMusic({ reason: 'ch2-done' });
            });
        }
    }, 1500);

    // холодный старт: меню вне сессии
    syncEpochalMusic({ reason: 'init' });
    // автоплей может быть запрещён — жест снимет блок
    tryUnlock();
}