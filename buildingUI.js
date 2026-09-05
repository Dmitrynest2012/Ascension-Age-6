/** Кнопка «?» кодекса у модалки здания */
export function syncBuildingModalCodexBtn(buildingId) {
    const modal = document.getElementById('building-modal');
    const btn = document.getElementById('building-modal-codex-btn');
    if (modal && buildingId) modal.dataset.buildingId = String(buildingId);
    if (btn) {
        if (buildingId) {
            btn.dataset.buildingId = String(buildingId);
            btn.hidden = false;
            btn.style.display = '';
        } else {
            delete btn.dataset.buildingId;
            btn.hidden = true;
        }
    }
}

import * as RecipesUI from './recipesUI.js';
const renderSchemesTab = (...a) => RecipesUI.renderSchemesTab(...a);
const showSchemesPanel = (...a) => RecipesUI.showSchemesPanel(...a);
import { getRecipesForBuilding, getRecipeActualOutput, getRecipeBaseOutput,
    getBuildingEnergyCapacityWh,
    buildingHasEnergyCapacityRecipe
} from './recipes.js';
import { state } from './state.js';
import { ensureBuildingGridSlots, attachBuildingListScroll, refreshBuildingListViewport } from './buildingList.js';
import { formatEnergyPair, formatEnergyWhPair } from './functions.js';
import { getBuildingMaxResidents } from './population.js';
import {
    getMaxForLevel,
    parseDepartments,
    getLocationBuildingData,
    updateLocationBuildingData,
    getBuildingOccupiedM2,
    getBuildingOccupiedKm2,
    getZoneFreeKm2,
    getBuildExtraAreaKm2,
    getUpgradeExtraAreaKm2,
    getStructureMax
} from './buildingHelpers.js';
import { formatValue } from './bodyParameters.js';
import { startTime } from './ui.js';
import {
    startConstruction,
    hasPendingAction,
    getPendingAction,
    updateConstructionUI,
    setConstructionPreview,
    getActionDurationMs
} from './construction.js';
import { updateResourceBar } from './resourceUI.js';
import { isBuildingInfoMasked } from './uiMasks.js';
import { t, locName, getBuildingVideoAvatars } from './settings.js';
import { getBuildingStorageFill, isStorageBuilding } from './resourceStorage.js';
import {
    canAffordAction,
    spendActionResources,
    spendEntries,
    hasResourceCostTable,
    refreshBuildingCostPanel,
    closeBuildingCostPanel,
    setCostHoverAction,
    updateBuildingCostPanel
} from './buildingResourceCosts.js';
import {
    bindPlanInputs,
    syncPlanInputs,
    getPlanForAction,
    canAffordPlan,
    isPlanNoOp,
    clearPlanInputs,
    ensurePlanInputDom,
    isPlannedConstructionEnabled,
    restorePlanInputsIfNeeded
} from './buildingPlanInputs.js';
import {
    renderLevelsTab,
    showLevelsPanel,
    updateLevelsTabLock,
    isLevelsTabLocked
} from './buildingLevels.js';

let _buildingModalAnimTok = 0;

export function isBuildingModalShown() {
    const modal = document.getElementById('building-modal');
    return !!(modal && modal.style.display === 'flex' && modal.dataset.modalAnim !== 'leave');
}

/** Открытие с анимацией как у модалки технологии. Повторный вызов на уже открытой — без анимации. */
export function showBuildingModal() {
    const modal = document.getElementById('building-modal');
    if (!modal) return;
    const already = modal.style.display === 'flex'
        && modal.classList.contains('open')
        && modal.dataset.modalAnim !== 'leave';
    _buildingModalAnimTok += 1;
    modal.classList.remove('is-leaving');
    modal.style.display = 'flex';
    if (already) {
        modal.dataset.modalAnim = 'stay';
        modal.classList.add('open');
        return;
    }
    modal.dataset.modalAnim = 'enter';
    modal.classList.remove('open');
    void modal.offsetWidth;
    requestAnimationFrame(() => {
        modal.classList.add('open');
        modal.dataset.modalAnim = 'open';
    });
}

/** Закрытие с той же плавностью. */
export function hideBuildingModal() {
    const modal = document.getElementById('building-modal');
    if (!modal) return;
    if (modal.style.display !== 'flex' || modal.dataset.modalAnim === 'leave') {
        modal.style.display = 'none';
        modal.classList.remove('open', 'is-leaving');
        modal.dataset.modalAnim = '';
        return;
    }
    const tok = ++_buildingModalAnimTok;
    modal.dataset.modalAnim = 'leave';
    modal.classList.remove('open');
    modal.classList.add('is-leaving');
    const finish = () => {
        if (tok !== _buildingModalAnimTok) return;
        modal.style.display = 'none';
        modal.classList.remove('open', 'is-leaving');
        modal.dataset.modalAnim = '';
    };
    const onEnd = (e) => {
        if (e.target !== modal) return;
        modal.removeEventListener('transitionend', onEnd);
        finish();
    };
    modal.addEventListener('transitionend', onEnd);
    setTimeout(finish, 520);
}

/**
 * Список зданий + модалка (MB3). Вынесено из updateBodyMenu.
 */

/**
 * Аватар в модалке: video (muted, loop) если avatarVideo и built_count >= 1, иначе img.
 * Параметр avatarVideo в buildings.json — URL видеофайла.
 */
export function updateBuildingModalAvatar(building, locationData) {
    const container = document.querySelector('.modal-avatar-container');
    const img = document.querySelector('.modal-avatar');
    const video = document.querySelector('.modal-avatar-video');
    if (!container || !img) return;

    const count = Math.max(0, Number(locationData?.built_count) || 0);
    const videoUrl = (building?.avatarVideo || building?.avatar_video || '').trim();
    const imgUrl = building?.avatar || 'assets/textures/default.png';

    img.src = imgUrl;

    const allowVideo = (typeof getBuildingVideoAvatars === 'function') ? getBuildingVideoAvatars() : true;
    if (allowVideo && videoUrl && count >= 1 && video) {
        container.classList.add('has-video');
        img.classList.remove('grayscale');
        // не перезагружаем тот же src
        const abs = videoUrl;
        if (video.getAttribute('data-src') !== abs) {
            video.setAttribute('data-src', abs);
            video.src = abs;
        }
        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;
        video.loop = true;
        video.playsInline = true;
        video.removeAttribute('controls');
        const play = () => {
            const p = video.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
        };
        if (video.readyState >= 2) play();
        else video.addEventListener('loadeddata', play, { once: true });
    } else {
        container.classList.remove('has-video');
        if (video) {
            try { video.pause(); } catch (_) {}
            // оставляем src чтобы быстрый возврат при постройке; при желании можно video.removeAttribute('src')
        }
        if (count === 0) img.classList.add('grayscale');
        else img.classList.remove('grayscale');
    }
}


export function renderBuildingSection(currentLocation, ctx = {}) {
    const {
        activeMenuButton,
        activeSubmenuButton,
        activeBuildingCategory,
        activeModalTab,
        getActiveBuilding,
        setActiveBuilding
    } = ctx;

    ensureBuildingGridSlots();
    try { attachBuildingListScroll(); refreshBuildingListViewport(); } catch (_) {}
    const buildingList = document.getElementById('building-list');
    const buildingGrid = document.getElementById('building-grid');
    const modal = document.getElementById('building-modal');
    const modalBody = document.querySelector('.modal-body');

    function updateBuildingCounts() {
        const buildingItems = buildingGrid.querySelectorAll('.building-item');
        buildingItems.forEach(item => {
            const building = state.buildings.find(b => b.id === item.dataset.buildingId);
            if (!building || !currentLocation) return;
            const locationData = getLocationBuildingData(currentLocation.data.id, building.id);
            if (!locationData) return;
            const count = locationData.built_count || 0;
            const level = locationData.currentLevel || 0;
            const countSpan = item.querySelector('.building-count') || item.querySelector('span');
            if (countSpan) {
                if (isBuildingInfoMasked(building.id)) {
                    countSpan.textContent = t('modal.levelUnknown');
                    const nameP = item.querySelector('p');
                    if (nameP) nameP.textContent = t('common.unknownBuilding');
                } else {
                    countSpan.textContent = `Ур. ${level} / ${building.maxLevel || 0}   [ ${count}x ]`;
                    const nameP = item.querySelector('p');
                    if (nameP) nameP.textContent = locName(building.name, t('common.unknown'));
                }
            }
            if (count === 0) {
                item.classList.add('grayscale');
            } else {
                item.classList.remove('grayscale');
            }
            const pend = locationData.pendingAction || getPendingAction(currentLocation.data.id, building.id);
            const pType = pend?.type || '';
            item.classList.toggle('is-constructing', pType === 'build' || pType === 'upgrade');
            item.classList.toggle('is-deconstructing', pType === 'dismantle' || pType === 'downgrade');
            if (!item.querySelector('.building-action-tri--up')) {
                item.insertAdjacentHTML('beforeend',
                    '<span class="building-action-tri building-action-tri--up" aria-hidden="true">▲</span>'
                    + '<span class="building-action-tri building-action-tri--down" aria-hidden="true">▼</span>');
            }
        });
    }

    if (activeMenuButton === 'MB3' && activeSubmenuButton && ['MC1', 'MC2', 'MC3', 'MC4', 'MC5'].includes(activeSubmenuButton) && currentLocation) {
        buildingList.style.display = 'flex';
        const buildingItems = buildingGrid.querySelectorAll('.building-item');
        buildingItems.forEach(item => {
            const building = state.buildings.find(b => b.id === item.dataset.buildingId);
            if (!building) {
                item.style.display = 'none';
                return;
            }
            const locationData = currentLocation ? getLocationBuildingData(currentLocation.data.id, building.id) : null;
            if (building && locationData) {
                const isVisible = building.constructionZone === activeSubmenuButton && building.category === activeBuildingCategory &&
                                  (Number(building.parentBodyId) === Number(currentLocation.data.id) || currentLocation.data.childStructureIds?.includes(building.id));
                item.style.display = isVisible ? 'flex' : 'none';
                item.classList.remove('active', 'inactive', 'grayscale');
                item.classList.add(getActiveBuilding() === item.dataset.buildingId ? 'active' : 'inactive');
                
                if (locationData.built_count === 0) {
                    item.classList.add('grayscale');
                }
                const listMasked = isBuildingInfoMasked(building.id);
                const listName = listMasked ? t('common.unknownBuilding') : (locName(building.name, t('common.unknown')));
                const listCount = listMasked
                    ? t('modal.levelUnknown')
                    : `Ур. ${locationData.currentLevel || 0} / ${building.maxLevel || 0}   [ ${locationData.built_count || 0}x ]`;
                const pend = locationData.pendingAction || getPendingAction(currentLocation.data.id, building.id);
                const pType = pend?.type || '';
                const isUp = pType === 'build' || pType === 'upgrade';
                const isDown = pType === 'dismantle' || pType === 'downgrade';
                item.classList.toggle('is-constructing', isUp);
                item.classList.toggle('is-deconstructing', isDown);
                item.innerHTML = `
                    <img src="${building.avatar}" alt="${listName}" style="pointer-events: none;">
                    <p style="pointer-events: none;">${listName}</p>
                    <span style="pointer-events: none;" class="building-count">${listCount}</span>
                    <span class="building-action-tri building-action-tri--up" aria-hidden="true">▲</span>
                    <span class="building-action-tri building-action-tri--down" aria-hidden="true">▼</span>
                `;
                console.log(`Building item ${item.dataset.buildingId} updated, display: ${item.style.display}, state: ${item.classList.contains('active') ? 'active' : 'inactive'}`);
            } else {
                item.style.display = 'none';
                console.log(`Building item ${item.dataset.buildingId} hidden, no matching building in state.buildings or no locationData`);
            }
        });

        console.log(`Building list displayed for constructionZone: ${activeSubmenuButton}, category: ${activeBuildingCategory}, visible buildings count: ${Array.from(buildingItems).filter(item => item.style.display === 'flex').length}`);
        if (getActiveBuilding()) {
            const building = state.buildings.find(b => b.id === getActiveBuilding());
            const locationData = getLocationBuildingData(currentLocation.data.id, getActiveBuilding());
            if (building && locationData) {
                showBuildingModal();
                // сразу актуализировать lock вкладки «Уровни» (не ждать клика по Основное)
                try { updateLevelsTabLock(); } catch (_) {}
                const modalContent = document.querySelector('.modal-content');
                const modalBodyEl = document.querySelector('.modal-body') || modalBody;

                if (activeModalTab === 'modal-tab-main') {
                    // Всегда гасим схемы и показываем основное — даже если дальше будет ошибка
                    try { showSchemesPanel(false); } catch (_) {}
                    if (modalContent) modalContent.style.display = 'flex';
                    if (modalBodyEl) modalBodyEl.style.display = 'flex';

                    // ---- данные модалки ----
                    const infoMasked = isBuildingInfoMasked(building.id);
                    const nameEl = document.getElementById('modal-building-name');
                    const levelEl = document.getElementById('modal-level');
                    const builtEl = document.getElementById('modal-built-count');
                    if (nameEl) {
                        nameEl.textContent = infoMasked
                            ? t('common.unknownBuilding')
                            : (locName(building.name, t('common.unknown')));
                    }
                    try { syncBuildingModalCodexBtn(building.id); } catch (_) {}
                    if (levelEl) {
                        levelEl.textContent = infoMasked
                            ? t('common.unknownLower')
                            : `${locationData.currentLevel || 0} / ${building.maxLevel || 0}`;
                    }
                    if (builtEl) {
                        builtEl.textContent = infoMasked
                            ? t('common.unknownLower')
                            : `${locationData.built_count || 0}x`;
                    }
                    const descEl = document.querySelector('#modal-description .modal-description-value');
                    if (descEl) descEl.textContent = infoMasked
                        ? t('modal.descUnavailable')
                        : locName(building.description, '');
                    const rankEl = document.getElementById('modal-rank');
                    if (rankEl) {
                        const realRank = building.rank != null
                            ? String(building.rank)
                            : (building.maxRank != null ? `1 / ${building.maxRank}` : '1 / 9');
                        rankEl.textContent = infoMasked ? t('common.unknownLower') : realRank;
                    }
                    try { updateBuildingModalAvatar(building, locationData); } catch (e) { console.warn('avatar', e); }

                    const currentLevel = locationData.currentLevel || 0;
                    const builtCount = locationData.built_count || 0;
                    const currentCapacity = locationData.currentBuildingCapacity ?? 100;
                    const departments = parseDepartments(building.departments);

                    // ---- маска площади / структуры / склада ----
                    if (infoMasked) {
                        const areaElM = document.getElementById('modal-area');
                        if (areaElM) areaElM.textContent = t('common.unknownLower');
                        const stValM = document.getElementById('modal-structure-value');
                        if (stValM) stValM.textContent = t('common.unknownLower');
                        const storValM = document.getElementById('modal-storage-value');
                        if (storValM) storValM.textContent = t('common.unknownLower');
                    }

                    // ---- энергия: расход ----
                    const requiresElectricity = !!building.RequiresElectricity;
                    const maxEnergyPerUnit = (building.EnergyConsumption || [])[currentLevel] || 0;
                    const maxEnergy = maxEnergyPerUnit * builtCount;
                    const currentEnergy = maxEnergy * (currentCapacity / 100);
                    const energyElement = document.getElementById('energy-consumption');
                    const energyValueSpan = document.getElementById('energy-value');
                    if (energyElement && energyValueSpan) {
                        if (requiresElectricity && builtCount > 0) {
                            energyElement.style.display = 'block';
                            energyValueSpan.textContent = formatEnergyPair(currentEnergy, maxEnergy).text;
                        } else {
                            energyElement.style.display = 'none';
                        }
                    }

                    // ---- энергия: производство только из рецептов ----
                    const prodElement = document.getElementById('energy-production');
                    const prodValueSpan = document.getElementById('energy-production-value');
                    if (prodElement && prodValueSpan) {
                        let curProd = 0;
                        let maxProd = 0;
                        const recipes = getRecipesForBuilding(building.id) || [];
                        for (const recipe of recipes) {
                            const hasElec = (recipe.outputs || []).some(o => o.resourceId === 'RES_ELECTRICITY');
                            if (!hasElec) continue;
                            curProd += getRecipeActualOutput(currentLocation.data.id, building.id, recipe, 'RES_ELECTRICITY');
                            // max при 100% локальной мощности рецепта и полной эффективности специалистов
                            maxProd += getRecipeBaseOutput(currentLocation.data.id, building.id, recipe, 'RES_ELECTRICITY');
                        }
                        if (builtCount > 0 && maxProd > 0) {
                            prodElement.style.display = 'block';
                            prodValueSpan.textContent = formatEnergyPair(curProd, maxProd).text;
                        } else {
                            prodElement.style.display = 'none';
                        }
                    }

                    // ---- энергия: накопление (аккумуляторы) ----
                    const storesEnergy = !!building.StoresEnergy;
                    const storageEl = document.getElementById('energy-storage');
                    const storageVal = document.getElementById('energy-storage-value');
                    if (storageEl && storageVal) {
                        if (storesEnergy && builtCount > 0) {
                            let maxStore = 0;
                            if (buildingHasEnergyCapacityRecipe(building.id)) {
                                maxStore = getBuildingEnergyCapacityWh(currentLocation.data.id, building.id).wh;
                            } else {
                                const capArr = building.MaxEnergyCapacity || [];
                                maxStore = (capArr[currentLevel] || 0) * (currentCapacity / 100) * builtCount;
                            }
                            const curStore = Math.min(maxStore, Number(locationData.currentStoredEnergy) || 0);
                            storageEl.style.display = 'block';
                            storageVal.textContent = formatEnergyWhPair(curStore, maxStore).text;
                        } else {
                            storageEl.style.display = 'none';
                        }
                    }

                    // ---- население (жилые) ----
                    const popEl = document.getElementById('modal-population');
                    const popVal = document.getElementById('modal-population-value');
                    if (popEl && popVal) {
                        if (building.IsResidential && builtCount > 0) {
                            const maxR = getBuildingMaxResidents(building, locationData, currentLocation.data.id);
                            const curR = Math.min(maxR, Number(locationData.currentResidents) || 0);
                            popEl.style.display = 'block';
                            popVal.textContent = `${curR} / ${maxR}`;
                        } else {
                            popEl.style.display = 'none';
                        }
                    }

                    // ---- склад ресурсов ----
                    const storEl = document.getElementById('modal-storage');
                    const storVal = document.getElementById('modal-storage-value');
                    if (storEl && storVal) {
                        if (isStorageBuilding(building) && builtCount > 0) {
                            storEl.style.display = 'block';
                            // та же маска, что у остальных параметров Базы (до главы II)
                            if (infoMasked) {
                                storVal.textContent = t('common.unknownLower');
                            } else {
                                try {
                                    const fill = getBuildingStorageFill(currentLocation.data.id, building.id, currentLocation.data);
                                    if (!fill || fill.revealed === false) {
                                        storVal.textContent = t('common.unknownLower');
                                    } else {
                                        const pct = Number.isFinite(fill.percent) ? fill.percent : 0;
                                        storVal.textContent = `${pct.toFixed(1)}% / 100%`;
                                    }
                                } catch (e) {
                                    console.warn('modal storage fill', e);
                                    storVal.textContent = '—';
                                }
                            }
                        } else {
                            storEl.style.display = 'none';
                        }
                    }

                    // ---- структура (ОЖ) ----
                    {
                        const stRow = document.getElementById('modal-structure-row');
                        const stVal = document.getElementById('modal-structure-value');
                        if (stRow && stVal) {
                            const maxS = getStructureMax(building, currentLevel) * Math.max(0, builtCount);
                            if (builtCount > 0 && maxS > 0) {
                                const curS = Math.min(maxS, Math.max(0, Number(locationData.currentStructure) || 0));
                                stRow.style.display = 'block';
                                stVal.textContent = `${Math.floor(curS)} / ${Math.floor(maxS)} ${t('unit.HP')}`;
                                stVal.style.color = curS < maxS * 0.5 ? '#e88' : (curS < maxS ? '#ec8' : '');
                            } else {
                                stRow.style.display = 'none';
                            }
                        }
                    }

                    // ---- кнопки: всегда клонируем, чтобы слушатели были свежими ----
                    const ids = ['BUILNG001', 'BUILNG002', 'BUILNG003', 'BUILNG004'];
                    const btns = {};
                    ids.forEach(id => {
                        const old = document.getElementById(id);
                        if (old) {
                            const neu = old.cloneNode(true);
                            old.replaceWith(neu);
                            btns[id] = neu;
                        }
                    });
                    const buildBtn = btns['BUILNG001'];
                    const dismantleBtn = btns['BUILNG002'];
                    const upgradeBtn = btns['BUILNG003'];
                    const downgradeBtn = btns['BUILNG004'];

                    function setButtonLocks(locData) {
                        const count = locData.built_count || 0;
                        const level = locData.currentLevel || 0;
                        const canBuild = !building.unique_building || count < 1;
                        const maxCountReached = count >= (building.max_count || Infinity);
                        let canUpgrade = count > 0 && level < (building.maxLevel || Infinity);

                        // Площади в км²: free = (равнины+пустыни+степи) − занято всеми зданиями зоны
                        const freeKm2 = getZoneFreeKm2(currentLocation.data, currentLocation.data.id, building.constructionZone);
                        const needBuild = getBuildExtraAreaKm2(building, locData);
                        const needUpgrade = getUpgradeExtraAreaKm2(building, locData);
                        const areaBlocksBuild = freeKm2 != null && needBuild > freeKm2;
                        const areaBlocksUpgrade = freeKm2 != null && needUpgrade > freeKm2;

                        const pending = hasPendingAction(currentLocation.data.id, getActiveBuilding());
                        const bodyData = currentLocation.data;
                        const masked = isBuildingInfoMasked(building.id);
                        const lackBuild = !masked && hasResourceCostTable(building) && !canAffordAction(bodyData, building, locData, 'build');
                        const lackUpgrade = !masked && hasResourceCostTable(building) && !canAffordAction(bodyData, building, locData, 'upgrade');
                        if (buildBtn) {
                            buildBtn.classList.toggle('locked', masked || pending || !canBuild || maxCountReached || !currentLocation.data.colonized || areaBlocksBuild || lackBuild);
                        }
                        if (dismantleBtn) dismantleBtn.classList.toggle('locked', masked || pending || count <= 0);
                        if (upgradeBtn) upgradeBtn.classList.toggle('locked', masked || pending || !canUpgrade || areaBlocksUpgrade || lackUpgrade);
                        if (downgradeBtn) downgradeBtn.classList.toggle('locked', masked || pending || level <= 0);

                        try {
                            ensurePlanInputDom();
                            bindPlanInputs((action) => {
                                try {
                                    if (!currentLocation || !getActiveBuilding()) return;
                                    const liveLoc = getLocationBuildingData(currentLocation.data.id, getActiveBuilding());
                                    const liveBody = currentLocation.data;
                                    const plan = getPlanForAction(building, liveLoc, action);
                                    if (!plan) return;
                                    setCostHoverAction(action);
                                    const isPend = hasPendingAction(currentLocation.data.id, getActiveBuilding());
                                    updateBuildingCostPanel({
                                        template: building,
                                        locData: liveLoc,
                                        bodyData: liveBody,
                                        forceAction: action,
                                        open: true,
                                        resolvedOverride: plan,
                                        skipStockCheck: isPend
                                    });
                                    if (!isPend) {
                                        if (isPlanNoOp(plan)) {
                                            setConstructionPreview(null);
                                        } else {
                                            setConstructionPreview({ type: action, durationMs: plan.durationMs || 0 });
                                        }
                                        updateConstructionUI(startTime.getTime(), currentLocation.data.id, getActiveBuilding());
                                    }
                                    syncPlanInputs({
                                        bodyData: liveBody,
                                        template: building,
                                        locData: liveLoc,
                                        masked: isBuildingInfoMasked(building.id),
                                        pending: isPend
                                    });
                                } catch (e) { console.warn('plan input change', e); }
                            });
                            syncPlanInputs({
                                bodyData,
                                template: building,
                                locData: locationData,
                                masked,
                                pending
                            });
                        } catch (e) { console.warn('plan inputs', e); }
                    }

                    function refreshAreaDisplay(locData) {
                        const areaEl = document.getElementById('modal-area');
                        if (!areaEl) return;

                        // Занято: OccupiedArea из JSON (м²) × количество
                        const occupiedM2 = getBuildingOccupiedM2(building, locData);
                        // Свободно в зоне: сумма типов поверхностей − все здания зоны (км²)
                        const freeKm2 = getZoneFreeKm2(currentLocation.data, currentLocation.data.id, building.constructionZone);

                        const occupiedText = formatValue(occupiedM2, 'м²');
                        const freeText = freeKm2 == null ? '∞' : formatValue(freeKm2, 'км²');
                        areaEl.textContent = `${occupiedText} / ${freeText}`;

                        const needBuild = getBuildExtraAreaKm2(building, locData);
                        const needUpgrade = getUpgradeExtraAreaKm2(building, locData);
                        const lack = freeKm2 != null && (
                            ((locData.built_count || 0) < (building.max_count || Infinity) && needBuild > freeKm2) ||
                            ((locData.built_count || 0) > 0 && (locData.currentLevel || 0) < (building.maxLevel || Infinity) && needUpgrade > freeKm2)
                        );
                        areaEl.style.color = lack ? '#e88' : '';
                    }

                    function refreshSpecialists(locData) {
                        const lvl = locData.currentLevel || 0;
                        const cnt = locData.built_count || 0;
                        const cap = locData.currentBuildingCapacity ?? 100;
                        const effective = cnt * (cap / 100);

                        const engEl = document.getElementById('engineering-capacity');
                        const botEl = document.getElementById('botanical-capacity');
                        const sciEl = document.getElementById('scientific-capacity');
                        const expEl = document.getElementById('expedition-capacity');

                        if (engEl) {
                            const parent = engEl.parentElement;
                            if (parent) parent.style.display = departments.includes('DEP1') ? 'flex' : 'none';
                            if (departments.includes('DEP1')) {
                                const maxV = getMaxForLevel(building.maxEngineeringCapacity, lvl);
                                engEl.textContent = `${locData.currentEngineeringCapacity || 0} / ${Math.round(maxV * effective)}`;
                            }
                        }
                        if (botEl) {
                            const parent = botEl.parentElement;
                            if (parent) parent.style.display = departments.includes('DEP2') ? 'flex' : 'none';
                            if (departments.includes('DEP2')) {
                                const maxV = getMaxForLevel(building.maxBotanicalCapacity, lvl);
                                botEl.textContent = `${locData.currentBotanicalCapacity || 0} / ${Math.round(maxV * effective)}`;
                            }
                        }
                        if (sciEl) {
                            const parent = sciEl.parentElement;
                            if (parent) parent.style.display = departments.includes('DEP3') ? 'flex' : 'none';
                            if (departments.includes('DEP3')) {
                                const maxV = getMaxForLevel(building.maxScientificCapacity, lvl);
                                sciEl.textContent = `${locData.currentScientificCapacity || 0} / ${Math.round(maxV * effective)}`;
                            }
                        }
                        if (expEl) {
                            const parent = expEl.parentElement;
                            if (parent) parent.style.display = departments.includes('DEP4') ? 'flex' : 'none';
                            if (departments.includes('DEP4')) {
                                const maxV = getMaxForLevel(building.maxExpeditionCapacity, lvl);
                                expEl.textContent = `${locData.currentExpeditionCapacity || 0} / ${Math.round(maxV * effective)}`;
                            }
                        }
                    }

                    function refreshEnergy(locData) {
                        const lvl = locData.currentLevel || 0;
                        const cnt = locData.built_count || 0;
                        const cap = locData.currentBuildingCapacity ?? 100;

                        // расход
                        const maxPer = (building.EnergyConsumption || [])[lvl] || 0;
                        const maxE = maxPer * cnt;
                        const curE = maxE * (cap / 100);
                        if (energyElement && energyValueSpan) {
                            if (building.RequiresElectricity && cnt > 0) {
                                energyElement.style.display = 'block';
                                energyValueSpan.textContent = formatEnergyPair(curE, maxE).text;
                            } else {
                                energyElement.style.display = 'none';
                            }
                        }

                        // производство — только рецепты
                        const prodEl = document.getElementById('energy-production');
                        const prodVal = document.getElementById('energy-production-value');
                        if (prodEl && prodVal) {
                            let curP = 0, maxP = 0;
                            for (const recipe of (getRecipesForBuilding(building.id) || [])) {
                                if (!(recipe.outputs || []).some(o => o.resourceId === 'RES_ELECTRICITY')) continue;
                                curP += getRecipeActualOutput(currentLocation.data.id, building.id, recipe, 'RES_ELECTRICITY');
                                maxP += getRecipeBaseOutput(currentLocation.data.id, building.id, recipe, 'RES_ELECTRICITY');
                            }
                            if (cnt > 0 && maxP > 0) {
                                prodEl.style.display = 'block';
                                prodVal.textContent = formatEnergyPair(curP, maxP).text;
                            } else {
                                prodEl.style.display = 'none';
                            }
                        }

                        const stEl = document.getElementById('energy-storage');
                        const stVal = document.getElementById('energy-storage-value');
                        if (stEl && stVal) {
                            if (building.StoresEnergy && cnt > 0) {
                                let maxStore = 0;
                                if (buildingHasEnergyCapacityRecipe(building.id)) {
                                    maxStore = getBuildingEnergyCapacityWh(currentLocation.data.id, building.id).wh;
                                } else {
                                    const capArr = building.MaxEnergyCapacity || [];
                                    maxStore = (capArr[lvl] || 0) * (cap / 100) * cnt;
                                }
                                const curStore = Math.min(maxStore, Number(locData.currentStoredEnergy) || 0);
                                stEl.style.display = 'block';
                                stVal.textContent = formatEnergyWhPair(curStore, maxStore).text;
                            } else {
                                stEl.style.display = 'none';
                            }
                        }
                    }

                    function refreshStructure(locData) {
                        const stRow = document.getElementById('modal-structure-row');
                        const stVal = document.getElementById('modal-structure-value');
                        if (!stRow || !stVal) return;
                        const cnt = locData.built_count || 0;
                        const lvl = locData.currentLevel || 0;
                        const maxS = getStructureMax(building, lvl) * Math.max(0, cnt);
                        if (cnt > 0 && maxS > 0) {
                            const curS = Math.min(maxS, Math.max(0, Number(locData.currentStructure) || 0));
                            stRow.style.display = 'block';
                            stVal.textContent = `${Math.floor(curS)} / ${Math.floor(maxS)} ${t('unit.HP')}`;
                            stVal.style.color = curS < maxS * 0.5 ? '#e88' : (curS < maxS ? '#ec8' : '');
                        } else {
                            stRow.style.display = 'none';
                        }
                    }

                    function refreshAll() {
                        // Всегда берём свежие данные из state
                        const locData = getLocationBuildingData(currentLocation.data.id, getActiveBuilding());
                        const count = locData.built_count || 0;
                        const level = locData.currentLevel || 0;
                        const builtElR = document.getElementById('modal-built-count');
                        const levelElR = document.getElementById('modal-level');

                        if (isBuildingInfoMasked(building.id)) {
                            if (builtElR) builtElR.textContent = t('common.unknownLower');
                            if (levelElR) levelElR.textContent = t('common.unknownLower');
                        } else {
                            if (builtElR) builtElR.textContent = `${count}x`;
                            if (levelElR) levelElR.textContent = `${level} / ${building.maxLevel || 0}`;
                        }
                        setButtonLocks(locData);
                        refreshEnergy(locData);
                        refreshSpecialists(locData);
                        refreshAreaDisplay(locData);
                        refreshStructure(locData);

                        // --- Аватар в модалке: img / video ---
                        const bTpl = state.buildings?.find(b => b.id === getActiveBuilding());
                        if (bTpl) {
                            try { updateBuildingModalAvatar(bTpl, { built_count: count, ...locData }); } catch (_) {}
                        }

                        // --- Элемент в сетке зданий ---
                        const item = buildingGrid.querySelector(`.building-item[data-building-id="${getActiveBuilding()}"]`);
                        if (item) {
                            const span = item.querySelector('.building-count') || item.querySelector('span');
                            if (span) {
                                if (isBuildingInfoMasked(building.id)) {
                                    span.textContent = t('modal.levelUnknown');
                                    const nameP = item.querySelector('p');
                                    if (nameP) nameP.textContent = t('common.unknownBuilding');
                                } else {
                                    span.textContent = `Ур. ${level} / ${building.maxLevel || 0}   [ ${count}x ]`;
                                    const nameP = item.querySelector('p');
                                    if (nameP) nameP.textContent = locName(building.name, t('common.unknown'));
                                }
                            }
                            if (count === 0) {
                                item.classList.add('grayscale');
                            } else {
                                item.classList.remove('grayscale');
                            }
                            const pendAct = locData.pendingAction || getPendingAction(currentLocation.data.id, getActiveBuilding());
                            const pt = pendAct?.type || '';
                            item.classList.toggle('is-constructing', pt === 'build' || pt === 'upgrade');
                            item.classList.toggle('is-deconstructing', pt === 'dismantle' || pt === 'downgrade');
                            if (!item.querySelector('.building-action-tri--up')) {
                                item.insertAdjacentHTML('beforeend',
                                    '<span class="building-action-tri building-action-tri--up" aria-hidden="true">▲</span>'
                                    + '<span class="building-action-tri building-action-tri--down" aria-hidden="true">▼</span>');
                            }
                        }

                        // На всякий случай обновить счётчики всех видимых зданий
                        updateBuildingCounts();
                        try { updateResourceBar(currentLocation); } catch (e) { console.warn('refreshAll resourceBar', e); }
                    }

                    setButtonLocks(locationData);
                    refreshSpecialists(locationData);
                    refreshAreaDisplay(locationData);
                    try {
                        const locId = currentLocation.data.id;
                        const bId = getActiveBuilding();
                        if (isBuildingInfoMasked(building.id)) {
                            closeBuildingCostPanel();
                        } else if (hasPendingAction(locId, bId)) {
                            const p = getPendingAction(locId, bId);
                            refreshBuildingCostPanel(locId, bId, building, currentLocation.data, p?.type);
                        } else {
                            closeBuildingCostPanel();
                        }
                    } catch (_) {}

                    // --- обработчики (всегда свежие, т.к. кнопки склонированы) ---
                    if (buildBtn) {
                        buildBtn.addEventListener('click', (e) => {
                            if (e.target?.closest?.('.plan-target-input')) return;
                            if (buildBtn.classList.contains('locked') || !currentLocation || !getActiveBuilding()) return;
                            if (buildBtn.classList.contains('plan-unaffordable') || buildBtn.classList.contains('plan-noop')) return;
                            const locId = currentLocation.data.id;
                            const bId = getActiveBuilding();
                            const locData = getLocationBuildingData(locId, bId);
                            if (hasPendingAction(locId, bId)) return;
                            const plan = getPlanForAction(building, locData, 'build');
                            if (isPlanNoOp(plan)) return;
                            if (hasResourceCostTable(building)) {
                                if (plan?.mode === 'cost') {
                                    if (!canAffordPlan(currentLocation.data, plan)) {
                                        buildBtn.classList.add('plan-unaffordable');
                                        return;
                                    }
                                    if (!spendEntries(currentLocation.data, plan.entries)) return;
                                } else {
                                    if (!canAffordAction(currentLocation.data, building, locData, 'build')) return;
                                    if (!spendActionResources(currentLocation.data, building, locData, 'build')) return;
                                }
                                try { updateResourceBar(currentLocation); } catch (_) {}
                            }
                            startConstruction(locId, bId, 'build', building, locData, startTime.getTime(), plan);
                            try { clearPlanInputs(); } catch (_) {}
                            refreshAll();
                            updateConstructionUI(startTime.getTime(), locId, bId);
                            try { refreshBuildingCostPanel(locId, bId, building, currentLocation.data, 'build'); } catch (_) {}
                        });
                    }
                    if (dismantleBtn) {
                        dismantleBtn.addEventListener('click', (e) => {
                            if (e.target?.closest?.('.plan-target-input')) return;
                            if (dismantleBtn.classList.contains('locked') || !currentLocation || !getActiveBuilding()) return;
                            const locId = currentLocation.data.id;
                            const bId = getActiveBuilding();
                            const locData = getLocationBuildingData(locId, bId);
                            if ((locData.built_count || 0) <= 0) return;
                            if (hasPendingAction(locId, bId)) return;
                            const plan = getPlanForAction(building, locData, 'dismantle');
                            if (isPlanNoOp(plan)) return;
                            startConstruction(locId, bId, 'dismantle', building, locData, startTime.getTime(), plan);
                            try { clearPlanInputs(); } catch (_) {}
                            refreshAll();
                            updateConstructionUI(startTime.getTime(), locId, bId);
                            try { refreshBuildingCostPanel(locId, bId, building, currentLocation.data, 'dismantle'); } catch (_) {}
                        });
                    }
                    if (upgradeBtn) {
                        upgradeBtn.addEventListener('click', (e) => {
                            if (e.target?.closest?.('.plan-target-input')) return;
                            if (upgradeBtn.classList.contains('locked') || !currentLocation || !getActiveBuilding()) return;
                            const locId = currentLocation.data.id;
                            const bId = getActiveBuilding();
                            const locData = getLocationBuildingData(locId, bId);
                            if ((locData.built_count || 0) <= 0) return;
                            if ((locData.currentLevel || 0) >= (building.maxLevel || Infinity)) return;
                            if (hasPendingAction(locId, bId)) return;
                            const plan = getPlanForAction(building, locData, 'upgrade');
                            if (upgradeBtn.classList.contains('plan-unaffordable') || upgradeBtn.classList.contains('plan-noop')) return;
                            if (isPlanNoOp(plan)) return;
                            if (hasResourceCostTable(building)) {
                                if (plan?.mode === 'cost') {
                                    if (!canAffordPlan(currentLocation.data, plan)) return;
                                    if (!spendEntries(currentLocation.data, plan.entries)) return;
                                } else {
                                    if (!canAffordAction(currentLocation.data, building, locData, 'upgrade')) return;
                                    if (!spendActionResources(currentLocation.data, building, locData, 'upgrade')) return;
                                }
                                try { updateResourceBar(currentLocation); } catch (_) {}
                            }
                            startConstruction(locId, bId, 'upgrade', building, locData, startTime.getTime(), plan);
                            try { clearPlanInputs(); } catch (_) {}
                            refreshAll();
                            updateConstructionUI(startTime.getTime(), locId, bId);
                            try { refreshBuildingCostPanel(locId, bId, building, currentLocation.data, 'upgrade'); } catch (_) {}
                        });
                    }
                    if (downgradeBtn) {
                        downgradeBtn.addEventListener('click', (e) => {
                            if (e.target?.closest?.('.plan-target-input')) return;
                            if (downgradeBtn.classList.contains('locked') || !currentLocation || !getActiveBuilding()) return;
                            const locId = currentLocation.data.id;
                            const bId = getActiveBuilding();
                            const locData = getLocationBuildingData(locId, bId);
                            if ((locData.currentLevel || 0) <= 0) return;
                            if (hasPendingAction(locId, bId)) return;
                            const plan = getPlanForAction(building, locData, 'downgrade');
                            if (isPlanNoOp(plan)) return;
                            startConstruction(locId, bId, 'downgrade', building, locData, startTime.getTime(), plan);
                            try { clearPlanInputs(); } catch (_) {}
                            refreshAll();
                            updateConstructionUI(startTime.getTime(), locId, bId);
                            try { refreshBuildingCostPanel(locId, bId, building, currentLocation.data, 'downgrade'); } catch (_) {}
                        });
                    }

                    // Предпросмотр длительности при наведении на кнопки
                    function bindActionPreview(btn, actionType) {
                        if (!btn) return;
                        btn.addEventListener('mouseenter', () => {
                            if (!currentLocation || !getActiveBuilding()) return;
                            const locId = currentLocation.data.id;
                            const bId = getActiveBuilding();
                            // маска / locked — не превью таймера и не панель ресурсов
                            if (isBuildingInfoMasked(building.id) || btn.classList.contains('locked')) {
                                setCostHoverAction(null);
                                try { closeBuildingCostPanel(); } catch (_) {}
                                return;
                            }
                            // Не перекрываем активную операцию таймером, но costs можно показать
                            if (!hasPendingAction(locId, bId)) {
                                const locData = getLocationBuildingData(locId, bId);
                                const plan = getPlanForAction(building, locData, actionType);
                                if (isPlanNoOp(plan)) {
                                    setConstructionPreview(null);
                                } else {
                                    const durationMs = plan?.durationMs || getActionDurationMs(building, locData, actionType);
                                    setConstructionPreview({ type: actionType, durationMs });
                                }
                                updateConstructionUI(startTime.getTime(), locId, bId);
                            }
                            setCostHoverAction(actionType);
                            try {
                                const locData = getLocationBuildingData(locId, bId);
                                const plan = getPlanForAction(building, locData, actionType);
                                if (plan) {
                                    updateBuildingCostPanel({
                                        template: building,
                                        locData,
                                        bodyData: currentLocation.data,
                                        forceAction: actionType,
                                        open: true,
                                        resolvedOverride: plan,
                                        skipStockCheck: hasPendingAction(locId, bId)
                                    });
                                } else {
                                    refreshBuildingCostPanel(locId, bId, building, currentLocation.data, actionType);
                                }
                            } catch (_) {}
                        });
                        btn.addEventListener('mouseleave', () => {
                            setConstructionPreview(null);
                            setCostHoverAction(null);
                            if (!currentLocation || !getActiveBuilding()) return;
                            const locId = currentLocation.data.id;
                            const bId = getActiveBuilding();
                            updateConstructionUI(startTime.getTime(), locId, bId);
                            // если идёт стройка — оставить панель открытой с типом pending
                            try {
                                if (hasPendingAction(locId, bId)) {
                                    const p = getPendingAction(locId, bId);
                                    refreshBuildingCostPanel(locId, bId, building, currentLocation.data, p?.type);
                                } else {
                                    closeBuildingCostPanel();
                                }
                            } catch (_) {}
                        });
                    }
                    bindActionPreview(buildBtn, 'build');
                    bindActionPreview(dismantleBtn, 'dismantle');
                    bindActionPreview(upgradeBtn, 'upgrade');
                    bindActionPreview(downgradeBtn, 'downgrade');


                    // ---- power slider ----
                    const powerContainer = document.getElementById('power-container');
                    if (powerContainer) {
                        powerContainer.style.display = 'flex';
                        const powerSlider = document.getElementById('power-slider');
                        const powerValue = document.getElementById('power-value');
                        if (powerSlider && powerValue) {
                            // клонируем слайдер чтобы сбросить старые слушатели
                            const newSlider = powerSlider.cloneNode(true);
                            powerSlider.replaceWith(newSlider);
                            newSlider.value = currentCapacity;
                            powerValue.textContent = `${currentCapacity} \\ 100%`;

                            const applyPower = (raw) => {
                                if (!currentLocation || !getActiveBuilding()) return;
                                const newCap = Math.max(0, Math.min(100, parseInt(raw, 10) || 0));
                                const locId = currentLocation.data.id;
                                const locData = getLocationBuildingData(locId, getActiveBuilding());
                                locData.currentBuildingCapacity = newCap;
                                newSlider.value = String(newCap);
                                powerValue.textContent = `${newCap} \\ 100%`;
                                try { refreshEnergy(locData); } catch (_) {}
                                try { refreshSpecialists(locData); } catch (_) {}
                                try { updateResourceBar(currentLocation); } catch (_) {}
                            };
                            newSlider.addEventListener('input', (e) => applyPower(e.target.value));
                            newSlider.addEventListener('change', (e) => applyPower(e.target.value));
                        }
                    }

                    // показать контейнер кнопок / основное
                    const bcc = document.getElementById('building-controls-container');
                    if (bcc) bcc.style.display = 'flex';
                    if (modalContent) modalContent.style.display = 'flex';
                    if (modalBodyEl) modalBodyEl.style.display = 'flex';
                    try { showSchemesPanel(false); } catch (_) {}
                    try { showLevelsPanel(false); } catch (_) {}
                    try { document.getElementById('building-modal')?.classList.remove('levels-open', 'schemes-open'); } catch (_) {}
                    try { updateLevelsTabLock(); } catch (_) {}

                    console.log(`Modal: ${getActiveBuilding()} on ${locName(currentLocation.data.name)} | lvl=${locationData.currentLevel} count=${locationData.built_count}`);
                    try { updateConstructionUI(startTime.getTime(), currentLocation.data.id, getActiveBuilding()); } catch (_) {}
                } else if (activeModalTab === 'modal-tab-schemes') {
                    if (modalContent) modalContent.style.display = 'none';
                    const bcc = document.getElementById('building-controls-container');
                    if (bcc) bcc.style.display = 'none';
                    const pc = document.getElementById('power-container');
                    if (pc) pc.style.display = 'none';
                    try { showLevelsPanel(false); } catch (_) {}
                    try { document.getElementById('building-modal')?.classList.remove('levels-open', 'schemes-open'); } catch (_) {}
                    try {
                        const modalEl = document.getElementById('building-modal');
                        if (modalEl) modalEl.classList.add('schemes-open');
                        showSchemesPanel(true, getActiveBuilding());
                        renderSchemesTab(currentLocation.data.id, getActiveBuilding());
                    } catch (e) {
                        console.error('schemes tab render failed', e);
                    }
                } else if (activeModalTab === 'modal-tab-levels') {
                    if (modalContent) modalContent.style.display = 'none';
                    const bcc = document.getElementById('building-controls-container');
                    if (bcc) bcc.style.display = 'none';
                    const pc = document.getElementById('power-container');
                    if (pc) pc.style.display = 'none';
                    try { showSchemesPanel(false); } catch (_) {}
                    try { updateLevelsTabLock(); } catch (_) {}
                    if (isLevelsTabLocked()) {
                        try { showLevelsPanel(false); } catch (_) {}
                        try { document.getElementById('building-modal')?.classList.remove('levels-open', 'schemes-open'); } catch (_) {}
                        // откат на основное если вкладка ещё недоступна
                        activeModalTab = 'modal-tab-main';
                        document.querySelectorAll('.modal-tab-button').forEach(btn => {
                            btn.classList.toggle('active', btn.id === 'modal-tab-main');
                            btn.classList.toggle('inactive', btn.id !== 'modal-tab-main');
                        });
                        // re-enter main branch via recursion would be heavy — leave empty panel
                    } else {
                        try {
                            const modalEl = document.getElementById('building-modal');
                            if (modalEl) modalEl.classList.add('levels-open');
                            showLevelsPanel(true);
                            renderLevelsTab(currentLocation.data.id, getActiveBuilding(), currentLocation.data);
                        } catch (e) {
                            console.error('levels tab render failed', e);
                        }
                    }
                } else {
                    // другие вкладки (заглушка)
                    if (modalContent) modalContent.style.display = 'none';
                    const bcc = document.getElementById('building-controls-container');
                    if (bcc) bcc.style.display = 'none';
                    const pc = document.getElementById('power-container');
                    if (pc) pc.style.display = 'none';
                    try { showSchemesPanel(false); } catch (_) {}
                    try { showLevelsPanel(false); } catch (_) {}
                    try { document.getElementById('building-modal')?.classList.remove('levels-open', 'schemes-open'); } catch (_) {}
                }
            } else {
                hideBuildingModal();
                setActiveBuilding(null);
            }
        }
    } else {
        // Не режим строительства — скрываем список и модалку
        buildingList.style.display = 'none';
        hideBuildingModal();
        const powerContainer = document.getElementById('power-container');
        if (powerContainer) powerContainer.style.display = 'none';
    }


}


/**
 * Живое обновление строки «Накоплено энергии» в открытой модалке.
 * Вызывать из игрового цикла после tickLocationEnergyStorage.
 */
export function refreshModalEnergyStorage(locationId, buildingId) {
    if (locationId == null || !buildingId) return;
    const modal = document.getElementById('building-modal');
    if (!modal || modal.style.display === 'none') return;

    const storageEl = document.getElementById('energy-storage');
    const storageVal = document.getElementById('energy-storage-value');
    if (!storageEl || !storageVal) return;

    const building = state.buildings.find(b => b.id === buildingId);
    if (!building || !building.StoresEnergy) {
        storageEl.style.display = 'none';
        return;
    }

    const locData = getLocationBuildingData(locationId, buildingId);
    const count = locData.built_count || 0;
    if (count <= 0) {
        storageEl.style.display = 'none';
        return;
    }

    const level = locData.currentLevel || 0;
    const cap = (locData.currentBuildingCapacity ?? 100) / 100;
    let maxStore = 0;
    if (buildingHasEnergyCapacityRecipe(buildingId)) {
        maxStore = getBuildingEnergyCapacityWh(locationId, buildingId).wh;
    } else {
        maxStore = ((building.MaxEnergyCapacity || [])[level] || 0) * cap * count;
    }
    const curStore = Math.min(maxStore, Number(locData.currentStoredEnergy) || 0);
    storageEl.style.display = 'block';
    storageVal.textContent = formatEnergyWhPair(curStore, maxStore).text;
}


/** Живое обновление вместимости населения в модалке */
export function refreshModalPopulation(locationId, buildingId) {
    if (locationId == null || !buildingId) return;
    const modal = document.getElementById('building-modal');
    if (!modal || modal.style.display === 'none') return;

    const popEl = document.getElementById('modal-population');
    const popVal = document.getElementById('modal-population-value');
    if (!popEl || !popVal) return;

    const building = state.buildings.find(b => b.id === buildingId);
    if (!building?.IsResidential) {
        popEl.style.display = 'none';
        return;
    }
    const locData = getLocationBuildingData(locationId, buildingId);
    const count = locData.built_count || 0;
    if (count <= 0) {
        popEl.style.display = 'none';
        return;
    }
    const maxR = getBuildingMaxResidents(building, locData, locationId);
    const curR = Math.min(maxR, Number(locData.currentResidents) || 0);
    popEl.style.display = 'block';
    popVal.textContent = `${curR} / ${maxR}`;
}


/** Живое обновление структуры (ОЖ) в открытой модалке */
export function refreshModalStructure(locationId, buildingId) {
    if (locationId == null || !buildingId) return;
    const modal = document.getElementById('building-modal');
    if (!modal || modal.style.display === 'none') return;
    const stRow = document.getElementById('modal-structure-row');
    const stVal = document.getElementById('modal-structure-value');
    if (!stRow || !stVal) return;
    const building = state.buildings.find(b => b.id === buildingId);
    if (!building) return;
    const locData = getLocationBuildingData(locationId, buildingId);
    const count = locData.built_count || 0;
    const level = locData.currentLevel || 0;
    const maxS = getStructureMax(building, level) * Math.max(0, count);
    if (count <= 0 || maxS <= 0) {
        stRow.style.display = 'none';
        return;
    }
    const curS = Math.min(maxS, Math.max(0, Number(locData.currentStructure) || 0));
    stRow.style.display = 'block';
    stVal.textContent = `${Math.floor(curS)} / ${Math.floor(maxS)} ${t('unit.HP')}`;
    stVal.style.color = curS < maxS * 0.5 ? '#e88' : (curS < maxS ? '#ec8' : '');
}


/** Обновить подписи в списке зданий (с учётом масок квестов) — без полного rebuild секции */
export function refreshBuildingListMasks(currentLocation) {
    if (!currentLocation) return;
    const grid = document.getElementById('building-grid');
    if (!grid) return;
    grid.querySelectorAll('.building-item').forEach(item => {
        const building = state.buildings.find(b => b.id === item.dataset.buildingId);
        if (!building) return;
        const locationData = getLocationBuildingData(currentLocation.data.id, building.id);
        if (!locationData) return;
        const masked = isBuildingInfoMasked(building.id);
        const nameP = item.querySelector('p');
        const span = item.querySelector('.building-count') || item.querySelector('span');
        if (nameP) nameP.textContent = masked ? t('common.unknownBuilding') : (locName(building.name, t('common.unknown')));
        if (span) {
            span.textContent = masked
                ? t('modal.levelUnknown')
                : `Ур. ${locationData.currentLevel || 0} / ${building.maxLevel || 0}   [ ${locationData.built_count || 0}x ]`;
        }
    });
}

export function refreshModalStorage(locationId, buildingId) {
    const storEl = document.getElementById('modal-storage');
    const storVal = document.getElementById('modal-storage-value');
    if (!storEl || !storVal) return;
    const building = (state.buildings || []).find(b => b.id === buildingId);
    if (!isStorageBuilding(building)) {
        storEl.style.display = 'none';
        return;
    }
    const locData = getLocationBuildingData(locationId, buildingId);
    const count = locData?.built_count || 0;
    if (count <= 0) {
        storEl.style.display = 'none';
        return;
    }
    storEl.style.display = 'block';
    if (isBuildingInfoMasked(buildingId)) {
        storVal.textContent = t('common.unknownLower');
        return;
    }
    try {
        const bodyData = globalThis.__currentBodyData;
        const fill = getBuildingStorageFill(locationId, buildingId, bodyData);
        if (!fill || fill.revealed === false) {
            storVal.textContent = t('common.unknownLower');
        } else {
            const pct = Number.isFinite(fill.percent) ? fill.percent : 0;
            storVal.textContent = `${pct.toFixed(1)}% / 100%`;
        }
    } catch (e) {
        console.warn('refreshModalStorage', e);
        storVal.textContent = '—';
    }
}


/** Вызывается после завершения любой стройки/разбора — сброс плановых инпутов */
export function notifyConstructionFinished() {
    try { clearPlanInputs(); } catch (_) {}
    try {
        // сбросить превью таймера, если висели старые цифры плана
        setConstructionPreview(null);
    } catch (_) {}
}


/** Восстановить плановые инпуты после возврата из главного меню */
export function restoreBuildingPlanInputs(currentLocation, getActiveBuildingFn) {
    try {
        const modal = document.getElementById('building-modal');
        if (!modal) return;
        const visible = modal.style.display !== 'none' && window.getComputedStyle(modal).display !== 'none';
        if (!visible) return;
        ensurePlanInputDom();
        if (!currentLocation || !getActiveBuildingFn) {
            restorePlanInputsIfNeeded({});
            return;
        }
        const bId = getActiveBuildingFn();
        if (!bId) {
            restorePlanInputsIfNeeded({});
            return;
        }
        const building = (state.buildings || []).find(b => b.id === bId);
        const locData = getLocationBuildingData(currentLocation.data.id, bId);
        const pending = !!(locData && locData.pendingAction);
        const masked = building ? isBuildingInfoMasked(building.id) : false;
        restorePlanInputsIfNeeded({
            bodyData: currentLocation.data,
            template: building,
            locData,
            masked,
            pending
        });
    } catch (e) {
        console.warn('restoreBuildingPlanInputs', e);
    }
}