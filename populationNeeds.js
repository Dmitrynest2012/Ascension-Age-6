/**
 * Потребности населения: потребление еды/жидкости со склада,
 * бонусы к рождаемости/смертности, голод при отсутствии групп пищи.
 */
import { state } from './state.js';
import { getResource, getBodyStockMap, getStockAmount, getLocationBirthBonusFromRecipes } from './recipes.js';
import { locName } from './settings.js';
/** Совпадает с population.js (без циклического импорта) */
export const DEFAULT_BIRTH_RATE = 0.01;
export const DEFAULT_DEATH_RATE = 0.0;
export const GAME_SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/** Типы потребляемой пищи */
export const FOOD_SOLID = 'solid';
export const FOOD_LIQUID = 'liquid';

/** За месяц (1/12 года) всё население → 0 при отсутствии твёрдой пищи */
export const FAMINE_SOLID_DEATH_RATE = 12; // 1/month ≈ 12 / year
/** За 7 дней → 0 при отсутствии жидкости (или обеих групп) */
export const FAMINE_LIQUID_DEATH_RATE = 365.25 / 7; // ≈ 52.18 / year

/**
 * Каталог потребляемых населением ресурсов из __resourceCatalog.
 * @returns {Array<object>}
 */
export function listConsumableResources() {
    const cat = globalThis.__resourceCatalog;
    if (!cat || typeof cat.values !== 'function') return [];
    const out = [];
    for (const r of cat.values()) {
        if (!r) continue;
        const consumable = r.populationConsumable === true
            || r.consumableByPopulation === true
            || r.populationConsumes === true;
        if (!consumable) continue;
        const foodType = String(r.populationFoodType || r.foodType || '').toLowerCase();
        if (foodType !== FOOD_SOLID && foodType !== FOOD_LIQUID) continue;
        out.push({
            id: r.id,
            foodType,
            perPersonPerMinute: Math.max(0, Number(r.consumptionPerPersonPerMinute
                ?? r.populationConsumptionPerMinute
                ?? r.perPersonPerMinute) || 0),
            birthBonus: Number(r.birthBonus ?? r.populationBirthBonus) || 0,
            deathBonus: Number(r.deathBonus ?? r.populationDeathBonus) || 0,
            priority: Math.max(1, Math.min(9, Math.floor(Number(r.consumptionPriority ?? r.priority) || 5))),
            name: locName(r.name, r.id)
        });
    }
    return out;
}

function groupByType(list) {
    const solid = list.filter(r => r.foodType === FOOD_SOLID);
    const liquid = list.filter(r => r.foodType === FOOD_LIQUID);
    return { solid, liquid };
}

/**
 * Возврат ресурса после потребления.
 * Упакованная вода: packageWeightKg=20 → на каждые 20 л (1 упаковка) → amount канистр.
 * returnUnits = (take / packageWeightKg) * consumptionReturn.amount
 */
function applyConsumptionReturn(stock, resMeta, takeAmount) {
    if (!resMeta || !stock || !(takeAmount > 0)) return;
    const doReturn = resMeta.returnAfterConsumption === true
        || resMeta.returnsAfterConsumption === true;
    if (!doReturn) return;
    const ret = resMeta.consumptionReturn || resMeta.returnOnConsume || null;
    if (!ret || !ret.resourceId) return;
    const retId = String(ret.resourceId);
    const perPackage = Math.max(0, Number(ret.amount) || 0);
    if (perPackage <= 0) return;
    const pkgW = Math.max(1e-9, Number(resMeta.packageWeightKg) || 1);
    // сколько «упаковок» съели по весу/объёму
    const packages = takeAmount / pkgW;
    const returnQty = packages * perPackage;
    if (!(returnQty > 0)) return;
    stock[retId] = (Number(stock[retId]) || 0) + returnQty;
}

/**
 * Выбрать ресурсы одной группы для потребления:
 * минимальный priority среди тех, у кого есть сток;
 * при равном priority — делят нагрузку поровну.
 */
function pickActiveTier(bodyData, groupList) {
    const available = groupList.filter(r => {
        const res = getResource(r.id);
        if (res?.infinite) return true;
        return getStockAmount(bodyData, r.id) > 1e-12;
    });
    if (!available.length) return [];
    let minP = 9;
    for (const r of available) minP = Math.min(minP, r.priority);
    return available.filter(r => r.priority === minP);
}

/**
 * Потребление по группе за dt минут на total человек.
 * Возвращает { consumed: {id: amount}, fulfilled: 0..1, active: resources[], birthBonus, deathBonus }
 */
function consumeGroup(bodyData, groupList, totalPeople, dtMin) {
    const stock = getBodyStockMap(bodyData);
    const active = pickActiveTier(bodyData, groupList);
    if (!active.length || totalPeople <= 0 || dtMin <= 0) {
        return {
            consumed: {},
            fulfilled: 0,
            active: [],
            birthBonus: 0,
            deathBonus: 0,
            hasAny: groupList.some(r => getStockAmount(bodyData, r.id) > 1e-12 || getResource(r.id)?.infinite)
        };
    }

    const n = active.length;
    const consumed = {};
    let totalNeed = 0;
    let totalGot = 0;
    let birthSum = 0;
    let deathSum = 0;
    let weightSum = 0;

    for (const r of active) {
        const need = r.perPersonPerMinute * totalPeople * dtMin / n; // поровну при одном приоритете
        totalNeed += need;
        const resMeta = getResource(r.id);
        if (resMeta?.infinite) {
            consumed[r.id] = (consumed[r.id] || 0) + need;
            totalGot += need;
            birthSum += r.birthBonus;
            deathSum += r.deathBonus;
            weightSum += 1;
            continue;
        }
        const have = Math.max(0, Number(stock[r.id]) || 0);
        const take = Math.min(have, need);
        if (take > 0) {
            stock[r.id] = have - take;
            consumed[r.id] = (consumed[r.id] || 0) + take;
            totalGot += take;
            // Возврат тары после потребления (напр. пустые канистры от упакованной воды)
            applyConsumptionReturn(stock, resMeta, take);
        }
        // бонусы от тех, кто реально в рационе (даже если сток кончился mid-tick — доля)
        const share = need > 0 ? take / need : 0;
        if (share > 0 || have > 0) {
            birthSum += r.birthBonus;
            deathSum += r.deathBonus;
            weightSum += 1;
        }
    }

    const fulfilled = totalNeed > 0 ? Math.min(1, totalGot / totalNeed) : 0;
    const birthBonus = weightSum > 0 ? birthSum / weightSum : 0;
    const deathBonus = weightSum > 0 ? deathSum / weightSum : 0;

    return {
        consumed,
        fulfilled,
        active,
        birthBonus,
        deathBonus,
        hasAny: true
    };
}

/**
 * Полный тик потребностей + расчёт итоговых birth/death rate (доля в год).
 */
export function tickPopulationNeeds(locationId, bodyData, gameDeltaSeconds, totalPopulation) {
    const total = Math.max(0, Number(totalPopulation) || 0);
    const dtMin = (Number(gameDeltaSeconds) || 0) / 60;
    const consumables = listConsumableResources();
    const { solid, liquid } = groupByType(consumables);

    const solidResult = consumeGroup(bodyData, solid, total, dtMin);
    const liquidResult = consumeGroup(bodyData, liquid, total, dtMin);

    const hasSolid = solid.length === 0
        ? true // нет ни одного solid-ресурса в каталоге — не наказываем
        : solidResult.active.length > 0 || solidResult.fulfilled > 0;
    const hasLiquid = liquid.length === 0
        ? true
        : liquidResult.active.length > 0 || liquidResult.fulfilled > 0;

    // «Есть на складе» для голода: если в группе есть ресурсы в каталоге, но сток пуст
    const solidOnStock = solid.some(r => getResource(r.id)?.infinite || getStockAmount(bodyData, r.id) > 1e-12);
    const liquidOnStock = liquid.some(r => getResource(r.id)?.infinite || getStockAmount(bodyData, r.id) > 1e-12);
    // После потребления active мог опустеть — смотрим и fulfilled этого тика
    const solidOk = solid.length === 0 || solidOnStock || solidResult.fulfilled > 0.01;
    const liquidOk = liquid.length === 0 || liquidOnStock || liquidResult.fulfilled > 0.01;

    let birthRate = DEFAULT_BIRTH_RATE;
    let deathRate = DEFAULT_DEATH_RATE;

    // бонусы от фактически использованных продуктов (уже в «долях в год», как базовые)
    if (solidOk) {
        birthRate += solidResult.birthBonus;
        deathRate += solidResult.deathBonus;
    }
    if (liquidOk) {
        birthRate += liquidResult.birthBonus;
        deathRate += liquidResult.deathBonus;
    }

    // Бонус от зданий (перинатальный центр / больница — RCP_HEALTH_SUPPORT)
    try {
        const recipeBirth = getLocationBirthBonusFromRecipes(locationId);
        if (recipeBirth > 0) birthRate += recipeBirth;
    } catch (_) { /* */ }

    birthRate = Math.max(0, birthRate);
    deathRate = Math.max(0, deathRate);

    let famine = null; // 'solid' | 'liquid' | 'both' | null
    if (!solidOk && !liquidOk) {
        famine = 'both';
        deathRate = Math.max(deathRate, FAMINE_LIQUID_DEATH_RATE);
        birthRate = 0;
    } else if (!solidOk) {
        famine = 'solid';
        deathRate = Math.max(deathRate, FAMINE_SOLID_DEATH_RATE);
        birthRate = Math.min(birthRate, DEFAULT_BIRTH_RATE * 0.1);
    } else if (!liquidOk) {
        famine = 'liquid';
        deathRate = Math.max(deathRate, FAMINE_LIQUID_DEATH_RATE);
        birthRate = Math.min(birthRate, DEFAULT_BIRTH_RATE * 0.1);
    }

    // кэш для UI
    if (!state.populationNeedsCache) state.populationNeedsCache = {};
    state.populationNeedsCache[Number(locationId)] = {
        birthRate,
        deathRate,
        famine,
        solidOk,
        liquidOk,
        solidFulfilled: solidResult.fulfilled,
        liquidFulfilled: liquidResult.fulfilled,
        solidConsumed: solidResult.consumed,
        liquidConsumed: liquidResult.consumed,
        updatedAt: Date.now()
    };

    return {
        birthRate,
        deathRate,
        famine,
        solidOk,
        liquidOk,
        solidResult,
        liquidResult
    };
}

/** Последний рассчитанный снимок (без тика) */
export function getPopulationNeedsSnapshot(locationId) {
    return state.populationNeedsCache?.[Number(locationId)] || null;
}

/**
 * Формат отображения коэффициента: до 100% — «12.50%», выше — «1.2x», «12x».
 * rateFraction — доля в год (0.01 = 1%/год, 12 = 12x/год).
 */
export function formatPopulationRate(rateFraction) {
    const r = Number(rateFraction) || 0;
    const pct = r * 100;
    if (pct > 100 + 1e-6) {
        const x = pct / 100;
        if (x >= 10) return `${Math.round(x)}x`;
        return `${x.toFixed(1).replace(/\.0$/, '')}x`;
    }
    if (Math.abs(pct) < 0.01) return '0%';
    if (Math.abs(pct) >= 10) return `${pct.toFixed(1)}%`;
    return `${pct.toFixed(2)}%`;
}
