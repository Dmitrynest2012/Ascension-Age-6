import { state } from './state.js';
import { getBuildingPopulationBonus, buildingHasPopulationCapacityRecipe } from './recipes.js';
import {
    getLocationBuildingData,
    updateLocationBuildingData
} from './buildingHelpers.js';
import { tickPopulationNeeds, getPopulationNeedsSnapshot, formatPopulationRate } from './populationNeeds.js';
import { clampSpecialistsToSettled } from './specialists.js';

/** Секунд в игровом году (1x: 1 сек игры = 1 сек реальная) */
export const GAME_SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/** Рождаемость по умолчанию: доля от всего населения в год */
export const DEFAULT_BIRTH_RATE = 0.01;
/** Смертность по умолчанию */
export const DEFAULT_DEATH_RATE = 0.0;

function capacityAt(template, level) {
    const arr = template.PopulationCapacity || [];
    if (!arr.length) return 0;
    const i = Math.max(0, Math.min(level, arr.length - 1));
    return Number(arr[i]) || 0;
}

/** Резервная вместимость (работает без энергии). Входит в обычную, не сверх неё. */
function reserveCapacityAt(template, level) {
    const arr = template.ReservePopulationCapacity
        || template.PopulationCapacityReserve
        || template.reservePopulationCapacity
        || [];
    if (!arr.length) return 0;
    const i = Math.max(0, Math.min(level, arr.length - 1));
    const reserve = Number(arr[i]) || 0;
    // не больше обычной вместимости уровня
    const normal = capacityAt(template, level);
    return Math.max(0, Math.min(reserve, normal || reserve));
}

/** Есть ли энергия у локации (из заглушки energyStorage / locationFlags) */
export function isLocationEnergyAvailable(locationId) {
    const flags = state.locationFlags?.[Number(locationId)];
    if (flags && typeof flags.energyAvailable === 'boolean') {
        return flags.energyAvailable;
    }
    // если флагов ещё нет — считаем, что энергии нет (старт без сети)
    // но если есть производство > 0 — energyStorage выставит флаг
    return false;
}

/**
 * Макс. вместимость одного жилого здания на локации.
 * С энергией: PopulationCapacity × count × power.
 * Без энергии: ReservePopulationCapacity × count × power (если параметр есть).
 * Резерв входит в обычную вместимость (не добавляется сверху).
 */
export function getBuildingMaxResidents(template, locData, locationId) {
    if (!template?.IsResidential) return 0;
    const count = locData?.built_count || 0;
    if (count <= 0) return 0;
    const level = locData.currentLevel || 0;
    const power = (locData.currentBuildingCapacity ?? 100) / 100;
    const normal = capacityAt(template, level);
    const hasEnergy = isLocationEnergyAvailable(locationId);
    const effectiveCap = hasEnergy ? normal : reserveCapacityAt(template, level);
    // Базовая вместимость (как раньше)
    let total = effectiveCap * count * power;
    // Бонус от рецепта «Обслуживание жилплощади» (поверх базы)
    try {
        if (template.id && buildingHasPopulationCapacityRecipe(template.id)) {
            total += getBuildingPopulationBonus(locationId, template.id);
        }
    } catch (_) { /* ignore */ }
    return Math.floor(Math.max(0, total));
}

/** Суммарная жилая вместимость локации */
export function calcLocationHousingCapacity(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locMap = state.locationBuildings[locId] || {};
    let total = 0;
    for (const buildingId of Object.keys(locMap)) {
        const template = state.buildings.find(b => b.id === buildingId);
        if (!template?.IsResidential) continue;
        total += getBuildingMaxResidents(template, locMap[buildingId], locId);
    }
    return total;
}

/** Обустроенные = сумма currentResidents по жилым */
export function calcLocationSettled(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locMap = state.locationBuildings[locId] || {};
    let settled = 0;
    for (const buildingId of Object.keys(locMap)) {
        const template = state.buildings.find(b => b.id === buildingId);
        if (!template?.IsResidential) continue;
        settled += Math.max(0, Number(locMap[buildingId].currentResidents) || 0);
    }
    return settled;
}

export function getLocationTotalPopulation(bodyData) {
    return Math.max(0, Number(bodyData?.resources?.population) || 0);
}

export function setLocationTotalPopulation(bodyData, value) {
    if (!bodyData) return;
    if (!bodyData.resources) bodyData.resources = {};
    bodyData.resources.population = Math.max(0, value);
}

/**
 * Распределить население по жилым зданиям.
 * Бездомные = total - settled после клампа по вместимости.
 * При росте вместимости бездомные равномерно заселяются.
 * При падении вместимости лишние выселяются в бездомные.
 */
export function redistributePopulation(locationId, bodyData) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locMap = state.locationBuildings[locId] || {};
    const total = getLocationTotalPopulation(bodyData);

    const residential = [];
    for (const buildingId of Object.keys(locMap)) {
        const template = state.buildings.find(b => b.id === buildingId);
        if (!template?.IsResidential) continue;
        const locData = locMap[buildingId];
        const maxR = getBuildingMaxResidents(template, locData, locId);
        let cur = Math.max(0, Number(locData.currentResidents) || 0);
        if (cur > maxR) cur = maxR;
        residential.push({ buildingId, locData, maxR, cur });
    }

    let settled = residential.reduce((s, r) => s + r.cur, 0);

    // Убыль населения: обустроенных не может быть больше total
    if (settled > total) {
        let overflow = settled - total;
        while (overflow > 0 && residential.some(r => r.cur > 0)) {
            const occupied = residential.filter(r => r.cur > 0);
            if (!occupied.length) break;
            const share = Math.max(1, Math.floor(overflow / occupied.length));
            for (const r of occupied) {
                if (overflow <= 0) break;
                const take = Math.min(r.cur, share, overflow);
                r.cur -= take;
                overflow -= take;
            }
            if (overflow > 0) {
                for (const r of residential) {
                    if (overflow <= 0) break;
                    if (r.cur <= 0) continue;
                    r.cur -= 1;
                    overflow -= 1;
                }
            }
        }
        settled = residential.reduce((s, r) => s + r.cur, 0);
    }

    let homeless = Math.max(0, total - settled);
    const freeSlots = residential.reduce((s, r) => s + Math.max(0, r.maxR - r.cur), 0);

    if (homeless > 0 && freeSlots > 0) {
        let remaining = Math.min(homeless, freeSlots);
        const withSpace = residential.filter(r => r.maxR > r.cur);
        while (remaining > 0 && withSpace.some(r => r.cur < r.maxR)) {
            const open = withSpace.filter(r => r.cur < r.maxR);
            if (!open.length) break;
            const share = Math.max(1, Math.floor(remaining / open.length));
            for (const r of open) {
                if (remaining <= 0) break;
                const can = r.maxR - r.cur;
                const add = Math.min(can, share, remaining);
                r.cur += add;
                remaining -= add;
            }
        }
        if (remaining > 0) {
            for (const r of residential) {
                if (remaining <= 0) break;
                const can = r.maxR - r.cur;
                if (can <= 0) continue;
                const add = Math.min(can, remaining);
                r.cur += add;
                remaining -= add;
            }
        }
    }

    for (const r of residential) {
        updateLocationBuildingData(locId, r.buildingId, { currentResidents: r.cur });
    }

    settled = residential.reduce((s, r) => s + r.cur, 0);
    homeless = Math.max(0, total - settled);
    return { total, settled, homeless, maxCapacity: residential.reduce((s, r) => s + r.maxR, 0) };
}

/**
 * Тик населения: рождаемость/смертность + перераспределение.
 */
export function tickLocationPopulation(locationId, bodyData, gameDeltaSeconds, opts = {}) {
    if (!bodyData || !bodyData.colonized) return null;

    let total = getLocationTotalPopulation(bodyData);

    // Потребности: расход еды/жидкости + расчёт birth/death с голодом
    const needs = (opts.birthRate != null && opts.deathRate != null)
        ? { birthRate: opts.birthRate, deathRate: opts.deathRate, famine: null }
        : tickPopulationNeeds(locationId, bodyData, gameDeltaSeconds, total);

    const birthRate = needs.birthRate ?? DEFAULT_BIRTH_RATE;
    const deathRate = needs.deathRate ?? DEFAULT_DEATH_RATE;

    const years = (Number(gameDeltaSeconds) || 0) / GAME_SECONDS_PER_YEAR;

    const births = total * birthRate * years;
    const deaths = total * deathRate * years;
    const delta = births - deaths;

    if (!state.populationAccum) state.populationAccum = {};
    const lid = Number(locationId);
    const acc = state.populationAccum[lid] || 0;
    const next = acc + delta;
    const whole = next >= 0 ? Math.floor(next) : Math.ceil(next);
    state.populationAccum[lid] = next - whole;

    if (whole !== 0) {
        total = Math.max(0, total + whole);
        setLocationTotalPopulation(bodyData, total);
    }

    const stats = redistributePopulation(lid, bodyData);
    // Специалисты не могут превышать обустроенных после убыли
    try { clampSpecialistsToSettled(lid); } catch (_) { /* цикл импортов на старте */ }

    const liveTotal = getLocationTotalPopulation(bodyData);
    const birthsPerYear = liveTotal * birthRate;
    const deathsPerYear = liveTotal * deathRate;
    const dynamics = birthsPerYear - deathsPerYear;

    return {
        ...stats,
        total: liveTotal,
        birthsPerYear,
        deathsPerYear,
        birthRatePct: birthRate * 100,
        deathRatePct: deathRate * 100,
        birthRate,
        deathRate,
        birthDisplay: formatPopulationRate(birthRate),
        deathDisplay: formatPopulationRate(deathRate),
        famine: needs.famine || null,
        dynamics
    };
}

/** Снимок статистики без тика (для UI) */
export function getPopulationStats(locationId, bodyData) {
    if (!bodyData) {
        return {
            total: 0, settled: 0, homeless: 0, maxCapacity: 0,
            birthsPerYear: 0, deathsPerYear: 0,
            birthRatePct: DEFAULT_BIRTH_RATE * 100,
            deathRatePct: DEFAULT_DEATH_RATE * 100,
            birthDisplay: formatPopulationRate(DEFAULT_BIRTH_RATE),
            deathDisplay: formatPopulationRate(DEFAULT_DEATH_RATE),
            famine: null,
            dynamics: 0
        };
    }
    const total = getLocationTotalPopulation(bodyData);
    const settled = calcLocationSettled(locationId);
    const maxCapacity = calcLocationHousingCapacity(locationId);
    const homeless = Math.max(0, total - settled);

    const snap = getPopulationNeedsSnapshot(locationId);
    const birthRate = snap?.birthRate ?? DEFAULT_BIRTH_RATE;
    const deathRate = snap?.deathRate ?? DEFAULT_DEATH_RATE;
    const birthsPerYear = total * birthRate;
    const deathsPerYear = total * deathRate;
    return {
        total,
        settled,
        homeless,
        maxCapacity,
        birthsPerYear,
        deathsPerYear,
        birthRatePct: birthRate * 100,
        deathRatePct: deathRate * 100,
        birthRate,
        deathRate,
        birthDisplay: formatPopulationRate(birthRate),
        deathDisplay: formatPopulationRate(deathRate),
        famine: snap?.famine || null,
        dynamics: birthsPerYear - deathsPerYear
    };
}
