/**
 * Система юнитов: каталог, стояние в Технопорте, орбита, взлёт/посадка.
 * state.locationUnits[bodyId] = {
 *   slots: { space: [slot|null×4], air: [...], ground: [...] },
 *   inOrbit: [ { instanceId, unitTypeId, bodyId, lx, lz, status, remainingMs, totalMs } ]
 *   lx/lz — локальные координаты относительно mesh тела (система грав. колодца)
 * }
 * slot = { unitTypeId, count }
 */
import { state } from './state.js';
import { locName, t } from './settings.js';
import { getLocationBuildingData } from './buildingHelpers.js';
import {
    syncUnitEngineSnapshot,
    lockUnitEngineForManeuver,
    getUnitEffectiveFlightSpeed
} from './unitSpaceSpeed.js';

export const UNIT_CATEGORIES = ['space', 'air', 'ground'];
export const SLOTS_PER_CATEGORY = 4;

let unitsCatalog = [];
let unitsById = {};
let nextInstanceSeq = 1;

export function getUnitsCatalog() {
    return unitsCatalog;
}

export function getUnitDef(id) {
    return unitsById[id] || null;
}

export async function loadUnitsData() {
    try {
        const res = await fetch('units.json');
        unitsCatalog = await res.json();
        unitsById = {};
        for (const u of unitsCatalog) unitsById[u.id] = u;
        console.log('Units loaded:', unitsCatalog.length);
    } catch (e) {
        console.error('Failed to load units.json', e);
        unitsCatalog = [];
        unitsById = {};
    }
    return unitsCatalog;
}

/** Длина/ширина → м, площадь → м² */
export function unitFootprintM2(def) {
    if (!def) return 0;
    const toM = (v, unit) => {
        const n = Number(v) || 0;
        const u = String(unit || 'm').toLowerCase();
        if (u === 'km' || u === 'км') return n * 1000;
        return n;
    };
    const L = toM(def.length, def.lengthUnit);
    const W = toM(def.width, def.widthUnit);
    return Math.max(0, L * W);
}

export function formatAreaM2(m2) {
    const v = Number(m2) || 0;
    if (v >= 1e6) {
        return `${(v / 1e6).toFixed(2)} ${t('unit.km2') || 'км²'}`;
    }
    if (v >= 10000) {
        return `${(v / 1e6).toFixed(3)} ${t('unit.km2') || 'км²'}`;
    }
    return `${Math.round(v)} ${t('unit.m2') || 'м²'}`;
}

/** Суммарная вместимость Технопорта (м²) по всем IsTechnoport зданиям локации */
export function getTechnoportCapacityM2(bodyId) {
    const locId = Number(bodyId);
    const buildings = state.buildings || [];
    let total = 0;
    for (const b of buildings) {
        if (!b.IsTechnoport) continue;
        const loc = getLocationBuildingData(locId, b.id);
        if (!loc || !(loc.built_count > 0)) continue;
        const level = Math.max(0, Number(loc.currentLevel) || 0);
        const arr = b.TechnoportCapacity || [];
        const per = Number(arr[Math.min(level, arr.length - 1)] ?? arr[0] ?? 0) || 0;
        total += per * (Number(loc.built_count) || 0);
    }
    return total;
}

/** Есть ли хотя бы 1 здание-технопорт на теле */
export function bodyHasTechnoportBuilding(bodyId) {
    const locId = Number(bodyId);
    const buildings = state.buildings || [];
    for (const b of buildings) {
        if (!b.IsTechnoport) continue;
        const loc = getLocationBuildingData(locId, b.id);
        if (loc && (loc.built_count || 0) >= 1) return true;
    }
    return false;
}

export function isTechnoportUnlocked(body) {
    if (!body?.data) return false;
    if (body.data.has_technoport) return true;
    return bodyHasTechnoportBuilding(body.data.id);
}

function emptySlots() {
    return {
        space: Array(SLOTS_PER_CATEGORY).fill(null),
        air: Array(SLOTS_PER_CATEGORY).fill(null),
        ground: Array(SLOTS_PER_CATEGORY).fill(null)
    };
}

export function ensureLocationUnits(bodyId) {
    const locId = Number(bodyId);
    if (!state.locationUnits) state.locationUnits = {};
    if (!state.locationUnits[locId]) {
        state.locationUnits[locId] = {
            slots: emptySlots(),
            inOrbit: []
        };
        // стартовые юниты из hev.body.json
        const body = state.celestialBodies[locId] || state.celestialBodies[String(locId)];
        const starter = body?.data?.units;
        if (starter && typeof starter === 'object') {
            for (const cat of UNIT_CATEGORIES) {
                const list = starter[cat] || [];
                for (const entry of list) {
                    const slotIdx = Math.min(
                        SLOTS_PER_CATEGORY - 1,
                        Math.max(0, Number(entry.slot) || 0)
                    );
                    const typeId = entry.unitTypeId;
                    const count = Math.max(1, Number(entry.count) || 1);
                    if (!typeId || !getUnitDef(typeId)) continue;
                    state.locationUnits[locId].slots[cat][slotIdx] = {
                        unitTypeId: typeId,
                        count
                    };
                }
            }
        }
    }
    return state.locationUnits[locId];
}

export function getUsedCapacityM2(bodyId) {
    const data = ensureLocationUnits(bodyId);
    let used = 0;
    for (const cat of UNIT_CATEGORIES) {
        for (const slot of data.slots[cat] || []) {
            if (!slot) continue;
            const def = getUnitDef(slot.unitTypeId);
            used += unitFootprintM2(def) * (Number(slot.count) || 0);
        }
    }
    // юниты в процессе посадки ещё «в пути» — не считаем в технопорте
    return used;
}

export function canAddUnitCount(bodyId, unitTypeId, addCount = 1) {
    const def = getUnitDef(unitTypeId);
    if (!def) return false;
    const need = unitFootprintM2(def) * addCount;
    const used = getUsedCapacityM2(bodyId);
    const cap = getTechnoportCapacityM2(bodyId);
    return used + need <= cap + 1e-6;
}

/** Переставить / объединить слоты внутри категории */
export function moveUnitSlot(bodyId, category, fromIdx, toIdx) {
    const data = ensureLocationUnits(bodyId);
    if (!UNIT_CATEGORIES.includes(category)) return false;
    const slots = data.slots[category];
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= SLOTS_PER_CATEGORY || toIdx >= SLOTS_PER_CATEGORY) return false;
    if (fromIdx === toIdx) return true;
    const a = slots[fromIdx];
    const b = slots[toIdx];
    if (!a) return false;
    if (!b) {
        slots[toIdx] = a;
        slots[fromIdx] = null;
        return true;
    }
    if (a.unitTypeId === b.unitTypeId) {
        b.count = (Number(b.count) || 0) + (Number(a.count) || 0);
        slots[fromIdx] = null;
        return true;
    }
    // swap
    slots[fromIdx] = b;
    slots[toIdx] = a;
    return true;
}

function genInstanceId(unitTypeId) {
    return `${unitTypeId}_${Date.now().toString(36)}_${nextInstanceSeq++}`;
}

/**
 * Начать взлёт одного юнита из слота.
 * @returns {{ ok:boolean, instanceId?:string, reason?:string }}
 */
export function startLaunch(bodyId, category, slotIdx) {
    const data = ensureLocationUnits(bodyId);
    const slots = data.slots[category];
    if (!slots) return { ok: false, reason: 'bad_category' };
    const slot = slots[slotIdx];
    if (!slot || !(slot.count > 0)) return { ok: false, reason: 'empty' };

    // уже есть активный взлёт/посадка этого слота — не дублируем
    const busy = data.inOrbit.find(
        u => u.status === 'launching' && u.fromSlot === slotIdx && u.category === category && u.unitTypeId === slot.unitTypeId
    );
    if (busy) return { ok: false, reason: 'busy', instanceId: busy.instanceId };

    const def = getUnitDef(slot.unitTypeId);
    if (!def) return { ok: false, reason: 'unknown' };
    const totalMs = Math.max(1000, (Number(def.launchTimeSec) || 12) * 1000);
    const instanceId = genInstanceId(slot.unitTypeId);

    // локальный оффсет в системе грав. колодца тела (не мировые координаты)
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    const size = Number(body?.data?.size) || 1;
    const wellMul = Number(body?.data?.gravityWellMultiplier) || 1;
    const wellR = size * wellMul;
    const spawnR = size + Math.max(0.08, (wellR - size) * 0.14);
    const ang = Math.random() * Math.PI * 2;

    const olx = Math.cos(ang) * spawnR;
    const olz = Math.sin(ang) * spawnR;
    const launched = {
        instanceId,
        unitTypeId: slot.unitTypeId,
        bodyId: Number(bodyId),
        lx: olx,
        lz: olz,
        // во время взлёта: старт ближе к телу, летим наружу к spawnR
        launchFromLx: Math.cos(ang) * (size * 1.02),
        launchFromLz: Math.sin(ang) * (size * 1.02),
        launchToLx: olx,
        launchToLz: olz,
        facingX: Math.cos(ang),
        facingZ: Math.sin(ang),
        animScale: 0.15,
        animOpacity: 0.15,
        status: 'orbit', // временно для снимка двигателя, ниже → launching
        remainingMs: totalMs,
        totalMs,
        category,
        fromSlot: slotIdx
    };
    try { lockUnitEngineForManeuver(launched); } catch (_) {}
    launched.status = 'launching';
    data.inOrbit.push(launched);
    return { ok: true, instanceId, totalMs };
}

export function startLanding(instanceId) {
    const found = findOrbitUnit(instanceId);
    if (!found) return { ok: false, reason: 'not_found' };
    const { data, unit } = found;
    if (unit.status !== 'orbit' && unit.status !== 'flying') return { ok: false, reason: 'not_in_orbit' };
    if (!isWithinLandingZone(unit)) return { ok: false, reason: 'too_far' };
    delete unit.destLx;
    delete unit.destLz;
    delete unit.finalLx;
    delete unit.finalLz;
    delete unit.waypoints;

    const def = getUnitDef(unit.unitTypeId);
    const totalMs = Math.max(1000, (Number(def?.landTimeSec ?? def?.launchTimeSec) || 12) * 1000);
    // нос к центру тела
    const clx = Number(unit.lx) || 0;
    const clz = Number(unit.lz) || 0;
    const cd = Math.hypot(clx, clz) || 1;
    unit.facingX = -clx / cd;
    unit.facingZ = -clz / cd;
    unit.landFromLx = clx;
    unit.landFromLz = clz;
    unit.animScale = 1;
    unit.animOpacity = 1;
    unit.status = 'landing';
    unit.remainingMs = totalMs;
    unit.totalMs = totalMs;
    return { ok: true, totalMs };
}

export function findOrbitUnit(instanceId) {
    const map = state.locationUnits || {};
    for (const bodyId of Object.keys(map)) {
        const data = map[bodyId];
        const unit = (data.inOrbit || []).find(u => u.instanceId === instanceId);
        if (unit) return { bodyId: Number(bodyId), data, unit };
    }
    return null;
}

export function getOrbitUnitsForBody(bodyId) {
    return ensureLocationUnits(bodyId).inOrbit || [];
}

export function getAllOrbitUnits() {
    const out = [];
    const map = state.locationUnits || {};
    for (const bodyId of Object.keys(map)) {
        for (const u of map[bodyId].inOrbit || []) out.push(u);
    }
    return out;
}

/** 20% зоны от поверхности тела до пунктира грав. колодца */
export function isWithinLandingZone(unit) {
    const body = state.celestialBodies[unit.bodyId] || state.celestialBodies[String(unit.bodyId)];
    if (!body?.mesh && unit.lx == null && unit.x == null) return false;
    const size = Number(body?.data?.size) || 1;
    const wellMul = Number(body?.data?.gravityWellMultiplier) || 1;
    const wellR = size * wellMul;
    const ring = Math.max(0.01, wellR - size);
    const maxDist = size + ring * 0.2;
    let dist;
    if (unit.lx != null || unit.lz != null) {
        dist = Math.sqrt((Number(unit.lx) || 0) ** 2 + (Number(unit.lz) || 0) ** 2);
    } else if (body?.mesh) {
        const dx = (unit.x || 0) - body.mesh.position.x;
        const dz = (unit.z || 0) - body.mesh.position.z;
        dist = Math.sqrt(dx * dx + dz * dz);
    } else {
        return false;
    }
    return dist <= maxDist + 1e-6;
}


/** Юнит в жёлтой зоне (80–99% maxR) — можно начать полёт внутри системы. */
export function isInYellowZone(unit) {
    if (!unit) return false;
    const lim = getWellFlightLimits(unit.bodyId);
    let dist;
    if (unit.lx != null || unit.lz != null) {
        dist = Math.hypot(Number(unit.lx) || 0, Number(unit.lz) || 0);
    } else {
        return false;
    }
    const lo = lim.maxR * 0.80;
    const hi = lim.maxR * 0.99;
    return dist >= lo - 1e-4 && dist <= hi + 1e-3;
}

/** Точка прибытия на 99% кольца целевого тела со стороны подхода. */
export function getSystemArrivalLocal(fromWx, fromWz, targetBodyId) {
    const body = state.celestialBodies[targetBodyId] || state.celestialBodies[String(targetBodyId)];
    if (!body?.mesh) return null;
    const lim = getWellFlightLimits(targetBodyId);
    const r = lim.maxR * 0.99;
    const cx = body.mesh.position.x;
    const cz = body.mesh.position.z;
    let dx = fromWx - cx;
    let dz = fromWz - cz;
    let d = Math.hypot(dx, dz);
    if (d < 1e-6) {
        dx = 1; dz = 0; d = 1;
    }
    const lx = (dx / d) * r;
    const lz = (dz / d) * r;
    return { lx, lz, wx: cx + lx, wz: cz + lz, cx, cz, r };
}

export function stopUnitMotion(instanceId) {
    const found = findOrbitUnit(instanceId);
    if (!found) return;
    const { unit } = found;
    delete unit.destLx;
    delete unit.destLz;
    delete unit.finalLx;
    delete unit.finalLz;
    delete unit.waypoints;
    delete unit.systemTargetBodyId;
    delete unit.wx;
    delete unit.wz;
    if (unit.status === 'flying' || unit.status === 'systemFlying') {
        unit.status = 'orbit';
    }
}

/** Назначить полёт к другому небесному телу (внутри звёздной системы). */
export function setSystemFlightDestination(instanceId, targetBodyId) {
    const found = findOrbitUnit(instanceId);
    if (!found) return { ok: false, reason: 'not_found' };
    const { unit, bodyId } = found;
    if (unit.status !== 'orbit' && unit.status !== 'flying' && unit.status !== 'systemFlying') {
        return { ok: false, reason: 'busy' };
    }
    if (!isInYellowZone(unit) && unit.status !== 'systemFlying') {
        return { ok: false, reason: 'not_in_yellow_zone' };
    }
    targetBodyId = Number(targetBodyId);
    if (targetBodyId === Number(bodyId)) {
        return { ok: false, reason: 'same_body' };
    }
    const destBody = state.celestialBodies[targetBodyId] || state.celestialBodies[String(targetBodyId)];
    if (!destBody?.mesh) return { ok: false, reason: 'bad_target' };
    // только планеты/луны/карлики и т.п. — не звезда/система/туманность
    const t = destBody.data?.type;
    if (t === 'star' || t === 'starSystem' || t === 'interstellarNebula') {
        return { ok: false, reason: 'bad_type' };
    }

    const wp = getUnitWorldPos(unit);
    stopUnitMotion(instanceId);
    try { lockUnitEngineForManeuver(unit); } catch (_) {}
    unit.status = 'systemFlying';
    unit.systemTargetBodyId = targetBodyId;
    unit.systemFromBodyId = Number(bodyId);
    unit.wx = wp.x;
    unit.wz = wp.z;
    // нос к цели
    const arr = getSystemArrivalLocal(wp.x, wp.z, targetBodyId);
    if (arr) {
        const dx = arr.wx - wp.x;
        const dz = arr.wz - wp.z;
        const len = Math.hypot(dx, dz) || 1;
        unit.facingX = dx / len;
        unit.facingZ = dz / len;
    }
    return { ok: true };
}

export function getLandingZoneInfo(bodyId) {
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    if (!body?.mesh) return null;
    const size = Number(body.data?.size) || 1;
    const wellMul = Number(body.data?.gravityWellMultiplier) || 1;
    const wellR = size * wellMul;
    const ring = Math.max(0.01, wellR - size);
    return {
        bodySize: size,
        wellRadius: wellR,
        landingMaxDist: size + ring * 0.2,
        center: { x: body.mesh.position.x, z: body.mesh.position.z }
    };
}

/** Плотность сетки грав. колодца (как в bodies.js gridDensity) */
export const GRAVITY_WELL_GRID_DENSITY = 10;

/** Мир-позиция юнита = позиция тела + локальный оффсет в плоскости XZ */
export function getUnitWorldPos(unit) {
    // межсистемный полёт — мировые координаты
    if (unit.status === 'systemFlying' && unit.wx != null && unit.wz != null) {
        return { x: Number(unit.wx), z: Number(unit.wz), y: 0.05 };
    }
    const body = state.celestialBodies[unit.bodyId] || state.celestialBodies[String(unit.bodyId)];
    const bx = body?.mesh?.position?.x || 0;
    const bz = body?.mesh?.position?.z || 0;
    if (unit.lx == null && unit.x != null) {
        return { x: unit.x, z: unit.z, y: 0.05 };
    }
    return {
        x: bx + (Number(unit.lx) || 0),
        z: bz + (Number(unit.lz) || 0),
        y: 0.05
    };
}

/** Размер одной клетки сетки грав. колодца в мировых единицах */
export function getGravityWellCellWorldSize(bodyId) {
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    const size = Number(body?.data?.size) || 1;
    const wellMul = Number(body?.data?.gravityWellMultiplier) || 1;
    const wellR = size * wellMul;
    return (2 * wellR) / GRAVITY_WELL_GRID_DENSITY;
}

/** Мин/макс радиус полёта в локальных координатах тела (XZ). */
export function getWellFlightLimits(bodyId) {
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    const size = Number(body?.data?.size) || 1;
    const wellMul = Number(body?.data?.gravityWellMultiplier) || 1;
    const wellR = size * wellMul;
    const ring = Math.max(0.01, wellR - size);
    // мин = точка спавна после взлёта; макс = пунктир грав. колодца (lineRadius)
    const minR = size + Math.max(0.08, ring * 0.14);
    const maxR = wellR * 1.05;
    // внешний край зоны посадки (как isWithinLandingZone)
    const landMaxR = size + ring * 0.2;
    return { minR, maxR, landMaxR, wellR, size, ring };
}

/** Зажать локальную точку в допустимое кольцо; null если внутри тела / снаружи колодца. */
export function clampLocalToFlightRing(bodyId, lx, lz) {
    const { minR, maxR } = getWellFlightLimits(bodyId);
    const dist = Math.sqrt(lx * lx + lz * lz);
    if (dist < minR - 1e-6 || dist > maxR + 1e-6) return null;
    return { lx, lz, dist };
}


/**
 * Пересекает ли отрезок диск радиуса R (центр в 0).
 */
function segmentHitsDisk(sx, sz, ex, ez, R) {
    const dx = ex - sx;
    const dz = ez - sz;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-12) return Math.hypot(sx, sz) < R;
    let t = -(sx * dx + sz * dz) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = sx + t * dx;
    const cz = sz + t * dz;
    return (cx * cx + cz * cz) < R * R - 1e-10;
}

function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

/**
 * Маршрут S→E: прямая или дуга облёта вокруг диска minR.
 * Возвращает промежуточные точки + финиш (без старта).
 */
export function buildFlightWaypoints(sx, sz, ex, ez, minR) {
    const R = minR * 1.02; // небольшой зазор
    if (!segmentHitsDisk(sx, sz, ex, ez, R)) {
        return [{ lx: ex, lz: ez }];
    }
    const a0 = Math.atan2(sz, sx);
    const a1 = Math.atan2(ez, ex);
    let da = normAngle(a1 - a0);
    // дуга: точки на окружности R
    const steps = Math.max(5, Math.ceil(Math.abs(da) / (Math.PI / 10)));
    const wps = [];
    for (let i = 1; i < steps; i++) {
        const a = a0 + da * (i / steps);
        wps.push({ lx: Math.cos(a) * R, lz: Math.sin(a) * R });
    }
    wps.push({ lx: ex, lz: ez });
    return wps;
}

/** Полный путь (включая текущую позицию) для отрисовки.
 *  previewDest — если задан, всегда строим превью к курсору (призрак),
 *  даже когда юнит уже летит по другому маршруту.
 */
export function getFlightPathLocal(unit, previewDest) {
    if (!unit) return [];
    const sx = Number(unit.lx) || 0;
    const sz = Number(unit.lz) || 0;
    const { minR } = getWellFlightLimits(unit.bodyId);

    // превью курсора / призрак — приоритетнее активного маршрута
    if (previewDest && previewDest.lx != null && previewDest.lz != null) {
        const wps = buildFlightWaypoints(sx, sz, previewDest.lx, previewDest.lz, minR);
        return [{ lx: sx, lz: sz }, ...wps];
    }

    // активный маршрут
    if (unit.waypoints && unit.waypoints.length) {
        return [{ lx: sx, lz: sz }, ...unit.waypoints.map(w => ({ lx: w.lx, lz: w.lz }))];
    }
    if (unit.destLx != null && unit.destLz != null) {
        const wps = buildFlightWaypoints(sx, sz, unit.destLx, unit.destLz, minR);
        return [{ lx: sx, lz: sz }, ...wps];
    }
    return [];
}

/** Назначить точку назначения (локальные lx/lz). */
export function setFlightDestination(instanceId, destLx, destLz) {
    const found = findOrbitUnit(instanceId);
    if (!found) return { ok: false, reason: 'not_found' };
    const { unit } = found;
    if (unit.status !== 'orbit' && unit.status !== 'flying') {
        return { ok: false, reason: 'busy' };
    }
    const clamped = clampLocalToFlightRing(unit.bodyId, destLx, destLz);
    if (!clamped) return { ok: false, reason: 'out_of_bounds' };

    const curLx = Number(unit.lx) || 0;
    const curLz = Number(unit.lz) || 0;
    if (Math.hypot(clamped.lx - curLx, clamped.lz - curLz) < 1e-5) {
        return { ok: false, reason: 'same_point' };
    }

    const { minR } = getWellFlightLimits(unit.bodyId);
    const wps = buildFlightWaypoints(curLx, curLz, clamped.lx, clamped.lz, minR);
    try { lockUnitEngineForManeuver(unit); } catch (_) {}
    unit.status = 'flying';
    unit.waypoints = wps;
    const first = wps[0];
    unit.destLx = first.lx;
    unit.destLz = first.lz;
    unit.finalLx = clamped.lx;
    unit.finalLz = clamped.lz;
    const dx = first.lx - curLx;
    const dz = first.lz - curLz;
    const len = Math.hypot(dx, dz) || 1;
    unit.facingX = dx / len;
    unit.facingZ = dz / len;
    return { ok: true };
}

export function clearFlightDestination(instanceId) {
    const found = findOrbitUnit(instanceId);
    if (!found) return;
    const { unit } = found;
    delete unit.destLx;
    delete unit.destLz;
    delete unit.finalLx;
    delete unit.finalLz;
    delete unit.waypoints;
    if (unit.status === 'flying') unit.status = 'orbit';
}

/**
 * Тик процессов взлёта/посадки (ms).
 * @returns {{ slotsChanged: boolean, orbitChanged: boolean }}
 */
export function tickUnits(dtMs, timeSpeed = 1) {
    const result = { slotsChanged: false, orbitChanged: false };
    if (!state.locationUnits) return result;
    const dt = Math.max(0, Number(dtMs) || 0);
    if (dt <= 0) return result;
    const speedMul = Math.max(0, Number(timeSpeed) || 0);
    const gameDt = (dt / 1000) * speedMul; // игровые секунды

    for (const bodyId of Object.keys(state.locationUnits)) {
        const data = state.locationUnits[bodyId];
        const remain = [];
        for (const unit of data.inOrbit || []) {
            // в покое — подтянуть тягу с актуальной технологии
            if (unit.status === 'orbit') {
                try { syncUnitEngineSnapshot(unit); } catch (_) {}
            }
            // --- полёт к точке ---
            if (unit.status === 'flying' && unit.destLx != null && unit.destLz != null && gameDt > 0) {
                let spd = 0.35 / 800;
                try { spd = getUnitEffectiveFlightSpeed(unit, 'well'); } catch (_) {}
                const budgetCap = Math.max(1e-9, spd);
                let budget = budgetCap * gameDt;
                let guard = 0;
                while (budget > 1e-8 && unit.status === 'flying' && guard++ < 32) {
                    const curLx = Number(unit.lx) || 0;
                    const curLz = Number(unit.lz) || 0;
                    const dx = unit.destLx - curLx;
                    const dz = unit.destLz - curLz;
                    const dist = Math.hypot(dx, dz);
                    if (dist < 1e-4) {
                        unit.lx = unit.destLx;
                        unit.lz = unit.destLz;
                        // следующая точка маршрута
                        if (unit.waypoints && unit.waypoints.length) {
                            unit.waypoints.shift();
                        }
                        if (unit.waypoints && unit.waypoints.length) {
                            unit.destLx = unit.waypoints[0].lx;
                            unit.destLz = unit.waypoints[0].lz;
                        } else {
                            unit.status = 'orbit';
                            delete unit.destLx;
                            delete unit.destLz;
                            delete unit.finalLx;
                            delete unit.finalLz;
                            delete unit.waypoints;
                            break;
                        }
                        continue;
                    }
                    unit.facingX = dx / dist;
                    unit.facingZ = dz / dist;
                    const step = Math.min(dist, budget);
                    budget -= step;
                    let nx = curLx + unit.facingX * step;
                    let nz = curLz + unit.facingZ * step;
                    const lim = getWellFlightLimits(unit.bodyId);
                    let r = Math.hypot(nx, nz);
                    if (r < lim.minR) {
                        const s = lim.minR / Math.max(r, 1e-9);
                        nx *= s; nz *= s;
                    } else if (r > lim.maxR) {
                        const s = lim.maxR / Math.max(r, 1e-9);
                        nx *= s; nz *= s;
                    }
                    unit.lx = nx;
                    unit.lz = nz;
                    result.orbitChanged = true;
                }
            }


            if (unit.status === 'systemFlying' && unit.systemTargetBodyId != null && gameDt > 0) {
                let spd = 4.5 / 800;
                try { spd = getUnitEffectiveFlightSpeed(unit, 'system'); } catch (_) {}
                spd = Math.max(1e-9, spd);
                let wx = Number(unit.wx);
                let wz = Number(unit.wz);
                if (!Number.isFinite(wx) || !Number.isFinite(wz)) {
                    const wp0 = getUnitWorldPos(unit);
                    wx = wp0.x; wz = wp0.z;
                    unit.wx = wx; unit.wz = wz;
                }
                const arr = getSystemArrivalLocal(wx, wz, unit.systemTargetBodyId);
                if (!arr) {
                    unit.status = 'orbit';
                    delete unit.systemTargetBodyId;
                    delete unit.wx; delete unit.wz;
                    remain.push(unit);
                    result.orbitChanged = true;
                    continue;
                }
                const dx = arr.wx - wx;
                const dz = arr.wz - wz;
                const dist = Math.hypot(dx, dz);
                if (dist < Math.max(0.08, arr.r * 0.02)) {
                    // прибытие: перенос на целевое тело
                    const fromId = unit.bodyId;
                    const toId = Number(unit.systemTargetBodyId);
                    unit.bodyId = toId;
                    unit.lx = arr.lx;
                    unit.lz = arr.lz;
                    unit.status = 'orbit';
                    unit.animScale = 1;
                    unit.animOpacity = 1;
                    delete unit.systemTargetBodyId;
                    delete unit.systemFromBodyId;
                    delete unit.wx;
                    delete unit.wz;
                    delete unit.destLx;
                    delete unit.destLz;
                    delete unit.waypoints;
                    // перенос между списками inOrbit
                    if (Number(fromId) !== toId) {
                        const fromData = ensureLocationUnits(fromId);
                        fromData.inOrbit = (fromData.inOrbit || []).filter(u => u.instanceId !== unit.instanceId);
                        const toData = ensureLocationUnits(toId);
                        if (!toData.inOrbit) toData.inOrbit = [];
                        toData.inOrbit.push(unit);
                        // уже не push в remain текущего body
                        result.orbitChanged = true;
                        result.slotsChanged = true;
                        continue;
                    }
                    remain.push(unit);
                    result.orbitChanged = true;
                    continue;
                }
                const step = Math.min(dist, spd * gameDt);
                unit.wx = wx + (dx / dist) * step;
                unit.wz = wz + (dz / dist) * step;
                unit.facingX = dx / dist;
                unit.facingZ = dz / dist;
                // синхронизируем lx относительно «текущего» body (для совместимости)
                const host = state.celestialBodies[unit.bodyId] || state.celestialBodies[String(unit.bodyId)];
                if (host?.mesh) {
                    unit.lx = unit.wx - host.mesh.position.x;
                    unit.lz = unit.wz - host.mesh.position.z;
                }
                remain.push(unit);
                result.orbitChanged = true;
                continue;
            }

            if (unit.status === 'launching' || unit.status === 'landing') {
                // remainingMs в «игровых» мс: при 0x стоит, при 2x идёт вдвое быстрее
                unit.remainingMs = Math.max(0, (unit.remainingMs || 0) - dt * speedMul);
                const total = Math.max(1, Number(unit.totalMs) || 1);
                const done = 1 - (unit.remainingMs / total); // 0→1
                if (unit.status === 'launching') {
                    const t = Math.min(1, Math.max(0, done));
                    const a = t * t * (3 - 2 * t); // smoothstep
                    const fx = Number(unit.launchFromLx) || 0;
                    const fz = Number(unit.launchFromLz) || 0;
                    const tx = Number(unit.launchToLx) || Number(unit.lx) || 0;
                    const tz = Number(unit.launchToLz) || Number(unit.lz) || 0;
                    unit.lx = fx + (tx - fx) * a;
                    unit.lz = fz + (tz - fz) * a;
                    const odx = tx - fx, odz = tz - fz;
                    const ol = Math.hypot(odx, odz) || 1;
                    unit.facingX = odx / ol;
                    unit.facingZ = odz / ol;
                    unit.animScale = 0.15 + 0.85 * a;
                    unit.animOpacity = 0.15 + 0.85 * a;
                } else if (unit.status === 'landing') {
                    const t = Math.min(1, Math.max(0, done));
                    const a = t * t * (3 - 2 * t);
                    const fx = Number(unit.landFromLx) || Number(unit.lx) || 0;
                    const fz = Number(unit.landFromLz) || Number(unit.lz) || 0;
                    // к центру (0,0), но не дальше surface
                    const body = state.celestialBodies[unit.bodyId] || state.celestialBodies[String(unit.bodyId)];
                    const size = Number(body?.data?.size) || 1;
                    const targetR = size * 0.92;
                    const fromR = Math.hypot(fx, fz) || 1;
                    const ang = Math.atan2(fz, fx);
                    const toX = Math.cos(ang) * targetR;
                    const toZ = Math.sin(ang) * targetR;
                    unit.lx = fx + (toX - fx) * a;
                    unit.lz = fz + (toZ - fz) * a;
                    unit.facingX = -Math.cos(ang);
                    unit.facingZ = -Math.sin(ang);
                    unit.animScale = 1 - 0.9 * a;
                    unit.animOpacity = 1 - 0.95 * a;
                }
                result.orbitChanged = true;
                if (unit.remainingMs <= 0) {
                    if (unit.status === 'launching') {
                        const slots = data.slots[unit.category];
                        const slot = slots?.[unit.fromSlot];
                        if (slot && slot.unitTypeId === unit.unitTypeId && slot.count > 0) {
                            slot.count -= 1;
                            if (slot.count <= 0) slots[unit.fromSlot] = null;
                            result.slotsChanged = true;
                        }
                        unit.status = 'orbit';
                        unit.remainingMs = 0;
                        unit.animScale = 1;
                        unit.animOpacity = 1;
                        delete unit.launchFromLx;
                        delete unit.launchFromLz;
                        delete unit.launchToLx;
                        delete unit.launchToLz;
                        remain.push(unit);
                        result.orbitChanged = true;
                    } else if (unit.status === 'landing') {
                        returnUnitToTechnoport(Number(bodyId), unit.unitTypeId);
                        result.slotsChanged = true;
                        result.orbitChanged = true;
                    }
                    continue;
                }
            }
            remain.push(unit);
        }
        data.inOrbit = remain;
    }
    return result;
}

function returnUnitToTechnoport(bodyId, unitTypeId) {
    const def = getUnitDef(unitTypeId);
    if (!def) return;
    const cat = def.category || 'space';
    const data = ensureLocationUnits(bodyId);
    const slots = data.slots[cat] || data.slots.space;
    // найти существующий слот того же типа
    for (let i = 0; i < slots.length; i++) {
        if (slots[i] && slots[i].unitTypeId === unitTypeId) {
            slots[i].count = (Number(slots[i].count) || 0) + 1;
            return;
        }
    }
    // пустой слот
    for (let i = 0; i < slots.length; i++) {
        if (!slots[i]) {
            slots[i] = { unitTypeId, count: 1 };
            return;
        }
    }
    // все заняты — всё равно добавить в первый (переполнение слотов UI, вместимость проверяем мягко)
    if (!slots[0]) slots[0] = { unitTypeId, count: 1 };
    else if (slots[0].unitTypeId === unitTypeId) slots[0].count += 1;
    else slots[0] = { unitTypeId, count: (slots[0].count || 0) }; // keep
}

/** Снимок для сейва */
export function collectUnitsSnapshot() {
    return JSON.parse(JSON.stringify(state.locationUnits || {}));
}

export function applyUnitsSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    state.locationUnits = JSON.parse(JSON.stringify(snap));
}

export function unitDisplayName(defOrId) {
    const def = typeof defOrId === 'string' ? getUnitDef(defOrId) : defOrId;
    return locName(def?.name, def?.id || '—');
}
