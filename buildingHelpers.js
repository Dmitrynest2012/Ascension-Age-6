import { state } from './state.js';
import { calculateBodyParameters } from './bodyParameters.js';

// --- Хелперы зданий (per-location) ---

/** maxCapacity может быть числом или массивом по уровням */
export function getMaxForLevel(maxCap, level) {
    if (maxCap == null) return 0;
    if (Array.isArray(maxCap)) {
        if (level < maxCap.length) return maxCap[level] ?? 0;
        return maxCap[maxCap.length - 1] ?? 0;
    }
    return Number(maxCap) || 0;
}


/** Макс. структура здания на уровне (ОЖ) */
export function getStructureMax(template, level) {
    const arr = template?.Structure || template?.structure || [];
    if (!arr.length) return 0;
    const i = Math.max(0, Math.min(Number(level) || 0, arr.length - 1));
    return Math.max(0, Number(arr[i]) || 0);
}

/** Стартовая структура: StartingStructure если задана, иначе max */
export function getStructureInitial(template, level) {
    if (template?.StartingStructure != null && template.StartingStructure !== undefined) {
        const start = Number(template.StartingStructure);
        if (Number.isFinite(start)) {
            return Math.max(0, Math.min(getStructureMax(template, level), start));
        }
    }
    return getStructureMax(template, level);
}

export function parseDepartments(deps) {
    if (Array.isArray(deps)) return deps;
    return (deps || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Принадлежит ли здание данному небесному телу */
export function buildingBelongsToLocation(locationId, buildingId) {
    const locId = Number(locationId);
    const template = state.buildings.find(b => b.id === buildingId);
    if (!template) return false;
    if (Number(template.parentBodyId) === locId) return true;
    const body = state.celestialBodies[locId];
    const childIds = body?.data?.childStructureIds || body?.childStructureIds || [];
    return Array.isArray(childIds) && childIds.includes(buildingId);
}

export function getLocationBuildingData(locationId, buildingId) {
    // locationId всегда приводим к числу для стабильности ключей
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);

    if (!state.locationBuildings[locId]) {
        state.locationBuildings[locId] = {};
    }

    if (!state.locationBuildings[locId][buildingId]) {
        const template = state.buildings.find(b => b.id === buildingId);
        // Чужие здания (напр. марсианская база при просмотре Земли) НЕ наследуют
        // built_count/level из шаблона — иначе энергия/население «удваиваются».
        const belongs = buildingBelongsToLocation(locId, buildingId);
        const seedLevel = belongs ? (template?.currentLevel ?? 0) : 0;
        const seedCount = belongs ? (template?.built_count ?? 0) : 0;
        let seedStruct = 0;
        if (belongs && template && seedCount > 0) {
            // StartingStructure подменяет текущую структуру на старте (один раз при сиде)
            const per = getStructureInitial(template, seedLevel);
            seedStruct = per * seedCount;
        }
        state.locationBuildings[locId][buildingId] = {
            currentLevel: seedLevel,
            built_count: seedCount,
            currentEngineeringCapacity: 0,
            currentBotanicalCapacity: 0,
            currentScientificCapacity: 0,
            currentBuildingCapacity: belongs
                ? ((template?.currentBuildingCapacity ?? template?.CurrentBuildingCapacity ?? 100) || 100)
                : 100,
            currentStoredEnergy: 0,
            currentResidents: 0,
            currentStructure: seedStruct
        };
    }

    const data = state.locationBuildings[locId][buildingId];
    // 0% — валидная мощность (здание выключено). Нормализуем только отсутствие значения.
    // Стартовый seed из шаблона CurrentBuildingCapacity=0 трактуем как 100 при ПЕРВОМ создании (выше).
    if (data.currentBuildingCapacity === undefined || data.currentBuildingCapacity === null) {
        data.currentBuildingCapacity = 100;
    } else {
        data.currentBuildingCapacity = Math.max(0, Math.min(100, Number(data.currentBuildingCapacity) || 0));
    }
    if (data.currentStoredEnergy === undefined || data.currentStoredEnergy === null) {
        data.currentStoredEnergy = 0;
    }
    if (data.currentResidents === undefined || data.currentResidents === null) {
        data.currentResidents = 0;
    }
    if (data.currentStructure === undefined || data.currentStructure === null) {
        const template = state.buildings.find(b => b.id === buildingId);
        const level = data.currentLevel || 0;
        const count = data.built_count || 0;
        if (template && count > 0) {
            data.currentStructure = getStructureInitial(template, level) * count;
        } else {
            data.currentStructure = 0;
        }
    }
    return data;
}

export function updateLocationBuildingData(locationId, buildingId, updates) {
    const locId = Number(locationId);
    const data = getLocationBuildingData(locId, buildingId);
    Object.assign(data, updates);
    console.log(`[LOC ${locId}] ${buildingId} =>`, JSON.stringify(data));
    return data;
}

/** Суммарное текущее потребление энергии всеми зданиями локации (RequiresElectricity) */
export function calcLocationEnergyConsumption(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locBuildings = state.locationBuildings[locId] || {};
    let total = 0;
    for (const buildingId of Object.keys(locBuildings)) {
        // игнорируем записи чужих зданий, если они попали в map
        if (!buildingBelongsToLocation(locId, buildingId)) continue;
        const locData = locBuildings[buildingId];
        const count = locData.built_count || 0;
        if (count <= 0) continue;
        const template = state.buildings.find(b => b.id === buildingId);
        if (!template || !template.RequiresElectricity) continue;
        const level = locData.currentLevel || 0;
        const capacity = Math.max(0, Math.min(100, Number(locData.currentBuildingCapacity) || 100));
        const perUnit = (template.EnergyConsumption || [])[level] || 0;
        total += perUnit * count * (capacity / 100);
    }
    return total;
}

/** Суммарное текущее производство энергии всеми зданиями локации.
 *  Приоритет: рецепты с выходом RES_ELECTRICITY; иначе legacy ProducesElectricity. */
export function calcLocationEnergyProduction(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);

    // Ленивый импорт, чтобы избежать циклов при загрузке модуля
    let recipeApi = null;
    try {
        recipeApi = globalThis.__recipesApi || null;
    } catch (_) {}

    if (recipeApi && typeof recipeApi.calcLocationRecipeElectricityProduction === 'function') {
        const { total: rt } = recipeApi.calcLocationRecipeElectricityProduction(locId);
        return rt || 0;
    }

    // Legacy ProducesElectricity больше не даёт ватты напрямую —
    // EnergyProduction[] используется как множитель внутри рецептов.
    return 0;
}

/** OccupiedArea в JSON задаётся в м²; вместимость зоны считаем в км² */
export const KM2_TO_M2 = 1_000_000;

/**
 * Площадь одного типа поверхности в км²: totalSurface × (percent / 100).
 * Типы СКЛАДЫВАЮТСЯ, не перемножаются.
 */
function areaFromPercent(surfaceAreaKm2, percents, key) {
    const percent = Number(percents?.[key]) || 0;
    return surfaceAreaKm2 * (percent / 100);
}

/**
 * Вместимость зоны на теле (км²).
 * MC3 (наземное): равнины + пустыни + степи  (сумма!)
 * MC4 (надводное): водные поверхности
 * MC1/MC2/MC5: пока без лимита (null)
 */
export function getZoneCapacityKm2(bodyData, constructionZone) {
    if (!bodyData || bodyData.type === 'star') return null;
    const { surfaceArea } = calculateBodyParameters(bodyData.radius || 0);
    const p = bodyData.surfacePercents || {};

    if (constructionZone === 'MC3') {
        const plains = areaFromPercent(surfaceArea, p, 'plains');
        const deserts = areaFromPercent(surfaceArea, p, 'deserts');
        const steppes = areaFromPercent(surfaceArea, p, 'steppes');
        return plains + deserts + steppes;
    }
    if (constructionZone === 'MC4') {
        return areaFromPercent(surfaceArea, p, 'water');
    }
    return null;
}

/** Площадь одного экземпляра здания на уровне (м²) */
export function getUnitAreaM2(buildingTemplate, level) {
    const arr = buildingTemplate.OccupiedArea || buildingTemplate.occupiedArea || [];
    if (!arr.length) return 0;
    const lvl = Math.max(0, Math.min(Number(level) || 0, arr.length - 1));
    return Number(arr[lvl]) || 0;
}

/** Площадь одного экземпляра в км² */
export function getUnitAreaKm2(buildingTemplate, level) {
    return getUnitAreaM2(buildingTemplate, level) / KM2_TO_M2;
}

/** Суммарная занятая площадь здания на локации (км²) */
export function getBuildingOccupiedKm2(buildingTemplate, locData) {
    const count = locData?.built_count || 0;
    if (count <= 0) return 0;
    return getUnitAreaKm2(buildingTemplate, locData.currentLevel || 0) * count;
}

/** Суммарная занятая площадь здания на локации (м²) — напрямую из OccupiedArea */
export function getBuildingOccupiedM2(buildingTemplate, locData) {
    const count = locData?.built_count || 0;
    if (count <= 0) return 0;
    return getUnitAreaM2(buildingTemplate, locData.currentLevel || 0) * count;
}

/**
 * Суммарная занятость всех зданий зоны на локации (км²).
 */
export function getZoneOccupiedKm2(locationId, constructionZone) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locMap = state.locationBuildings[locId] || {};
    let total = 0;
    for (const buildingId of Object.keys(locMap)) {
        const template = state.buildings.find(b => b.id === buildingId);
        if (!template || template.constructionZone !== constructionZone) continue;
        total += getBuildingOccupiedKm2(template, locMap[buildingId]);
    }
    return total;
}

/**
 * Свободная площадь зоны (км²). null = без лимита.
 * free = (сумма типов поверхностей зоны) − (занято всеми зданиями зоны)
 */
export function getZoneFreeKm2(bodyData, locationId, constructionZone) {
    const capKm2 = getZoneCapacityKm2(bodyData, constructionZone);
    if (capKm2 == null) return null;
    const occupiedKm2 = getZoneOccupiedKm2(locationId, constructionZone);
    return Math.max(0, capKm2 - occupiedKm2);
}

/** для совместимости: свободная в м² */
export function getZoneFreeM2(bodyData, locationId, constructionZone) {
    const freeKm2 = getZoneFreeKm2(bodyData, locationId, constructionZone);
    if (freeKm2 == null) return null;
    return freeKm2 * KM2_TO_M2;
}

/** Доп. площадь для постройки ещё 1 шт. (км²) */
export function getBuildExtraAreaKm2(buildingTemplate, locData) {
    const level = locData?.currentLevel || 0;
    return getUnitAreaKm2(buildingTemplate, level);
}

export function getBuildExtraAreaM2(buildingTemplate, locData) {
    return getBuildExtraAreaKm2(buildingTemplate, locData) * KM2_TO_M2;
}

/** Доп. площадь при апгрейде всех экземпляров на +1 уровень (км²) */
export function getUpgradeExtraAreaKm2(buildingTemplate, locData) {
    const count = locData?.built_count || 0;
    if (count <= 0) return 0;
    const level = locData.currentLevel || 0;
    const now = getUnitAreaKm2(buildingTemplate, level);
    const next = getUnitAreaKm2(buildingTemplate, level + 1);
    return Math.max(0, (next - now) * count);
}

export function getUpgradeExtraAreaM2(buildingTemplate, locData) {
    return getUpgradeExtraAreaKm2(buildingTemplate, locData) * KM2_TO_M2;
}
