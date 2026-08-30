import { state } from './state.js';
/**
 * unitSpaceSpeed.js — модификаторы скорости космических юнитов от технологий двигателей.
 *
 * Физика (упрощённо для игры):
 *   тяга F (кН) → относительная «моторная сила» относительно эталона max-tech.
 *   a ∝ F/m, но масса корабля пока константа в def; cruise speed в карте —
 *   абстракция, поэтому:
 *     speedMult = MIN + (SPEED_NERF - MIN) * (thrust / THRUST_REF)^0.85
 *   При max тяге (750 кН) mult ≈ SPEED_NERF → эффективная скорость ≈ «старой»
 *   до ослабления базы в 800 раз.
 *
 * Блокировка апгрейда двигателя:
 *   во время flying / systemFlying / launching / landing снимок тяги не обновляется.
 *   в технопорте (слот) или status === 'orbit' без активного маршрута — тяга с tech.
 */

import { getTechLevel, techById } from './technologies.js';
import { getUnitDef } from './units.js';

/** Во сколько раз урезаны базовые flightSpeed / systemFlightSpeed в units.json */
export const SPACE_SPEED_NERF = 800;

/** Эталонная тяга (кН) при полной прокачке STAT_ROCKET_THRUST — level 8 → 750 */
export const THRUST_REF_KN = 750;

/** Минимальный множитель при нулевой/отсутствующей тяге (всё ещё × база после nerf) */
export const MIN_ENGINE_MULT = 0.35;

const BUSY_STATUSES = new Set(['flying', 'systemFlying', 'launching', 'landing']);

/**
 * Значение стата технологии на текущем (или заданном) уровне.
 * @returns {number|null}
 */
export function getTechStatNumeric(techId, statId, levelOverride = null) {
    if (!techId || !statId) return null;
    const tech = techById?.(techId);
    if (!tech || !Array.isArray(tech.stats)) return null;
    const stat = tech.stats.find(s => s.id === statId);
    if (!stat || !Array.isArray(stat.values)) return null;
    const level = levelOverride != null
        ? Math.max(0, Number(levelOverride) || 0)
        : (getTechLevel?.(techId) ?? 0);
    const idx = Math.max(0, Math.min(level, stat.values.length - 1));
    const v = Number(stat.values[idx]);
    return Number.isFinite(v) ? v : null;
}

/**
 * Тяга → множитель скорости (безразмерный).
 * 0 кН → MIN_ENGINE_MULT; THRUST_REF_KN → SPACE_SPEED_NERF.
 */
export function thrustKnToSpeedMultiplier(thrustKn) {
    const f = Number(thrustKn);
    if (!Number.isFinite(f) || f <= 0) return MIN_ENGINE_MULT;
    const t = Math.min(1, Math.max(0, f / THRUST_REF_KN));
    // чуть вогнутая кривая: ранние уровни заметны, потолок — полный откат nerf
    const shaped = Math.pow(t, 0.85);
    return MIN_ENGINE_MULT + (SPACE_SPEED_NERF - MIN_ENGINE_MULT) * shaped;
}

/** Можно ли пересчитать двигатель с текущей технологии */
export function canRefreshUnitEngine(unit) {
    if (!unit) return false;
    // в слоте технопорта — всегда (нет status orbit)
    if (unit.inTechnoportSlot || unit._inTechnoport) return true;
    const st = unit.status;
    if (!st) return true;
    if (BUSY_STATUSES.has(st)) return false;
    // orbit без маршрута
    return st === 'orbit';
}

/**
 * Живая тяга с технологии, установленной на типе юнита.
 */
export function getLiveEngineThrustKn(unitOrTypeId) {
    let def = null;
    let unit = null;
    if (unitOrTypeId && typeof unitOrTypeId === 'object') {
        unit = unitOrTypeId;
        def = getUnitDef(unit.unitTypeId);
    } else {
        def = getUnitDef(unitOrTypeId);
    }
    if (!def) return 0;
    const engineType = def.engineType || unit?.engineType;
    if (engineType && engineType !== 'rocket') {
        // задел под другие двигатели
        return 0;
    }
    const techId = def.engineTechId || unit?.engineTechId || 'TECH_ROCKET_ENGINE';
    const statId = def.engineStatId || unit?.engineStatId || 'STAT_ROCKET_THRUST';
    const thrust = getTechStatNumeric(techId, statId);
    return thrust != null ? thrust : 0;
}

/**
 * Записать/обновить снимок двигателя на инстансе, если можно.
 * Вызывать при спавне, выходе на orbit, тике покоя.
 */
export function syncUnitEngineSnapshot(unit) {
    if (!unit) return;
    const def = getUnitDef(unit.unitTypeId);
    if (!def) return;
    if (def.engineType) unit.engineType = def.engineType;
    if (def.engineTechId) unit.engineTechId = def.engineTechId;
    if (def.engineStatId) unit.engineStatId = def.engineStatId;

    if (!canRefreshUnitEngine(unit)) return;

    const thrust = getLiveEngineThrustKn(unit);
    unit.engineThrustKn = thrust;
    unit.engineSpeedMult = thrustKnToSpeedMultiplier(thrust);
}

/**
 * Зафиксировать текущий снимок перед началом манёвра (полёт / system / launch).
 * Пока busy — syncUnitEngineSnapshot не перезапишет.
 */
export function lockUnitEngineForManeuver(unit) {
    if (!unit) return;
    // один раз подтянуть live, затем «заморозить» статусом манёвра
    const thrust = getLiveEngineThrustKn(unit);
    unit.engineThrustKn = thrust;
    unit.engineSpeedMult = thrustKnToSpeedMultiplier(thrust);
}

/**
 * Эффективная скорость для тика.
 * @param {'well'|'system'} mode
 */
export function getUnitEffectiveFlightSpeed(unit, mode = 'well') {
    const def = getUnitDef(unit?.unitTypeId);
    const baseWell = Number(def?.flightSpeed);
    const baseSys = Number(def?.systemFlightSpeed);
    const base = mode === 'system'
        ? (Number.isFinite(baseSys) ? baseSys : (Number.isFinite(baseWell) ? baseWell * 12 : 4.5 / SPACE_SPEED_NERF))
        : (Number.isFinite(baseWell) ? baseWell : 0.35 / SPACE_SPEED_NERF);

    // если снимок ещё не ставили — посчитать
    if (unit && (unit.engineSpeedMult == null || !Number.isFinite(unit.engineSpeedMult))) {
        if (canRefreshUnitEngine(unit)) syncUnitEngineSnapshot(unit);
        else lockUnitEngineForManeuver(unit);
    }
    const mult = Number(unit?.engineSpeedMult);
    const m = Number.isFinite(mult) && mult > 0 ? mult : MIN_ENGINE_MULT;
    let devM = 1;
    try { const d = Number(state?.devOverrides?.unitSpeedMult); if (Number.isFinite(d) && d > 0) devM = d; } catch (_) {}
    return Math.max(1e-9, base * m * devM);
}

/** Для UI / отладки */
export function describeUnitEngine(unit) {
    const def = getUnitDef(unit?.unitTypeId);
    return {
        engineType: unit?.engineType || def?.engineType || null,
        techId: unit?.engineTechId || def?.engineTechId || null,
        thrustKn: unit?.engineThrustKn ?? getLiveEngineThrustKn(unit),
        speedMult: unit?.engineSpeedMult ?? thrustKnToSpeedMultiplier(getLiveEngineThrustKn(unit)),
        locked: unit ? !canRefreshUnitEngine(unit) : false
    };
}
