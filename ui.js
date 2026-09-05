import { switchBody, currentLocation } from './camera.js';
import { heightLevels } from './utils.js';
import { state } from './state.js';
import { calculateBodyParameters, formatValue, calculateSurfaceBreakdown } from './bodyParameters.js';
// formatDistanceAuto used for starSystem;
import { formatEnergyPair } from './functions.js';
import { getMaxForLevel, parseDepartments, getLocationBuildingData, updateLocationBuildingData } from './buildingHelpers.js';
import { updateResourceBar, initResourcePopup } from './resourceUI.js';
import { initSpecialistsUI, showSpecialistsPanel, refreshSpecialistsPanel } from './specialistsUI.js';
import { initProductionChainsUI, showProductionChainsPanel, refreshProductionChainsPanel } from './productionChains.js';
import { renderBuildingSection, hideBuildingModal } from './buildingUI.js';
import { renderTechnoportSection } from './technoport.js';
import { isTechnoportUnlocked } from './units.js';
import { t, locName, onLanguageChange } from './settings.js';
import { getOpticalBodyState, getOpticalUnknownName, isOpticalFogEnabled } from './opticalScan.js';
import { initGeodataUI, loadGeoResources, showGeodataPanel, renderGeodataPanel } from './geodata.js';
import { initGeoSurveyUI, showGeoSurveyPanel } from './geoSurvey.js';
import { initCartographyUI, openCartographyFor, closeCartography, showCartographyPanel } from './cartography.js';

export let timeSpeed = 1;

const TIME_SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
let currentSpeedIndex = TIME_SPEEDS.indexOf(1);
if (currentSpeedIndex < 0) currentSpeedIndex = 2;
let timePaused = false;
let speedBeforePause = TIME_SPEEDS[currentSpeedIndex];

function applySpeedDisplayDom() {
    const speedValue = document.getElementById('speed-value');
    if (!speedValue) return;
    if (timePaused || timeSpeed === 0) {
        speedValue.textContent = '0x';
    } else {
        const v = Number(timeSpeed);
        speedValue.textContent = (Number.isInteger(v) || Math.abs(v - Math.round(v)) < 1e-9)
            ? `${v.toFixed(0)}x`
            : `${v.toFixed(2)}x`;
    }
}

function syncPauseButtonDom() {
    const pauseTimeButton = document.getElementById('pause-time');
    if (!pauseTimeButton) return;
    pauseTimeButton.textContent = timePaused ? '▶' : '⏸';
    const tip = timePaused
        ? (typeof t === 'function' ? (t('time.resume') || 'Возобновить') : 'Возобновить')
        : (typeof t === 'function' ? (t('time.pause') || 'Пауза') : 'Пауза');
    if (typeof window.setTip === 'function') window.setTip(pauseTimeButton, tip);
    else {
        pauseTimeButton.setAttribute('data-tip', tip);
        pauseTimeButton.removeAttribute('title');
    }
}

/** Восстановить скорость из сейва (0 = пауза). */
export function applyTimeSpeedFromSave(speed, beforePause) {
    const s = Number(speed);
    const bp = Number(beforePause);
    if (!Number.isFinite(s) || s <= 0) {
        timePaused = true;
        timeSpeed = 0;
        if (Number.isFinite(bp) && bp > 0) {
            speedBeforePause = bp;
            const idx = TIME_SPEEDS.indexOf(bp);
            if (idx >= 0) currentSpeedIndex = idx;
        }
    } else {
        timePaused = false;
        timeSpeed = s;
        speedBeforePause = s;
        let idx = TIME_SPEEDS.indexOf(s);
        if (idx < 0) {
            let best = 0, bestD = Infinity;
            TIME_SPEEDS.forEach((v, i) => {
                const d = Math.abs(v - s);
                if (d < bestD) { bestD = d; best = i; }
            });
            idx = best;
            timeSpeed = TIME_SPEEDS[idx];
            speedBeforePause = timeSpeed;
        }
        currentSpeedIndex = idx;
    }
    applySpeedDisplayDom();
    syncPauseButtonDom();
}

export function captureTimeSpeedSnapshot() {
    return {
        timeSpeed: timePaused || timeSpeed === 0 ? 0 : Number(timeSpeed) || 1,
        speedBeforePause: Number(speedBeforePause) > 0 ? Number(speedBeforePause) : 1,
        paused: !!(timePaused || timeSpeed === 0)
    };
}

/** Последний подраздел Строительства (MC*) — сброс при смене тела */
let lastConstructionSubmenu = null;
let lastConstructionLocationId = null;
export let startTime = new Date(2108, 2, 30, 11, 0, 0); // 30.03.2108 11:00:00
export let activeMenuButton = 'MB1';
export let activeSubmenuButton = null;
export let activeBuildingCategory = 'COP01';
export let activeBuilding = null;
export let activeModalTab = 'modal-tab-main';
export let activeBodyInfoTab = 'main';

export function setActiveBuilding(id) {
    activeBuilding = id;
}
export function getActiveBuilding() {
    return activeBuilding;
}


/** Возраст тела: годы → «N млрд./млн./тыс. лет» */

/** Земные сутки/годы из JSON → чч:мм:сс дд:мм:гггг */
function formatBodyPeriod(earthDays) {
    const d = Number(earthDays);
    if (!Number.isFinite(d) || d < 0) return '—';
    let totalSec = Math.round(d * 86400);

    const SEC_YEAR = 365.25 * 24 * 3600;
    const SEC_MONTH = 30 * 24 * 3600;
    const SEC_DAY = 24 * 3600;

    let years = Math.floor(totalSec / SEC_YEAR);
    totalSec -= years * SEC_YEAR;
    let months = Math.floor(totalSec / SEC_MONTH);
    totalSec -= months * SEC_MONTH;
    let days = Math.floor(totalSec / SEC_DAY);
    totalSec -= days * SEC_DAY;
    let hours = Math.floor(totalSec / 3600);
    totalSec -= hours * 3600;
    let minutes = Math.floor(totalSec / 60);
    let seconds = Math.floor(totalSec % 60);

    let overflow = false;
    if (years > 9999) {
        overflow = true;
        years = 9999;
    }
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const timePart = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    const datePart = `${pad(days)}:${pad(months)}:${pad(years, 4)}`;
    return overflow ? `>${timePart} ${datePart}` : `${timePart} ${datePart}`;
}

/** year в JSON уже в земных годах → тоже через дни */
function formatBodyYearPeriod(earthYears) {
    const y = Number(earthYears);
    if (!Number.isFinite(y) || y < 0) return '—';
    return formatBodyPeriod(y * 365.25);
}

/** 1 а.е. в км — только для отображения [а.е.] из orbitalRadius (км) в JSON */
const AU_KM = 149597870.7;

function formatGravityWellFromJson(gravityWellRadiusKm) {
    const well = Number(gravityWellRadiusKm);
    if (!Number.isFinite(well) || well <= 0) return '—';
    return formatValue(well, 'км');
}

function formatOrbitalRadiusFromJson(orbitalRadiusKm) {
    const km = Number(orbitalRadiusKm);
    if (!Number.isFinite(km) || km <= 0) return '—';
    const au = km / AU_KM;
    const kmText = formatValue(km, 'км');
    const auText = au >= 0.01 ? au.toFixed(3) : au.toExponential(2);
    return `${kmText} [${auText} а.е.]`;
}

function formatBodyAge(years) {
    const y = Number(years);
    if (!Number.isFinite(y) || y < 0) return '—';
    if (y >= 1e9) return `${(y / 1e9).toFixed(2)} ${t('unit.billionYears')}`;
    if (y >= 1e6) return `${(y / 1e6).toFixed(2)} ${t('unit.millionYears')}`;
    if (y >= 1e3) return `${(y / 1e3).toFixed(2)} ${t('unit.thousandYears')}`;
    return `${Math.round(y)} ${t('unit.years')}`;
}

function formatSurfaceTemp(celsius) {
    if (celsius === undefined || celsius === null || !Number.isFinite(Number(celsius))) return '—';
    const t = Number(celsius);
    const abs = Math.abs(t);
    const text = abs >= 100 ? t.toFixed(0) : t.toFixed(1);
    return `${text} °C`;
}

function showBodyInfoTab(tabId) {
    activeBodyInfoTab = tabId || 'main';
    document.querySelectorAll('.info-tab-button').forEach(btn => {
        const on = btn.dataset.infoTab === activeBodyInfoTab;
        btn.classList.toggle('active', on);
        btn.classList.toggle('inactive', !on);
    });
    document.querySelectorAll('.info-panel').forEach(panel => {
        panel.style.display = panel.dataset.infoPanel === activeBodyInfoTab ? 'flex' : 'none';
    });
}

export function initUI() {
    initSpecialistsUI();
    initProductionChainsUI();

    initResourcePopup();

    // Дипломатия / Военное — пока заблокированы
    ['btn-diplomacy', 'btn-military'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.add('locked', 'tab-locked', 'header-nav-locked');
        btn.setAttribute('aria-disabled', 'true');
        const tip = id === 'btn-diplomacy'
            ? (t('header.diplomacyLocked') || 'Дипломатия — недоступно')
            : (t('header.militaryLocked') || 'Военное — недоступно');
        if (typeof window.setTip === 'function') window.setTip(btn, tip);
        else { btn.setAttribute('data-tip', tip); btn.removeAttribute('title'); }
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    });


    const slowTimeButton = document.getElementById('slow-time');
    const pauseTimeButton = document.getElementById('pause-time');
    const fastTimeButton = document.getElementById('fast-time');

    slowTimeButton?.addEventListener('click', () => {
        if (currentSpeedIndex > 0) currentSpeedIndex--;
        const next = TIME_SPEEDS[currentSpeedIndex];
        if (timePaused) {
            timePaused = false;
            speedBeforePause = next;
        }
        timeSpeed = next;
        speedBeforePause = next;
        applySpeedDisplayDom();
        syncPauseButtonDom();
    });

    pauseTimeButton?.addEventListener('click', () => {
        if (!timePaused) {
            speedBeforePause = timeSpeed > 0 ? timeSpeed : (TIME_SPEEDS[currentSpeedIndex] || 1);
            if (timeSpeed > 0) {
                const idx = TIME_SPEEDS.indexOf(timeSpeed);
                if (idx >= 0) currentSpeedIndex = idx;
            }
            timePaused = true;
            timeSpeed = 0;
        } else {
            timePaused = false;
            let restore = speedBeforePause;
            if (!(restore > 0)) restore = TIME_SPEEDS[currentSpeedIndex] || 1;
            const idx = TIME_SPEEDS.indexOf(restore);
            if (idx >= 0) currentSpeedIndex = idx;
            else {
                let best = 0;
                let bestD = Infinity;
                TIME_SPEEDS.forEach((s, i) => {
                    const d = Math.abs(s - restore);
                    if (d < bestD) { bestD = d; best = i; }
                });
                currentSpeedIndex = best;
                restore = TIME_SPEEDS[best];
            }
            timeSpeed = restore;
            speedBeforePause = restore;
        }
        applySpeedDisplayDom();
        syncPauseButtonDom();
    });

    fastTimeButton?.addEventListener('click', () => {
        if (currentSpeedIndex < TIME_SPEEDS.length - 1) currentSpeedIndex++;
        const next = TIME_SPEEDS[currentSpeedIndex];
        if (timePaused) {
            timePaused = false;
            speedBeforePause = next;
        }
        timeSpeed = next;
        speedBeforePause = next;
        applySpeedDisplayDom();
        syncPauseButtonDom();
    });

    syncPauseButtonDom();
    applySpeedDisplayDom();

    const prevBodyButton = document.getElementById('prev-body');
    const nextBodyButton = document.getElementById('next-body');

    prevBodyButton.addEventListener('click', () => {
        switchBody('prev');
        updateBodyMenu(currentLocation);
        console.log('Switched to previous body, UI updated');
    });

    nextBodyButton.addEventListener('click', () => {
        switchBody('next');
        updateBodyMenu(currentLocation);
        console.log('Switched to next body, UI updated');
    });

    const menuButtons = document.querySelectorAll('.menu-button');
    menuButtons.forEach(button => {
        button.addEventListener('click', () => {
            if (!button.classList.contains('locked')) {
                menuButtons.forEach(btn => btn.classList.replace('active', 'inactive'));
                button.classList.replace('inactive', 'active');
                activeMenuButton = button.id;
                activeSubmenuButton = null;
                if (button.id === 'MB3' && currentLocation?.data?.id != null
                    && lastConstructionLocationId === Number(currentLocation.data.id)
                    && lastConstructionSubmenu) {
                    activeSubmenuButton = lastConstructionSubmenu;
                }
                console.log(`Main button ${button.id} clicked, set to active, activeMenuButton: ${activeMenuButton}`);
                updateBodyMenu(currentLocation);
            } else {
                console.log(`Main button ${button.id} clicked, but is locked`);
            }
        });
    });

    document.addEventListener('click', (e) => {
        const button = e.target.closest('.submenu-button');
        if (button && !button.classList.contains('locked')) {
            e.stopPropagation();
            e.preventDefault();
            const submenuBody = button.closest('.submenu-body');
            if (submenuBody) {
                console.log(`Submenu click detected on ${button.id}, position: ${button.getBoundingClientRect().top}x${button.getBoundingClientRect().left}`);
                submenuBody.querySelectorAll('.submenu-button').forEach(btn => btn.classList.replace('active', 'inactive'));
                button.classList.replace('inactive', 'active');
                activeSubmenuButton = button.id;
                if (button.id && String(button.id).startsWith('MC') && currentLocation?.data?.id != null) {
                    lastConstructionSubmenu = button.id;
                    lastConstructionLocationId = Number(currentLocation.data.id);
                }
                console.log(`Submenu button ${button.id} clicked, set to active, activeSubmenuButton: ${activeSubmenuButton}`);
                updateBodyMenu(currentLocation);
            } else {
                console.log(`Submenu click on ${button.id}, but no .submenu-body found`);
            }
        }
    });

    document.querySelectorAll('.submenu-button').forEach(button => {
        button.addEventListener('mouseenter', () => {
            console.log(`Mouse entered submenu button ${button.id}, position: ${button.getBoundingClientRect().top}x${button.getBoundingClientRect().left}`);
        });
        button.addEventListener('mouseleave', () => {
            console.log(`Mouse left submenu button ${button.id}`);
        });
    });

    const buildingCategoryButtons = document.querySelectorAll('.building-category-button');
    buildingCategoryButtons.forEach(button => {
        button.addEventListener('click', () => {
            buildingCategoryButtons.forEach(btn => btn.classList.replace('active', 'inactive'));
            button.classList.replace('inactive', 'active');
            activeBuildingCategory = button.id;
            console.log(`Building category ${button.id} clicked, set to active, activeBuildingCategory: ${activeBuildingCategory}`);
            updateBodyMenu(currentLocation);
        });
    });

    const buildingGrid = document.getElementById('building-grid');
    buildingGrid.addEventListener('click', (e) => {
        const buildingItem = e.target.closest('.building-item');
        if (!buildingItem) {
            console.log('Click on building-grid, but no building-item found');
            return;
        }

        const buildingId = buildingItem.dataset.buildingId;
        const building = state.buildings.find(b => b.id === buildingId);

        if (!building || !currentLocation) {
            console.error(`Building ${buildingId} not found in state.buildings or no currentLocation`);
            return;
        }

        console.log(`Click detected on building-item ${buildingId}, position: ${buildingItem.getBoundingClientRect().top}x${buildingItem.getBoundingClientRect().left}`);

        if (buildingItem.classList.contains('active')) {
            buildingItem.classList.replace('active', 'inactive');
            activeBuilding = null;
            hideBuildingModal();
            console.log(`Building ${buildingId} deactivated, activeBuilding: null, modal hidden`);
        } else {
            document.querySelectorAll('.building-item').forEach(item => item.classList.replace('active', 'inactive'));
            buildingItem.classList.replace('inactive', 'active');
            activeBuilding = buildingId;
            // Вся логика модалки, кнопок, энергии и специалистов теперь только в updateBodyMenu
            updateBodyMenu(currentLocation);
        }
    });

    buildingGrid.addEventListener('mouseenter', (e) => {
        const buildingItem = e.target.closest('.building-item');
        if (buildingItem) {
            console.log(`Mouse entered building item ${buildingItem.dataset.buildingId}`);
        }
    }, true);

    buildingGrid.addEventListener('mouseleave', (e) => {
        const buildingItem = e.target.closest('.building-item');
        if (buildingItem) {
            console.log(`Mouse left building item ${buildingItem.dataset.buildingId}`);
        }
    }, true);


    // Вкладки общей сводки небесного тела
    document.querySelectorAll('.info-tab-button').forEach(btn => {
        btn.addEventListener('click', () => {
            showBodyInfoTab(btn.dataset.infoTab);
        });
    });
    initGeodataUI();
    loadGeoResources();
    initGeoSurveyUI();
    initCartographyUI();

    const modalCloseButton = document.querySelector('.modal-close-button');
    modalCloseButton.addEventListener('click', () => {
        hideBuildingModal();
        document.querySelectorAll('.building-item').forEach(item => item.classList.replace('active', 'inactive'));
        activeBuilding = null;
        console.log('Modal closed, active building items deactivated, activeBuilding: null');
    });

    const modalTabButtons = document.querySelectorAll('.modal-tab-button');
    modalTabButtons.forEach(button => {
        button.addEventListener('click', async () => {
            if (button.id === 'modal-tab-levels') {
                try {
                    const mod = await import('./buildingLevels.js');
                    if (mod.isLevelsTabLocked?.()) return;
                } catch (_) {}
            }
            modalTabButtons.forEach(btn => btn.classList.replace('active', 'inactive'));
            button.classList.replace('inactive', 'active');
            activeModalTab = button.id;
            console.log(`Modal tab ${button.id} clicked, set to active, activeModalTab: ${activeModalTab}`);
            updateBodyMenu(currentLocation);
        });
    });

    const powerSlider = document.getElementById('power-slider');
    const powerValue = document.getElementById('power-value');
    if (powerSlider && powerValue) {
        powerSlider.addEventListener('input', () => {
            powerValue.textContent = `${powerSlider.value} \\ 100%`;
            console.log(`Power slider changed to ${powerSlider.value}%`);
        });
        console.log('Power slider event listener attached in initUI');
    } else {
        console.error('Power slider or power value element not found in DOM');
    }
}

export function resetActiveButtons() {
    activeMenuButton = 'MB1';
    activeSubmenuButton = null;
    activeBuildingCategory = 'COP01';
    activeBuilding = null;
    hideBuildingModal();
    showSpecialistsPanel(false);
    showProductionChainsPanel(false);
    console.log('resetActiveButtons called, activeMenuButton: MB1, activeSubmenuButton: null, activeBuildingCategory: COP01, activeBuilding: null, modal hidden');
}

export function formatTime(date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${hours}:${minutes}:${seconds} ${day}.${month}.${year}`;
}

export function updateBodyMenu(currentLocation) {
    console.log('updateBodyMenu called with currentLocation:', currentLocation ? locName(currentLocation.data.name) : 'null', 'activeMenuButton:', activeMenuButton, 'activeSubmenuButton:', activeSubmenuButton, 'activeBuildingCategory:', activeBuildingCategory, 'activeBuilding:', activeBuilding);
    const buttons = {
        MB1: document.getElementById('MB1'),
        MB2: document.getElementById('MB2'),
        MB3: document.getElementById('MB3'),
        MB4: document.getElementById('MB4')
    };
    const submenu = document.getElementById('submenu');
    const submenuBody = submenu.querySelector('.submenu-body');
    const bodyInfo = document.getElementById('body-info');
    const buildingList = document.getElementById('building-list');
    const buildingGrid = document.getElementById('building-grid');
    const modal = document.getElementById('building-modal');
    const modalBody = document.querySelector('.modal-body');

    if (!currentLocation) {
        console.log('No currentLocation — lock all body menu sections');
        updateResourceBar(null);
        Object.keys(buttons).forEach(id => {
            const btn = buttons[id];
            if (!btn) return;
            btn.classList.remove('active', 'inactive');
            btn.classList.add('locked');
        });
        if (submenu) submenu.style.display = 'none';
        if (bodyInfo) bodyInfo.style.display = 'none';
        if (buildingList) buildingList.style.display = 'none';
        hideBuildingModal();
        activeSubmenuButton = null;
        return;
    }

    // сброс запоминателя строительства при смене тела
    const locIdNow = Number(currentLocation.data.id);
    if (lastConstructionLocationId != null && lastConstructionLocationId !== locIdNow) {
        lastConstructionSubmenu = null;
        lastConstructionLocationId = null;
    }

    state.initializeLocationBuildings(currentLocation.data.id);
    updateResourceBar(currentLocation);

    const isStarSystem = currentLocation.data.type === 'starSystem';
    const isNebula = currentLocation.data.type === 'interstellarNebula';
    const isGalaxy = currentLocation.data.type === 'galaxy';
    const colonized = (isStarSystem || isNebula || isGalaxy)
        ? !!(currentLocation.data.developed)
        : !!(currentLocation.data.colonized);
    const has_technoport = isTechnoportUnlocked(currentLocation);

    Object.keys(buttons).forEach(id => {
        const btn = buttons[id];
        if (!btn) return;
        btn.classList.remove('active', 'inactive', 'locked');
        if (id === 'MB2' || id === 'MB3') {
            // для starSystem — задел: Управление/Строительство только если «Освоена»
            if (!colonized) {
                btn.classList.add('locked');
                if (id === activeMenuButton) {
                    activeMenuButton = 'MB1';
                    buttons.MB1.classList.replace('inactive', 'active');
                }
            } else {
                btn.classList.add(id === activeMenuButton ? 'active' : 'inactive');
            }
        } else if (id === 'MB4') {
            if (isStarSystem || !colonized || !has_technoport) {
                btn.classList.add('locked');
                if (id === activeMenuButton) {
                    activeMenuButton = 'MB1';
                    buttons.MB1.classList.replace('inactive', 'active');
                }
            } else {
                btn.classList.add(id === activeMenuButton ? 'active' : 'inactive');
            }
        } else {
            // MB1 Общее — доступно всегда, когда локация выбрана
            btn.classList.add(id === activeMenuButton ? 'active' : 'inactive');
        }
    });

    submenuBody.querySelectorAll('.submenu-button').forEach(btn => {
        btn.style.display = 'none';
        btn.classList.remove('active', 'inactive');
    });

    let submenuItems = [];
    let currentPrefix;
    if (activeMenuButton === 'MB1') {
        currentPrefix = 'MA';
        submenuItems = [
            { id: 'MA1', text: t('submenu.summary') },
            { id: 'MAC', text: t('submenu.cartography') },
            { id: 'MAG', text: t('submenu.geoSurvey') },
            { id: 'MA2', text: t('submenu.geodata') }
        ];
    } else if (activeMenuButton === 'MB2') {
        currentPrefix = 'MB2_';
        submenuItems = [
            { id: 'MB2_1', text: t('submenu.specialists') },
            { id: 'MB2_2', text: t('submenu.productionChains') }
        ];
    } else if (activeMenuButton === 'MB3') {
        currentPrefix = 'MC';
        submenuItems = [
            { id: 'MC1', text: t('submenu.orbital') },
            { id: 'MC2', text: t('submenu.aerostat') },
            { id: 'MC3', text: t('submenu.surface') },
            { id: 'MC4', text: t('submenu.surfaceWater') },
            { id: 'MC5', text: t('submenu.underground') }
        ];
    } else {
        currentPrefix = '';
    }

    if (activeSubmenuButton && currentPrefix && !activeSubmenuButton.startsWith(currentPrefix)) {
        activeSubmenuButton = null;
        console.log('Reset activeSubmenuButton to null because prefix mismatch');
    }

    // Сначала выбираем подменю по умолчанию, ПОТОМ решаем, показывать ли body-info
    if (submenuItems.length > 0) {
        submenu.style.display = 'flex';
        submenu.style.pointerEvents = 'auto';
        if (submenuBody) submenuBody.style.display = 'flex';

        if (!activeSubmenuButton) {
            activeSubmenuButton = submenuItems[0].id;
            console.log(`Set default activeSubmenuButton to ${activeSubmenuButton}`);
        }

        submenuItems.forEach((item) => {
            const button = document.getElementById(item.id);
            if (button) {
                button.style.display = 'block';
                button.textContent = item.text;
                button.classList.remove('active', 'inactive');
                button.classList.add(activeSubmenuButton === item.id ? 'active' : 'inactive');
            } else {
                console.error(`Submenu button ${item.id} not found in DOM`);
            }
        });
    } else {
        submenu.style.display = 'none';
        activeSubmenuButton = null;
        console.log('Submenu hidden for MB4');
    }

    // body-info: Общее → Общая сводка (MA1)
    const surfaceSection = document.getElementById('info-section-surface');
    const surfaceBreakdown = document.getElementById('info-surface-breakdown');

    if (activeMenuButton === 'MB1' && activeSubmenuButton === 'MA1' && currentLocation) {
        bodyInfo.style.display = 'flex';
        const data = currentLocation.data;
        const { name, type, description, radius, surfacePercents, age, avgSurfaceTemp } = data;
        const { diameter, surfaceArea } = calculateBodyParameters(radius || 0);

        const typeLabel = type === 'star' ? t('bodyType.star')
            : type === 'planet' ? t('bodyType.planet')
            : type === 'moon' ? t('bodyType.moon')
            : type === 'starSystem' ? t('bodyType.starSystem')
            : type === 'interstellarNebula' ? t('bodyType.interstellarNebula')
            : type === 'galaxy' ? t('bodyType.galaxy')
            : type === 'universe' ? t('bodyType.universe')
            : type === 'multiverse' ? t('bodyType.multiverse')
            : t('bodyType.unknown');

        const setText = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };

        (function() {
            let display = locName(name, t('common.unknown'));
            try {
                const custom = state.bodyCustomNames?.[String(currentLocation?.data?.id)];
                if (typeof custom === 'string' && custom.trim()) display = custom.trim();
            } catch (_) {}
            setText('info-name', display);
        })();
        setText('info-type', typeLabel);
        setText('info-age', formatBodyAge(age));
        setText('info-day', formatBodyPeriod(data.day));
        setText('info-year', formatBodyYearPeriod(data.year));
        setText('info-description', locName(description, t('bodyInfo.noDescription')));

        if (type === 'galaxy') {
            // Радиус/диаметр в световых годах (как у туманности)
            setText('info-radius', data.radius != null ? `${Number(data.radius).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ${t('unit.ly') || 'св.лет'}` : '—');
            setText('info-diameter', data.radius != null ? `${(Number(data.radius)*2).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ${t('unit.ly') || 'св.лет'}` : '—');
            setText('info-surface-area', '—');
            setText('info-gravity-well', '—');
            setText('info-orbital-radius', '—');
            setText('info-avg-temp', '—');
            setText('info-day', '—');
            setText('info-year', '—');
        } else if (type === 'interstellarNebula') {
            const ly = Number(data.distanceLy) || 0;
            setText('info-radius', data.radius != null ? `${Number(data.radius).toFixed(1)} ${t('unit.ly') || 'св.лет'}` : '—');
            setText('info-diameter', data.radius != null ? `${(Number(data.radius)*2).toFixed(1)} ${t('unit.ly') || 'св.лет'}` : '—');
            setText('info-surface-area', '—');
            setText('info-gravity-well', '—');
            setText('info-orbital-radius', `${ly.toFixed(2)} ${t('unit.ly') || 'св.лет'}`);
            setText('info-avg-temp', '—');
            setText('info-day', '—');
            setText('info-year', '—');
        } else if (type === 'starSystem') {
            const AU = 149597870.7;
            const rKm = radius || 0;
            const dKm = (diameter || rKm * 2);
            const auR = rKm / AU;
            const auD = dKm / AU;
            // площадь сферы: 4πr², r в а.е. → а.е.²
            const auArea = 4 * Math.PI * auR * auR;
            const fmtAu = (v) => v >= 1000
                ? `${(v / 1000).toFixed(2)} ${t('unit.thousand')} ${t('unit.au')}`
                : `${v.toFixed(2)} ${t('unit.au')}`;
            const fmtAu2 = (v) => v >= 1000
                ? `${(v / 1000).toFixed(2)} ${t('unit.thousand')} ${t('unit.au2')}`
                : `${v.toFixed(2)} ${t('unit.au2')}`;
            setText('info-radius', fmtAu(auR));
            setText('info-diameter', fmtAu(auD));
            setText('info-surface-area', fmtAu2(auArea));
        } else {
            setText('info-radius', formatValue(radius || 0, 'км'));
            setText('info-diameter', formatValue(diameter || 0, 'км'));
            setText('info-surface-area', formatValue(surfaceArea || 0, 'км²'));
        }
        setText('info-gravity-well', formatGravityWellFromJson(data.gravityWellRadius));
        setText('info-orbital-radius', formatOrbitalRadiusFromJson(data.orbitalRadius));
        setText('info-avg-temp', formatSurfaceTemp(avgSurfaceTemp));

        if (surfaceSection && surfaceBreakdown) {
            // Поверхность только у планет/лун — не у звёзд и не у звёздных систем
            if (type !== 'star' && type !== 'starSystem' && type !== 'interstellarNebula' && type !== 'galaxy' && type !== 'universe' && type !== 'multiverse') {
                surfaceSection.style.display = '';
                const rows = calculateSurfaceBreakdown(surfaceArea, surfacePercents || {});
                surfaceBreakdown.innerHTML = rows.map(r =>
                    `<p><strong>${r.label}:</strong> <span>${r.text}</span></p>`
                ).join('');
            } else {
                surfaceSection.style.display = 'none';
                surfaceBreakdown.innerHTML = '';
            }
        }

        try {
            if (isOpticalFogEnabled()
                && (type === 'planet' || type === 'moon' || type === 'star' || type === 'starSystem')) {
                const ost = getOpticalBodyState(currentLocation);
                if (ost === 'detect' || ost === 'hidden') {
                    const unk = t('common.unknown');
                    setText('info-name', getOpticalUnknownName());
                    setText('info-type', t('optical.unknownType'));
                    setText('info-age', unk);
                    setText('info-day', unk);
                    setText('info-year', unk);
                    setText('info-description', unk);
                    setText('info-radius', unk);
                    setText('info-diameter', unk);
                    setText('info-surface-area', unk);
                    setText('info-gravity-well', unk);
                    setText('info-orbital-radius', unk);
                    setText('info-avg-temp', unk);
                    if (surfaceSection && surfaceBreakdown && (type === 'planet' || type === 'moon')) {
                        surfaceSection.style.display = '';
                        const labels = Array.from(surfaceBreakdown.querySelectorAll('strong'));
                        if (labels.length) {
                            surfaceBreakdown.innerHTML = labels.map(l =>
                                `<p><strong>${l.textContent}</strong> <span>${unk}</span></p>`
                            ).join('');
                        } else {
                            surfaceBreakdown.innerHTML = `<p><span>${unk}</span></p>`;
                        }
                    }
                }
            }
        } catch (_) {}

        // показать активную вкладку сводки
        showBodyInfoTab(activeBodyInfoTab);
        showGeodataPanel(false);
        showGeoSurveyPanel(false);
        showCartographyPanel(false);

        console.log(`Body info displayed for ${locName(name)}, surfaceArea=${surfaceArea}`);
    } else if (activeMenuButton === 'MB1' && activeSubmenuButton === 'MAC' && currentLocation) {
        bodyInfo.style.display = 'none';
        if (surfaceSection) surfaceSection.style.display = 'none';
        showGeodataPanel(false);
        showGeoSurveyPanel(false);
        openCartographyFor(currentLocation);
        console.log('Cartography panel shown');
    } else if (activeMenuButton === 'MB1' && activeSubmenuButton === 'MAG' && currentLocation) {
        bodyInfo.style.display = 'none';
        if (surfaceSection) surfaceSection.style.display = 'none';
        showGeodataPanel(false);
        showCartographyPanel(false);
        showGeoSurveyPanel(true);
        console.log('Geo-survey panel shown');
    } else if (activeMenuButton === 'MB1' && activeSubmenuButton === 'MA2' && currentLocation) {
        bodyInfo.style.display = 'none';
        if (surfaceSection) surfaceSection.style.display = 'none';
        showGeoSurveyPanel(false);
        showCartographyPanel(false);
        showGeodataPanel(true);
        renderGeodataPanel(currentLocation.data);
        console.log('Geodata panel shown');
    } else {
        bodyInfo.style.display = 'none';
        if (surfaceSection) surfaceSection.style.display = 'none';
        showGeodataPanel(false);
        showGeoSurveyPanel(false);
        showCartographyPanel(false);
        console.log('Body info hidden');
    }

    // Специалисты: Управление → Специалисты (MB2_1)
    const showSpec = activeMenuButton === 'MB2' && activeSubmenuButton === 'MB2_1' && currentLocation;
    showSpecialistsPanel(!!showSpec);
    // Цепочки производства: Управление → MB2_2
    const showPc = activeMenuButton === 'MB2' && activeSubmenuButton === 'MB2_2' && currentLocation;
    showProductionChainsPanel(!!showPc);
    if (showSpec && currentLocation?.data?.id != null) {
        refreshSpecialistsPanel(currentLocation.data.id);
    }

    // Список зданий и модалка — buildingUI.js
    renderBuildingSection(currentLocation, {
        activeMenuButton,
        activeSubmenuButton,
        activeBuildingCategory,
        activeModalTab,
        getActiveBuilding,
        setActiveBuilding
    });

    renderTechnoportSection(currentLocation, {
        activeMenuButton,
        activeSubmenuButton
    });

    const buildingCategoryButtons = document.querySelectorAll('.building-category-button');
    buildingCategoryButtons.forEach(btn => {
        btn.classList.remove('active', 'inactive');
        btn.classList.add(activeBuildingCategory === btn.id ? 'active' : 'inactive');
    });
}

export function updateUI(height, currentLevelId) {
    const heightDisplay = document.getElementById('camera-height');
    if (heightDisplay) {
        let levelText = '';
        if (height >= 2 && height <= 480000) {
            let levelId = '';
            for (let id in heightLevels) {
                if (height >= heightLevels[id].min && height <= heightLevels[id].max) {
                    levelId = id;
                    break;
                }
            }
            if (levelId) {
                const lvlTitle = t('camera.level.' + levelId) || heightLevels[levelId].title;
                levelText = `\n${t('camera.level')} ${lvlTitle}`;
            }
        }
        heightDisplay.innerText = `${t('camera.height')} ${Math.round(height)}${levelText}`;
    }
}
