import { state } from './state.js';
import {
    getLocationBuildingData,
    updateLocationBuildingData,
    calcLocationEnergyConsumption,
    calcLocationEnergyProduction
} from './buildingHelpers.js';
import { getBuildingEnergyCapacityWh, buildingHasEnergyCapacityRecipe } from './recipes.js';

/** Вт × секунды → Вт·ч */
export function wattsToWattHours(watts, gameSeconds) {
    return (Number(watts) || 0) * (Number(gameSeconds) || 0) / 3600;
}

/** Вт·ч → средняя мощность Вт за intervalSeconds */
export function wattHoursToWatts(wattHours, gameSeconds) {
    const t = Number(gameSeconds) || 0;
    if (t <= 0) return 0;
    return (Number(wattHours) || 0) * 3600 / t;
}

function capacityAt(template, level) {
    const arr = template.MaxEnergyCapacity || [];
    if (!arr.length) return 0;
    const i = Math.max(0, Math.min(level, arr.length - 1));
    return Number(arr[i]) || 0;
}

function chargeRateAt(template, level) {
    const arr = template.ChargeRate || [];
    if (!arr.length) return 0;
    const i = Math.max(0, Math.min(level, arr.length - 1));
    return Number(arr[i]) || 0;
}

function dischargeRateAt(template, level) {
    const arr = template.DischargeRate || [];
    if (!arr.length) return 0;
    const i = Math.max(0, Math.min(level, arr.length - 1));
    return Number(arr[i]) || 0;
}

/** Список аккумуляторных зданий локации с метаданными */
export function listStorageUnits(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings(locId);
    const locMap = state.locationBuildings[locId] || {};
    const units = [];
    for (const buildingId of Object.keys(locMap)) {
        const template = state.buildings.find(b => b.id === buildingId);
        if (!template || !template.StoresEnergy) continue;
        const locData = locMap[buildingId];
        const count = locData.built_count || 0;
        if (count <= 0) continue;
        const level = locData.currentLevel || 0;
        const capacityPct = (locData.currentBuildingCapacity ?? 100) / 100;
        const unitCharge = chargeRateAt(template, level) * capacityPct;
        const unitDischarge = dischargeRateAt(template, level) * capacityPct;
        // Ёмкость: от рецепта обслуживания (если есть), иначе MaxEnergyCapacity × мощность здания
        let maxWh = 0;
        if (buildingHasEnergyCapacityRecipe(buildingId)) {
            maxWh = getBuildingEnergyCapacityWh(locId, buildingId).wh;
        } else {
            maxWh = capacityAt(template, level) * capacityPct * count;
        }
        const stored = Math.min(maxWh, Number(locData.currentStoredEnergy) || 0);
        units.push({
            buildingId,
            template,
            locData,
            count,
            level,
            maxWh,
            storedWh: stored,
            chargeRateW: unitCharge * count,
            dischargeRateW: unitDischarge * count
        });
    }
    return units;
}

export function calcLocationStorageTotals(locationId) {
    const units = listStorageUnits(locationId);
    let stored = 0;
    let max = 0;
    let maxDischargeW = 0;
    let maxChargeW = 0;
    for (const u of units) {
        stored += u.storedWh;
        max += u.maxWh;
        maxDischargeW += u.dischargeRateW;
        maxChargeW += u.chargeRateW;
    }
    return { storedWh: stored, maxWh: max, maxDischargeW, maxChargeW, units };
}

/**
 * Приоритет зарядки: здания с chargeRate выше медианы — «быстрые» (75%),
 * остальные — «медленные» (25%). Один тип/одно здание — 100%.
 */
function allocateChargePower(units, availableBalanceW) {
    if (!units.length || availableBalanceW <= 0) return new Map();

    if (units.length === 1) {
        const u = units[0];
        const w = Math.min(availableBalanceW, u.chargeRateW, Math.max(0, (u.maxWh - u.storedWh) > 0 ? u.chargeRateW : 0));
        // room limited later
        return new Map([[u.buildingId, Math.min(availableBalanceW, u.chargeRateW)]]);
    }

    const rates = units.map(u => u.chargeRateW);
    const sorted = [...rates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    const fast = units.filter(u => u.chargeRateW >= median);
    const slow = units.filter(u => u.chargeRateW < median);

    // если все одинаковые — 100% поровну по мощности
    if (!slow.length || !fast.length) {
        const map = new Map();
        const totalRate = units.reduce((s, u) => s + u.chargeRateW, 0) || 1;
        for (const u of units) {
            map.set(u.buildingId, availableBalanceW * (u.chargeRateW / totalRate));
        }
        return map;
    }

    const map = new Map();
    const fastPool = availableBalanceW * 0.75;
    const slowPool = availableBalanceW * 0.25;
    const fastTotal = fast.reduce((s, u) => s + u.chargeRateW, 0) || 1;
    const slowTotal = slow.reduce((s, u) => s + u.chargeRateW, 0) || 1;

    for (const u of fast) {
        map.set(u.buildingId, Math.min(u.chargeRateW, fastPool * (u.chargeRateW / fastTotal)));
    }
    for (const u of slow) {
        map.set(u.buildingId, Math.min(u.chargeRateW, slowPool * (u.chargeRateW / slowTotal)));
    }
    return map;
}

/**
 * Тик зарядки/разрядки за gameDeltaSeconds.
 * @returns {{ dischargedW: number, energyAvailable: boolean }}
 * energyAvailable — заглушка: false если баланс 0 и нет запаса в аккумуляторах
 */
export function tickLocationEnergyStorage(locationId, gameDeltaSeconds) {
    const locId = Number(locationId);
    const production = calcLocationEnergyProduction(locId);
    const consumption = calcLocationEnergyConsumption(locId);
    const surplusW = Math.max(0, production - consumption);
    const deficitW = Math.max(0, consumption - production);

    const units = listStorageUnits(locId);
    let dischargedW = 0;

    if (surplusW > 0 && units.length) {
        // зарядка
        const alloc = allocateChargePower(units, surplusW);
        for (const u of units) {
            const powerW = alloc.get(u.buildingId) || 0;
            if (powerW <= 0) continue;
            const room = Math.max(0, u.maxWh - u.storedWh);
            if (room <= 0) continue;
            const addWh = Math.min(room, wattsToWattHours(powerW, gameDeltaSeconds));
            const newStored = u.storedWh + addWh;
            updateLocationBuildingData(locId, u.buildingId, { currentStoredEnergy: newStored });
        }
    } else if (deficitW > 0 && units.length) {
        // разрядка: покрываем дефицит по DischargeRate и запасу
        let needW = deficitW;
        // приоритет: у кого больше запас / быстрее разряд — пропорционально dischargeRate
        const totalDis = units.reduce((s, u) => s + u.dischargeRateW, 0) || 1;
        for (const u of units) {
            if (needW <= 0) break;
            if (u.storedWh <= 0) continue;
            const shareW = Math.min(u.dischargeRateW, needW * (u.dischargeRateW / totalDis), needW);
            const maxWhFromStore = u.storedWh;
            const maxWhFromRate = wattsToWattHours(shareW, gameDeltaSeconds);
            const takeWh = Math.min(maxWhFromStore, maxWhFromRate);
            if (takeWh <= 0) continue;
            const actualW = wattHoursToWatts(takeWh, gameDeltaSeconds);
            dischargedW += actualW;
            needW -= actualW;
            updateLocationBuildingData(locId, u.buildingId, {
                currentStoredEnergy: Math.max(0, u.storedWh - takeWh)
            });
        }
    }

    // --- Рационирование мощности сети ---
    // demand = заявленное потребление зданий; supply = генерация + то, что АКБ
    // реально могут отдать (DischargeRate при запасе > 0).
    // powerRatio = supply/demand ∈ [0..1]: здания/рецепты с requiresEnergy
    // работают только в пределах доступной мощности (не на «магической» полной).
    const totals = calcLocationStorageTotals(locId);
    const batMaxW = calcLocationBatteryOutputW(locId); // 0, если запас пуст
    const demandW = Math.max(0, consumption);
    const prodW = Math.max(0, production);
    let supplyW;
    if (prodW >= demandW) {
        supplyW = demandW; // полная нагрузка покрыта генерацией
    } else {
        const needFromBat = demandW - prodW;
        const fromBat = Math.min(needFromBat, batMaxW);
        supplyW = prodW + fromBat;
    }
    const powerRatio = demandW > 1e-9
        ? Math.max(0, Math.min(1, supplyW / demandW))
        : 1;

    const balanceW = Math.max(0, production - consumption);
    const energyAvailable = supplyW > 1e-9 || totals.storedWh > 1e-9;

    if (!state.locationFlags) state.locationFlags = {};
    state.locationFlags[locId] = {
        ...(state.locationFlags[locId] || {}),
        energyAvailable,
        noEnergyForBuildings: powerRatio <= 1e-9,
        powerRatio,
        energyDemandW: demandW,
        energySupplyW: supplyW,
        energyBatMaxW: batMaxW,
        lastBatteryDrainW: deficitW > 0 ? dischargedW : 0,
        lastBatteryDeficitW: deficitW,
        lastBatterySurplusW: surplusW
    };

    return {
        dischargedW,
        energyAvailable,
        surplusW,
        deficitW,
        balanceW,
        powerRatio,
        supplyW,
        demandW
    };
}

/** Доля доступной мощности сети 0..1 (1 = хватает на всю заявленную нагрузку). */
export function getLocationPowerRatio(locationId) {
    const flags = state.locationFlags?.[Number(locationId)];
    if (!flags) return 1;
    const r = Number(flags.powerRatio);
    return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1;
}

/** Суммарная мощность разряда, которую сейчас могут выдать аккумуляторы (Вт) */
export function calcLocationBatteryOutputW(locationId) {
    const units = listStorageUnits(locationId);
    let w = 0;
    for (const u of units) {
        if (u.storedWh <= 0) continue;
        w += u.dischargeRateW;
    }
    return w;
}
