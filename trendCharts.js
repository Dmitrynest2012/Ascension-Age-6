/**
 * Графики трендов — история складов / энергии / населения / технологий.
 *
 * API:
 *   openTrendCharts(sectionKey, opts?)
 *   closeTrendCharts()
 *   isTrendChartsOpen()
 *   tickTrendHistory(dtGameSec)
 *   captureTrendHistorySnapshot() / applyTrendHistorySnapshot(snap)
 */
import { state } from './state.js';
import { t, locName, onLanguageChange } from './settings.js';
import { getResourceMaxCapacity } from './resourceStorage.js';
import { createFirmSelect } from './firmSelect.js';
import { startTime, timeSpeed } from './ui.js';
import { formatEnergy, formatEnergyWh } from './functions.js';
import { currentLocation } from './camera.js';

const MAX_SERIES = 5;
const SAMPLE_INTERVAL_SEC = 2; // игровые секунды между точками (базово)
const ARCHIVE_AGE_MS = 365 * 24 * 3600 * 1000; // 1 игровой год
const ARCHIVE_STEP_MS = 30 * 24 * 3600 * 1000; // месяц

/** Палитра кривых (не повторяется в одном окне) */
const SERIES_COLORS = [
    '#2ec4ff', '#ff6b6b', '#51cf66', '#fcc419', '#cc5de8',
    '#20c997', '#ff922b', '#748ffc', '#f06595', '#15aabf'
];

/** Масштабы: длина окна просмотра в игровых мс */
const ZOOM_LEVELS = [
    { id: 'sec', ms: 60 * 1000, labelKey: 'trend.zoom.sec' },       // 1 мин
    { id: 'min', ms: 30 * 60 * 1000, labelKey: 'trend.zoom.min' },   // 30 мин
    { id: 'hour', ms: 6 * 3600 * 1000, labelKey: 'trend.zoom.hour' }, // 6 ч
    { id: 'day', ms: 3 * 24 * 3600 * 1000, labelKey: 'trend.zoom.day' },
    { id: 'week', ms: 21 * 24 * 3600 * 1000, labelKey: 'trend.zoom.week' },
    { id: 'month', ms: 120 * 24 * 3600 * 1000, labelKey: 'trend.zoom.month' },
    { id: 'year', ms: 5 * 365 * 24 * 3600 * 1000, labelKey: 'trend.zoom.year' }
];

const STOCK_SECTIONS = {
    'Сырье': 'raw',
    'Материалы': 'materials',
    'Компоненты': 'components',
    'Продукция': 'products',
    'Продовольствие': 'food'
};

const ENERGY_SERIES = [
    { id: 'energy:balance', i18n: 'res.popup.balance', cap: false },
    { id: 'energy:production', i18n: 'res.popup.production', cap: true },
    { id: 'energy:consumption', i18n: 'res.popup.consumption', cap: true },
    { id: 'energy:storage', i18n: 'res.popup.storage', cap: true },
    { id: 'energy:remain', i18n: 'res.popup.energyWillLast', cap: false }
];

const POP_SERIES = [
    { id: 'pop:total', i18n: 'pop.total', cap: true },
    { id: 'pop:homeless', i18n: 'pop.homeless', cap: false },
    { id: 'pop:settled', i18n: 'pop.housed', cap: true },
    { id: 'pop:idlers', i18n: 'spec.idlers', cap: true },
    { id: 'pop:creators', i18n: 'spec.creators', cap: false },
    { id: 'pop:engineers', i18n: 'spec.engineers', cap: true },
    { id: 'pop:agronomists', i18n: 'spec.agronomists', cap: true },
    { id: 'pop:scientists', i18n: 'spec.scientists', cap: true },
    { id: 'pop:expeditioners', i18n: 'spec.expeditioners', cap: true },
    { id: 'pop:dynamics', i18n: 'pop.dynamics', cap: false },
    { id: 'pop:birth', i18n: 'pop.birth', cap: false },
    { id: 'pop:death', i18n: 'pop.death', cap: false }
];

const TECH_SERIES = [
    { id: 'tech:rate', i18n: 'res.section.technologies', cap: false }
];

/** @type {Map<bodyId, Map<seriesId, {points: Array<{t:number,v:number,c?:number}>}>>} */
let historyStore = new Map();
let sampleAcc = 0;

let open = false;
let activeSection = 'Сырье';
let selectedIds = [];
/** UI state per section */
const uiState = Object.create(null); // section → { selected, zoomIdx, viewEndT }

let firmSelectApi = null;
let hoverX = null;
let animZoom = null; // { from, to, t0, dur, startView, targetView }
let rafId = 0;

function gameNowMs() {
    try {
        if (startTime instanceof Date) return startTime.getTime();
    } catch (_) {}
    return Date.now();
}

function currentBodyId() {
    const id = currentLocation?.data?.id;
    return id != null ? Number(id) : null;
}

function ensureBodyHist(bodyId) {
    if (!historyStore.has(bodyId)) historyStore.set(bodyId, new Map());
    return historyStore.get(bodyId);
}

function ensureSeries(bodyId, seriesId) {
    const m = ensureBodyHist(bodyId);
    if (!m.has(seriesId)) m.set(seriesId, { points: [] });
    return m.get(seriesId);
}

function resourceCatalog() {
    return globalThis.__resourceCatalog || new Map();
}

function getStockValue(bodyId, resourceId) {
    const body = state.celestialBodies?.[bodyId];
    const stock = body?.data?.resources?.stock || {};
    return Math.max(0, Number(stock[resourceId]) || 0);
}

function getStockCap(bodyId, resourceId) {
    try {
        return Math.max(0, Number(getResourceMaxCapacity(bodyId, resourceId)) || 0);
    } catch (_) {
        return 0;
    }
}

function sectionResourceOptions(sectionKey) {
    const key = STOCK_SECTIONS[sectionKey];
    if (!key) return [];
    const out = [];
    for (const [id, r] of resourceCatalog()) {
        if (r.resourceBarSection === key) {
            out.push({
                id,
                label: locName(r.name) || id,
                isPiece: !!r.isPieceItem,
                packageKg: Number(r.packageWeightKg) || 0
            });
        }
    }
    out.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    return out;
}

function seriesOptionsForSection(sectionKey) {
    if (STOCK_SECTIONS[sectionKey]) return sectionResourceOptions(sectionKey);
    if (sectionKey === 'Энергия') {
        return ENERGY_SERIES.map(s => ({ id: s.id, label: t(s.i18n) || s.id, cap: s.cap }));
    }
    if (sectionKey === 'Население') {
        return POP_SERIES.map(s => ({ id: s.id, label: t(s.i18n) || s.id, cap: s.cap }));
    }
    if (sectionKey === 'Технологии') {
        return TECH_SERIES.map(s => ({ id: s.id, label: t(s.i18n) || s.id, cap: s.cap }));
    }
    return [];
}

function seriesHasCap(seriesId, sectionKey) {
    if (STOCK_SECTIONS[sectionKey]) return true;
    const list = sectionKey === 'Энергия' ? ENERGY_SERIES
        : sectionKey === 'Население' ? POP_SERIES
        : sectionKey === 'Технологии' ? TECH_SERIES : [];
    return !!list.find(s => s.id === seriesId)?.cap;
}

function colorForIndex(i) {
    return SERIES_COLORS[i % SERIES_COLORS.length];
}

function formatValue(seriesId, v, sectionKey) {
    const n = Number(v) || 0;
    if (STOCK_SECTIONS[sectionKey]) {
        const meta = resourceCatalog().get(seriesId);
        if (meta?.isPieceItem && Number(meta.packageWeightKg) > 0) {
            const pcs = Math.floor(n / Number(meta.packageWeightKg));
            return `${pcs} ${t('unit.pcs') || 'шт.'}`;
        }
        return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${t('unit.kg') || 'кг'}`;
    }
    if (seriesId === 'energy:remain') {
        // храним секунды
        const sec = Math.max(0, Math.floor(n));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = (x) => String(x).padStart(2, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    if (seriesId.startsWith('energy:')) {
        if (seriesId === 'energy:storage') {
            try { return formatEnergyWh(n).text; } catch (_) {
                return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ${t('unit.Wh') || 'Вт·ч'}`;
            }
        }
        try { return formatEnergy(n).text; } catch (_) {
            return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ${t('unit.W') || t('unit.watts') || 'Вт'}`;
        }
    }
    if (seriesId.startsWith('pop:')) {
        if (seriesId === 'pop:birth' || seriesId === 'pop:death') {
            return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}`;
        }
        return `${Math.round(n).toLocaleString('ru-RU')}`;
    }
    if (seriesId === 'tech:rate') {
        return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${t('unit.techPerMin') || 'тех./мин'}`;
    }
    return String(n);
}

/** Сэмпл живых значений с текущей локации */
function sampleLiveValues(bodyId) {
    if (bodyId == null) return;
    const tNow = gameNowMs();
    const body = state.celestialBodies?.[bodyId];
    if (!body?.data) return;

    // склады
    const stock = body.data.resources?.stock || {};
    for (const rid of Object.keys(stock)) {
        const v = Math.max(0, Number(stock[rid]) || 0);
        const c = getStockCap(bodyId, rid);
        pushPoint(bodyId, rid, tNow, v, c);
    }

    // энергия — из locationFlags + dataset контейнера если есть
    const flags = state.locationFlags?.[bodyId] || {};
    const energyEl = document.querySelector('.resource-container[data-resource-id="Энергия"], .resource-container.section-energy');
    const prod = Number(energyEl?.dataset?.energyProduction ?? flags.energySupplyW) || 0;
    const cons = Number(energyEl?.dataset?.energyConsumption ?? flags.energyDemandW) || 0;
    const bal = prod - cons;
    const stored = Number(energyEl?.dataset?.storageStored) || 0;
    const smax = Number(energyEl?.dataset?.storageMax) || 0;
    const remainSec = Number(energyEl?.dataset?.energyRemainSec);
    pushPoint(bodyId, 'energy:balance', tNow, bal, null);
    pushPoint(bodyId, 'energy:production', tNow, prod, prod); // cap = current max approx
    pushPoint(bodyId, 'energy:consumption', tNow, cons, cons);
    pushPoint(bodyId, 'energy:storage', tNow, stored, smax);
    if (Number.isFinite(remainSec)) pushPoint(bodyId, 'energy:remain', tNow, remainSec, null);

    // население
    const popEl = document.querySelector('.resource-container[data-resource-id="Население"], .resource-container.section-population');
    if (popEl) {
        const total = Number(popEl.dataset.popTotal) || Number(body.data.resources?.population) || 0;
        const maxCap = Number(popEl.dataset.popMax) || 0;
        pushPoint(bodyId, 'pop:total', tNow, total, maxCap);
        pushPoint(bodyId, 'pop:homeless', tNow, Number(popEl.dataset.popHomeless) || 0, null);
        pushPoint(bodyId, 'pop:settled', tNow, Number(popEl.dataset.popSettled) || 0, maxCap);
        pushPoint(bodyId, 'pop:idlers', tNow, Number(popEl.dataset.popIdlers) || 0, Number(popEl.dataset.popIdlers) || 0);
        pushPoint(bodyId, 'pop:creators', tNow, Number(popEl.dataset.popCreators) || 0, null);
        pushPoint(bodyId, 'pop:engineers', tNow, Number(popEl.dataset.popEngineers) || 0, Number(popEl.dataset.popIdlers) || 0);
        pushPoint(bodyId, 'pop:agronomists', tNow, Number(popEl.dataset.popAgronomists) || 0, Number(popEl.dataset.popIdlers) || 0);
        pushPoint(bodyId, 'pop:scientists', tNow, Number(popEl.dataset.popScientists) || 0, Number(popEl.dataset.popIdlers) || 0);
        pushPoint(bodyId, 'pop:expeditioners', tNow, Number(popEl.dataset.popExpeditioners) || 0, Number(popEl.dataset.popIdlers) || 0);
        pushPoint(bodyId, 'pop:dynamics', tNow, Number(popEl.dataset.popDynamics) || 0, null);
        pushPoint(bodyId, 'pop:birth', tNow, Number(popEl.dataset.popBirth) || 0, null);
        pushPoint(bodyId, 'pop:death', tNow, Number(popEl.dataset.popDeath) || 0, null);
    }

    // технологии
    const techEl = document.querySelector('.resource-container[data-resource-id="Технологии"], .resource-container.section-technologies');
    if (techEl) {
        pushPoint(bodyId, 'tech:rate', tNow, Number(techEl.dataset.techProduction) || 0, null);
    }
}

function pushPoint(bodyId, seriesId, tMs, value, cap) {
    const series = ensureSeries(bodyId, seriesId);
    const pts = series.points;
    const v = Number(value) || 0;
    const last = pts[pts.length - 1];
    // не дублируем почти идентичные соседние точки
    if (last && Math.abs(last.t - tMs) < 400 && Math.abs(last.v - v) < 1e-6) {
        last.v = v;
        if (cap != null) last.c = Number(cap) || 0;
        return;
    }
    const p = { t: tMs, v };
    if (cap != null && Number.isFinite(Number(cap))) p.c = Number(cap) || 0;
    pts.push(p);
    // жёсткий потолок точек — прореживаем старую половину
    const MAX_PTS = 4000;
    if (pts.length > MAX_PTS) {
        const keep = [];
        const half = Math.floor(pts.length / 2);
        for (let i = 0; i < half; i += 2) keep.push(pts[i]);
        for (let i = half; i < pts.length; i++) keep.push(pts[i]);
        series.points = keep;
    }
}

/** Архивация: точки старше года → шаг месяц */
function archiveSeries(series) {
    const tNow = gameNowMs();
    const cutoff = tNow - ARCHIVE_AGE_MS;
    const pts = series.points;
    if (pts.length < 8) return;
    const keep = [];
    let bucket = null;
    for (const p of pts) {
        if (p.t >= cutoff) {
            keep.push(p);
            continue;
        }
        const b = Math.floor(p.t / ARCHIVE_STEP_MS);
        if (!bucket || bucket.b !== b) {
            if (bucket) keep.push(bucket.p);
            bucket = { b, p: { ...p } };
        } else {
            // среднее в бакете
            bucket.p.v = (bucket.p.v + p.v) * 0.5;
            if (p.c != null) bucket.p.c = p.c;
            bucket.p.t = p.t;
        }
    }
    if (bucket) keep.push(bucket.p);
    // сохранить хронологию
    keep.sort((a, b) => a.t - b.t);
    series.points = keep;
}

export function tickTrendHistory(dtGameSec) {
    const bodyId = currentBodyId();
    if (bodyId == null) return;
    const dt = Math.max(0, Number(dtGameSec) || 0);
    sampleAcc += dt;
    // прогрессивная оптимизация: интервал семпла ≈ max(1, timeSpeed) игровых секунд
    // 1× → каждую игровую секунду; 4× → раз в 4 игр. сек; 4096× → раз в 4096 игр. сек
    // (≈1 семпл/сек реального времени при любом ускорении)
    let spd = 1;
    try { spd = Number(timeSpeed) || 1; } catch (_) { spd = 1; }
    if (spd <= 0) return; // пауза — не пишем историю
    const interval = Math.max(1, spd);
    if (sampleAcc < interval) return;
    // не теряем «хвост» при больших dt
    sampleAcc = sampleAcc % interval;
    try {
        sampleLiveValues(bodyId);
        const hist = historyStore.get(bodyId);
        if (hist && Math.random() < 0.01) {
            for (const s of hist.values()) archiveSeries(s);
        }
    } catch (e) {
        console.warn('trend sample', e);
    }
    if (open) scheduleDraw();
}

export function captureTrendHistorySnapshot() {
    const out = {};
    for (const [bodyId, map] of historyStore) {
        const bodyOut = {};
        for (const [sid, series] of map) {
            bodyOut[sid] = series.points.map(p =>
                p.c != null ? [p.t, p.v, p.c] : [p.t, p.v]
            );
        }
        out[bodyId] = bodyOut;
    }
    // UI state
    const ui = {};
    for (const k of Object.keys(uiState)) {
        ui[k] = {
            selected: (uiState[k].selected || []).slice(0, MAX_SERIES),
            zoomIdx: Number(uiState[k].zoomIdx) || 0,
            viewEndT: Number(uiState[k].viewEndT) || 0
        };
    }
    return { series: out, ui };
}

export function applyTrendHistorySnapshot(snap) {
    historyStore = new Map();
    if (!snap || typeof snap !== 'object') return;
    const seriesRoot = snap.series || snap;
    for (const bodyId of Object.keys(seriesRoot)) {
        if (bodyId === 'ui') continue;
        const map = new Map();
        const body = seriesRoot[bodyId] || {};
        for (const sid of Object.keys(body)) {
            const arr = body[sid];
            if (!Array.isArray(arr)) continue;
            const points = arr.map(row => {
                if (Array.isArray(row)) {
                    const p = { t: Number(row[0]) || 0, v: Number(row[1]) || 0 };
                    if (row[2] != null) p.c = Number(row[2]) || 0;
                    return p;
                }
                return { t: Number(row.t) || 0, v: Number(row.v) || 0, c: row.c != null ? Number(row.c) : undefined };
            }).filter(p => p.t > 0);
            map.set(sid, { points });
        }
        historyStore.set(Number(bodyId) || bodyId, map);
    }
    if (snap.ui && typeof snap.ui === 'object') {
        for (const k of Object.keys(snap.ui)) {
            uiState[k] = {
                selected: Array.isArray(snap.ui[k].selected) ? snap.ui[k].selected.slice(0, MAX_SERIES) : [],
                zoomIdx: Number(snap.ui[k].zoomIdx) || 0,
                viewEndT: Number(snap.ui[k].viewEndT) || 0
            };
        }
    }
}

function getUiState(section) {
    if (!uiState[section]) {
        uiState[section] = { selected: [], zoomIdx: 2, viewEndT: 0 };
    }
    return uiState[section];
}

function getPoints(bodyId, seriesId) {
    return ensureSeries(bodyId, seriesId).points;
}

function windowRange(st) {
    const zoom = ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, st.zoomIdx))] || ZOOM_LEVELS[2];
    const end = st.viewEndT > 0 ? st.viewEndT : gameNowMs();
    const start = end - zoom.ms;
    return { start, end, zoom };
}

/** Интерполяция значения в момент t */
function valueAt(points, tMs) {
    if (!points.length) return null;
    if (tMs <= points[0].t) return points[0];
    if (tMs >= points[points.length - 1].t) return points[points.length - 1];
    // binary search
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (points[mid].t <= tMs) lo = mid;
        else hi = mid;
    }
    const a = points[lo], b = points[hi];
    const u = (tMs - a.t) / Math.max(1, b.t - a.t);
    const v = a.v + (b.v - a.v) * u;
    const c = (a.c != null || b.c != null)
        ? (Number(a.c) || 0) + ((Number(b.c) || 0) - (Number(a.c) || 0)) * u
        : null;
    return { t: tMs, v, c };
}

function scheduleDraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        drawChart();
    });
}

function drawChart() {
    const canvas = document.getElementById('trend-chart-canvas');
    const wrap = document.querySelector('.trend-chart-canvas-wrap');
    if (!canvas || !wrap || !open) return;

    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w < 8 || h < 8) return;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const bodyId = currentBodyId();
    const st = getUiState(activeSection);
    let { start, end, zoom } = windowRange(st);

    // плавный зум
    if (animZoom) {
        const u = Math.min(1, (performance.now() - animZoom.t0) / animZoom.dur);
        const e = 1 - Math.pow(1 - u, 3);
        const fromMs = ZOOM_LEVELS[animZoom.from].ms;
        const toMs = ZOOM_LEVELS[animZoom.to].ms;
        const ms = fromMs + (toMs - fromMs) * e;
        end = animZoom.targetEnd;
        start = end - ms;
        if (u >= 1) {
            st.zoomIdx = animZoom.to;
            animZoom = null;
        } else {
            scheduleDraw();
        }
    }

    const pad = { l: 48, r: 12, t: 12, b: 22 };
    const cw = w - pad.l - pad.r;
    const ch = h - pad.t - pad.b;

    // сетка
    ctx.strokeStyle = 'rgba(80, 100, 120, 0.18)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = pad.t + (ch * i) / 4;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(pad.l + cw, y);
        ctx.stroke();
    }
    for (let i = 0; i <= 6; i++) {
        const x = pad.l + (cw * i) / 6;
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, pad.t + ch);
        ctx.stroke();
    }

    if (!selectedIds.length || bodyId == null) {
        ctx.fillStyle = 'rgba(180, 190, 200, 0.35)';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t('trend.empty') || 'Выберите ряды слева', w / 2, h / 2);
        updateMeta(zoom);
        return;
    }

    // масштаб Y
    let yMax = 1;
    const seriesData = selectedIds.map((id, idx) => {
        const pts = getPoints(bodyId, id);
        const visible = pts.filter(p => p.t >= start - (end - start) * 0.05 && p.t <= end + (end - start) * 0.05);
        for (const p of visible) {
            yMax = Math.max(yMax, p.v, p.c != null ? p.c : 0);
        }
        // текущее
        const cur = valueAt(pts, Math.min(end, gameNowMs()));
        if (cur) yMax = Math.max(yMax, cur.v, cur.c != null ? cur.c : 0);
        return { id, idx, pts, color: colorForIndex(idx), hasCap: seriesHasCap(id, activeSection) };
    });
    yMax *= 1.08;

    const xOf = (tMs) => pad.l + ((tMs - start) / Math.max(1, end - start)) * cw;
    const yOf = (v) => pad.t + ch - (Math.max(0, v) / yMax) * ch;

    // capacity lines + curves
    for (const s of seriesData) {
        // capacity
        if (s.hasCap) {
            const caps = s.pts.filter(p => p.c != null && p.t >= start && p.t <= end);
            if (caps.length) {
                ctx.save();
                ctx.setLineDash([5, 5]);
                ctx.strokeStyle = s.color + '66';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                let first = true;
                for (const p of caps) {
                    const x = xOf(p.t), y = yOf(p.c);
                    if (first) { ctx.moveTo(x, y); first = false; }
                    else ctx.lineTo(x, y);
                }
                // extend to end with last
                if (caps.length) {
                    const last = caps[caps.length - 1];
                    ctx.lineTo(xOf(Math.min(end, gameNowMs())), yOf(last.c));
                }
                ctx.stroke();
                ctx.restore();
            }
        }

        // curve + gradient fill
        const pts = s.pts;
        if (pts.length < 1) continue;
        // sample densified path in window
        const pathPts = [];
        const step = Math.max(1, Math.floor((end - start) / (cw * 1.5)));
        let i0 = 0;
        while (i0 < pts.length && pts[i0].t < start) i0++;
        if (i0 > 0) i0--;
        for (let i = i0; i < pts.length; i++) {
            if (pts[i].t > end) {
                pathPts.push(pts[i]);
                break;
            }
            pathPts.push(pts[i]);
        }
        if (pathPts.length < 2) {
            const cur = valueAt(pts, Math.min(end, gameNowMs()));
            if (cur) pathPts.push({ t: start, v: cur.v }, cur);
        }

        // fill
        ctx.beginPath();
        let started = false;
        for (const p of pathPts) {
            const x = xOf(p.t), y = yOf(p.v);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        if (started) {
            const last = pathPts[pathPts.length - 1];
            const first = pathPts[0];
            ctx.lineTo(xOf(last.t), pad.t + ch);
            ctx.lineTo(xOf(first.t), pad.t + ch);
            ctx.closePath();
            const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
            grad.addColorStop(0, s.color + '55');
            grad.addColorStop(1, s.color + '00');
            ctx.fillStyle = grad;
            ctx.fill();
        }

        // stroke
        ctx.beginPath();
        started = false;
        for (const p of pathPts) {
            const x = xOf(p.t), y = yOf(p.v);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
    }

    // hover
    const tip = document.getElementById('trend-chart-tooltip');
    if (hoverX != null && hoverX >= pad.l && hoverX <= pad.l + cw) {
        const tMs = start + ((hoverX - pad.l) / cw) * (end - start);
        ctx.strokeStyle = 'rgba(200, 220, 240, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hoverX, pad.t);
        ctx.lineTo(hoverX, pad.t + ch);
        ctx.stroke();

        const lines = [];
        for (const s of seriesData) {
            const cur = valueAt(s.pts, tMs);
            if (!cur) continue;
            const y = yOf(cur.v);
            // glow point
            ctx.beginPath();
            ctx.arc(hoverX, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = s.color;
            ctx.shadowColor = s.color;
            ctx.shadowBlur = 12;
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.arc(hoverX, y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            const name = seriesOptionsForSection(activeSection).find(o => o.id === s.id)?.label || s.id;
            lines.push(`${name}: ${formatValue(s.id, cur.v, activeSection)}`);
        }
        if (tip && lines.length) {
            tip.innerHTML = lines.join('<br>');
            tip.classList.add('visible');
            const tw = tip.offsetWidth || 120;
            const th = tip.offsetHeight || 40;
            let left = hoverX + 12;
            let top = pad.t + 8;
            if (left + tw > w - 4) left = hoverX - tw - 12;
            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
        }
    } else if (tip) {
        tip.classList.remove('visible');
    }

    // Y labels
    ctx.fillStyle = 'rgba(180, 190, 200, 0.55)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const val = yMax * (1 - i / 4);
        const y = pad.t + (ch * i) / 4;
        ctx.fillText(formatShort(val), pad.l - 6, y + 3);
    }

    updateMeta(zoom);
}

function formatShort(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    if (Math.abs(v) >= 10) return v.toFixed(0);
    return v.toFixed(1);
}

function formatRulerLabel(tMs, zoomId) {
    const d = new Date(tMs);
    const pad = (n) => String(n).padStart(2, '0');
    if (zoomId === 'sec' || zoomId === 'min') {
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    if (zoomId === 'hour') {
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (zoomId === 'day' || zoomId === 'week') {
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:00`;
    }
    if (zoomId === 'month') {
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
    }
    // year
    return `${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function updateMeta(zoom) {
    const el = document.getElementById('trend-chart-meta');
    if (!el) return;
    const zLabel = t(zoom.labelKey) || zoom.id;
    const st = getUiState(activeSection);
    const { start, end } = windowRange(st);
    // 7 делений линейки
    const ticks = 7;
    let ticksHtml = '';
    for (let i = 0; i < ticks; i++) {
        const u = i / (ticks - 1);
        const tm = start + (end - start) * u;
        const left = (u * 100).toFixed(2);
        const major = i === 0 || i === ticks - 1 || i === Math.floor((ticks - 1) / 2);
        ticksHtml += `<span class="trend-chart-ruler-tick${major ? ' is-major' : ''}" style="left:${left}%">${formatRulerLabel(tm, zoom.id)}</span>`;
    }
    el.innerHTML = `<span class="trend-chart-meta-zoom">${t('trend.zoom') || 'Масштаб'}: ${zLabel}</span>` +
        `<div class="trend-chart-ruler">${ticksHtml}</div>`;
}

function renderChips() {
    const host = document.getElementById('trend-chips');
    if (!host) return;
    if (!selectedIds.length) {
        host.innerHTML = `<div class="trend-chips-empty">${t('trend.pickSeries') || 'Выберите до 5 рядов'}</div>`;
        return;
    }
    const opts = seriesOptionsForSection(activeSection);
    host.innerHTML = selectedIds.map((id, idx) => {
        const opt = opts.find(o => o.id === id);
        const label = opt?.label || id;
        const color = colorForIndex(idx);
        let icon = opt?.icon || '';
        if (!icon && STOCK_SECTIONS[activeSection]) {
            const meta = resourceCatalog().get(id);
            icon = meta?.icon || '';
        }
        if (!icon) {
            // fallback icons by series family
            if (String(id).startsWith('energy:')) icon = 'assets/textures/icons/energy_storage.png';
            else if (String(id).startsWith('pop:')) icon = 'assets/textures/icons/pop_total.png';
            else if (String(id).startsWith('tech:')) icon = 'assets/textures/icons/technologies.png';
            else icon = 'assets/textures/icons/resource_value.png';
        }
        const grad = `linear-gradient(90deg, transparent 0%, ${color}00 15%, ${color}55 100%)`;
        return `<div class="trend-chip" data-id="${id}">
            <span class="trend-chip-grad" style="background:${grad}"></span>
            <img class="trend-chip-icon" src="${icon}" alt="" onerror="this.style.opacity='0.25'">
            <span class="trend-chip-name">${label}</span>
            <button type="button" class="trend-chip-remove" data-remove="${id}" data-ui>×</button>
        </div>`;
    }).join('');
    host.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-remove');
            selectedIds = selectedIds.filter(x => x !== id);
            getUiState(activeSection).selected = selectedIds.slice();
            firmSelectApi?.setValue(selectedIds);
            renderChips();
            scheduleDraw();
        });
    });
}

function setupSelect() {
    const host = document.getElementById('trend-select-host');
    if (!host) return;
    if (firmSelectApi) {
        try { firmSelectApi.destroy(); } catch (_) {}
        firmSelectApi = null;
    }
    const options = seriesOptionsForSection(activeSection).map(o => ({ id: o.id, label: o.label }));
    firmSelectApi = createFirmSelect(host, {
        multiple: true,
        max: MAX_SERIES,
        options,
        value: selectedIds,
        placeholder: t('trend.selectPlaceholder') || 'Добавить ряд…',
        onChange(val) {
            selectedIds = (val || []).slice(0, MAX_SERIES);
            getUiState(activeSection).selected = selectedIds.slice();
            renderChips();
            scheduleDraw();
        }
    });
}

export function isTrendChartsOpen() {
    return !!open;
}

export function closeTrendCharts() {
    open = false;
    const panel = document.getElementById('trend-charts-panel');
    if (panel) panel.classList.remove('open');
    hoverX = null;
    // критично: вернуть попап в рабочее состояние (opacity/active), иначе клики по разделам «молчат»
    try {
        const popup = document.getElementById('resource-popup');
        if (popup) {
            popup.style.opacity = '';
            popup.style.display = 'none';
        }
        document.querySelectorAll('.resource-container.active').forEach(el => {
            el.classList.remove('active');
        });
    } catch (_) {}
}

/** Вернуться в попап ресурсной полоски */
function backToPopup() {
    const section = activeSection;
    closeTrendCharts();
    // динамический импорт — разрыв цикличности trendCharts ↔ resourceUI
    requestAnimationFrame(() => {
        import('./resourceUI.js').then(m => {
            try { m.openResourceSectionPopup(section); } catch (e) { console.warn('backToPopup', e); }
        }).catch(e => console.warn('backToPopup import', e));
    });
}

/**
 * @param {string} sectionKey — ключ раздела ('Сырье' | 'Энергия' | …)
 */
export function openTrendCharts(sectionKey) {
    activeSection = sectionKey || 'Сырье';
    const st = getUiState(activeSection);
    selectedIds = (st.selected || []).slice(0, MAX_SERIES);
    if (!st.viewEndT) st.viewEndT = 0; // 0 = live end

    // закрыть попап (без opacity — иначе после закрытия графиков попап остаётся невидимым)
    const popup = document.getElementById('resource-popup');
    if (popup) {
        popup.style.display = 'none';
        popup.style.opacity = '';
    }
    try {
        document.querySelectorAll('.resource-container.active').forEach(el => el.classList.remove('active'));
    } catch (_) {}

    const panel = document.getElementById('trend-charts-panel');
    if (!panel) return false;
    open = true;
    panel.classList.add('open');

    const title = panel.querySelector('.trend-panel-title');
    if (title) {
        const secKeyMap = {
            'Сырье': 'res.section.raw',
            'Материалы': 'res.section.materials',
            'Компоненты': 'res.section.components',
            'Продукция': 'res.section.products',
            'Продовольствие': 'res.section.food',
            'Энергия': 'res.section.energy',
            'Технологии': 'res.section.technologies',
            'Население': 'res.section.population'
        };
        const secName = t(secKeyMap[activeSection] || 'trend.title') || activeSection;
        title.textContent = `${t('trend.title') || 'Графики трендов'} — ${secName}`;
    }

    // sample now so chart not empty
    try { sampleLiveValues(currentBodyId()); } catch (_) {}

    setupSelect();
    renderChips();
    scheduleDraw();
    return true;
}

export function initTrendChartsUI() {
    // panel may be injected
    ensurePanelDom();

    const panel = document.getElementById('trend-charts-panel');
    if (!panel) return;

    panel.setAttribute('data-ui', 'true');

    panel.querySelector('#trend-btn-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTrendCharts();
    });
    panel.querySelector('#trend-btn-back')?.addEventListener('click', (e) => {
        e.stopPropagation();
        backToPopup();
    });

    const wrap = panel.querySelector('.trend-chart-canvas-wrap');
    wrap?.addEventListener('mousemove', (e) => {
        const rect = wrap.getBoundingClientRect();
        hoverX = e.clientX - rect.left;
        scheduleDraw();
    });
    wrap?.addEventListener('mouseleave', () => {
        hoverX = null;
        scheduleDraw();
    });

    // wheel zoom
    wrap?.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const st = getUiState(activeSection);
        const dir = e.deltaY > 0 ? 1 : -1;
        const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, st.zoomIdx + dir));
        if (next === st.zoomIdx) return;
        animZoom = {
            from: st.zoomIdx,
            to: next,
            t0: performance.now(),
            dur: 320,
            targetEnd: st.viewEndT > 0 ? st.viewEndT : gameNowMs()
        };
        st.zoomIdx = next;
        scheduleDraw();
    }, { passive: false });

    panel.addEventListener('wheel', (e) => {
        e.stopPropagation();
    }, { passive: true });

    // Resize
    window.addEventListener('resize', () => {
        if (open) scheduleDraw();
    });

    onLanguageChange?.(() => {
        if (open) {
            setupSelect();
            renderChips();
            scheduleDraw();
        }
    });

    console.debug('[trendCharts] ready');
}

function ensurePanelDom() {
    if (document.getElementById('trend-charts-panel')) return;
    const div = document.createElement('div');
    div.id = 'trend-charts-panel';
    div.setAttribute('data-ui', 'true');
    div.innerHTML = `
        <div class="trend-panel-window" data-ui>
            <div class="trend-panel-top">
                <div class="trend-panel-title">${t('trend.title') || 'Графики трендов'}</div>
                <button type="button" class="trend-panel-btn" id="trend-btn-back" title="Назад" data-ui>
                    <img src="assets/textures/icons/trend_back.png" alt="←" onerror="this.parentNode.textContent='←'">
                </button>
                <button type="button" class="trend-panel-btn trend-panel-btn-close" id="trend-btn-close" data-ui>×</button>
            </div>
            <div class="trend-panel-body">
                <div class="trend-side" data-ui>
                    <div class="trend-side-label">${t('trend.series') || 'Ряды'}</div>
                    <div id="trend-select-host"></div>
                    <div class="trend-chips" id="trend-chips"></div>
                </div>
                <div class="trend-chart-host" data-ui>
                    <div class="trend-chart-meta" id="trend-chart-meta"></div>
                    <div class="trend-chart-canvas-wrap">
                        <canvas id="trend-chart-canvas"></canvas>
                        <div class="trend-chart-tooltip" id="trend-chart-tooltip"></div>
                    </div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(div);
}

/** Хелпер для resourceUI: кнопка в заголовке */
export function chartsButtonHtml(sectionKey) {
    const icon = 'assets/textures/icons/trend_charts.png';
    return `<button type="button" class="popup-charts-btn" data-trend-section="${sectionKey}" data-ui title="${t('trend.open') || 'Графики трендов'}">
        <img src="${icon}" alt="📈" onerror="this.parentNode.textContent='📈'">
    </button>`;
}

export function bindChartsButtons(popup) {
    if (!popup) return;
    popup.querySelectorAll('.popup-charts-btn').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const sec = btn.getAttribute('data-trend-section') || 'Сырье';
            openTrendCharts(sec);
        });
    });
}
