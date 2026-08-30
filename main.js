import { initCalculator } from './calculator.js';
import { initNotepad } from './notepad.js';
import { initBodyRename } from './bodyRename.js';
import { initOpticalScan, tickOpticalScan } from './opticalScan.js';
import { initNavigator, tickNavigator } from './navigator.js';
import { initCamera, updateCamera, updateCurrentLocation, currentLocation, focusBodyAtHeight } from './camera.js';
import { updateGeoSurveyCamera } from './geoSurveyCamera.js';
import { initUI, timeSpeed, startTime, formatTime, updateUI, updateBodyMenu, resetActiveButtons, getActiveBuilding } from './ui.js';
import { refreshModalEnergyStorage, refreshModalPopulation, refreshModalStructure, refreshModalStorage, notifyConstructionFinished } from './buildingUI.js';
// restoreBuildingPlanInputs imported below if needed;
import { refreshSpecialistsPanel } from './specialistsUI.js';
import { processConstructions, updateConstructionUI } from './construction.js';
import { tickLocationEnergyStorage } from './energyStorage.js';
import { tickLocationPopulation } from './population.js';
import { updateResourceBar } from './resourceUI.js';
import { loadBodiesFromJSON, updateBodies } from './bodies.js';
import { tickCartography } from './cartography.js';
import { tickGeodataUI } from './geodata.js';
import { renderNebulaPass, removeNebulaDomOverlay, NEBULA_LAYER } from './nebula.js';
import { heightLevels } from './utils.js';
import { state } from './state.js';
import { ensureBuildingGridSlots } from './buildingList.js';
import { loadUnitsData, tickUnits } from './units.js';
import { initTechnoportUI, tickTechnoportUI } from './technoport.js';
import { loadRecipesData, calcLocationRecipeElectricityProduction, tickLocationRecipes } from './recipes.js';
import { refreshSchemesIfOpen } from './recipesUI.js';
import { loadQuestsData } from './quests.js';
import { initQuestsUI, tickQuestsUI, renderQuestList } from './questsUI.js';
import { loadNpcDialogues, initNpcDialogueUI, evaluateNpcTriggers } from './npcDialogue.js';
import { refreshTimeMask } from './uiMasks.js';
import { loadVersionHistory, initVersionHistoryUI, refreshVersionVisibility } from './versionHistory.js';
import { loadHeroDossier, initHeroUI, tickHeroUI } from './hero.js';
import { loadTechnologiesData, initTechUI, tickTechUI } from './technologies.js';
import { initCodexUI } from './codex.js';
import { initTrendChartsUI, tickTrendHistory } from './trendCharts.js';
import { beginNewSession, resetLiveGameToDefaults, applySessionSnapshot, getSession, listSessions, tickAutosave, startAutosaveTimer, pausePlayClock, resumePlayClock, initPlayClockListeners } from './saveSystem.js';
import { initSaveUI, setLoadSessionHandler, updateMenuButtonsForGameState, closeLoadPanel, closeSavePanel } from './saveUI.js';
import { openSessionNameModal, initIntroUI, cleanupIntro } from './intro.js';
import {
    loadUiLocalization,
    loadAndApplySystemSettings,
    initSettings,
    openSettingsPanel,
    closeSettingsPanel,
    updatePrimaryMenuButton,
    applyUiLocalization,
    onLanguageChange,
    locName,
    getShowNavigator
} from './settings.js';

let scene;
let lastFrameTime = performance.now();
let lastLocation = null;

function init() {
    scene = new THREE.Scene();
    try { state.scene = scene; } catch (_) {}
    try { globalThis.__gameScene = scene; } catch (_) {}

    initCamera(scene);
    // Слои освещения звёздных систем (bodies.js ставит меши на 1/2)
    state.camera.layers.enable(0);
    state.camera.layers.enable(1);
    state.camera.layers.enable(2);
    // layer 7 — только в renderNebulaPass, не в composer
    try { removeNebulaDomOverlay(); } catch (_) {}

    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(state.renderer.domElement);

    state.composer = new THREE.EffectComposer(state.renderer);
    const renderPass = new THREE.RenderPass(scene, state.camera);
    state.composer.addPass(renderPass);
    const bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.4, 0.1);
    state.composer.addPass(bloomPass);

    initUI();
    try { initBodyRename(); } catch (e) { console.warn(e); }
    try { initNotepad(); } catch (e) { console.warn(e); }
    try { initCalculator(); } catch (e) { console.warn(e); }
    try { initTechnoportUI(); } catch (e) { console.warn(e); }

    return Promise.all([
        fetch('hev.body.json')
            .then(response => response.json())
            .then(data => {
                console.log('JSON loaded, initializing bodies');
                return loadBodiesFromJSON(data, scene).then(() => { try { initOpticalScan(scene); } catch (e) { console.warn('[optical] init', e); } });
            }),
        fetch('buildings.json')
            .then(response => response.json())
            .then(data => {
                state.buildings = data;
                console.log('Buildings JSON loaded:', data.length, 'buildings');
            }),
        loadRecipesData().then(() => {
            globalThis.__recipesApi = { calcLocationRecipeElectricityProduction };
            console.log('Recipes API ready');
        }),
        loadQuestsData(),
        loadNpcDialogues(),
        loadUnitsData()
    ])
    .then(() => {
        console.log('Bodies, buildings, recipes and quests loaded, starting animation');
        // Стартовая локация новой игры: id 3 (Святая Русь), высота камеры 3
        focusBodyAtHeight(3, 3);
        initQuestsUI();
        loadHeroDossier().then(() => initHeroUI()).catch(err => console.warn('Hero dossier:', err));
        loadTechnologiesData().then(() => initTechUI()).catch(err => console.warn('Technologies:', err));
        try { initCodexUI(); } catch (e) { console.warn('Codex:', e); }
        try { initTrendChartsUI(); } catch (e) { console.warn('TrendCharts:', e); }
        try { initNavigator(getShowNavigator()); } catch (e) { console.warn('Navigator:', e); }
        initNpcDialogueUI();
        renderQuestList();
        evaluateNpcTriggers();
        animate(0);
    })
    .catch(error => {
        console.error('Error loading JSON:', error);
        throw error;
    });
}

function animate(time) {
    requestAnimationFrame(animate);

    if (Object.keys(state.celestialBodies).length === 0) {
        console.log('animate: Waiting for celestial bodies to load');
        return;
    }

    const currentTime = performance.now();
    const deltaTime = (currentTime - lastFrameTime) / 1000;
    lastFrameTime = currentTime;

    startTime.setTime(startTime.getTime() + deltaTime * timeSpeed * 1000);
    refreshTimeMask(startTime);

    const gameNow = startTime.getTime();
    const finished = processConstructions(gameNow);
    if (finished) {
        try { notifyConstructionFinished(); } catch (_) {}
        if (currentLocation) updateBodyMenu(currentLocation);
    }
    updateConstructionUI(gameNow, currentLocation?.data?.id, getActiveBuilding());

    // Зарядка/разрядка аккумуляторов (игровое время: 1x → 1 сек = 1 сек)
    if (currentLocation?.data?.id != null && timeSpeed > 0) {
        try { tickLocationEnergyStorage(currentLocation.data.id, deltaTime * timeSpeed); } catch (e) { console.warn('energy tick', e); }
        if (currentLocation.data.colonized) {
            try { tickLocationPopulation(currentLocation.data.id, currentLocation.data, deltaTime * timeSpeed); } catch (e) { console.warn('pop tick', e); }
            try { tickLocationRecipes(currentLocation.data.id, currentLocation.data, deltaTime * timeSpeed); } catch (e) { console.warn('recipes tick', e); }
            try { updateResourceBar(currentLocation); } catch (e) { console.warn('resource bar', e); }
        }
        try { refreshModalEnergyStorage(currentLocation.data.id, getActiveBuilding()); } catch (_) {}
        try { refreshModalPopulation(currentLocation.data.id, getActiveBuilding()); } catch (_) {}
        try { refreshModalStorage(currentLocation.data.id, getActiveBuilding()); } catch (_) {}
        try { refreshModalStructure(currentLocation.data.id, getActiveBuilding()); } catch (_) {}
        try { refreshSpecialistsPanel(currentLocation.data.id); } catch (_) {}
        try { refreshSchemesIfOpen(currentLocation.data.id, getActiveBuilding()); } catch (e) { console.warn('schemes refresh', e); }
        try { tickQuestsUI(); } catch (_) {}
        try { tickHeroUI(); } catch (_) {}
        try { tickTechUI(deltaTime * timeSpeed); } catch (_) {}
        try { tickTrendHistory(deltaTime * timeSpeed); } catch (_) {}
        try { tickAutosave(); } catch (_) {}
    } else if (currentLocation?.data?.id != null) {
        try { refreshModalEnergyStorage(currentLocation.data.id, getActiveBuilding()); } catch (_) {}
        try { refreshModalPopulation(currentLocation.data.id, getActiveBuilding()); } catch (_) {}
        try { refreshModalStorage(currentLocation.data.id, getActiveBuilding()); } catch (_) {}
        try { refreshModalStructure(currentLocation.data.id, getActiveBuilding()); } catch (_) {}
        try { refreshSpecialistsPanel(currentLocation.data.id); } catch (_) {}
    }

    const height = state.camera.position.y;
    let currentLevelId = '';
    for (let id in heightLevels) {
        if (height >= heightLevels[id].min && height <= heightLevels[id].max) {
            currentLevelId = id;
            break;
        }
    }

    const surveyCam = updateGeoSurveyCamera(deltaTime);
        if (!surveyCam) updateCamera(deltaTime, currentLevelId);
    updateCurrentLocation();

    if (lastLocation !== currentLocation && !state.geoSurveyBlocking) {
        resetActiveButtons();
        updateBodyMenu(currentLocation);
        lastLocation = currentLocation;
        console.log('Location changed, reset active buttons and updated body menu');
    }

    updateBodies(deltaTime, timeSpeed, currentLevelId);
    try { tickOpticalScan(deltaTime, currentLevelId); } catch (e) { console.warn('[optical]', e); }
    try { tickNavigator(); } catch (e) { console.warn('[navigator]', e); }
    updateUI(height, currentLevelId);

    // Пример: Суммарный расход (если есть глобальный UI для энергии)
let totalCurrentEnergy = 0;
const locationBuildings = state.locationBuildings[currentLocation?.data?.id] || {};
Object.keys(locationBuildings).forEach(buildId => {
    const building = state.buildings.find(b => b.id === buildId);
    if (building && building.RequiresElectricity) {
        const data = locationBuildings[buildId];
        const maxPerUnit = building.EnergyConsumption[data.currentLevel || 0] || 0;
        totalCurrentEnergy += maxPerUnit * (data.built_count || 0) * (data.currentBuildingCapacity / 100);
    }
});

    // Юниты: взлёт/посадка (реальное время)
    try {
        const unitTick = tickUnits(deltaTime * 1000, timeSpeed);
    try { tickCartography(deltaTime * 1000); } catch (_) {}
        try {
            if (currentLocation?.data) tickGeodataUI(currentLocation.data, deltaTime * 1000);
        } catch (_) {}
        tickTechnoportUI(unitTick);
    } catch (e) {
        console.warn('units tick', e);
    }

    state.composer.render();
    // Туманность отдельным проходом — без UnrealBloomPass
    try {
        renderNebulaPass(state.renderer, scene, state.camera);
    } catch (e) {
        console.warn('nebula pass', e);
    }
}


/* ===== Главное меню ===== */
let gameStarted = false;
window.__gameStarted = false;

function hideMainMenu() {
    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) {
        mainMenu.classList.add('hidden');
        mainMenu.style.display = 'none';
    }
    document.body.classList.remove('main-menu-active');
    closeSettingsPanel();
}

function showMainMenu() {
    // выход в меню = конец текущего игрового отрезка
    try { pausePlayClock(); } catch (_) {}
    updateMenuButtonsForGameState(gameStarted);
    closeLoadPanel();
    closeSavePanel();
    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) {
        mainMenu.classList.remove('hidden');
        mainMenu.style.display = '';
    }
    document.body.classList.add('main-menu-active');
    updatePrimaryMenuButton(gameStarted);
    applyUiLocalization();
}

/** Загрузка основного экрана (без интро). report(pct) — прогресс 0..100 */
async function loadMainGame(report) {
    if (typeof THREE === 'undefined') {
        console.error('THREE.js is not loaded');
        report?.(100);
        return;
    }
    report?.(10);
    const pendingNew = !!window.__pendingNewGame;
    if (!window.__mainGameInited) {
        report?.(25);
        await init();
        window.__mainGameInited = true;
        report?.(80);
    } else if (pendingNew) {
        report?.(30);
        try { await resetLiveGameToDefaults(); } catch (e) { console.error('resetLiveGameToDefaults', e); }
        report?.(80);
    }
    if (pendingNew) {
        try {
            const name = window.__sessionName || '';
            beginNewSession(name);
        } catch (e) { console.warn('beginNewSession', e); }
        window.__pendingNewGame = false;
    }
    report?.(100);
    gameStarted = true;
    window.__gameStarted = true;
    updatePrimaryMenuButton(true);
    updateMenuButtonsForGameState(true);
    try { startAutosaveTimer(); } catch (_) {}
    document.body.classList.remove('main-menu-active');
    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) {
        mainMenu.style.display = 'none';
        mainMenu.classList.add('hidden');
    }
}

function startNewGame() {
    // Новая игра → окно имени сессии → интро (доступно и изнутри сессии)
    openSessionNameModal();
}

async function continueGame() {
    if (!gameStarted) {
        // на холодном старте «Продолжить» = последнее сохранение
        await loadLatestSession();
        return;
    }
    // Без интро: синхронное гашение меню и оверлеев
    const fadeEls = [
        document.getElementById('main-menu'),
        document.getElementById('social-panel'),
        document.getElementById('social-poster'),
        document.getElementById('vh-preview-wrap'),
        document.getElementById('vh-build-btn')
    ].filter(Boolean);
    fadeEls.forEach(el => {
        el.style.transition = 'opacity 0.8s ease';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
    });
    await new Promise(r => setTimeout(r, 800));
    hideMainMenu();
    fadeEls.forEach(el => {
        el.style.opacity = '';
        el.style.transition = '';
        el.style.pointerEvents = '';
    });
    try { resumePlayClock(); } catch (_) {}
    try { restoreBuildingPlanInputs(currentLocation, getActiveBuilding); } catch (_) {}
}


async function loadLatestSession() {
    let list = [];
    try {
        list = listSessions({ includeAutosaves: true }) || [];
    } catch (_) { list = []; }
    if (!list.length) return;
    // list уже отсортирован по updatedAtMs desc
    const latest = list[0];
    if (!latest?.id) return;
    await loadSessionFromSave(latest.id);
}

async function loadSessionFromSave(sessionId) {
    const snap = getSession(sessionId);
    if (!snap) {
        console.warn('Session not found', sessionId);
        return;
    }

    window.__loadingSession = true;
    window.__suppressQuestAutoModal = true;

    // оверлей загрузки — минимум 3 секунды
    let overlay = document.getElementById('session-load-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'session-load-overlay';
        overlay.innerHTML = '<div class="session-load-label"></div><div class="session-load-pct">0%</div>';
        document.body.appendChild(overlay);
    }
    const label = overlay.querySelector('.session-load-label');
    const pctEl = overlay.querySelector('.session-load-pct');
    try {
        const { t } = await import('./settings.js');
        if (label) label.textContent = t('save.loading');
    } catch (_) {
        if (label) label.textContent = 'Загрузка сессии…';
    }
    overlay.classList.add('visible');
    const t0 = performance.now();
    const report = (n) => { if (pctEl) pctEl.textContent = Math.round(n) + '%'; };

    // плавно гасим всё меню + соц/сборки (как при «Погружение»)
    const fadeEls = [
        document.getElementById('main-menu'),
        document.getElementById('social-panel'),
        document.getElementById('social-poster'),
        document.getElementById('vh-preview-wrap'),
        document.getElementById('vh-build-btn')
    ].filter(Boolean);
    fadeEls.forEach(el => {
        el.style.transition = 'opacity 0.8s ease';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
    });
    await new Promise(r => setTimeout(r, 800));

    report(10);
    await loadMainGame((n) => report(10 + n * 0.7));
    report(85);
    try {
        applySessionSnapshot(snap);
    } catch (err) {
        console.error('applySessionSnapshot failed:', err);
    }
    report(92);

    // закрыть случайно открытую модалку квеста
    try {
        const qui = await import('./questsUI.js');
        if (typeof qui.closeQuestModal === 'function') qui.closeQuestModal();
        else {
            const qm = document.getElementById('quest-modal');
            if (qm) qm.classList.remove('open');
        }
        qui.renderQuestList?.();
    } catch (_) {}

    try {
        const { updateResourceBar } = await import('./resourceUI.js');
        const { currentLocation } = await import('./camera.js');
        updateResourceBar?.(currentLocation);
        const { applyGenderToHeader } = await import('./quests.js');
        applyGenderToHeader?.();
        const { refreshTimeMask } = await import('./uiMasks.js');
        const { startTime, updateBodyMenu } = await import('./ui.js');
        refreshTimeMask?.(startTime);
        if (currentLocation) updateBodyMenu?.(currentLocation);
        const { refreshSpecialistsPanel } = await import('./specialistsUI.js');
        refreshSpecialistsPanel?.();
        const { refreshSchemesIfOpen } = await import('./recipesUI.js');
        refreshSchemesIfOpen?.();
    } catch (e) {
        console.warn('post-load UI', e);
    }

    report(100);
    // держим оверлей не меньше 3 с с момента показа
    const elapsed = performance.now() - t0;
    if (elapsed < 3000) await new Promise(r => setTimeout(r, 3000 - elapsed));

    overlay.classList.remove('visible');
    fadeEls.forEach(el => {
        el.style.opacity = '';
        el.style.transition = '';
        el.style.pointerEvents = '';
    });
    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) {
        mainMenu.style.display = 'none';
        mainMenu.classList.add('hidden');
    }
    document.body.classList.remove('main-menu-active');

    // снять блокировку авто-модалок после стабилизации
    setTimeout(() => {
        window.__loadingSession = false;
        window.__suppressQuestAutoModal = false;
    }, 500);
}

function setupMainMenu() {
    const btnNewGame = document.getElementById('btn-new-game');
    const btnContinue = document.getElementById('btn-continue');
    const btnSettings = document.getElementById('btn-settings');
    const btnExit = document.getElementById('btn-exit');
    const headerSettingsBtn = document.getElementById('header-btn-settings');

    if (btnNewGame) {
        btnNewGame.addEventListener('click', () => {
            startNewGame();
        });
    }

    if (btnContinue) {
        btnContinue.addEventListener('click', () => {
            continueGame();
        });
    }

    if (btnSettings) {
        btnSettings.addEventListener('click', () => {
            openSettingsPanel();
        });
    }

    if (btnExit) {
        btnExit.addEventListener('click', () => {
            window.close();
            setTimeout(() => {
                if (!window.closed) {
                    alert('Закройте вкладку вручную (Ctrl+W / Cmd+W).');
                }
            }, 300);
        });
    }

    // Шестерёнка в хедере → главное меню
    if (headerSettingsBtn) {
        headerSettingsBtn.addEventListener('click', () => {
            if (!gameStarted) return;
            showMainMenu();
        });
    }

    // Escape = та же шестерёнка (выход в главное меню из сессии)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // не перехватываем, если игрок печатает
        const tag = (e.target?.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.target?.isContentEditable) return;
        // если открыт блокнот / калькулятор — их закрытие уже обрабатывается локально
        if (document.getElementById('notepad-modal')?.style.display === 'flex') return;
        if (document.getElementById('calculator-modal')?.style.display === 'flex') return;
        if (!gameStarted) return;
        // уже в главном меню — ничего
        if (document.body.classList.contains('main-menu-active')) return;
        e.preventDefault();
        showMainMenu();
    });
}

// Инициализация локализации и меню
loadAndApplySystemSettings();
loadUiLocalization().then(async () => {
    initSettings();
    setupMainMenu();
    ensureBuildingGridSlots();
    initSaveUI();
    initPlayClockListeners();
    setLoadSessionHandler((id) => { loadSessionFromSave(id); });
    updatePrimaryMenuButton(false);
    updateMenuButtonsForGameState(false);
    await loadVersionHistory();
    initVersionHistoryUI();
    initIntroUI({
        startGameLoad: async (report) => {
            await loadMainGame(report);
        }
    });
    onLanguageChange((lang) => {
        // квесты / NPC — язык уже выставлен в setLanguage, просто перерисовываем
        import('./quests.js').then(mod => {
            if (typeof mod.setQuestLang === 'function') mod.setQuestLang(lang || 'ru');
            return import('./questsUI.js');
        }).then(q => {
            if (q.renderQuestList) q.renderQuestList();
            if (q.refreshQuestModal) q.refreshQuestModal();
        }).catch(() => {});
        import('./npcDialogue.js').then(n => {
            if (n.refreshActiveNpcDialogue) n.refreshActiveNpcDialogue();
        }).catch(() => {});
        // перерисовать динамические панели при смене языка
        import('./ui.js').then(ui => {
            import('./camera.js').then(cam => {
                if (cam.currentLocation && ui.updateBodyMenu) {
                    ui.updateBodyMenu(cam.currentLocation);
                }
            });
        }).catch(() => {});
        // обновить имя локации
        import('./bodyRename.js').then(br => {
            if (br.refreshAllBodyNameDisplays) br.refreshAllBodyNameDisplays();
        }).catch(() => {
            import('./camera.js').then(cam => {
                const el = document.getElementById('location-name');
                if (el && cam.currentLocation?.data?.name) {
                    el.textContent = locName(cam.currentLocation.data.name);
                }
            }).catch(() => {});
        });
    });
}).catch(err => {
    console.error('Settings/UI loc init failed', err);
    setupMainMenu();
});

const fullscreenBtn = document.getElementById('fullscreen-btn');

if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.warn('Не удалось войти в полноэкранный режим:', err);
            });
        } else {
            document.exitFullscreen();
        }
    });

    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            fullscreenBtn.textContent = '⛶';
            fullscreenBtn.classList.add('active');
            fullscreenBtn.title = 'Выйти из полноэкранного режима';
        } else {
            fullscreenBtn.textContent = '⛶';
            fullscreenBtn.classList.remove('active');
            fullscreenBtn.title = 'Полноэкранный режим';
        }
    });
}