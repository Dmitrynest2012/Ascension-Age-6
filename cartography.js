/**
 * Картография: панель 2D-карты + местные действия / экспедиции.
 */
import { state } from './state.js';
import { timeSpeed as uiTimeSpeed, startTime } from './ui.js';
import { t, locName, onLanguageChange } from './settings.js';
import { getLocationSpecialists } from './specialists.js';
import { addResourceClamped } from './resourceStorage.js';
import {
    attachMap, detachMap, loadBodyTextures, startMapLoop, stopMapLoop, resize,
    setMarkers, setPathLine, setMissionPaths, setPickMode, setMarkerClickHandler, setBackgroundClickHandler, isPickMode,
    revealFog, resetFogFull, exportFogData, importFogData,
    distanceKm, getMapView, diameterKmOf, focusMapOn, getFogRevealedPercent
} from './cartographyMap.js';
import { initCartographyHud, refreshCartographyHud } from './cartographyHud.js';
import { createFirmSelect } from './firmSelect.js';

let panelVisible = false;
let currentBody = null;
let catalogs = { units: [], resources: [], structures: [], geo: [] };
let selectedTarget = null; // marker or null
let pendingCoords = null;
let pendingNodeId = null; // resource node id for mine
let focusedNodeId = null; // нода, по которой кликнули (карточка в действиях)
let expeditionType = 'scout';
let assignCount = 1;
let typeSelectApi = null;

const BASE_LON = 80;   // север Сибири / Карское побережье
const BASE_LAT = 72;
const BASE_VISION_KM = 300;

function $(id) { return document.getElementById(id); }

function bodyKey(body) {
    return String(body?.data?.id ?? body?.id ?? '');
}

export function getCartographyMap() {
    if (!state.locationCartography) state.locationCartography = {};
    return state.locationCartography;
}

export function ensureBodyCartography(body) {
    const id = bodyKey(body);
    if (!id) return null;
    const map = getCartographyMap();
    if (map[id]) return map[id];

    const entry = {
        fogData: null,
        structures: [],
        units: [],
        expeditions: [],
        resources: []
    };

    // Стартовая база Космистов только на Святой Руси
    if (Number(body?.data?.id) === 3) {
        entry.structures.push({
            id: 'struct_cosmists_1',
            structureId: 'GSTRUCT_COSMISTS_BASE',
            lon: BASE_LON,
            lat: BASE_LAT,
            garrison: 0
        });
    }

    // Ресурсные ноды с тела (groundResourceNodes)
    seedResourceNodes(body, entry);

    map[id] = entry;
    return entry;
}

function resourceMeta(id) {
    return catalogs.resources.find(x => x.id === id) || null;
}

/** Инициализация нод из body.data.groundResourceNodes */
function seedResourceNodes(body, entry) {
    if (!entry.resources) entry.resources = [];
    // дотянуть linkedGeo у уже сохранённых нод
    for (const r of entry.resources) {
        if (!r.linkedGeoResourceId) {
            const meta = resourceMeta(r.resourceId);
            if (meta?.linkedGeoResourceId) r.linkedGeoResourceId = meta.linkedGeoResourceId;
            if (meta?.stockResourceId && !r.stockResourceId) r.stockResourceId = meta.stockResourceId;
            if (meta?.icon && !r.icon) r.icon = meta.icon;
        }
    }
    const nodes = body?.data?.groundResourceNodes;
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
        if (!n || !n.resourceId) continue;
        const nid = n.id || `node_${n.resourceId}_${n.lon}_${n.lat}`;
        const existing = entry.resources.find(r => r.id === nid);
        if (existing) {
            // синхронизация координат из JSON тела
            if (Number.isFinite(Number(n.lon))) existing.lon = Number(n.lon);
            if (Number.isFinite(Number(n.lat))) existing.lat = Number(n.lat);
            continue;
        }
        const meta = resourceMeta(n.resourceId);
        entry.resources.push({
            id: nid,
            resourceId: n.resourceId,
            lon: Number(n.lon),
            lat: Number(n.lat),
            name: locName(meta?.name, n.resourceId),
            linkedGeoResourceId: meta?.linkedGeoResourceId || n.linkedGeoResourceId || null,
            stockResourceId: meta?.stockResourceId || n.stockResourceId || null,
            complexity: Number(meta?.complexity) || 1,
            baseYieldKgPerPerson: Number(meta?.baseYieldKgPerPerson) || 50,
            mineHoursBase: Number(meta?.mineHoursBase) || 3
        });
    }
}

function findResourceNode(entry, nodeId) {
    return (entry?.resources || []).find(r => r.id === nodeId) || null;
}

function findNearestNode(entry, lon, lat, maxKm = 15) {
    if (!entry?.resources?.length || !currentBody) return null;
    let best = null;
    let bestD = Infinity;
    for (const r of entry.resources) {
        const d = distanceKm(currentBody, lon, lat, r.lon, r.lat);
        if (d < bestD) { bestD = d; best = r; }
    }
    return bestD <= maxKm ? best : null;
}

/** Расчёт цикла добычи: туда + работа + обратно */
function calcMineCycle(body, fromLon, fromLat, node, people) {
    const meta = unitMeta('GUNIT_EXPEDITIONER');
    const speed = Number(meta?.speedKmh) || 5.5;
    const n = Math.max(1, people | 0);
    const complexity = Math.max(0.1, Number(node.complexity) || 1);
    const dist = distanceKm(body, fromLon, fromLat, node.lon, node.lat);
    // обратно на базу
    const baseLon = BASE_LON;
    const baseLat = BASE_LAT;
    const distBack = distanceKm(body, node.lon, node.lat, baseLon, baseLat);
    const travelHours = (dist + distBack) / Math.max(0.1, speed);
    // больше людей чуть ускоряют выработку
    const mineHours = (Number(node.mineHoursBase) || 3) * complexity / (1 + 0.12 * (n - 1));
    const yieldKg = Math.floor((Number(node.baseYieldKgPerPerson) || 50) / complexity * n);
    return {
        travelHours,
        mineHours,
        cycleHours: travelHours + mineHours,
        yieldKg: Math.max(1, yieldKg),
        distToNode: dist,
        distBack
    };
}

export async function loadCartographyCatalogs() {
    try {
        const [u, r, s, g] = await Promise.all([
            fetch('groundUnits.json').then(x => x.json()),
            fetch('groundResources.json').then(x => x.json()),
            fetch('groundStructures.json').then(x => x.json()),
            fetch('geoResources.json').then(x => x.json()).catch(() => [])
        ]);
        catalogs.units = u || [];
        catalogs.resources = r || [];
        catalogs.structures = s || [];
        catalogs.geo = Array.isArray(g) ? g : [];
    } catch (e) {
        console.warn('cartography catalogs', e);
    }
}

function unitMeta(id) {
    return catalogs.units.find(x => x.id === id) || catalogs.units[0];
}
function structMeta(id) {
    return catalogs.structures.find(x => x.id === id);
}
function geoMeta(id) {
    return catalogs.geo.find(x => x.id === id) || null;
}

/** Всего назначено специалистов-экспедиционеров на теле */
function totalExpeditioners(body) {
    try {
        const id = Number(body?.data?.id ?? body?.id);
        if (!Number.isFinite(id)) return 0;
        const s = getLocationSpecialists(id);
        return Math.max(0, Math.floor(Number(s?.expeditioners) || 0));
    } catch (_) {
        return 0;
    }
}

/** Сколько уже в отрядах на 2D-карте */
function deployedExpeditioners(entry) {
    if (!entry?.units) return 0;
    return entry.units.reduce((sum, u) => sum + Math.max(0, Number(u.count) || 1), 0);
}

/**
 * Свободные на базе = всего специалистов − сумма всех отрядов на карте.
 * Можно параллельно слать сколько угодно отрядов, пока free > 0.
 */
function freeExpeditioners(body) {
    if (!body) return 0;
    const entry = ensureBodyCartography(body);
    return Math.max(0, totalExpeditioners(body) - deployedExpeditioners(entry));
}

/**
 * Если специалистов урезали (вплоть до 0): безвозвратно снимаем отряды на карте
 * пока deployed <= total. Возвращает true, если список отрядов изменился.
 */
function reconcileExpeditionerPool(body) {
    if (!body) return false;
    const entry = ensureBodyCartography(body);
    if (!entry.units) entry.units = [];
    const total = totalExpeditioners(body);
    let deployed = deployedExpeditioners(entry);
    if (deployed <= total) return false;

    let excess = deployed - total;
    let changed = false;
    for (let i = entry.units.length - 1; i >= 0 && excess > 0; i--) {
        const u = entry.units[i];
        const c = Math.max(0, Math.floor(Number(u.count) || 0));
        if (c <= 0) {
            entry.units.splice(i, 1);
            changed = true;
            if (selectedTarget?.type === 'unit' && selectedTarget.id === u.id) selectedTarget = null;
            continue;
        }
        if (c <= excess) {
            excess -= c;
            entry.units.splice(i, 1);
            changed = true;
            if (selectedTarget?.type === 'unit' && selectedTarget.id === u.id) selectedTarget = null;
        } else {
            u.count = c - excess;
            excess = 0;
            changed = true;
            if (selectedTarget?.type === 'unit' && selectedTarget.id === u.id) {
                selectedTarget.meta = u;
                const um = unitMeta(u.unitId);
                selectedTarget.label = `${locName(um?.name, 'unit')} ×${u.count || 1}`;
            }
        }
    }
    // страховка: total=0 → карта без отрядов
    if (total <= 0 && entry.units.length) {
        entry.units.length = 0;
        if (selectedTarget?.type === 'unit') selectedTarget = null;
        changed = true;
    }
    return changed;
}

function buildMarkers(body, entry) {
    const list = [];
    for (const st of entry.structures || []) {
        const meta = structMeta(st.structureId);
        list.push({
            type: 'structure',
            id: st.id,
            lon: st.lon,
            lat: st.lat,
            label: locName(meta?.name, meta?.id || 'base'),
            meta: st
        });
    }
    for (const u of entry.units || []) {
        const meta = unitMeta(u.unitId);
        list.push({
            type: 'unit',
            id: u.id,
            lon: u.lon,
            lat: u.lat,
            label: `${locName(meta?.name, 'unit')} ×${u.count || 1}`,
            meta: u,
            icon: meta?.icon || null
        });
    }
    for (const r of entry.resources || []) {
        const meta = resourceMeta(r.resourceId);
        const g = geoMeta(r.linkedGeoResourceId || meta?.linkedGeoResourceId);
        list.push({
            type: 'resource',
            id: r.id,
            lon: r.lon,
            lat: r.lat,
            label: r.name || locName(g?.name || meta?.name, r.resourceId),
            meta: r,
            // иконка из geoResources (приоритет), иначе groundResources
            icon: g?.icon || meta?.icon || null
        });
    }
    const seen = new Set();
    return list.filter(m => {
        const k = `${m.type}:${m.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function applyVision(body, entry) {
    resetFogFull();
    for (const st of entry.structures || []) {
        const meta = structMeta(st.structureId);
        const r = Number(meta?.actionRadiusKm) || BASE_VISION_KM;
        revealFog(body, st.lon, st.lat, r);
    }
    for (const u of entry.units || []) {
        const meta = unitMeta(u.unitId);
        const r = Number(meta?.visionRadiusKm) || 25;
        revealFog(body, u.lon, u.lat, r);
    }
    if (entry.fogData) {
        // fogData is authoritative if present after first reveal; re-apply vision on top
        // actually vision already cleared — import saved fog then re-reveal bases
    }
}

function leftMsOfUnit(u) {
    if (!u || !u.moving) return 0;
    return Math.max(0, (u.durationMs || 0) - (u.progressMs || 0));
}

/** Остаток длительности: чч:мм:сс или Nд чч:мм:сс */
function formatDuration(hours) {
    const totalSec = Math.max(0, Math.floor(Number(hours) * 3600));
    return formatDurationMs(totalSec * 1000);
}

function formatDurationMs(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = n => String(n).padStart(2, '0');
    if (days > 0) return `${days}д ${pad(h)}:${pad(m)}:${pad(s)}`;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Абсолютное внутриигровое время завершения: чч:мм:сс дд.мм.гггг */
function formatCompleteAt(msFromNow) {
    const pad = n => String(n).padStart(2, '0');
    try {
        const base = (startTime instanceof Date) ? startTime.getTime() : Date.now();
        const d = new Date(base + Math.max(0, msFromNow));
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    } catch (_) {
        return '—';
    }
}

function formatRemainingFromUnit(u) {
    if (!u || !u.moving) return null;
    return formatDurationMs(leftMsOfUnit(u));
}

function formatCompleteAtFromUnit(u) {
    if (!u || !u.moving) return null;
    return formatCompleteAt(leftMsOfUnit(u));
}

/** Оставшаяся дистанция км (линейно по progress) */
function remainingDistanceKm(u) {
    if (!u || !u.moving) return null;
    const total = Number(u.distanceKm);
    if (Number.isFinite(total) && total >= 0) {
        const p = Math.min(1, Math.max(0, (u.progressMs || 0) / Math.max(1, u.durationMs || 1)));
        return Math.max(0, total * (1 - p));
    }
    // fallback: haversine до цели
    if (u.toLon != null && currentBody) {
        return distanceKm(currentBody, u.lon, u.lat, u.toLon, u.toLat);
    }
    return null;
}

function formatDistKm(km) {
    if (!Number.isFinite(km)) return '—';
    if (km < 1) return `${Math.round(km * 1000)} м`;
    if (km < 10) return `${km.toFixed(1)} км`;
    return `${Math.round(km)} км`;
}

function refreshCoordsHud() {
    const v = getMapView();
    const el = $('carto-coords');
    if (el) {
        // курсор вне карты — getMapView хранит последние координаты внутри
        el.textContent = `${v.cursorLat.toFixed(2)}° / ${v.cursorLon.toFixed(2)}°`;
    }
    const fogEl = $('carto-fog-pct');
    if (fogEl) {
        let fogPct = 0;
        try { fogPct = getFogRevealedPercent(); } catch (_) {}
        const prefix = t('carto.mapRevealed') || 'Карта раскрыта на';
        fogEl.textContent = `${prefix}: ${fogPct.toFixed(0)}%`;
    }
    try { refreshCartographyHud(currentBody); } catch (_) {}
}

function viewZoomLabel() {
    try {
        return getMapView().zoom?.toFixed?.(1) || '1.0';
    } catch (_) { return '1.0'; }
}

/** Свободные/всего: база = пул специалистов; отряд = люди в отряде (для сплита) */
function poolDisplayForSelection() {
    if (selectedTarget?.type === 'unit') {
        const c = Math.max(0, Number(selectedTarget.meta?.count) || 1);
        return { free: c, total: c, maxAssign: c };
    }
    const free = freeExpeditioners(currentBody);
    const total = totalExpeditioners(currentBody);
    return { free, total, maxAssign: free };
}

function liveUpdateFreeTotal() {
    if (!currentBody) return;
    const freeEl = $('carto-free-exp');
    if (!freeEl) return;
    const formEl = $('carto-form');
    if (formEl && formEl.style.display === 'none') return;
    const pool = poolDisplayForSelection();
    freeEl.textContent = `${pool.free} / ${pool.total}`;
    const countInp = $('carto-assign-count');
    if (countInp && (selectedTarget?.type === 'structure' || selectedTarget?.type === 'unit')) {
        const maxAssign = pool.maxAssign;
        countInp.max = String(Math.max(0, maxAssign));
        let v = Number(countInp.value) || 0;
        if (maxAssign >= 1) {
            assignCount = Math.max(1, Math.min(maxAssign, v || 1));
            countInp.value = String(assignCount);
            countInp.disabled = false;
        } else {
            assignCount = 0;
            countInp.value = '0';
            countInp.disabled = true;
        }
        const startBtn = $('carto-start-btn');
        if (startBtn) {
            const okPeople = assignCount >= 1 && assignCount <= maxAssign;
            if (expeditionType === 'mine') {
                startBtn.disabled = !(okPeople && pendingNodeId && pendingCoords);
            } else {
                startBtn.disabled = !(okPeople && pendingCoords);
            }
        }
    }
}

function formatGeoAmount(v) {
    const n = Number(v) || 0;
    if (n >= 1e12) return (n / 1e12).toFixed(2) + ' трлн т';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' млрд т';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' млн т';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + ' тыс. т';
    return n.toFixed(1) + ' т';
}

function renderNodeCard(entry) {
    const card = $('carto-node-card');
    if (!card) return;
    const nodeId = focusedNodeId || pendingNodeId;
    if (!nodeId || !entry) {
        card.style.display = 'none';
        card.innerHTML = '';
        return;
    }
    const node = findResourceNode(entry, nodeId);
    if (!node) {
        card.style.display = 'none';
        card.innerHTML = '';
        return;
    }
    const gMeta = geoMeta(node.linkedGeoResourceId);
    const gId = node.linkedGeoResourceId;
    const dep = currentBody?.data?.geoDeposits?.[gId];
    const cur = dep ? Number(dep.current) || 0 : 0;
    const max = dep ? Number(dep.max) || 0 : 0;
    // geoDeposits.current = остаток, max = исходный максимум
    const leftPct = max > 0 ? Math.min(100, (cur / max) * 100) : 0;
    const extractedPct = max > 0 ? Math.min(100, ((max - cur) / max) * 100) : 0;
    const icon = gMeta?.icon || resourceMeta(node.resourceId)?.icon || '';
    const title = locName(gMeta?.name, node.name || node.resourceId);
    const symbol = gMeta?.symbol || '';
    const desc = locName(gMeta?.description, '') || locName(resourceMeta(node.resourceId)?.description, '');
    card.style.display = 'block';
    card.innerHTML = `
        <div class="carto-node-top">
            ${icon ? `<img class="carto-node-icon" src="${icon}" alt="">` : ''}
            <div class="carto-node-title-wrap">
                <div class="carto-node-title">${title}</div>
                <div class="carto-node-coords">${node.lat.toFixed(2)}° , ${node.lon.toFixed(2)}°</div>
            </div>
            ${symbol ? `<span class="carto-node-symbol">${symbol}</span>` : ''}
        </div>
        <div class="carto-node-lines">
            <div>[${extractedPct.toFixed(0)}% / 100%]</div>
            <div>${formatGeoAmount(cur)} / ${formatGeoAmount(max)}</div>
            <div class="carto-node-rem">${t('geo.remaining') || 'Осталось'}: ${formatGeoAmount(cur)}</div>
        </div>
        ${desc ? `<div class="carto-node-desc">${desc}</div>` : ''}
    `;
}

function unitIsOnMission(u) {
    return !!(u && (u.mission || u.moving));
}

/** Режим панели: node | unitMission | unitIdle | base | none */
function panelMode() {
    const hasNode = !!focusedNodeId;
    const isUnit = selectedTarget?.type === 'unit';
    const isStruct = selectedTarget?.type === 'structure';
    // осмотр ноды — только геоданные + связанные экспедиции, без формы
    if (hasNode) return 'node';
    if (isUnit && unitIsOnMission(selectedTarget.meta)) return 'unitMission';
    if (isUnit) return 'unitIdle';
    if (isStruct) return 'base';
    return 'none';
}

function expeditionTypeOptions() {
    const opts = [
        { id: 'scout', label: t('carto.mission.scout') || 'Разведка' },
        { id: 'mine', label: t('carto.mission.mine') || 'Добыча' }
    ];
    // С базы «вернуться на базу» бессмысленно
    if (selectedTarget?.type !== 'structure') {
        opts.push({ id: 'return', label: t('carto.mission.return') || 'Вернуться на базу' });
    }
    return opts;
}

function ensureTypeSelect() {
    const host = $('carto-exp-type');
    if (!host || typeSelectApi) return typeSelectApi;
    typeSelectApi = createFirmSelect(host, {
        options: expeditionTypeOptions(),
        value: expeditionType,
        placeholder: '—',
        onChange(v) {
            expeditionType = v || 'scout';
            refreshActionsPanel();
        }
    });
    return typeSelectApi;
}

function syncTypeSelect() {
    ensureTypeSelect();
    if (!typeSelectApi) return;
    const opts = expeditionTypeOptions();
    typeSelectApi.setOptions(opts);
    if (!opts.some(o => o.id === expeditionType)) expeditionType = opts[0]?.id || 'scout';
    typeSelectApi.setValue(expeditionType);
}

function collectUnitPaths(entry) {
    const list = [];
    for (const u of entry?.units || []) {
        if (!u) continue;
        if (u.mission === 'mine') {
            if (u.minePhase === 'toNode' || u.minePhase === 'toBase') {
                if (u.toLon != null && u.toLat != null) {
                    list.push({
                        from: { lon: u.lon, lat: u.lat },
                        to: { lon: u.toLon, lat: u.toLat },
                        style: 'mine'
                    });
                }
            } else if (u.minePhase === 'mining') {
                const node = findResourceNode(entry, u.targetNodeId);
                if (node) {
                    list.push({
                        from: { lon: u.lon, lat: u.lat },
                        to: { lon: node.lon, lat: node.lat },
                        style: 'mine'
                    });
                }
            }
            continue;
        }
        if (u.moving && u.toLon != null && u.toLat != null) {
            list.push({
                from: { lon: u.lon, lat: u.lat },
                to: { lon: u.toLon, lat: u.toLat },
                style: u.mission === 'return' ? 'return' : 'scout'
            });
        }
    }
    return list;
}

function setExpListTitle(mode) {
    const title = $('carto-exp-list-title');
    if (!title) return;
    if (mode === 'node' || mode === 'unitMission') {
        title.textContent = t('carto.linkedExpedition') || 'Связанная экспедиция';
    } else {
        title.textContent = t('carto.activeList') || 'Активные экспедиции';
    }
}

function refreshActionsPanel() {

    const entry = currentBody ? ensureBodyCartography(currentBody) : null;
    if (entry) reconcileExpeditionerPool(currentBody);

    const emptyEl = $('carto-empty-hint');
    const formEl = $('carto-form');
    const mode = panelMode();
    const hasSel = mode === 'unitIdle' || mode === 'base' || mode === 'unitMission';
    const hasNode = mode === 'node' || !!(focusedNodeId || pendingNodeId);

    if (emptyEl) emptyEl.style.display = (mode === 'none') ? 'block' : 'none';

    // форма: база, свободный отряд ИЛИ отряд в миссии (данные юнита)
    const showForm = !focusedNodeId && (mode === 'base' || mode === 'unitIdle' || mode === 'unitMission');
    if (formEl) formEl.style.display = showForm ? 'flex' : 'none';

    // блок назначения новой миссии — только база / свободный отряд
    const assignBlock = $('carto-assign-block');
    if (assignBlock) assignBlock.style.display = (mode === 'base' || mode === 'unitIdle') ? '' : 'none';

    renderNodeCard(entry);
    setExpListTitle(mode);
    renderExpeditionsList(entry, mode);

    if (!showForm) {
        syncPathForSelection();
        return;
    }

    // актуальный meta отряда из entry (движение на карте)
    if (selectedTarget?.type === 'unit' && entry) {
        const live = (entry.units || []).find(x => String(x.id) === String(selectedTarget.id));
        if (live) {
            selectedTarget.meta = live;
            selectedTarget.lon = live.lon;
            selectedTarget.lat = live.lat;
            const um = unitMeta(live.unitId);
            selectedTarget.label = `${locName(um?.name, 'unit')} ×${live.count || 1}`;
        }
    }

    const pool = poolDisplayForSelection();
    const freeEl = $('carto-free-exp');
    if (freeEl) freeEl.textContent = `${pool.free} / ${pool.total}`;

    const selEl = $('carto-selection');
    if (selEl) selEl.textContent = selectedTarget?.label || selectedTarget?.id || '—';

    const remainRow = $('carto-remain-row');
    const remainEl = $('carto-remain-time');
    const completeRow = $('carto-complete-row');
    const completeEl = $('carto-complete-time');
    const speedRow = $('carto-speed-row');
    const speedEl = $('carto-speed');
    const distRow = $('carto-dist-row');
    const distEl = $('carto-dist');
    const uMeta = selectedTarget?.type === 'unit' ? selectedTarget.meta : null;
    const remainStr = uMeta?.moving ? formatRemainingFromUnit(uMeta) : null;
    const completeStr = uMeta?.moving ? formatCompleteAtFromUnit(uMeta) : null;
    if (remainRow) remainRow.style.display = remainStr ? 'flex' : 'none';
    if (remainEl) remainEl.textContent = remainStr || '—';
    if (completeRow) completeRow.style.display = completeStr ? 'flex' : 'none';
    if (completeEl) completeEl.textContent = completeStr || '—';

    // скорость / дистанция для выбранного юнита
    if (selectedTarget?.type === 'unit') {
        const um = unitMeta(uMeta?.unitId || selectedTarget.meta?.unitId);
        const spd = Number(um?.speedKmh) || Number(uMeta?.speedKmh) || 0;
        if (speedRow) speedRow.style.display = 'flex';
        if (speedEl) speedEl.textContent = spd > 0 ? `${spd} км/ч` : '—';
        const leftKm = remainingDistanceKm(uMeta);
        if (distRow) distRow.style.display = (leftKm != null) ? 'flex' : 'none';
        if (distEl) distEl.textContent = leftKm != null ? formatDistKm(leftKm) : '—';
    } else {
        if (speedRow) speedRow.style.display = 'none';
        if (distRow) distRow.style.display = 'none';
    }

    const cancelBtn = $('carto-cancel-btn');
    if (cancelBtn) {
        const canCancel = selectedTarget?.type === 'unit' && unitIsOnMission(selectedTarget.meta);
        cancelBtn.style.display = canCancel ? '' : 'none';
        cancelBtn.disabled = !canCancel;
    }

    // поля назначения — только если блок виден
    if (mode === 'base' || mode === 'unitIdle') {
        syncTypeSelect();
        if (typeSelectApi) {
            const v = typeSelectApi.getValue();
            if (v) expeditionType = v;
        }

        const countInp = $('carto-assign-count');
        let maxAssign = pool.maxAssign;
        if (countInp) {
            countInp.max = String(Math.max(0, maxAssign));
            countInp.min = maxAssign >= 1 ? '1' : '0';
            let v = Number(countInp.value);
            if (!Number.isFinite(v)) v = maxAssign >= 1 ? 1 : 0;
            assignCount = maxAssign >= 1
                ? Math.max(1, Math.min(maxAssign, v || 1))
                : 0;
            countInp.value = String(assignCount);
            countInp.disabled = maxAssign < 1;
        }

        const mineHintRow = $('carto-mine-hint-row');
        const mineHint = $('carto-mine-hint');
        const yieldRow = $('carto-yield-row');
        const yieldEl = $('carto-yield');
        const isMine = expeditionType === 'mine';
        if (mineHintRow) mineHintRow.style.display = isMine ? 'flex' : 'none';
        if (yieldRow) yieldRow.style.display = isMine ? 'flex' : 'none';
        if (isMine && pendingNodeId && mineHint) {
            const node = findResourceNode(entry, pendingNodeId);
            mineHint.textContent = node
                ? `${node.name || node.resourceId} (${node.lat.toFixed(2)}°, ${node.lon.toFixed(2)}°)`
                : '—';
        } else if (mineHint) {
            mineHint.textContent = isMine ? (t('carto.pickNode') || 'Кликните ноду на карте') : '—';
        }

        const coordEl = $('carto-target-coords');
        if (coordEl) {
            coordEl.textContent = pendingCoords
                ? `${pendingCoords.lat.toFixed(2)}° , ${pendingCoords.lon.toFixed(2)}°`
                : '—';
        }

        const timeEl = $('carto-travel-time');
        const startBtn = $('carto-start-btn');
        let canStart = false;
        if (pendingCoords && currentBody && entry && assignCount >= 1) {
            const from = getExpeditionOrigin(entry);
            if (from) {
                if (isMine && pendingNodeId) {
                    const node = findResourceNode(entry, pendingNodeId);
                    if (node) {
                        const cyc = calcMineCycle(currentBody, from.lon, from.lat, node, assignCount);
                        if (timeEl) timeEl.textContent = formatDuration(cyc.cycleHours);
                        if (yieldEl) yieldEl.textContent = `${cyc.yieldKg} кг`;
                        canStart = assignCount <= maxAssign;
                    }
                } else if (!isMine) {
                    const dist = distanceKm(currentBody, from.lon, from.lat, pendingCoords.lon, pendingCoords.lat);
                    const meta = unitMeta('GUNIT_EXPEDITIONER');
                    const speed = Number(meta?.speedKmh) || 5.5;
                    const hours = dist / Math.max(0.1, speed);
                    if (timeEl) timeEl.textContent = formatDuration(hours);
                    canStart = assignCount <= maxAssign;
                }
            }
        } else if (timeEl) {
            timeEl.textContent = '—';
            if (yieldEl) yieldEl.textContent = '—';
        }
        const coordsBtn = $('carto-set-coords');
        if (coordsBtn) coordsBtn.style.display = isMine ? 'none' : '';
        if (startBtn) {
            startBtn.style.display = isMine ? 'none' : '';
            if (!isMine) startBtn.disabled = !canStart;
        }
    }

    syncPathForSelection();
}

function getExpeditionOrigin(entry) {
    // только явный выбор: отряд или база
    if (selectedTarget?.type === 'unit') {
        const live = (entry.units || []).find(x => x.id === selectedTarget.id);
        if (live) {
            selectedTarget.meta = live;
            return { lon: live.lon, lat: live.lat, unit: live };
        }
        return null;
    }
    if (selectedTarget?.type === 'structure') {
        const st = (entry.structures || []).find(x => x.id === selectedTarget.id)
            || selectedTarget.meta;
        if (st) return { lon: st.lon, lat: st.lat, structure: st };
    }
    return null;
}

function minePhaseLabel(phase) {
    if (phase === 'toNode') return t('carto.phase.toNode') || 'К месторождению';
    if (phase === 'mining') return t('carto.phase.mining') || 'Добыча на месте';
    if (phase === 'toBase') return t('carto.phase.toBase') || 'Возврат на базу';
    return phase || '';
}

function renderExpeditionsList(entry, mode = null) {
    const box = $('carto-exp-list');
    if (!box) return;
    mode = mode || panelMode();
    let units = (entry?.units || []).filter(u => u.moving || u.mission);

    if (mode === 'unitMission' || mode === 'unitIdle') {
        // связанная с выбранным отрядом
        units = units.filter(u => String(u.id) === String(selectedTarget?.id));
    } else if (mode === 'node') {
        // связанные с этой нодой (targetNodeId)
        const nid = String(focusedNodeId || pendingNodeId || '');
        units = units.filter(u => String(u.targetNodeId || '') === nid);
    }
    // base | none → все активные

    if (!units.length) {
        const emptyMsg = (mode === 'node' || mode === 'unitMission')
            ? (t('carto.noLinked') || 'Нет связанной экспедиции')
            : (t('carto.noActive') || 'Нет активных экспедиций');
        box.innerHTML = `<div class="carto-empty">${emptyMsg}</div>`;
        return;
    }
    box.innerHTML = units.map(u => {
        const meta = unitMeta(u.unitId);
        const left = u.moving ? formatRemainingFromUnit(u) : '';
        const complete = u.moving ? formatCompleteAtFromUnit(u) : '';
        let missionLabel = t('carto.mission.scout') || 'Разведка';
        let missionClass = 'scout';
        if (u.mission === 'return') {
            missionLabel = t('carto.mission.return') || 'Возврат';
            missionClass = 'return';
        } else if (u.mission === 'mine') {
            missionLabel = t('carto.mission.mine') || 'Добыча';
            missionClass = 'mine';
        }
        const phaseTxt = u.mission === 'mine' && u.minePhase
            ? minePhaseLabel(u.minePhase)
            : (u.moving ? (t('carto.phase.enRoute') || 'В пути') : (t('carto.phase.idle') || 'На месте'));
        const speed = Number(meta?.speedKmh) || 0;
        const leftKm = remainingDistanceKm(u);
        const cargo = u.cargoKg > 0
            ? `<div class="carto-exp-meta">${t('carto.cargo') || 'Груз'}: ${Math.floor(u.cargoKg)} кг</div>`
            : '';
        // ресурс добычи
        let resourceLine = '';
        if (u.mission === 'mine') {
            const node = findResourceNode(entry, u.targetNodeId);
            const rid = node?.resourceId || u.resourceId || u.stockResourceId;
            const rMeta = resourceMeta(rid) || (catalogs.geo || []).find(g => g.id === (node?.linkedGeoResourceId || u.linkedGeoResourceId));
            const rName = rMeta ? locName(rMeta.name, rMeta.id || 'res') : (rid || '');
            if (rName) {
                resourceLine = `<div class="carto-exp-meta">${t('carto.miningRes') || 'Ресурс'}: ${rName}</div>`;
            }
            if (u.plannedYieldKg) {
                resourceLine += `<div class="carto-exp-meta">${t('carto.yield') || 'За цикл'}: ~${u.plannedYieldKg} кг</div>`;
            }
        }
        const spdLine = speed > 0
            ? `<div class="carto-exp-meta">${t('carto.speed') || 'Скорость'}: ${speed} км/ч</div>`
            : '';
        const distLine = leftKm != null
            ? `<div class="carto-exp-meta">${t('carto.remainDist') || 'Осталось пути'}: ${formatDistKm(leftKm)}</div>`
            : '';
        const active = selectedTarget?.type === 'unit' && String(selectedTarget.id) === String(u.id) ? ' is-active' : '';
        const canCancel = u.moving || u.mission;
        return `<div class="carto-exp-card carto-exp-${missionClass}${active}" data-unit-id="${String(u.id)}" role="button" tabindex="0">
            <div class="carto-exp-card-top">
                <span class="carto-exp-name">${locName(meta?.name, 'unit')} ×${u.count || 1}</span>
                <span class="carto-exp-badge">${missionLabel}</span>
            </div>
            <div class="carto-exp-phase">${phaseTxt}</div>
            ${left ? `<div class="carto-exp-eta">${t('carto.remainTime') || 'Осталось'}: ${left}</div>` : ''}
            ${complete ? `<div class="carto-exp-eta carto-exp-complete">${t('carto.completeAt') || 'Будет выполнено'}: ${complete}</div>` : ''}
            ${spdLine}${distLine}${resourceLine}${cargo}
            ${canCancel ? `<button type="button" class="carto-exp-cancel" data-cancel-unit="${String(u.id)}">${t('carto.cancel') || 'Прервать'}</button>` : ''}
        </div>`;
    }).join('');

    // pointerdown — без задержки click
    box.querySelectorAll('.carto-exp-card[data-unit-id]').forEach((card) => {
        card.addEventListener('pointerdown', onExpCardPointer, { passive: false });
        card.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                selectUnitById(card.getAttribute('data-unit-id'));
            }
        });
    });
    box.querySelectorAll('[data-cancel-unit]').forEach((btn) => {
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = btn.getAttribute('data-cancel-unit');
            cancelExpeditionById(id);
        }, { passive: false });
    });
}

function onExpCardPointer(e) {
    if (e.button != null && e.button !== 0) return;
    // не перехватывать кнопку «Прервать»
    if (e.target?.closest?.('[data-cancel-unit]')) return;
    const card = e.currentTarget || e.target?.closest?.('.carto-exp-card[data-unit-id]');
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    selectUnitById(card.getAttribute('data-unit-id'));
}

function cancelExpeditionById(unitId) {
    if (!currentBody || !unitId) return;
    const entry = ensureBodyCartography(currentBody);
    const u = (entry.units || []).find(x => String(x.id) === String(unitId));
    if (!u) return;
    u.moving = false;
    u.mission = null;
    u.minePhase = null;
    u.cargoKg = 0;
    u.toLon = u.lon;
    u.toLat = u.lat;
    u.progressMs = u.durationMs;
    if (selectedTarget?.type === 'unit' && String(selectedTarget.id) === String(unitId)) {
        selectedTarget.meta = u;
    }
    setPathLine(null, null);
    refreshMarkers();
    refreshActionsPanel();
}

function selectUnitById(unitId) {
    if (unitId == null || unitId === '') return;
    // если currentBody ещё не выставлен — взять из state
    if (!currentBody) {
        currentBody = state.currentLocation || window.currentLocation || null;
    }
    if (!currentBody) return;
    const entry = ensureBodyCartography(currentBody);
    const uid = String(unitId);
    const u = (entry.units || []).find(x => String(x.id) === uid);
    if (!u) {
        console.warn('[carto] selectUnitById: unit not found', unitId, entry.units?.map(x => x.id));
        return;
    }
    const um = unitMeta(u.unitId);
    // как клик по маркеру юнита на карте
    selectedTarget = {
        type: 'unit',
        id: u.id,
        lon: u.lon,
        lat: u.lat,
        meta: u,
        label: `${locName(um?.name, 'unit')} ×${u.count || 1}`
    };
    focusedNodeId = null;
    pendingNodeId = null;
    pendingCoords = null;
    setPickMode(false);
    // центрировать карту на отряде, зум не сбрасываем
    try {
        const z = getMapView()?.zoom || 64;
        focusMapOn(u.lon, u.lat, z);
    } catch (_) {}
    syncPathForSelection();
    refreshMarkers();
    refreshActionsPanel();
}

function onPick(lon, lat) {
    pendingCoords = { lon, lat };
    setPickMode(false);
    const entry = ensureBodyCartography(currentBody);
    const from = getExpeditionOrigin(entry);
    if (from) setPathLine({ lon: from.lon, lat: from.lat }, pendingCoords, true);
    refreshActionsPanel();
}

function selectBaseStructure(entry) {
    const base = (entry?.structures || []).find(s => s.structureId === 'GSTRUCT_COSMISTS_BASE');
    if (!base) return;
    const meta = structMeta(base.structureId);
    selectedTarget = {
        type: 'structure',
        id: base.id,
        lon: base.lon,
        lat: base.lat,
        label: locName(meta?.name, meta?.id || 'base'),
        meta: base
    };
    pendingCoords = null;
    setPathLine(null, null);
    setPickMode(false);
    refreshMarkers();
    refreshActionsPanel();
}

function syncPathForSelection() {
    const entry = currentBody ? ensureBodyCartography(currentBody) : null;
    if (!entry || !selectedTarget) {
        setPathLine(null, null);
        return;
    }
    if (selectedTarget.type === 'unit') {
        const u = (entry.units || []).find(x => x.id === selectedTarget.id);
        if (u?.moving && u.toLon != null) {
            setPathLine(
                { lon: u.lon, lat: u.lat },
                { lon: u.toLon, lat: u.toLat },
                false // в пути — без пульса
            );
            return;
        }
    }
    if (pendingCoords) {
        const from = getExpeditionOrigin(entry);
        if (from) setPathLine({ lon: from.lon, lat: from.lat }, pendingCoords, true);
        else setPathLine(null, null);
        return;
    }
    setPathLine(null, null);
}

function onMarkerClick(m) {
    // Клик по ресурсной ноде — карточка геоданных; форма только если уже выбран отряд/база под добычу
    if (m.type === 'resource') {
        if (typeSelectApi) {
            const v = typeSelectApi.getValue();
            if (v) expeditionType = v;
        }
        const assigning = selectedTarget?.type === 'structure' || selectedTarget?.type === 'unit';
        // Добыча: клик по ноде сразу запускает экспедицию (без кнопки «Начать»)
        if (assigning && expeditionType === 'mine') {
            pendingNodeId = m.id;
            pendingCoords = { lon: m.lon, lat: m.lat };
            focusedNodeId = m.id;
            setPickMode(false);
            const ok = startExpedition();
            if (!ok) refreshActionsPanel();
            return;
        }
        if (isPickMode() && assigning) {
            pendingNodeId = m.id;
            pendingCoords = { lon: m.lon, lat: m.lat };
            focusedNodeId = m.id;
            setPickMode(false);
            const entry = ensureBodyCartography(currentBody);
            const from = getExpeditionOrigin(entry);
            if (from) setPathLine({ lon: from.lon, lat: from.lat }, pendingCoords, true);
            refreshActionsPanel();
            return;
        }
        // Осмотр ноды: только геоданные + связанные экспедиции
        focusedNodeId = m.id;
        pendingNodeId = m.id;
        pendingCoords = { lon: m.lon, lat: m.lat };
        selectedTarget = null;
        setPickMode(false);
        setPathLine(null, null);
        refreshActionsPanel();
        return;
    }
    selectedTarget = m;
    pendingCoords = null;
    pendingNodeId = null;
    focusedNodeId = null;
    setPickMode(false);
    syncPathForSelection();
    refreshActionsPanel();
}

/** Клик по пустой карте — сброс выбора */
export function onMapBackgroundClick() {
    if (typeof isPickMode === 'function' && isPickMode()) return;
    selectedTarget = null;
    pendingCoords = null;
    pendingNodeId = null;
    focusedNodeId = null;
    setPathLine(null, null);
    refreshActionsPanel();
}

function spawnOrSplitUnit(entry, from, count) {
    let unit = null;
    if (from.unit) {
        unit = from.unit;
        if ((unit.count || 1) > count) {
            unit.count -= count;
            unit = {
                id: `gun_${Date.now()}_${Math.floor(Math.random() * 1e5)}`,
                unitId: 'GUNIT_EXPEDITIONER',
                lon: from.unit.lon,
                lat: from.unit.lat,
                count,
                moving: false
            };
            entry.units.push(unit);
        }
    } else {
        const free = freeExpeditioners(currentBody);
        if (free < count) return null;
        const base = (entry.structures || []).find(s => s.structureId === 'GSTRUCT_COSMISTS_BASE')
            || from.structure;
        unit = {
            id: `gun_${Date.now()}_${Math.floor(Math.random() * 1e5)}`,
            unitId: 'GUNIT_EXPEDITIONER',
            lon: base?.lon ?? from.lon,
            lat: base?.lat ?? from.lat,
            count,
            moving: false
        };
        entry.units.push(unit);
    }
    return unit;
}

/**
 * Сдать груз на склад. Залежи (geoDeposits.current = остаток, т)
 * уже уменьшены во время фазы mining — здесь только склад.
 */
function deliverMineCargo(unit, entry, body = currentBody) {
    const data = body?.data;
    if (!data || !unit.cargoKg || unit.cargoKg <= 0) return;
    const node = findResourceNode(entry, unit.targetNodeId);
    const stockId = node?.stockResourceId || unit.stockResourceId || 'RES_ICE';
    const kg = Math.floor(unit.cargoKg);
    try {
        addResourceClamped(data.id, data, stockId, kg);
    } catch (e) {
        console.warn('mine deliver stock', e);
    }
    unit.cargoKg = 0;
}

/** Остаток залежи в кг (current в geoDeposits — тонны). */
function depositRemainingKg(body, geoId) {
    const dep = body?.data?.geoDeposits?.[geoId];
    if (!dep) return 0;
    return Math.max(0, (Number(dep.current) || 0) * 1000);
}

/** Списать из залежи кг; current хранится в тоннах. */
function drainDepositKg(body, geoId, kg) {
    if (!body?.data || !geoId || !(kg > 0)) return 0;
    if (!body.data.geoDeposits) body.data.geoDeposits = {};
    if (!body.data.geoDeposits[geoId]) {
        body.data.geoDeposits[geoId] = { current: 0, max: 0 };
    }
    const dep = body.data.geoDeposits[geoId];
    const haveKg = Math.max(0, (Number(dep.current) || 0) * 1000);
    const take = Math.min(haveKg, kg);
    dep.current = Math.max(0, (Number(dep.current) || 0) - take / 1000);
    return take;
}

function startMineCycleOnBody(unit, entry, node, body) {
    const b = body || currentBody;
    const cyc = calcMineCycle(b, unit.lon, unit.lat, node, unit.count || 1);
    const meta = unitMeta('GUNIT_EXPEDITIONER');
    const speed = Number(meta?.speedKmh) || 5.5;
    const dist = distanceKm(b, unit.lon, unit.lat, node.lon, node.lat);
    unit.mission = 'mine';
    unit.targetNodeId = node.id;
    unit.stockResourceId = node.stockResourceId;
    unit.linkedGeoResourceId = node.linkedGeoResourceId;
    unit.plannedYieldKg = cyc.yieldKg;
    unit.mineHours = cyc.mineHours;
    unit.cargoKg = 0;
    unit.minePhase = 'toNode';
    unit.moving = true;
    unit.fromLon = unit.lon;
    unit.fromLat = unit.lat;
    unit.toLon = node.lon;
    unit.toLat = node.lat;
    unit.departAt = performance.now();
    unit.progressMs = 0;
    unit.distanceKm = dist;
    unit.durationMs = (dist / Math.max(0.1, speed)) * 3600 * 1000;
    unit.targetStructureId = null;
}

function startMineCycle(unit, entry, node) {
    startMineCycleOnBody(unit, entry, node, currentBody);
}

function startExpedition() {
    if (!currentBody || !pendingCoords) return false;
    const entry = ensureBodyCartography(currentBody);
    reconcileExpeditionerPool(currentBody);
    const from = getExpeditionOrigin(entry);
    if (!from) return false;
    if (assignCount < 1) return false;

    if (expeditionType === 'mine') {
        if (!pendingNodeId) return false;
        const node = findResourceNode(entry, pendingNodeId);
        if (!node) return false;
        const unit = spawnOrSplitUnit(entry, from, assignCount);
        if (!unit) return false;
        startMineCycle(unit, entry, node);
        setPathLine(null, null);
        pendingCoords = null;
        // остаёмся на осмотре ноды — без формы отряда между геоданными и списком
        selectedTarget = null;
        focusedNodeId = node.id;
        pendingNodeId = node.id;
        refreshMarkers();
        try { setMissionPaths(collectUnitPaths(entry)); } catch (_) {}
        refreshActionsPanel();
        return true;
    }

    const meta = unitMeta('GUNIT_EXPEDITIONER');
    const speed = Number(meta?.speedKmh) || 5.5;
    const dist = distanceKm(currentBody, from.lon, from.lat, pendingCoords.lon, pendingCoords.lat);
    const durationMs = (dist / Math.max(0.1, speed)) * 3600 * 1000;

    const unit = spawnOrSplitUnit(entry, from, assignCount);
    if (!unit) return false;

    unit.moving = true;
    unit.mission = expeditionType === 'return' ? 'return' : 'scout';
    unit.fromLon = unit.lon;
    unit.fromLat = unit.lat;
    unit.toLon = pendingCoords.lon;
    unit.toLat = pendingCoords.lat;
    unit.departAt = performance.now();
    unit.progressMs = 0;
    unit.distanceKm = dist;
    unit.durationMs = durationMs;
    unit.targetStructureId = null;
    unit.minePhase = null;

    if (expeditionType === 'return') {
        const base = (entry.structures || []).find(s => s.structureId === 'GSTRUCT_COSMISTS_BASE');
        if (base) {
            unit.toLon = base.lon;
            unit.toLat = base.lat;
            unit.targetStructureId = base.id;
            const dist2 = distanceKm(currentBody, unit.fromLon, unit.fromLat, base.lon, base.lat);
            unit.distanceKm = dist2;
            unit.durationMs = (dist2 / Math.max(0.1, speed)) * 3600 * 1000;
            unit.progressMs = 0;
        }
    }

    setPathLine({ lon: unit.lon, lat: unit.lat }, { lon: unit.toLon, lat: unit.toLat }, false);
    pendingCoords = null;
    pendingNodeId = null;
    const um = unitMeta(unit.unitId);
    selectedTarget = {
        type: 'unit',
        id: unit.id,
        lon: unit.lon,
        lat: unit.lat,
        meta: unit,
        label: `${locName(um?.name, 'unit')} ×${unit.count || 1}`
    };
    refreshMarkers();
    try { setMissionPaths(collectUnitPaths(entry)); } catch (_) {}
    refreshActionsPanel();
    return true;
}

function cancelExpedition() {
    const entry = ensureBodyCartography(currentBody);
    const stopOne = (u) => {
        if (!u) return;
        if (u.mission === 'scout' || u.mission === 'mine') {
            u.moving = false;
            u.mission = null;
            u.minePhase = null;
            u.cargoKg = 0;
            u.toLon = u.lon;
            u.toLat = u.lat;
            u.progressMs = u.durationMs;
        }
    };
    if (selectedTarget?.type === 'unit') {
        const u = (entry.units || []).find(x => x.id === selectedTarget.id);
        stopOne(u);
    } else {
        for (const u of entry.units || []) stopOne(u);
    }
    setPathLine(null, null);
    refreshMarkers();
    refreshActionsPanel();
}

function refreshMarkers() {
    if (!currentBody) return;
    const entry = ensureBodyCartography(currentBody);
    setMarkers(buildMarkers(currentBody, entry));
}

function resolveBodyForCartography(locationId) {
    const id = Number(locationId);
    const cb = state.celestialBodies?.[id];
    if (cb) return cb;
    // fallback-объект с data
    if (currentBody && Number(currentBody?.data?.id ?? currentBody?.id) === id) return currentBody;
    return { id, data: { id, diameterKm: id === 3 ? 12742 : 10000 } };
}

/**
 * Симуляция юнитов/добычи для одного тела (работает и с закрытой панелью).
 * @returns {{ changed: boolean, minePaths: Array }}
 */
function tickBodyCartographyUnits(body, entry, frameMs, speedMul) {
    let changed = false;
    const minePaths = [];
    if (!body || !entry) return { changed, minePaths };

    // пул специалистов — даже в фоне
    if (reconcileExpeditionerPool(body)) changed = true;

    for (const u of entry.units || []) {
        if (!u.moving) continue;
        if (u.progressMs == null) u.progressMs = 0;
        const prevProg = u.progressMs;
        u.progressMs += frameMs * speedMul;
        const dur = Math.max(1, u.durationMs || 1);
        if (!Number.isFinite(u.fromLon)) u.fromLon = u.lon;
        if (!Number.isFinite(u.fromLat)) u.fromLat = u.lat;
        if (!Number.isFinite(u.toLon) || !Number.isFinite(u.toLat)) {
            u.moving = false;
            continue;
        }

        // непрерывная добыча: груз + списание залежи в фазе mining
        if (u.mission === 'mine' && u.minePhase === 'mining') {
            const node = findResourceNode(entry, u.targetNodeId);
            const geoId = node?.linkedGeoResourceId || u.linkedGeoResourceId || 'GEO_ICE';
            const planned = Number(u.plannedYieldKg) || 0;
            const dFrac = (Math.min(u.progressMs, dur) - Math.min(prevProg, dur)) / dur;
            if (dFrac > 0 && planned > 0) {
                const wantKg = planned * dFrac;
                const took = drainDepositKg(body, geoId, wantKg);
                u.cargoKg = (Number(u.cargoKg) || 0) + took;
                // если залежь исчерпана — обрезаем цикл добычи
                if (took + 1e-9 < wantKg && depositRemainingKg(body, geoId) <= 0) {
                    u.progressMs = dur;
                    u.plannedYieldKg = u.cargoKg; // фактический урожай
                }
                changed = true;
            }
        }

        const tfrac = Math.min(1, u.progressMs / dur);
        u.lon = u.fromLon + (u.toLon - u.fromLon) * tfrac;
        u.lat = u.fromLat + (u.toLat - u.fromLat) * tfrac;
        if (panelVisible && body === currentBody) {
            try {
                const meta = unitMeta(u.unitId);
                revealFog(body, u.lon, u.lat, Number(meta?.visionRadiusKm) || 25);
            } catch (_) {}
        }
        changed = true;
        if (tfrac < 1) continue;

        u.lon = u.toLon;
        u.lat = u.toLat;
        u.moving = false;

        if (u.mission === 'mine') {
            const node = findResourceNode(entry, u.targetNodeId);
            const base = (entry.structures || []).find(s => s.structureId === 'GSTRUCT_COSMISTS_BASE');
            const meta = unitMeta('GUNIT_EXPEDITIONER');
            const speed = Number(meta?.speedKmh) || 5.5;
            if (u.minePhase === 'toNode') {
                u.minePhase = 'mining';
                u.moving = true;
                u.fromLon = u.lon;
                u.fromLat = u.lat;
                u.toLon = u.lon;
                u.toLat = u.lat;
                u.progressMs = 0;
                u.distanceKm = 0;
                u.cargoKg = 0;
                u.durationMs = Math.max(1000, (Number(u.mineHours) || 3) * 3600 * 1000);
            } else if (u.minePhase === 'mining') {
                // cargo уже накоплен при continuous drain
                u.minePhase = 'toBase';
                if (base) {
                    const distB = distanceKm(body, u.lon, u.lat, base.lon, base.lat);
                    u.moving = true;
                    u.fromLon = u.lon;
                    u.fromLat = u.lat;
                    u.toLon = base.lon;
                    u.toLat = base.lat;
                    u.progressMs = 0;
                    u.distanceKm = distB;
                    u.durationMs = (distB / Math.max(0.1, speed)) * 3600 * 1000;
                    u.targetStructureId = base.id;
                } else {
                    // некуда везти — сразу на склад локации
                    deliverMineCargo(u, entry, body);
                    u.mission = null;
                    u.minePhase = null;
                }
            } else if (u.minePhase === 'toBase') {
                deliverMineCargo(u, entry, body);
                if (node && depositRemainingKg(body, node.linkedGeoResourceId || u.linkedGeoResourceId) > 0) {
                    startMineCycleOnBody(u, entry, node, body);
                } else {
                    u.mission = null;
                    u.minePhase = null;
                }
            }
        } else if (u.mission === 'return' && u.targetStructureId) {
            const wasSelected = panelVisible && selectedTarget?.type === 'unit' && selectedTarget.id === u.id;
            entry.units = entry.units.filter(x => x.id !== u.id);
            if (wasSelected) selectBaseStructure(entry);
            u.mission = null;
        } else {
            u.mission = null;
        }
    }
    minePaths.push(...collectUnitPaths(entry));
    return { changed, minePaths };
}

/** call from main loop — всегда, не только при открытой карте */
export function tickCartography(dtMs) {
    let speedMul = 1;
    try {
        speedMul = Number(uiTimeSpeed);
        if (!Number.isFinite(speedMul) || speedMul < 0) speedMul = 1;
    } catch (_) { speedMul = 1; }
    const frameMs = Math.max(0, Number(dtMs) || 16);

    const map = getCartographyMap();
    let allMinePaths = [];
    let uiBodyChanged = false;

    for (const locId of Object.keys(map)) {
        const entry = map[locId];
        if (!entry) continue;
        const body = resolveBodyForCartography(locId);
        if (state.celestialBodies?.[Number(locId)]?.data) {
            body.data = state.celestialBodies[Number(locId)].data;
        }
        const { changed, minePaths } = tickBodyCartographyUnits(
            body, entry, frameMs, speedMul > 0 ? speedMul : 0
        );
        if (currentBody && String(currentBody?.data?.id ?? currentBody?.id) === String(locId)) {
            allMinePaths = allMinePaths.concat(minePaths.length ? minePaths : collectUnitPaths(entry));
            if (changed) uiBodyChanged = true;
        }
    }

    if (panelVisible) {
        try { setMissionPaths(allMinePaths); } catch (_) {}
        refreshCoordsHud();
        if (currentBody) {
            const entry = ensureBodyCartography(currentBody);
            const poolChanged = reconcileExpeditionerPool(currentBody);
            const anyMoving = (entry.units || []).some(u => u.moving || u.mission);
            if (poolChanged || uiBodyChanged || anyMoving) {
                refreshMarkers();
                if (selectedTarget?.type === 'unit') {
                    const live = (entry.units || []).find(x => x.id === selectedTarget.id);
                    if (!live) {
                        selectedTarget = null;
                    } else {
                        selectedTarget.meta = live;
                        selectedTarget.lon = live.lon;
                        selectedTarget.lat = live.lat;
                    }
                }
                refreshActionsPanel();
            } else {
                liveUpdateFreeTotal();
            }
            // preview маршрута только при выборе цели, не перекрываем векторы всех отрядов
            if (!pendingCoords) setPathLine(null, null);
        }
    }
}

export function showCartographyPanel(visible) {
    const panel = $('cartography-panel');
    if (!panel) return;
    panelVisible = !!visible;
    panel.style.display = visible ? 'flex' : 'none';
    if (!visible) {
        stopMapLoop();
        detachMap();
        setPickMode(false);
        currentBody = null;
        return;
    }

    const body = state.currentLocation || window.currentLocation;
    // currentLocation is often from ui module
    currentBody = body;
    // try import from ui if needed — caller passes via setCartographyBody
}

export async function openCartographyFor(body) {
    currentBody = body;
    const panel = $('cartography-panel');
    if (!panel) return;
    panelVisible = true;
    panel.style.display = 'flex';

    const entry = ensureBodyCartography(body);
    seedResourceNodes(body, entry);
    reconcileExpeditionerPool(body);
    const canvas = $('carto-canvas');
    const host = $('carto-map-host');
    if (canvas && host) {
        attachMap(canvas, host);
        await loadBodyTextures(body);
        // fog
        if (entry.fogData) importFogData(entry.fogData);
        else {
            resetFogFull();
            applyVision(body, entry);
        }
        // re-apply structure vision always
        for (const st of entry.structures || []) {
            const meta = structMeta(st.structureId);
            revealFog(body, st.lon, st.lat, Number(meta?.actionRadiusKm) || BASE_VISION_KM);
        }
        for (const u of entry.units || []) {
            const meta = unitMeta(u.unitId);
            revealFog(body, u.lon, u.lat, Number(meta?.visionRadiusKm) || 25);
        }
        refreshMarkers();
        setMarkerClickHandler(onMarkerClick);
        setBackgroundClickHandler(onMapBackgroundClick);
        resize();
        // по умолчанию 64× и центр на базе Космистов
        const base = (entry.structures || []).find(s => s.structureId === 'GSTRUCT_COSMISTS_BASE');
        if (base) {
            focusMapOn(base.lon, base.lat, 64);
        } else {
            focusMapOn(0, 0, 64);
        }
        startMapLoop();
    }
    refreshActionsPanel();
    refreshCoordsHud();
    try { refreshCartographyHud(body); } catch (_) {}
    refreshI18n(panel);
}

export function closeCartography() {
    if (currentBody) {
        const entry = ensureBodyCartography(currentBody);
        try { entry.fogData = exportFogData(); } catch (_) {}
    }
    showCartographyPanel(false);
}

function refreshI18n(root) {
    (root || document).querySelectorAll?.('[data-i18n]')?.forEach?.(node => {
        const key = node.getAttribute('data-i18n');
        if (key) node.textContent = t(key);
    });
}

export function initCartographyUI() {
    loadCartographyCatalogs();
    try { initCartographyHud(); } catch (_) {}
    try { ensureTypeSelect(); } catch (_) {}
    document.addEventListener('click', (e) => {
        if (e.target?.id === 'carto-set-coords') {
            const entry = currentBody ? ensureBodyCartography(currentBody) : null;
            const from = entry ? getExpeditionOrigin(entry) : null;
            if (!from) return;
            setPickMode(true, onPick, { lon: from.lon, lat: from.lat });
        }
        if (e.target?.id === 'carto-start-btn') startExpedition();
        if (e.target?.id === 'carto-cancel-btn') cancelExpedition();
    });
    document.addEventListener('change', (e) => {
        if (e.target?.id === 'carto-exp-type' || e.target?.id === 'carto-assign-count') {
            refreshActionsPanel();
        }
    });
    window.addEventListener('resize', () => { if (panelVisible) resize(); });
    try {
        onLanguageChange?.(() => {
            if (panelVisible) {
                refreshI18n($('cartography-panel'));
                refreshActionsPanel();
                refreshMarkers();
            }
        });
    } catch (_) {}
}

export function captureCartographySnapshot() {
    const map = getCartographyMap();
    // refresh fog for open body
    if (currentBody && panelVisible) {
        const e = ensureBodyCartography(currentBody);
        try { e.fogData = exportFogData(); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(map));
}

export function applyCartographySnapshot(snap) {
    state.locationCartography = snap && typeof snap === 'object' ? snap : {};
}
