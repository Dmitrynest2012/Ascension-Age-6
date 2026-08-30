import { state } from './state.js';
import { getLocationBuildingData, updateLocationBuildingData, buildingBelongsToLocation } from './buildingHelpers.js';
import { getSpecialistStats } from './specialists.js';
import { isRecipeInteractable } from './uiMasks.js';
import { addResourceClamped, isResourceStorageFull, getResourceMaxCapacity, clampAllStocksToCapacity } from './resourceStorage.js';

/** @type {Map<string, object>} */
let resourcesById = new Map();
/** @type {object[]} */
let allRecipes = [];
/** @type {Map<string, object[]>} buildingId → recipes */
let recipesByBuilding = new Map();

export async function loadRecipesData() {
    const [resRes, recRes] = await Promise.all([
        fetch('resources.json'),
        fetch('recipes.json')
    ]);
    const resources = await resRes.json();
    const recipes = await recRes.json();

    resourcesById = new Map(resources.map(r => [r.id, r]));
    allRecipes = recipes;
    recipesByBuilding = new Map();
    for (const r of recipes) {
        for (const bid of r.buildingIds || []) {
            if (!recipesByBuilding.has(bid)) recipesByBuilding.set(bid, []);
            recipesByBuilding.get(bid).push(r);
        }
    }
    console.log(`Recipes loaded: ${recipes.length}, resources: ${resources.length}`);
    globalThis.__resourceCatalog = resourcesById;
}

export function getResource(id) {
    return resourcesById.get(id) || null;
}

export function getAllResources() {
    return Array.from(resourcesById.values());
}

export function getResourcesBySection(section) {
    return getAllResources().filter(r => r.resourceBarSection === section);
}

export function getRecipesForBuilding(buildingId) {
    return recipesByBuilding.get(buildingId) || [];
}

export function getRecipe(recipeId) {
    return allRecipes.find(r => r.id === recipeId) || null;
}

export function getAllRecipes() {
    return allRecipes.slice();
}

/** state.locationBuildingRecipes[locId][buildingId][recipeId] = power% 0..100 */
function ensureRecipeState(locationId, buildingId) {
    const locId = Number(locationId);
    if (!state.locationBuildingRecipes) state.locationBuildingRecipes = {};
    if (!state.locationBuildingRecipes[locId]) state.locationBuildingRecipes[locId] = {};
    if (!state.locationBuildingRecipes[locId][buildingId]) {
        state.locationBuildingRecipes[locId][buildingId] = {};
    }
    return state.locationBuildingRecipes[locId][buildingId];
}

export function getRecipeLocalPower(locationId, buildingId, recipeId) {
    const st = ensureRecipeState(locationId, buildingId);
    if (st[recipeId] === undefined || st[recipeId] === null) st[recipeId] = 0;
    return Math.max(0, Math.min(100, Number(st[recipeId]) || 0));
}

/** Сумма локальных мощностей всех рецептов здания (информативно; лимита 100 больше нет) */
export function getBuildingRecipesPowerUsed(locationId, buildingId) {
    const recipes = getRecipesForBuilding(buildingId);
    let sum = 0;
    for (const r of recipes) {
        sum += getRecipeLocalPower(locationId, buildingId, r.id);
    }
    return sum;
}

export function getBuildingRecipesPowerRemaining(locationId, buildingId) {
    return Math.max(0, 100 - getBuildingRecipesPowerUsed(locationId, buildingId));
}

/**
 * Установить локальную мощность рецепта (0–100).
 * Каждый рецепт независим; общая мощность здания влияет отдельно (множитель).
 */
export function setRecipeLocalPower(locationId, buildingId, recipeId, percent) {
    if (!isRecipeInteractable(recipeId, buildingId)) return;
    const st = ensureRecipeState(locationId, buildingId);
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    st[recipeId] = p;
    syncBuildingSpecialistsFromRecipes(locationId, buildingId);
    return p;
}

/**
 * Список resourceId для входа (основной + alternatives), в порядке приоритета.
 */
export function getInputResourceIds(inp) {
    if (!inp) return [];
    if (Array.isArray(inp.resourceIds) && inp.resourceIds.length) {
        return inp.resourceIds.map(String);
    }
    const ids = [];
    if (inp.resourceId) ids.push(String(inp.resourceId));
    if (Array.isArray(inp.alternatives)) {
        for (const a of inp.alternatives) {
            const s = String(a);
            if (!ids.includes(s)) ids.push(s);
        }
    }
    return ids;
}

/**
 * Выбрать ресурс для входа: первый из списка, которого хватает на need (или любой с запасом > 0).
 * Возвращает { resourceId, have } или null.
 */
export function pickInputResource(bodyData, inp, needAmount) {
    const ids = getInputResourceIds(inp);
    if (!ids.length) return null;
    // 1) первый, у которого сток >= need
    for (const id of ids) {
        const res = getResource(id);
        if (res?.infinite) return { resourceId: id, have: Infinity, infinite: true };
        const have = getStockAmount(bodyData, id);
        if (have + 1e-9 >= needAmount) return { resourceId: id, have, infinite: false };
    }
    // 2) иначе первый с любым положительным запасом (частичный тик снаружи)
    for (const id of ids) {
        const res = getResource(id);
        if (res?.infinite) return { resourceId: id, have: Infinity, infinite: true };
        const have = getStockAmount(bodyData, id);
        if (have > 0) return { resourceId: id, have, infinite: false };
    }
    return null;
}

/**
 * Возврат тары после расхода входа рецепта (как у населения).
 * Упакованная вода 20 л → 1 пустая канистра.
 */
export function applyRecipeInputReturn(locationId, bodyData, resourceId, takeAmount) {
    if (!(takeAmount > 0) || !resourceId) return 0;
    const resMeta = getResource(resourceId);
    if (!resMeta) return 0;
    const doReturn = resMeta.returnAfterConsumption === true || resMeta.returnsAfterConsumption === true;
    if (!doReturn) return 0;
    const ret = resMeta.consumptionReturn || resMeta.returnOnConsume || null;
    if (!ret || !ret.resourceId) return 0;
    const perPackage = Math.max(0, Number(ret.amount) || 0);
    if (perPackage <= 0) return 0;
    const pkgW = Math.max(1e-9, Number(resMeta.packageWeightKg) || 1);
    const returnQty = (takeAmount / pkgW) * perPackage;
    if (!(returnQty > 0)) return 0;
    addResourceClamped(locationId, bodyData, String(ret.resourceId), returnQty);
    return returnQty;
}

/** Сколько тары вернёт вход в минуту, если сейчас выбран возвратный ресурс. */
export function getRecipeInputReturnPerMin(bodyData, recipe, inp, effectiveness, builtCount) {
    const need = (Number(inp?.perMinute) || 0) * Math.max(0, builtCount || 0) * Math.max(0, effectiveness || 0);
    if (need <= 0) return null;
    const pick = pickInputResource(bodyData, inp, Math.max(need, 1e-9));
    if (!pick || pick.infinite) return null;
    const resMeta = getResource(pick.resourceId);
    if (!resMeta || !(resMeta.returnAfterConsumption || resMeta.returnsAfterConsumption)) return null;
    const ret = resMeta.consumptionReturn || resMeta.returnOnConsume;
    if (!ret?.resourceId) return null;
    const pkgW = Math.max(1e-9, Number(resMeta.packageWeightKg) || 1);
    const amount = (need / pkgW) * Math.max(0, Number(ret.amount) || 0);
    if (!(amount > 0)) return null;
    return { resourceId: String(ret.resourceId), perMinute: amount, fromResourceId: pick.resourceId };
}


const ROLE_TO_DEP = {
    engineers: 'currentEngineeringCapacity',
    agronomists: 'currentBotanicalCapacity',
    scientists: 'currentScientificCapacity',
    expeditioners: 'currentExpeditionCapacity'
};

/**
 * Сколько специалистов каждой роли требуется рецептом при 100% локальной мощности
 * (умножается на built_count и localPower/100 при расчёте actual).
 */
export function getRecipeSpecialistDemand(recipe, localPowerPct, builtCount) {
    const factor = (Math.max(0, Math.min(100, localPowerPct)) / 100) * Math.max(0, builtCount || 0);
    const demand = { engineers: 0, agronomists: 0, scientists: 0, expeditioners: 0 };
    const sp = recipe.specialists || {};
    for (const role of Object.keys(demand)) {
        const raw = (Number(sp[role]) || 0) * factor;
        demand[role] = raw > 1e-9 ? Math.round(raw * 10000) / 10000 : 0;
    }
    return demand;
}

/** Отображение ставки специалиста: 1 или 0.5 */
export function formatSpecialistAmount(n) {
    const x = Number(n) || 0;
    if (Math.abs(x) < 1e-9) return '0';
    if (Math.abs(x - Math.round(x)) < 1e-6) return String(Math.round(x));
    return String(Math.round(x * 10) / 10);
}

/** Занятые специалисты всеми рецептами одного здания */
export function getBuildingRecipeSpecialistUsage(locationId, buildingId) {
    const locData = getLocationBuildingData(locationId, buildingId);
    const count = locData?.built_count || 0;
    const usage = { engineers: 0, agronomists: 0, scientists: 0, expeditioners: 0 };
    if (count <= 0) return usage;
    for (const recipe of getRecipesForBuilding(buildingId)) {
        const p = getRecipeLocalPower(locationId, buildingId, recipe.id);
        if (p <= 0) continue;
        const d = getRecipeSpecialistDemand(recipe, p, count);
        for (const role of Object.keys(usage)) usage[role] += d[role];
    }
    return usage;
}

/**
 * Суммарный спрос на специалистов всеми активными рецептами на теле.
 * @param exclude — опционально исключить одно здание+рецепт (для «свободного» пула)
 */
export function getLocationRecipeSpecialistUsage(locationId, exclude = null) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locMap = state.locationBuildings[locId] || {};
    const usage = { engineers: 0, agronomists: 0, scientists: 0, expeditioners: 0 };

    for (const buildingId of Object.keys(locMap)) {
        if (!buildingBelongsToLocation(locId, buildingId)) continue;
        const locData = locMap[buildingId];
        const count = locData?.built_count || 0;
        if (count <= 0) continue;
        for (const recipe of getRecipesForBuilding(buildingId)) {
            if (exclude && exclude.buildingId === buildingId && exclude.recipeId === recipe.id) {
                continue;
            }
            const p = getRecipeLocalPower(locId, buildingId, recipe.id);
            if (p <= 0) continue;
            const d = getRecipeSpecialistDemand(recipe, p, count);
            for (const role of Object.keys(usage)) usage[role] += d[role];
        }
    }
    return usage;
}

/**
 * Записать текущие занятые специалисты здания в locData
 * (для отображения в «Основное»: current / max).
 */
export function syncBuildingSpecialistsFromRecipes(locationId, buildingId) {
    const stats = getSpecialistStats(locationId);
    const rawUsage = getBuildingRecipeSpecialistUsage(locationId, buildingId);

    // Занятость рецептами других зданий (не этого)
    const otherUsage = { engineers: 0, agronomists: 0, scientists: 0 };
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locMap = state.locationBuildings[locId] || {};
    for (const bid of Object.keys(locMap)) {
        if (bid === buildingId) continue;
        if (!buildingBelongsToLocation(locId, bid)) continue;
        const u = getBuildingRecipeSpecialistUsage(locId, bid);
        for (const role of Object.keys(otherUsage)) otherUsage[role] += u[role];
    }

    const capped = { engineers: 0, agronomists: 0, scientists: 0 };
    const patch = {};
    for (const [role, key] of Object.entries(ROLE_TO_DEP)) {
        const hired = Math.max(0, Math.floor(Number(stats[role]) || 0));
        const free = Math.max(0, hired - (otherUsage[role] || 0));
        // Не пишем в департамент больше, чем есть свободных нанятых на теле
        capped[role] = Math.min(rawUsage[role] || 0, free);
        patch[key] = capped[role];
    }
    updateLocationBuildingData(locationId, buildingId, patch);
    return capped;
}

/**
 * Эффективность рецепта 0..1 с учётом:
 * локальной мощности, доступности специалистов на теле, энергии (если requiresEnergy).
 */
export function getRecipeEffectiveness(locationId, buildingId, recipe) {
    const locData = getLocationBuildingData(locationId, buildingId);
    const count = locData?.built_count || 0;
    if (count <= 0) return 0;
    if (!isRecipeInteractable(recipe.id, buildingId)) return 0;

    const localP = getRecipeLocalPower(locationId, buildingId, recipe.id);
    if (localP <= 0) return 0;

    const buildingCap = (locData.currentBuildingCapacity ?? 100) / 100;

    let energyRatio = 1;
    if (recipe.requiresEnergy) {
        const flags = state.locationFlags?.[Number(locationId)];
        if (flags && flags.noEnergyForBuildings) return 0;
        const pr = Number(flags?.powerRatio);
        if (Number.isFinite(pr)) {
            if (pr <= 1e-9) return 0;
            energyRatio = Math.max(0, Math.min(1, pr));
        }
    }

    // Специалисты: общий пул нанятых. Другие рецепты забирают свою долю первыми,
    // этому рецепту достаётся остаток (не больше need).
    const demand = getRecipeSpecialistDemand(recipe, localP, count);
    const stats = getSpecialistStats(locationId);

    let specialistRatio = 1;
    for (const role of ['engineers', 'agronomists', 'scientists', 'expeditioners']) {
        const need = demand[role];
        if (need <= 0) continue;
        const hired = Math.max(0, Math.floor(Number(stats[role]) || 0));
        if (hired <= 0) return 0;

        const usedOthers = getLocationRecipeSpecialistUsage(locationId, {
            buildingId,
            recipeId: recipe.id
        })[role] || 0;
        const freeForThis = Math.max(0, hired - usedOthers);
        if (freeForThis <= 0) return 0;

        specialistRatio = Math.min(specialistRatio, Math.min(1, freeForThis / need));
    }
    specialistRatio = Math.max(0, Math.min(1, specialistRatio));

    return (localP / 100) * buildingCap * specialistRatio * energyRatio;
}

/**
 * Базовый выход ресурса при 100% (без учёта эффективности).
 * scaleWithBuildingEnergyProduction: EnergyProduction[level] — МНОЖИТЕЛЬ к perMinute
 * (не абсолютные ватты). Итог: perMinute × multiplier × count.
 */
export function getRecipeBaseOutput(locationId, buildingId, recipe, resourceId) {
    const locData = getLocationBuildingData(locationId, buildingId);
    const count = locData?.built_count || 0;
    const level = locData?.currentLevel || 0;
    const template = state.buildings.find(b => b.id === buildingId);
    let total = 0;

    for (const out of recipe.outputs || []) {
        if (out.resourceId !== resourceId) continue;
        const perMin = Number(out.perMinute) || 0;
        if (out.scaleWithBuildingEnergyProduction && template) {
            const arr = template.EnergyProduction || [];
            let mult = 1;
            if (arr.length) {
                const i = Math.max(0, Math.min(level, arr.length - 1));
                const v = Number(arr[i]);
                mult = Number.isFinite(v) && v > 0 ? v : 1;
            }
            total += perMin * mult * count;
        } else if (out.scaleWithBuildingMaxEnergyCapacity && template) {
            // Макс. энергоёмкость: MaxEnergyCapacity[level] — множитель к base (perMinute)
            const arr = template.MaxEnergyCapacity || template.maxEnergyCapacity || [];
            let mult = 1;
            if (arr.length) {
                const i = Math.max(0, Math.min(level, arr.length - 1));
                const v = Number(arr[i]);
                mult = Number.isFinite(v) && v > 0 ? v : 1;
            }
            total += perMin * mult * count;
        } else if (out.scaleWithBuildingResourceStorageCapacity && template) {
            // Бонус склада: тот же индекс, что getStorageMultiplier (level 1 → index 0)
            const arr = template.ResourceStorageCapacity || [];
            let mult = 1;
            if (arr.length) {
                const lvl = Math.max(0, Number(level) || 0);
                const i = Math.min(Math.max(lvl - 1, 0), arr.length - 1);
                const v = Number(arr[i]);
                mult = Number.isFinite(v) && v > 0 ? v : 1;
            }
            total += perMin * mult * count;
        } else if (out.scaleWithBuildingPopulationCapacity && template) {
            // Бонус жилплощади: PopulationCapacity[level] — множитель (как EnergyProduction)
            const arr = template.PopulationCapacity || [];
            let mult = 1;
            if (arr.length) {
                const i = Math.max(0, Math.min(level, arr.length - 1));
                const v = Number(arr[i]);
                mult = Number.isFinite(v) && v > 0 ? v : 1;
            }
            total += perMin * mult * count;
        } else if (out.scaleWithBuildingExtractionBonus && template) {
            // Добыча гео→склад: ExtractionBonus[level]
            const arr = template.ExtractionBonus || template.extractionBonus || [];
            let mult = 1;
            if (arr.length) {
                const i = Math.max(0, Math.min(level, arr.length - 1));
                const v = Number(arr[i]);
                mult = Number.isFinite(v) && v > 0 ? v : 1;
            }
            total += perMin * mult * count;
        } else {
            total += perMin * count;
        }
    }
    // Множитель здания (напр. библиотека 0.25× к научным открытиям)
    const scaleMap = recipe.buildingOutputScale;
    if (scaleMap && buildingId != null && scaleMap[buildingId] != null) {
        const s = Number(scaleMap[buildingId]);
        if (Number.isFinite(s)) total *= s;
    }
    return total;
}


/** Эффективность переработки 0..1 (потери сырья). Нет поля → 1. */
export function getRecipeProcessingEfficiency(recipe) {
    const v = Number(recipe?.processingEfficiency);
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(1, v));
}

/** Фактический выход ресурса рецептом (мощность/штат × processingEfficiency) */
export function getRecipeActualOutput(locationId, buildingId, recipe, resourceId) {
    const base = getRecipeBaseOutput(locationId, buildingId, recipe, resourceId);
    const eff = getRecipeEffectiveness(locationId, buildingId, recipe);
    const proc = getRecipeProcessingEfficiency(recipe);
    return base * eff * proc;
}

/** Суммарное производство электричества по всем рецептам локации */
export function calcLocationRecipeElectricityProduction(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locBuildings = state.locationBuildings[locId] || {};
    let total = 0;
    const buildingsWithRecipeElec = new Set();

    for (const buildingId of Object.keys(locBuildings)) {
        if (!buildingBelongsToLocation(locId, buildingId)) continue;
        const recipes = getRecipesForBuilding(buildingId);
        for (const recipe of recipes) {
            const hasElec = (recipe.outputs || []).some(o => o.resourceId === 'RES_ELECTRICITY');
            if (!hasElec) continue;
            buildingsWithRecipeElec.add(buildingId);
            total += getRecipeActualOutput(locId, buildingId, recipe, 'RES_ELECTRICITY');
        }
    }
    try {
        const ov = state.devOverrides?.elecPerMin;
        if (ov != null && Number.isFinite(Number(ov))) total = Number(ov);
    } catch (_) {}
    return { total, buildingsWithRecipeElec };
}

/** Потоковая выработка технологий (тех./мин) — не складируется */
export function calcLocationTechProduction(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locBuildings = state.locationBuildings[locId] || {};
    let total = 0;
    for (const buildingId of Object.keys(locBuildings)) {
        if (!buildingBelongsToLocation(locId, buildingId)) continue;
        for (const recipe of getRecipesForBuilding(buildingId)) {
            const hasTech = (recipe.outputs || []).some(o => o.resourceId === 'RES_TECH_OUTPUT');
            if (!hasTech) continue;
            total += getRecipeActualOutput(locId, buildingId, recipe, 'RES_TECH_OUTPUT');
        }
    }
    try {
        const ov = state.devOverrides?.techPerMin;
        if (ov != null && Number.isFinite(Number(ov))) return Number(ov);
    } catch (_) {}
    return total;
}

/** Ресурс потоковый (энергия / тех.) — не идёт на склад */
export function isFlowResourceId(resourceId) {
    return resourceId === 'RES_ELECTRICITY' || resourceId === 'RES_TECH_OUTPUT' || resourceId === 'RES_ENERGY_CAPACITY' || resourceId === 'RES_STORAGE_CAPACITY' || resourceId === 'RES_POPULATION_CAPACITY';
}

/**
 * Доступно специалистов для отображения «need / canHire»:
 * canHire = min(свободные слоты здания, свободные тунеядцы+незанятые на теле по роли)
 * Упрощённо: [need / (buildingMax - otherUsage)] and global free
 */
export function formatSpecialistNeed(locationId, buildingId, recipe, role) {
    const locData = getLocationBuildingData(locationId, buildingId);
    const count = locData?.built_count || 0;
    const level = locData?.currentLevel || 0;
    const cap = (locData?.currentBuildingCapacity ?? 100) / 100;
    const localP = getRecipeLocalPower(locationId, buildingId, recipe.id);
    const needNow = getRecipeSpecialistDemand(recipe, localP, count)[role] || 0;
    // Превью потребности при 100% локальной мощности (рычаг внизу)
    const needPreview = getRecipeSpecialistDemand(recipe, 100, Math.max(1, count))[role] || 0;
    const displayNeed = localP > 0 ? needNow : needPreview;

    const template = state.buildings.find(b => b.id === buildingId);
    const maxKey = {
        engineers: 'maxEngineeringCapacity',
        agronomists: 'maxBotanicalCapacity',
        scientists: 'maxScientificCapacity'
    }[role];
    let buildingMax = 0;
    if (template && maxKey) {
        const arr = template[maxKey];
        const per = Array.isArray(arr) ? (arr[level] ?? arr[0] ?? 0) : (Number(arr) || 0);
        buildingMax = Math.round(per * Math.max(0, count) * cap);
    }

    const stats = getSpecialistStats(locationId);
    // Только реально нанятые на теле (не тунеядцы, не max*)
    const hired = Math.max(0, Math.floor(Number(stats[role]) || 0));

    // Спрос других рецептов на теле (без текущего)
    const usedOthers = getLocationRecipeSpecialistUsage(locationId, {
        buildingId,
        recipeId: recipe.id
    })[role] || 0;

    // Свободно в глобальном пуле для ЭТОГО рецепта
    const freePool = Math.max(0, hired - usedOthers);

    // Лимит слотов здания: если 0 (нет департамента) — ограничивает только пул
    const freeSlots = buildingMax > 0 ? buildingMax : freePool;

    // can = сколько МОЖНО реально поставить сюда (пул ∩ слоты)
    const can = Math.min(freeSlots, freePool);
    // working = сколько реально работает сейчас
    const working = localP > 0 ? Math.min(needNow, can) : 0;

    return {
        need: displayNeed,
        can,
        working,
        buildingMax,
        hired,
        globalFree: hired,
        usedOthers,
        freePool
    };
}


// ===== Сток ресурсов тела + эффекты рецептов =====

export function getBodyStockMap(bodyData) {
    if (!bodyData) return {};
    if (!bodyData.resources) bodyData.resources = {};
    if (!bodyData.resources.stock || typeof bodyData.resources.stock !== 'object') {
        bodyData.resources.stock = {};
    }
    const stock = bodyData.resources.stock;
    // Миграция: Почва = Песок
    if (Object.prototype.hasOwnProperty.call(stock, 'RES_SOIL')) {
        const v = Number(stock.RES_SOIL) || 0;
        stock.RES_SAND = (Number(stock.RES_SAND) || 0) + v;
        delete stock.RES_SOIL;
    }
    return stock;
}

export function getStockAmount(bodyData, resourceId) {
    const stock = getBodyStockMap(bodyData);
    return Math.max(0, Number(stock[resourceId]) || 0);
}

export function setStockAmount(bodyData, resourceId, amount) {
    const stock = getBodyStockMap(bodyData);
    stock[resourceId] = Math.max(0, Number(amount) || 0);
    return stock[resourceId];
}

/** Рецепт заблокирован из‑за переполнения склада по выходам */
export function isRecipeWarehouseBlocked(locationId, bodyData, recipe) {
    if (!recipe || !bodyData) return false;
    return (recipe.outputs || []).some(out => {
        const res = getResource(out.resourceId);
        if (!res || res.isEffect || out.isEffect || out.isCapacity) return false;
        if (isFlowResourceId(out.resourceId)) return false;
        if (out.resourceId === 'RES_ENERGY_CAPACITY' || out.scaleWithBuildingMaxEnergyCapacity) return false;
        if (out.resourceId === 'RES_STORAGE_CAPACITY' || out.scaleWithBuildingResourceStorageCapacity) return false;
        if (out.resourceId === 'RES_POPULATION_CAPACITY' || out.scaleWithBuildingPopulationCapacity) return false;
        if (!res.form || res.form === 'energy' || res.form === 'tech' || res.form === 'info') return false;
        return isResourceStorageFull(locationId, out.resourceId, bodyData);
    });
}


/**
 * Тик рецептов локации: расход входов из стока, применение эффектов (ремонт структуры).
 * gameDeltaSeconds — игровые секунды за кадр.
 */
export function tickLocationRecipes(locationId, bodyData, gameDeltaSeconds) {
    if (!bodyData || !bodyData.colonized) return null;
    const locId = Number(locationId);
    const dtMin = (Number(gameDeltaSeconds) || 0) / 60; // минут игрового времени
    if (dtMin <= 0) return null;

    state.initializeLocationBuildings(locId);
    const locMap = state.locationBuildings[locId] || {};
    const stock = getBodyStockMap(bodyData);
    let repaired = 0;
    let kitsUsed = 0;

    for (const buildingId of Object.keys(locMap)) {
        if (!buildingBelongsToLocation(locId, buildingId)) continue;
        const locData = locMap[buildingId];
        const count = locData?.built_count || 0;
        if (count <= 0) continue;

        for (const recipe of getRecipesForBuilding(buildingId)) {
            const localP = getRecipeLocalPower(locId, buildingId, recipe.id);
            if (localP <= 0) continue;

            const eff = getRecipeEffectiveness(locId, buildingId, recipe);
            if (eff <= 0) continue;

            // Склад переполнен по любому складируемому выходу — рецепт неактивен
            const warehouseBlocked = (recipe.outputs || []).some(out => {
                const res = getResource(out.resourceId);
                if (!res || res.isEffect || out.isEffect) return false;
                if (isFlowResourceId(out.resourceId)) return false;
                if (!res.form || res.form === 'energy' || res.form === 'tech' || res.form === 'info') return false;
                return isResourceStorageFull(locId, out.resourceId, bodyData);
            });
            if (warehouseBlocked) continue;

            // Рецепт ремонта структуры: не тратим ресурсы, если ОЖ уже полные
            const hasStructRepair = (recipe.outputs || []).some(out => {
                const res = getResource(out.resourceId);
                return (out.effectId || res?.effectId) === 'EFF_REPAIR_STRUCTURE';
            });

            let repairScale = 1; // 1 = полный тик, <1 = только добиваем остаток ОЖ
            if (hasStructRepair) {
                const freshPre = getLocationBuildingData(locId, buildingId);
                const templatePre = state.buildings.find(b => b.id === buildingId);
                const levelPre = freshPre.currentLevel || 0;
                const maxArrPre = templatePre?.Structure || [];
                const maxPerPre = maxArrPre.length
                    ? Number(maxArrPre[Math.min(levelPre, maxArrPre.length - 1)]) || 0
                    : 0;
                const maxTotalPre = maxPerPre * (freshPre.built_count || count);
                const curPre = Math.max(0, Number(freshPre.currentStructure) || 0);
                if (maxTotalPre <= 0 || curPre >= maxTotalPre - 1e-9) {
                    // Структура цела — пропускаем рецепт целиком (без расхода)
                    continue;
                }
                // Ограничиваем расход пропорционально оставшимся ОЖ
                const repairOut = (recipe.outputs || []).find(out => {
                    const res = getResource(out.resourceId);
                    return (out.effectId || res?.effectId) === 'EFF_REPAIR_STRUCTURE';
                });
                const ratePre = Number(repairOut?.effectValuePerMinute ?? repairOut?.perMinute) || 0;
                const fullAdd = ratePre * count * eff * dtMin;
                if (fullAdd > 0) {
                    const remaining = maxTotalPre - curPre;
                    repairScale = Math.min(1, remaining / fullAdd);
                }
            }

            // --- расход входов (склад / гео-залежи) + repairScale ---
            let inputOk = true;
            const consumePlan = [];
            const geoPlan = [];
            let geoScale = 1; // ограничивает тик, если залежь почти пуста
            for (const inp of recipe.inputs || []) {
                const needBase = (Number(inp.perMinute) || 0) * count * eff * dtMin * repairScale;
                if (needBase <= 0) continue;

                if (isGeoRecipeInput(inp)) {
                    const geoId = resolveInputGeoId(inp);
                    if (!geoId) { inputOk = false; break; }
                    // для гео вход масштабируется так же, как выход с ExtractionBonus — через actual output ratio
                    // need кг ≈ base * extractionMult (берём из парного выхода, иначе 1)
                    let extractMult = 1;
                    const template = state.buildings.find(b => b.id === buildingId);
                    const level = locData.currentLevel || 0;
                    const arr = template?.ExtractionBonus || template?.extractionBonus || [];
                    if (arr.length) {
                        const i = Math.max(0, Math.min(level, arr.length - 1));
                        const v = Number(arr[i]);
                        if (Number.isFinite(v) && v > 0) extractMult = v;
                    }
                    const need = needBase * extractMult;
                    const have = getDepositRemainingKg(bodyData, geoId);
                    if (have + 1e-9 < need) {
                        if (have <= 1e-9) { inputOk = false; break; }
                        geoScale = Math.min(geoScale, have / need);
                    }
                    geoPlan.push({ geoId, need });
                    continue;
                }

                const need = needBase;
                const pick = pickInputResource(bodyData, inp, need);
                if (!pick) {
                    inputOk = false;
                    break;
                }
                if (pick.infinite) continue;
                if (pick.have + 1e-9 < need) {
                    inputOk = false;
                    break;
                }
                consumePlan.push({ id: pick.resourceId, need });
            }
            if (!inputOk) continue;

            // если залежь частично пуста — урезаем весь тик
            const tickScale = repairScale * geoScale;
            if (tickScale <= 1e-12) continue;

            for (const c of consumePlan) {
                const take = c.need * (geoScale); // repairScale уже в need
                stock[c.id] = Math.max(0, (Number(stock[c.id]) || 0) - take);
                if (c.id === 'RES_REPAIR_KIT') kitsUsed += take;
                applyRecipeInputReturn(locId, bodyData, c.id, take);
            }
            for (const g of geoPlan) {
                drainGeoDepositKg(bodyData, g.geoId, g.need * geoScale);
            }

            // --- обычные выходы на склад (не эффекты, не потоковые энергия/тех.), с учётом вместимости ---
            for (const out of recipe.outputs || []) {
                const res = getResource(out.resourceId);
                const isEffect = !!(out.isEffect || res?.isEffect || out.isCapacity);
                if (isEffect) continue;
                if (out.resourceId === 'RES_ENERGY_CAPACITY' || out.scaleWithBuildingMaxEnergyCapacity) continue;
                if (out.resourceId === 'RES_STORAGE_CAPACITY' || out.scaleWithBuildingResourceStorageCapacity) continue;
                if (out.resourceId === 'RES_POPULATION_CAPACITY' || out.scaleWithBuildingPopulationCapacity) continue;
                if (isFlowResourceId(out.resourceId)) continue;
                if (res?.form === 'tech' || res?.form === 'info') continue;
                // actual = perMinute × ExtractionBonus × count × eff (и др. scale)
                let amount = getRecipeActualOutput(locId, buildingId, recipe, out.resourceId) * dtMin * repairScale;
                if (typeof geoScale === 'number' && geoScale < 1) amount *= geoScale;
                if (amount <= 0) continue;
                addResourceClamped(locId, bodyData, out.resourceId, amount);
            }

            // --- эффекты выходов ---
            for (const out of recipe.outputs || []) {
                const res = getResource(out.resourceId);
                const isEffect = !!(out.isEffect || res?.isEffect);
                if (!isEffect) continue;

                const effectId = out.effectId || res?.effectId;
                if (effectId === 'EFF_REPAIR_STRUCTURE') {
                    // Восстановление структуры этого здания (ОЖ/мин)
                    const rate = Number(out.effectValuePerMinute ?? out.perMinute) || 0;
                    const add = rate * count * eff * dtMin * repairScale;
                    if (add <= 0) continue;

                    // Свежие данные (после предыдущих апдейтов в этом же тике)
                    const fresh = getLocationBuildingData(locId, buildingId);
                    const template = state.buildings.find(b => b.id === buildingId);
                    const level = fresh.currentLevel || 0;
                    const maxArr = template?.Structure || [];
                    const maxPer = maxArr.length
                        ? Number(maxArr[Math.min(level, maxArr.length - 1)]) || 0
                        : 0;
                    const maxTotal = maxPer * (fresh.built_count || count);
                    const cur = Math.max(0, Number(fresh.currentStructure) || 0);
                    if (maxTotal <= 0 || cur >= maxTotal) continue;
                    const next = Math.min(maxTotal, cur + add);
                    const gained = next - cur;
                    if (gained > 0) {
                        updateLocationBuildingData(locId, buildingId, { currentStructure: next });
                        repaired += gained;
                    }
                }
            }
        }
    }

    try { clampAllStocksToCapacity(locId, bodyData); } catch (_) {}
    return { repaired, kitsUsed };
}

/** Есть ли у здания рецепт энергоёмкости */
export function buildingHasEnergyCapacityRecipe(buildingId) {
    try {
        return (getRecipesForBuilding(buildingId) || []).some(r =>
            (r.outputs || []).some(o => o.resourceId === 'RES_ENERGY_CAPACITY' || o.scaleWithBuildingMaxEnergyCapacity)
        );
    } catch (_) {
        return false;
    }
}

/**
 * Макс. энергоёмкость (Вт·ч) здания: сумма фактических выходов RES_ENERGY_CAPACITY
 * (учитывает localPower, специалистов, count, MaxEnergyCapacity[level]).
 */
export function getBuildingEnergyCapacityWh(locationId, buildingId) {
    const locId = Number(locationId);
    const recipes = getRecipesForBuilding(buildingId) || [];
    let total = 0;
    let hasCapRecipe = false;
    for (const recipe of recipes) {
        const outs = recipe.outputs || [];
        const capOut = outs.find(o => o.resourceId === 'RES_ENERGY_CAPACITY' || o.scaleWithBuildingMaxEnergyCapacity);
        if (!capOut) continue;
        hasCapRecipe = true;
        // locked / unknown — вклад 0
        if (!isRecipeInteractable(recipe.id, buildingId)) continue;
        const rid = capOut.resourceId || 'RES_ENERGY_CAPACITY';
        total += getRecipeActualOutput(locId, buildingId, recipe, rid);
    }
    return { wh: Math.max(0, total), hasCapRecipe };
}

/**
 * Теоретический макс. ёмкости на 1 здание на уровне (100% мощность/штат).
 * Для таблицы «Уровни».
 */
export function getTheoreticalMaxEnergyCapacityWh(template, level) {
    if (!template?.id) return 0;
    const recipes = getRecipesForBuilding(template.id) || [];
    const arr = template.MaxEnergyCapacity || template.maxEnergyCapacity || [];
    let mult = 1;
    if (arr.length) {
        const i = Math.max(0, Math.min(level, arr.length - 1));
        const v = Number(arr[i]);
        mult = Number.isFinite(v) && v > 0 ? v : 1;
    }
    let total = 0;
    let any = false;
    for (const recipe of recipes) {
        for (const out of recipe.outputs || []) {
            if (!(out.resourceId === 'RES_ENERGY_CAPACITY' || out.scaleWithBuildingMaxEnergyCapacity)) continue;
            any = true;
            const perMin = Number(out.perMinute) || 0;
            total += perMin * mult;
        }
    }
    if (any) return total;
    // без рецепта — сырое значение массива (совместимость)
    return arr.length ? (Number(arr[Math.max(0, Math.min(level, arr.length - 1))]) || 0) : 0;
}


/** Рецепт бонуса складской вместимости */
export function buildingHasStorageCapacityRecipe(buildingId) {
    try {
        return (getRecipesForBuilding(buildingId) || []).some(r =>
            (r.outputs || []).some(o => o.resourceId === 'RES_STORAGE_CAPACITY' || o.scaleWithBuildingResourceStorageCapacity)
        );
    } catch (_) {
        return false;
    }
}

/**
 * Бонусный множитель склада от рецептов (уже с count/мощностью/штатом).
 * Базовая вместимость ResourceStorageCapacity остаётся отдельно.
 */
export function getBuildingStorageBonusMultiplier(locationId, buildingId) {
    const locId = Number(locationId);
    let total = 0;
    for (const recipe of getRecipesForBuilding(buildingId) || []) {
        const capOut = (recipe.outputs || []).find(o =>
            o.resourceId === 'RES_STORAGE_CAPACITY' || o.scaleWithBuildingResourceStorageCapacity
        );
        if (!capOut) continue;
        if (!isRecipeInteractable(recipe.id, buildingId)) continue;
        const rid = capOut.resourceId || 'RES_STORAGE_CAPACITY';
        total += getRecipeActualOutput(locId, buildingId, recipe, rid);
    }
    return Math.max(0, total);
}



/**
 * Бонус рождаемости от одного рецепта (доля/год) с учётом мощности, штата, энергии и buildingBirthBonusScale.
 */
export function getRecipeBirthBonus(locationId, buildingId, recipe) {
    const base = Number(recipe?.birthRateBonus);
    if (!Number.isFinite(base) || base === 0) return 0;
    if (!isRecipeInteractable(recipe.id, buildingId)) return 0;
    const locId = Number(locationId);
    const locData = getLocationBuildingData(locId, buildingId);
    const count = Math.max(0, Number(locData?.built_count) || 0);
    if (count <= 0) return 0;
    const scaleMap = recipe.buildingBirthBonusScale || {};
    const scale = scaleMap[buildingId] != null ? Number(scaleMap[buildingId]) : 1;
    const s = Number.isFinite(scale) ? scale : 1;
    const eff = getRecipeEffectiveness(locId, buildingId, recipe);
    return Math.max(0, base * s * eff * count);
}

/** Суммарный бонус рождаемости по всем активным рецептам локации (доля/год). */
export function getLocationBirthBonusFromRecipes(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locBuildings = state.locationBuildings[locId] || {};
    let total = 0;
    for (const buildingId of Object.keys(locBuildings)) {
        if (!buildingBelongsToLocation(locId, buildingId)) continue;
        for (const recipe of getRecipesForBuilding(buildingId)) {
            if (!(Number(recipe.birthRateBonus) > 0)) continue;
            total += getRecipeBirthBonus(locId, buildingId, recipe);
        }
    }
    return total;
}

export function buildingHasPopulationCapacityRecipe(buildingId) {
    try {
        return (getRecipesForBuilding(buildingId) || []).some(r =>
            (r.outputs || []).some(o => o.resourceId === 'RES_POPULATION_CAPACITY' || o.scaleWithBuildingPopulationCapacity)
        );
    } catch (_) {
        return false;
    }
}

/** Бонус мест населения от рецепта обслуживания жилплощади (уже с count/мощностью/штатом). */
export function getBuildingPopulationBonus(locationId, buildingId) {
    const locId = Number(locationId);
    let total = 0;
    for (const recipe of getRecipesForBuilding(buildingId) || []) {
        const out = (recipe.outputs || []).find(o =>
            o.resourceId === 'RES_POPULATION_CAPACITY' || o.scaleWithBuildingPopulationCapacity
        );
        if (!out) continue;
        if (!isRecipeInteractable(recipe.id, buildingId)) continue;
        total += getRecipeActualOutput(locId, buildingId, recipe, out.resourceId || 'RES_POPULATION_CAPACITY');
    }
    return Math.max(0, total);
}


/** geoResourceId входа или linkedGeoResourceId ресурса */
export function resolveInputGeoId(inp) {
    if (!inp) return null;
    if (inp.geoResourceId) return String(inp.geoResourceId);
    if (inp.fromGeo && inp.resourceId) {
        const res = getResource(inp.resourceId);
        return res?.linkedGeoResourceId || null;
    }
    // resourceId с linkedGeo + fromGeo implicit if only geo listed
    return null;
}

export function isGeoRecipeInput(inp) {
    return !!(inp && (inp.geoResourceId || inp.fromGeo));
}

/** Остаток залежи в кг (geoDeposits.current в тоннах). */
export function getDepositRemainingKg(bodyData, geoId) {
    if (!bodyData || !geoId) return 0;
    const dep = bodyData.geoDeposits?.[geoId];
    if (!dep) return 0;
    return Math.max(0, (Number(dep.current) || 0) * 1000);
}

/** Списать кг из залежи; возвращает фактически списанное. */
export function drainGeoDepositKg(bodyData, geoId, kg) {
    if (!bodyData || !geoId || !(kg > 0)) return 0;
    if (!bodyData.geoDeposits) bodyData.geoDeposits = {};
    if (!bodyData.geoDeposits[geoId]) {
        bodyData.geoDeposits[geoId] = { current: 0, max: 0 };
    }
    const dep = bodyData.geoDeposits[geoId];
    const haveKg = Math.max(0, (Number(dep.current) || 0) * 1000);
    const take = Math.min(haveKg, kg);
    dep.current = Math.max(0, (Number(dep.current) || 0) - take / 1000);
    return take;
}
