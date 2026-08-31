/**
 * Настройки главного меню + локализация интерфейса.
 * Вкладки: Игра / Графика / Звук.
 *
 * localStorage (v1):
 *   ascension_era6_system   — системные настройки (язык, графика, звук, fullscreen)
 *   ascension_era6_sessions — игровые сессии (позже)
 */

let uiLoc = null;
let currentLang = 'ru';
/** Каналы громкости 0–100. Итоговый уровень канала = master * channel / 100 */
let volumes = {
    master: 70,
    music: 50,
    voice: 80,
    ambient: 50,
    sfx: 70
};
let quality = 'medium';
/** Интервал автосохранения в минутах (0 = выкл) */
let autosaveMinutes = 0;
let onLanguageChangeCallbacks = [];
let onVolumeChangeCallbacks = [];

const LANG_OPTIONS = [
    { value: 'ru', label: 'Русский' },
    { value: 'en', label: 'English' },
    { value: 'de', label: 'Deutsch' }
];

/** localStorage keys */
const LS_SYSTEM_KEY = 'ascension_era6_system';
const LS_SESSIONS_KEY = 'ascension_era6_sessions';

let settingsDirty = false;
let preferredFullscreen = false;
/** Показывать video-аватар зданий при наличии avatarVideo */
let buildingVideoAvatars = true;
/** Навигатор небесных тел (по умолчанию выключен) */
let showNavigator = false;
let savedIndicatorTimer = null;

function readSystemSettings() {
    try {
        const raw = localStorage.getItem(LS_SYSTEM_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data : null;
    } catch (_) {
        return null;
    }
}

function writeSystemSettings(data) {
    try {
        localStorage.setItem(LS_SYSTEM_KEY, JSON.stringify(data));
        return true;
    } catch (e) {
        console.warn('localStorage write failed', e);
        return false;
    }
}

export function clearSystemSettings() {
    try { localStorage.removeItem(LS_SYSTEM_KEY); } catch (_) {}
}

/** Применить сохранённые системные настройки при старте (до UI). */
export function loadAndApplySystemSettings() {
    const data = readSystemSettings();
    if (!data) return false;
    if (data.lang && ['ru', 'en', 'de'].includes(data.lang)) {
        currentLang = data.lang;
    }
    if (data.quality && ['low', 'medium', 'high'].includes(data.quality)) {
        quality = data.quality;
    }
    if (data.volumes && typeof data.volumes === 'object') {
        for (const ch of Object.keys(volumes)) {
            if (data.volumes[ch] != null) {
                volumes[ch] = Math.max(0, Math.min(100, Number(data.volumes[ch]) || 0));
            }
        }
    }
    if (typeof data.fullscreen === 'boolean') {
        preferredFullscreen = data.fullscreen;
    }
    if (data.autosaveMinutes != null) {
        const n = Math.max(0, Math.min(60, Math.round(Number(data.autosaveMinutes) || 0)));
        autosaveMinutes = n;
    }
    if (typeof data.buildingVideoAvatars === 'boolean') {
        buildingVideoAvatars = data.buildingVideoAvatars;
    }
    if (typeof data.showNavigator === 'boolean') {
        showNavigator = data.showNavigator;
    }
    return true;
}

function collectSystemSettings() {
    return {
        version: 1,
        lang: currentLang,
        quality,
        volumes: { ...volumes },
        fullscreen: !!(typeof document !== 'undefined' && document.fullscreenElement) || preferredFullscreen,
        autosaveMinutes,
        buildingVideoAvatars,
        showNavigator
    };
}

function markSettingsDirty() {
    settingsDirty = true;
    updateSettingsFooterUI();
}

function markSettingsClean() {
    settingsDirty = false;
    updateSettingsFooterUI();
}

function updateSettingsFooterUI() {
    const applyBtn = document.getElementById('settings-apply');
    if (!applyBtn) return;
    if (settingsDirty) {
        applyBtn.style.display = '';
        requestAnimationFrame(() => applyBtn.classList.add('visible'));
    } else {
        applyBtn.classList.remove('visible');
        setTimeout(() => {
            if (!settingsDirty && applyBtn) applyBtn.style.display = 'none';
        }, 320);
    }
}

function showSettingsSavedIndicator() {
    const savedBtn = document.getElementById('settings-saved-indicator');
    if (!savedBtn) return;
    if (savedIndicatorTimer) {
        clearTimeout(savedIndicatorTimer);
        savedIndicatorTimer = null;
    }
    savedBtn.style.display = '';
    requestAnimationFrame(() => savedBtn.classList.add('visible'));
    savedIndicatorTimer = setTimeout(() => {
        savedBtn.classList.remove('visible');
        setTimeout(() => {
            if (savedBtn && !savedBtn.classList.contains('visible')) {
                savedBtn.style.display = 'none';
            }
        }, 320);
        savedIndicatorTimer = null;
    }, 2200);
}

function applySystemSettingsToControls() {
    const langSelect = document.getElementById('settings-language');
    if (langSelect) langSelect.value = currentLang;

    const qualitySelect = document.getElementById('settings-quality');
    if (qualitySelect) qualitySelect.value = quality;

    ['master', 'music', 'voice', 'ambient', 'sfx'].forEach(ch => {
        const slider = document.getElementById('settings-vol-' + ch);
        const valueEl = document.getElementById('settings-vol-' + ch + '-value');
        if (slider) slider.value = String(volumes[ch]);
        if (valueEl) valueEl.textContent = volumes[ch] + '%';
    });
    const asSlider = document.getElementById('settings-autosave');
    const asVal = document.getElementById('settings-autosave-value');
    if (asSlider) asSlider.value = String(autosaveMinutes);
    if (asVal) asVal.textContent = formatAutosaveLabel(autosaveMinutes);
    const navBtn2 = document.getElementById('settings-navigator');
    if (navBtn2) {
        navBtn2.dataset.on = showNavigator ? '1' : '0';
        navBtn2.textContent = showNavigator
            ? (t('settings.on') || 'Вкл.')
            : (t('settings.off') || 'Выкл.');
    }
}

function formatAutosaveLabel(mins) {
    const m = Math.max(0, Math.min(60, Number(mins) || 0));
    if (m <= 0) return t('settings.autosave.off') || 'без авто-сохранений';
    return m + ' ' + (t('settings.autosave.min') || 'мин');
}

export function applyAndSaveSystemSettings() {
    preferredFullscreen = !!document.fullscreenElement;
    writeSystemSettings(collectSystemSettings());
    markSettingsClean();
    showSettingsSavedIndicator();
}

export function resetSystemSettingsAndReload() {
    clearSystemSettings();
    window.location.reload();
}

export function getLang() {
    return currentLang;
}

/** Обратная совместимость: общая (master) громкость 0–100 */
export function getVolume() {
    return volumes.master;
}

export function getVolumes() {
    return { ...volumes };
}

/**
 * Эффективная громкость 0..1 для канала: master × channel.
 * channel: 'music' | 'voice' | 'ambient' | 'sfx'
 */
export function getEffectiveVolume(channel = 'master') {
    const m = (volumes.master ?? 70) / 100;
    if (channel === 'master') return m;
    const c = (volumes[channel] ?? 70) / 100;
    return Math.max(0, Math.min(1, m * c));
}

export function setVolume(channel, value) {
    if (!(channel in volumes)) return;
    volumes[channel] = Math.max(0, Math.min(100, Number(value) || 0));
    notifyVolumeChange();
}

export function onVolumeChange(cb) {
    if (typeof cb === 'function') onVolumeChangeCallbacks.push(cb);
}

function notifyVolumeChange() {
    onVolumeChangeCallbacks.forEach(cb => {
        try { cb(getVolumes()); } catch (e) { console.warn(e); }
    });
}

export function getBuildingVideoAvatars() {
    return !!buildingVideoAvatars;
}

export function getShowNavigator() {
    return !!showNavigator;
}

export function setShowNavigator(v) {
    showNavigator = !!v;
    try {
        import('./navigator.js').then(m => m.setNavigatorEnabled(showNavigator)).catch(() => {});
    } catch (_) {}
}

export function getQuality() {
    return quality;
}

export function getAutosaveMinutes() {
    return autosaveMinutes;
}

export function setAutosaveMinutes(v) {
    autosaveMinutes = Math.max(0, Math.min(60, Math.round(Number(v) || 0)));
}


export function t(key) {
    if (!uiLoc) return key;
    const pack = uiLoc[currentLang] || uiLoc.ru || {};
    return pack[key] ?? uiLoc.ru?.[key] ?? key;
}

/**
 * Локализованное имя/текст из JSON-поля.
 * Поддерживает: string | [ru,en,de] | {ru,en,de}
 */
export function locName(value, fallback = '') {
    if (value == null) return fallback;
    if (typeof value === 'string') return value || fallback;
    if (Array.isArray(value)) {
        const idx = currentLang === 'en' ? 1 : currentLang === 'de' ? 2 : 0;
        return value[idx] || value[0] || value[1] || fallback;
    }
    if (typeof value === 'object') {
        return value[currentLang] || value.ru || value.en || value.de || fallback;
    }
    return fallback;
}

/** Подписка на смену языка (чтобы UI мог перерисовать динамические панели) */
export function onLanguageChange(cb) {
    if (typeof cb === 'function') onLanguageChangeCallbacks.push(cb);
}

export async function loadUiLocalization() {
    try {
        const res = await fetch('uiLocalization.json');
        uiLoc = await res.json();
        console.log('UI localization loaded');
    } catch (e) {
        console.error('Failed to load uiLocalization.json', e);
        uiLoc = { ru: {}, en: {}, de: {} };
    }
}

/** Применить переводы ко всем элементам с data-i18n / data-i18n-title */
export function applyUiLocalization() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (!key) return;
        const text = t(key);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.placeholder = text;
            return;
        }
        // Кнопки стройки с плановым инпутом: не трогать textContent (уничтожит input)
        const planLabel = el.querySelector?.('.building-button-label');
        const planInput = el.querySelector?.('.plan-target-input');
        if (planLabel || planInput) {
            if (planLabel) planLabel.textContent = text;
            else {
                // label ещё нет — не затираем детей
                for (const node of Array.from(el.childNodes)) {
                    if (node.nodeType === 3) node.textContent = text;
                }
            }
            return;
        }
        el.textContent = text;
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) el.title = t(key);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) el.placeholder = t(key);
    });

    const titleKey = document.querySelector('title')?.getAttribute('data-i18n-doc-title') || 'game.title';
    document.title = t(titleKey);
    try { if (typeof window.harvestTooltips === 'function') window.harvestTooltips(document); } catch (_) {}

    const qualitySelect = document.getElementById('settings-quality');
    if (qualitySelect) {
        const optMap = {
            low: 'settings.quality.low',
            medium: 'settings.quality.medium',
            high: 'settings.quality.high'
        };
        Array.from(qualitySelect.options).forEach(opt => {
            const k = optMap[opt.value];
            if (k) opt.textContent = t(k);
        });
    }

    updateFullscreenButtonLabel();
    updatePrimaryMenuButton();
    const asVal2 = document.getElementById('settings-autosave-value');
    const asSlider2 = document.getElementById('settings-autosave');
    if (asVal2) {
        const m = asSlider2 ? Number(asSlider2.value) : autosaveMinutes;
        asVal2.textContent = formatAutosaveLabel(m);
    }
    const navBtnLoc = document.getElementById('settings-navigator');
    if (navBtnLoc) {
        navBtnLoc.textContent = showNavigator
            ? (t('settings.on') || 'Вкл.')
            : (t('settings.off') || 'Выкл.');
    }
}

function updateFullscreenButtonLabel() {
    const btn = document.getElementById('settings-fullscreen');
    if (!btn) return;
    btn.textContent = document.fullscreenElement
        ? t('settings.fullscreen.off')
        : t('settings.fullscreen.on');
}

export function updatePrimaryMenuButton(gameStarted = null) {
    // совместимость: делегируем в полное обновление кнопок меню
    try {
        // ленивый импорт чтобы не плодить циклы
        import('./saveUI.js').then(m => {
            if (m.updateMenuButtonsForGameState) {
                const started = gameStarted != null
                    ? gameStarted
                    : (typeof window.__gameStarted === 'boolean' ? window.__gameStarted : false);
                m.updateMenuButtonsForGameState(started);
            }
        }).catch(() => {});
    } catch (_) {}
    const btnNew = document.getElementById('btn-new-game');
    if (btnNew) {
        btnNew.textContent = t('mainMenu.newGame');
        btnNew.dataset.mode = 'new';
    }
}

function switchSettingsTab(tabId) {
    document.querySelectorAll('.settings-tab').forEach(tab => {
        const active = tab.dataset.tab === tabId;
        tab.classList.toggle('active', active);
        tab.classList.toggle('inactive', !active);
    });
    document.querySelectorAll('.settings-tab-panel').forEach(panel => {
        panel.style.display = panel.dataset.panel === tabId ? 'flex' : 'none';
    });
    updateSettingsFooterUI();
}

export function openSettingsPanel() {
    const panel = document.getElementById('main-menu-settings');
    if (panel) {
        panel.style.display = 'block';
        switchSettingsTab('game');
        applySystemSettingsToControls();
        applyUiLocalization();
        updateSettingsFooterUI();
    }
}

export function closeSettingsPanel() {
    const panel = document.getElementById('main-menu-settings');
    if (panel) panel.style.display = 'none';
}

export function setLanguage(lang) {
    if (!['ru', 'en', 'de'].includes(lang)) return;
    currentLang = lang;
    applyUiLocalization();
    const runCallbacks = () => {
        onLanguageChangeCallbacks.forEach(cb => {
            try { cb(currentLang); } catch (e) { console.warn(e); }
        });
    };
    try {
        import('./quests.js').then(mod => {
            if (typeof mod.setQuestLang === 'function') mod.setQuestLang(currentLang);
            runCallbacks();
        }).catch(() => runCallbacks());
    } catch (_) {
        runCallbacks();
    }
}

export function initSettings() {
    loadAndApplySystemSettings();

    const settingsClose = document.getElementById('settings-close');
    const qualitySelect = document.getElementById('settings-quality');
    const settingsFullscreen = document.getElementById('settings-fullscreen');
    const langSelect = document.getElementById('settings-language');
    const applyBtn = document.getElementById('settings-apply');
    const resetBtn = document.getElementById('settings-reset');

    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => switchSettingsTab(tab.dataset.tab));
    });

    if (settingsClose) {
        settingsClose.addEventListener('click', closeSettingsPanel);
    }

    const volChannels = ['master', 'music', 'voice', 'ambient', 'sfx'];
    volChannels.forEach(ch => {
        const slider = document.getElementById('settings-vol-' + ch);
        const valueEl = document.getElementById('settings-vol-' + ch + '-value');
        if (!slider) return;
        slider.value = String(volumes[ch]);
        if (valueEl) valueEl.textContent = volumes[ch] + '%';
        slider.addEventListener('input', () => {
            volumes[ch] = Number(slider.value);
            if (valueEl) valueEl.textContent = volumes[ch] + '%';
            notifyVolumeChange();
            markSettingsDirty();
        });
    });

    if (qualitySelect) {
        qualitySelect.value = quality;
        qualitySelect.addEventListener('change', () => {
            quality = qualitySelect.value;
            markSettingsDirty();
        });
    }

    const buildingVideoBtn = document.getElementById('settings-building-video');
    function syncBuildingVideoBtn() {
        if (!buildingVideoBtn) return;
        buildingVideoBtn.dataset.on = buildingVideoAvatars ? '1' : '0';
        buildingVideoBtn.textContent = buildingVideoAvatars
            ? (t('settings.on') || 'Вкл.')
            : (t('settings.off') || 'Выкл.');
    }
    syncBuildingVideoBtn();
    if (buildingVideoBtn) {
        buildingVideoBtn.addEventListener('click', () => {
            buildingVideoAvatars = !buildingVideoAvatars;
            syncBuildingVideoBtn();
            markSettingsDirty();
        });
    }

    const navBtn = document.getElementById('settings-navigator');
    function syncNavigatorBtn() {
        if (!navBtn) return;
        navBtn.dataset.on = showNavigator ? '1' : '0';
        navBtn.textContent = showNavigator
            ? (t('settings.on') || 'Вкл.')
            : (t('settings.off') || 'Выкл.');
    }
    syncNavigatorBtn();
    if (navBtn) {
        navBtn.addEventListener('click', () => {
            showNavigator = !showNavigator;
            syncNavigatorBtn();
            try {
                import('./navigator.js').then(m => m.setNavigatorEnabled(showNavigator)).catch(() => {});
            } catch (_) {}
            markSettingsDirty();
        });
    }


    if (langSelect) {
        langSelect.innerHTML = '';
        LANG_OPTIONS.forEach(({ value, label }) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            if (value === currentLang) opt.selected = true;
            langSelect.appendChild(opt);
        });
        langSelect.addEventListener('change', () => {
            setLanguage(langSelect.value);
            markSettingsDirty();
        });
    }

    const asSlider = document.getElementById('settings-autosave');
    const asVal = document.getElementById('settings-autosave-value');
    if (asSlider) {
        asSlider.value = String(autosaveMinutes);
        if (asVal) asVal.textContent = formatAutosaveLabel(autosaveMinutes);
        asSlider.addEventListener('input', () => {
            autosaveMinutes = Math.max(0, Math.min(60, Math.round(Number(asSlider.value) || 0)));
            if (asVal) asVal.textContent = formatAutosaveLabel(autosaveMinutes);
            markSettingsDirty();
            try {
                import('./saveSystem.js').then(m => m.resyncAutosaveTimer?.()).catch(() => {});
            } catch (_) {}
        });
    }

    if (settingsFullscreen) {
        settingsFullscreen.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
                preferredFullscreen = true;
            } else {
                document.exitFullscreen();
                preferredFullscreen = false;
            }
            markSettingsDirty();
        });
        document.addEventListener('fullscreenchange', () => {
            preferredFullscreen = !!document.fullscreenElement;
            updateFullscreenButtonLabel();
        });
    }

    if (applyBtn) {
        applyBtn.style.display = 'none';
        applyBtn.classList.remove('visible');
        applyBtn.addEventListener('click', () => {
            applyAndSaveSystemSettings();
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetSystemSettingsAndReload();
        });
    }

    const savedInd = document.getElementById('settings-saved-indicator');
    if (savedInd) {
        savedInd.style.display = 'none';
        savedInd.classList.remove('visible');
    }

    applySystemSettingsToControls();
    applyUiLocalization();
    markSettingsClean();
}
