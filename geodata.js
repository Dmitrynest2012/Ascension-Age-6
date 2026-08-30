/**
 * Геоданные небесного тела: залежи в недрах / атмосфере (не склад цивилизации).
 * geoDeposits[id].current = остаток (т), .max = исходный максимум (т).
 */
import { t, locName, onLanguageChange } from './settings.js';
import { state } from './state.js';
import {
    getRecipesForBuilding,
    getRecipeLocalPower,
    getRecipeEffectiveness,
    getRecipeActualOutput,
    isGeoRecipeInput,
    resolveInputGeoId,
    } from './recipes.js';
import { buildingBelongsToLocation, getLocationBuildingData } from './buildingHelpers.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';

const CATEGORIES = [
    { id: 'lithosphere', i18n: 'geo.tab.lithosphere', icon: 'assets/textures/icons/info_metrics.svg' },
    { id: 'volatiles', i18n: 'geo.tab.volatiles', icon: 'assets/textures/icons/info_climate.svg' },
    { id: 'exogenous', i18n: 'geo.tab.exogenous', icon: 'assets/textures/icons/info_main.svg' }
];

/** Цвета сегментов диаграммы (по id ресурса + запасная палитра) */
const GEO_COLOR_BY_ID = {
    GEO_IRON_ROCK: '#4a2c1a',       // тёмно-коричневый
    GEO_COPPER_ROCK: '#2ec4b6',
    GEO_TITANIUM_ROCK: '#8a8e96',   // серый
    GEO_TUNGSTEN_ROCK: '#1a1a1c',   // почти чёрный
    GEO_ALUMINUM_ROCK: '#c5c8cc',   // светло-серый
    GEO_SULFUR_ROCK: '#e8c41a',     // явно жёлтый
    GEO_LIMESTONE: '#d4c47a',       // едва заметный жёлтый
    GEO_N2: '#3ec6ff',
    GEO_O2: '#5ad67a',
    GEO_CO2: '#90a4ae',
    GEO_CH4: '#ff9ecd',
    GEO_HE: '#b388ff',
    GEO_NE: '#4dd0c8',
    GEO_AR: '#7eb6ff',
    GEO_WATER: '#3aa0e8',
    GEO_ICE: '#a8d4f0',
    GEO_OIL: '#5c4030',
    GEO_SAND: '#c2a878'
};
const CHART_FALLBACK = [
    '#3ec6ff', '#5ad67a', '#f0c040', '#ff7a5a', '#b388ff', '#4dd0c8', '#ff9ecd', '#90a4ae'
];

function colorForGeo(id, index) {
    const meta = id ? catalogById.get(id) : null;
    if (meta?.chartColor) return meta.chartColor;
    if (id && GEO_COLOR_BY_ID[id]) return GEO_COLOR_BY_ID[id];
    return CHART_FALLBACK[index % CHART_FALLBACK.length];
}

function lightenHex(hex, amount) {
    const h = String(hex || '#888888').replace('#', '');
    if (h.length !== 6) return hex;
    const n = parseInt(h, 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.min(255, Math.round(r + (255 - r) * amount));
    g = Math.min(255, Math.round(g + (255 - g) * amount));
    b = Math.min(255, Math.round(b + (255 - b) * amount));
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

let catalog = [];
let catalogById = new Map();
let activeGeoTab = 'lithosphere';
let _geoListScroll = null;
let _geoLegendScroll = null;
let lastBodyData = null;

export async function loadGeoResources() {
    try {
        const res = await fetch('geoResources.json');
        catalog = await res.json();
        catalogById = new Map(catalog.map(r => [r.id, r]));
        try { globalThis.__geoCatalog = catalog; } catch (_) {}
        console.log('Geo resources loaded:', catalog.length);
    } catch (e) {
        console.error('Failed to load geoResources.json', e);
        catalog = [];
        catalogById = new Map();
        try { globalThis.__geoCatalog = catalog; } catch (_) {}
    }
    return catalog;
}

/** geoExploration: false → маска; true / 'scanA' / … → открыто */
export function isGeoExplorationDone(bodyData) {
    const v = bodyData?.geoExploration;
    if (v === true) return true;
    if (typeof v === 'string' && v.length && v !== 'false' && v !== 'none') return true;
    return false;
}

/**
 * Крупные массы в тоннах: тыс / млн / млрд / трлн / квадрлн / квинтлн / секстрилн.
 */
export function formatGeoTons(tons) {
    const n = Number(tons);
    if (!Number.isFinite(n) || n < 0) return `— ${t('unit.t') || 'т'}`;
    const abs = Math.abs(n);
    if (abs >= 1e21) return `${(n / 1e21).toFixed(2)} ${t('unit.sextillionT') || 'секстрилн т'}`;
    if (abs >= 1e18) return `${(n / 1e18).toFixed(2)} ${t('unit.quintillionT') || 'квинтлн т'}`;
    if (abs >= 1e15) return `${(n / 1e15).toFixed(2)} ${t('unit.quadrillionT') || 'квадрлн т'}`;
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)} ${t('unit.trillionT') || 'трлн т'}`;
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)} ${t('unit.billionT') || 'млрд т'}`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)} ${t('unit.millionT') || 'млн т'}`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(2)} ${t('unit.thousandT') || 'тыс т'}`;
    if (abs >= 1) return `${n.toFixed(2)} ${t('unit.t') || 'т'}`;
    return `${n.toFixed(4)} ${t('unit.t') || 'т'}`;
}

const GEO_TREND_EPS = 1e-12; // т/мин — залежи огромные, но расход экспедиций мал
const GEO_TREND_HOLD = 1e-11;

/** bodyId → { id: tonsPerMin net }  (отрицательное = расход) */
const _geoRates = Object.create(null);
/** bodyId → { id: remainingTons } snapshot */
const _geoSnap = Object.create(null);
/** bodyId → { id: -1|0|1 } */
const _geoDir = Object.create(null);
let _geoSnapT = 0;

function trendClassFromRate(rate, dirKey = null) {
    const r = Number(rate) || 0;
    let dir = 0;
    if (r > GEO_TREND_EPS) dir = 1;
    else if (r < -GEO_TREND_EPS) dir = -1;
    if (dirKey != null) {
        const root = String(dirKey).split(':')[0] || '_';
        if (!_geoDir[root]) _geoDir[root] = Object.create(null);
        const bag = _geoDir[root];
        const prev = bag[dirKey] ?? 0;
        if (prev !== 0 && dir !== 0 && dir !== prev && Math.abs(r) < GEO_TREND_HOLD) dir = prev;
        if (dir === 0 && prev !== 0 && Math.abs(r) > GEO_TREND_EPS * 0.25) dir = prev;
        bag[dirKey] = dir;
    }
    if (dir > 0) return 'trend-up';
    if (dir < 0) return 'trend-down';
    return 'trend-flat';
}

function trendSlotHtml(rate = 0, dirKey = null) {
    return `<span class="trend-slot ${trendClassFromRate(rate, dirKey)}" aria-hidden="true"></span>`;
}

function getDeposit(bodyData, id) {
    const d = bodyData?.geoDeposits?.[id];
    if (!d || typeof d !== 'object') return { current: 0, max: 0 };
    return {
        current: Number(d.current) || 0, // остаток, т
        max: Number(d.max) || 0
    };
}

/**
 * Плановый расход залежи от активных горных экспедиций (т/мин, ≥0).
 * Фаза mining: plannedYield / mineHours.
 * toNode/toBase: тоже учитываем усреднённо (миссия уже идёт).
 */


/** Плановый расход залежи зданиями-экстракторами (т/мин). */
function plannedBuildingExtractionTpm(bodyData, geoId) {
    const locId = Number(bodyData?.id);
    if (!Number.isFinite(locId) || !geoId) return 0;
    let tpm = 0;
    try {
        state.initializeLocationBuildings?.(locId);
        const locMap = state.locationBuildings?.[locId] || {};
        for (const buildingId of Object.keys(locMap)) {
            try {
                if (!buildingBelongsToLocation(locId, buildingId)) continue;
            } catch (_) { continue; }
            const count = locMap[buildingId]?.built_count || 0;
            if (count <= 0) continue;
            for (const recipe of getRecipesForBuilding(buildingId) || []) {
                const localP = getRecipeLocalPower(locId, buildingId, recipe.id);
                if (localP <= 0) continue;
                const eff = getRecipeEffectiveness(locId, buildingId, recipe);
                if (eff <= 0) continue;
                for (const inp of recipe.inputs || []) {
                    if (!isGeoRecipeInput(inp)) continue;
                    const gid = resolveInputGeoId(inp) || inp.geoResourceId;
                    if (String(gid) !== String(geoId)) continue;
                    // кг/мин → т/мин
                    let kgPerMin = 0;
                    try {
                        const out = (recipe.outputs || []).find(o => o?.resourceId);
                        if (out?.resourceId) {
                            kgPerMin = getRecipeActualOutput(locId, buildingId, recipe, out.resourceId);
                        } else {
                            kgPerMin = (Number(inp.perMinute) || 0) * count * eff;
                        }
                    } catch (_) {
                        kgPerMin = (Number(inp.perMinute) || 0) * count * eff;
                    }
                    tpm += kgPerMin / 1000;
                }
            }
        }
    } catch (_) { /* ignore */ }
    return tpm;
}

function plannedMineConsumptionTpm(bodyData, geoId) {
    const bodyId = String(bodyData?.id ?? '');
    if (!bodyId || !geoId) return 0;
    const entry = state.locationCartography?.[bodyId];
    if (!entry) return 0;
    let tpm = 0;
    for (const u of entry.units || []) {
        if (u.mission !== 'mine') continue;
        const gid = u.linkedGeoResourceId
            || entry.resources?.find?.(r => r.id === u.targetNodeId)?.linkedGeoResourceId
            || '';
        if (String(gid) !== String(geoId)) continue;
        const yieldKg = Number(u.plannedYieldKg) || 0;
        const mineH = Math.max(0.05, Number(u.mineHours) || 3);
        if (u.minePhase === 'mining') {
            // т/мин во время добычи на месте
            tpm += (yieldKg / 1000) / (mineH * 60);
        } else if (u.minePhase === 'toNode' || u.minePhase === 'toBase') {
            // миссия активна — средний расход по циклу (добыча + грубые 2ч пути минимум)
            const cycleH = mineH + 1;
            tpm += (yieldKg / 1000) / (cycleH * 60);
        }
    }
    return tpm;
}

/**
 * Обновить скорости изменения залежей: плановый расход + EMA по факту.
 * net < 0 → залежь убывает.
 */
function updateGeoRates(bodyData) {
    const bodyId = String(bodyData?.id ?? '');
    if (!bodyId || !bodyData?.geoDeposits) {
        return _geoRates[bodyId] || {};
    }
    const now = performance.now();
    const deps = bodyData.geoDeposits;
    const rates = _geoRates[bodyId] || Object.create(null);
    const prev = _geoSnap[bodyId];
    const dt = prev ? Math.max(0.05, (now - _geoSnapT) / 1000) : 0;

    for (const id of Object.keys(deps)) {
        const cur = Number(deps[id]?.current) || 0;
        let instant = 0;
        if (prev && dt > 0 && Object.prototype.hasOwnProperty.call(prev, id)) {
            // т/мин по факту (current = остаток → убыль даёт отрицательный rate)
            instant = ((cur - prev[id]) / dt) * 60;
        }
        const planned = plannedMineConsumptionTpm(bodyData, id) + plannedBuildingExtractionTpm(bodyData, id); // ≥0 расход
        // нетто: факт EMA + если план активен, не даём «залипнуть» в 0
        const old = Number(rates[id]) || 0;
        let next = old * 0.7 + instant * 0.3;
        if (planned > 0) {
            // расход не меньше планового (отрицательный)
            next = Math.min(next, -planned);
        } else {
            // нет миссий — затухание к 0
            next *= 0.85;
            if (Math.abs(next) < GEO_TREND_EPS) next = 0;
        }
        rates[id] = next;
    }
    // id без депозита, но с планом (на всякий)
    const entry = state.locationCartography?.[bodyId];
    for (const u of entry?.units || []) {
        if (u.mission !== 'mine') continue;
        const gid = u.linkedGeoResourceId;
        if (!gid || rates[gid] != null) continue;
        const planned = plannedMineConsumptionTpm(bodyData, gid);
        if (planned > 0) rates[gid] = -planned;
    }

    _geoRates[bodyId] = rates;
    const snap = Object.create(null);
    for (const id of Object.keys(deps)) snap[id] = Number(deps[id]?.current) || 0;
    _geoSnap[bodyId] = snap;
    _geoSnapT = now;
    return rates;
}

function geoResourceRate(bodyData, geoId) {
    const bodyId = String(bodyData?.id ?? '');
    return Number((_geoRates[bodyId] || {})[geoId]) || 0;
}

function categoryItems(catId) {
    return catalog.filter(r => r.category === catId);
}

function pieSvg(slices) {
    const total = slices.reduce((s, x) => s + x.value, 0);
    if (total <= 0 || !slices.length) {
        return `<svg class="geo-pie" viewBox="0 0 120 120" aria-hidden="true">
            <defs>
                <radialGradient id="geo-pie-empty" cx="50%" cy="45%" r="55%">
                    <stop offset="0%" stop-color="rgba(70,70,80,0.7)"/>
                    <stop offset="100%" stop-color="rgba(30,30,35,0.85)"/>
                </radialGradient>
            </defs>
            <circle cx="60" cy="60" r="50" fill="url(#geo-pie-empty)" stroke="rgba(120,160,180,0.25)" stroke-width="1.5"/>
            <text x="60" y="64" text-anchor="middle" fill="rgba(180,180,180,0.7)" font-size="11" font-family="Play,sans-serif">—</text>
        </svg>`;
    }
    let a = -Math.PI / 2;
    const grads = [];
    const paths = [];
    slices.forEach((sl, i) => {
        const frac = sl.value / total;
        const a2 = a + frac * Math.PI * 2;
        const x1 = 60 + 48 * Math.cos(a);
        const y1 = 60 + 48 * Math.sin(a);
        const x2 = 60 + 48 * Math.cos(a2);
        const y2 = 60 + 48 * Math.sin(a2);
        const large = frac > 0.5 ? 1 : 0;
        const col = colorForGeo(sl.id, i);
        const colHi = lightenHex(col, 0.35);
        const gid = `geo-seg-${i}`;
        grads.push(
            `<linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="${colHi}"/>
                <stop offset="55%" stop-color="${col}"/>
                <stop offset="100%" stop-color="${col}"/>
            </linearGradient>`
        );
        if (frac >= 0.999) {
            paths.push(`<circle cx="60" cy="60" r="48" fill="url(#${gid})"/>`);
        } else if (frac > 1e-6) {
            paths.push(
                `<path d="M60 60 L${x1} ${y1} A48 48 0 ${large} 1 ${x2} ${y2} Z" fill="url(#${gid})" stroke="rgba(0,0,0,0.25)" stroke-width="0.6"/>`
            );
        }
        a = a2;
    });
    return `<svg class="geo-pie" viewBox="0 0 120 120" aria-hidden="true">
        <defs>
            ${grads.join('')}
            <radialGradient id="geo-pie-core" cx="50%" cy="40%" r="60%">
                <stop offset="0%" stop-color="rgba(40,48,58,0.98)"/>
                <stop offset="100%" stop-color="rgba(12,14,18,0.96)"/>
            </radialGradient>
            <filter id="geo-pie-soft" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="0.35" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
        </defs>
        <circle cx="60" cy="60" r="50.5" fill="none" stroke="rgba(140,190,220,0.18)" stroke-width="1"/>
        <g filter="url(#geo-pie-soft)">${paths.join('')}</g>
        <circle cx="60" cy="60" r="26" fill="url(#geo-pie-core)" stroke="rgba(100,140,160,0.2)" stroke-width="1"/>
    </svg>`;
}

function legendHtml(slices, masked) {
    if (!slices.length) {
        return `<div class="geo-legend-empty">${t('geo.noData') || 'Нет данных'}</div>`;
    }
    const total = slices.reduce((s, x) => s + x.value, 0) || 1;
    return slices.map((sl, i) => {
        const pct = masked ? '—' : `${((sl.value / total) * 100).toFixed(1)}%`;
        const col = colorForGeo(sl.id, i);
        return `<div class="geo-legend-row">
            <span class="geo-legend-swatch" style="background:${col}"></span>
            <span class="geo-legend-name">${sl.label}</span>
            <span class="geo-legend-pct">${pct}</span>
        </div>`;
    }).join('');
}

/**
 * Модель: current = остаток (т), max = исходный максимум (т).
 * % выработано = (max − current) / max · 100
 * «Осталось» = current
 */
function extractedPct(dep) {
    const max = Number(dep.max) || 0;
    const cur = Number(dep.current) || 0;
    if (max <= 0) return 0;
    return Math.min(100, Math.max(0, (max - cur) / max * 100));
}

function rowHtml(meta, dep, masked, bodyData = null) {
    const icon = meta.icon || 'assets/textures/icons/res_ore.png';
    const name = locName(meta.name, meta.id);
    const unknown = t('common.unknownLower') || 'неизвестно';
    const max = Number(dep.max) || 0;
    const remain = Math.max(0, Number(dep.current) || 0); // current = остаток
    const curStr = masked ? unknown : formatGeoTons(remain);
    const maxStr = masked ? unknown : formatGeoTons(max);
    const leftStr = masked ? unknown : formatGeoTons(remain);
    const pct = extractedPct(dep);
    const pctLine = masked
        ? `[${unknown}]`
        : `[${pct.toFixed(1)}% / 100%]`;
    const symbol = (meta.symbol || '').trim();
    const badgeCls = symbol.length > 2 ? 'geo-chem-badge geo-chem-badge-long' : 'geo-chem-badge';
    const badge = symbol
        ? `<span class="${badgeCls}" title="${symbol}">${symbol}</span>`
        : '';
    const col = colorForGeo(meta.id, 0);
    const rate = (!masked && bodyData) ? geoResourceRate(bodyData, meta.id) : 0;
    const dirKey = bodyData?.id != null ? `${bodyData.id}:${meta.id}` : null;
    return `<div class="geo-row" data-geo-id="${meta.id}" data-geo-color="${col}" style="--geo-accent:${col}">
        <div class="geo-row-icon-wrap">
            <img class="geo-row-icon" src="${icon}" alt="">
            ${badge}
        </div>
        <div class="geo-row-text">
            <span class="geo-row-name">${name}:</span>
            <span class="geo-row-line geo-row-pct">${pctLine}</span>
            <span class="geo-row-line geo-row-values">${curStr}<span class="geo-cap-sep"> / </span>${maxStr}${trendSlotHtml(rate, dirKey)}</span>
            <span class="geo-row-line geo-row-left">${t('geo.remaining') || 'Осталось'}: ${leftStr}</span>
        </div>
    </div>`;
}

export function setGeodataTab(tabId) {
    if (!CATEGORIES.some(c => c.id === tabId)) return;
    activeGeoTab = tabId;
    selectedGeoId = null;
    document.querySelectorAll('.geo-tab-button').forEach(btn => {
        const on = btn.dataset.geoTab === activeGeoTab;
        btn.classList.toggle('active', on);
        btn.classList.toggle('inactive', !on);
    });
    if (lastBodyData) renderGeodataPanel(lastBodyData);
}

function ensurePanelDom() {
    return document.getElementById('geodata-panel');
}

export function showGeodataPanel(visible) {
    const panel = ensurePanelDom();
    if (!panel) return;
    panel.style.display = visible ? 'flex' : 'none';
}

export function renderGeodataPanel(bodyData) {
    lastBodyData = bodyData || null;
    const panel = ensurePanelDom();
    if (!panel) return;
    if (!bodyData) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'flex';
    panel.querySelectorAll('[data-i18n]').forEach(node => {
        const key = node.getAttribute('data-i18n');
        if (key) node.textContent = t(key);
    });

    const masked = !isGeoExplorationDone(bodyData);
    updateGeoRates(bodyData);
    const items = categoryItems(activeGeoTab);
    const listEl = document.getElementById('geodata-list');
    const chartEl = document.getElementById('geodata-chart');
    const legendEl = document.getElementById('geodata-legend');
    const titleEl = document.getElementById('geodata-section-title');

    const cat = CATEGORIES.find(c => c.id === activeGeoTab);
    if (titleEl && cat) titleEl.textContent = t(cat.i18n);

    const slices = [];
    if (listEl) {
        if (!items.length) {
            listEl.innerHTML = `<div class="geo-empty">${t('geo.noData') || 'Нет данных'}</div>`;
        } else {
            listEl.innerHTML = items.map(meta => {
                const dep = getDeposit(bodyData, meta.id);
                // диаграмма по остатку
                if (!masked && dep.current > 0) {
                    slices.push({ id: meta.id, label: locName(meta.name, meta.id), value: dep.current });
                } else if (masked) {
                    slices.push({ id: meta.id, label: locName(meta.name, meta.id), value: 1 });
                }
                return rowHtml(meta, dep, masked, bodyData);
            }).join('');
        }
    }

    if (chartEl) chartEl.innerHTML = pieSvg(masked ? slices.map(s => ({ ...s, value: 1 })) : slices.filter(s => s.value > 0));
    // Легенда под диаграммой: ВСЕ типы вкладки (в т.ч. с 0 остатком), иначе литосфера «теряет» породы
    const legendSlices = masked
        ? items.map(m => ({ id: m.id, label: locName(m.name, m.id), value: 1 }))
        : items.map(m => {
            const dep = getDeposit(bodyData, m.id);
            return { id: m.id, label: locName(m.name, m.id), value: Math.max(0, Number(dep.current) || 0) };
        });
    if (legendEl) legendEl.innerHTML = legendHtml(legendSlices, masked);

    bindGeoCardInteractions(items, masked);
    try { ensureGeoFirmScrolls(); } catch (_) {}
    // описание: первая карточка вкладки или сохранённый выбор
    const prefer = selectedGeoId && items.some(m => m.id === selectedGeoId)
        ? selectedGeoId
        : (items[0]?.id || null);
    if (prefer) setGeoDescription(prefer, masked);
    else clearGeoDescription();
}

let selectedGeoId = null;

function clearGeoDescription() {
    const el = document.getElementById('geodata-desc');
    if (el) el.textContent = '';
}

function setGeoDescription(id, masked) {
    selectedGeoId = id;
    const el = document.getElementById('geodata-desc');
    if (!el) return;
    document.querySelectorAll('.geo-row').forEach(r => {
        r.classList.toggle('selected', r.dataset.geoId === id);
    });
    if (masked) {
        el.textContent = t('common.unknownLower') || 'неизвестно';
        return;
    }
    const meta = catalogById.get(id);
    el.textContent = locName(meta?.description, '') || (t('geo.noDescription') || '');
}

function bindGeoCardInteractions(items, masked) {
    document.querySelectorAll('.geo-row').forEach(row => {
        const id = row.dataset.geoId;
        const col = row.dataset.geoColor || colorForGeo(id, 0);
        row.addEventListener('mouseenter', () => {
            row.style.background = `linear-gradient(180deg,
                ${hexToRgba(col, 0.42)} 0%,
                ${hexToRgba(col, 0.22)} 55%,
                ${hexToRgba(col, 0.14)} 100%)`;
        });
        row.addEventListener('mouseleave', () => {
            if (!row.classList.contains('selected')) row.style.background = '';
            else row.style.background = `linear-gradient(180deg,
                ${hexToRgba(col, 0.28)} 0%,
                ${hexToRgba(col, 0.14)} 100%)`;
        });
        row.addEventListener('click', () => setGeoDescription(id, masked));
    });
}

function hexToRgba(hex, a) {
    const h = String(hex || '#888888').replace('#', '');
    if (h.length !== 6) return `rgba(80,80,90,${a})`;
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
}


function ensureGeoFirmScrolls() {
    const mainCol = document.querySelector('#geodata-panel .geo-main-col');
    if (mainCol) {
        try {
            if (!_geoListScroll) {
                _geoListScroll = attachFirmScroll(mainCol, {
                    axis: 'y',
                    mirrorV: true,
                    host: 'self',
                    fillHost: false
                });
            } else {
                updateFirmScroll?.(mainCol) || _geoListScroll.update?.();
            }
        } catch (e) { console.warn('geodata list firmScroll', e); }
    }
    const legend = document.getElementById('geodata-legend');
    if (legend) {
        try {
            if (!_geoLegendScroll) {
                _geoLegendScroll = attachFirmScroll(legend, {
                    axis: 'y',
                    mirrorV: true,
                    host: 'self',
                    fillHost: false
                });
            } else {
                _geoLegendScroll.update?.();
            }
        } catch (e) { console.warn('geodata legend firmScroll', e); }
    }
}

export function initGeodataUI() {
    document.querySelectorAll('.geo-tab-button').forEach(btn => {
        btn.addEventListener('click', () => setGeodataTab(btn.dataset.geoTab));
    });
    onLanguageChange(() => {
        if (lastBodyData && document.getElementById('geodata-panel')?.style.display !== 'none') {
            renderGeodataPanel(lastBodyData);
        }
    });
    console.log('Geodata UI ready');
}

/** Живое обновление трендов/цифр при открытой панели (раз в ~0.5 с). */
let _geoTickAcc = 0;
export function tickGeodataUI(bodyData, dtMs = 16) {
    const panel = ensurePanelDom();
    if (!panel || panel.style.display === 'none') return;
    if (!bodyData) return;
    _geoTickAcc += dtMs;
    if (_geoTickAcc < 500) return;
    _geoTickAcc = 0;
    lastBodyData = bodyData;
    updateGeoRates(bodyData);
    // точечно обновить карточки без полного сброса описания/скролла
    const masked = !isGeoExplorationDone(bodyData);
    document.querySelectorAll('.geo-row[data-geo-id]').forEach(row => {
        const id = row.dataset.geoId;
        if (!id) return;
        const dep = getDeposit(bodyData, id);
        const remain = Math.max(0, Number(dep.current) || 0);
        const max = Number(dep.max) || 0;
        const pct = extractedPct(dep);
        const rate = masked ? 0 : geoResourceRate(bodyData, id);
        const dirKey = `${bodyData.id}:${id}`;
        const pctEl = row.querySelector('.geo-row-pct');
        const valEl = row.querySelector('.geo-row-values');
        const leftEl = row.querySelector('.geo-row-left');
        const unknown = t('common.unknownLower') || 'неизвестно';
        if (pctEl) {
            pctEl.textContent = masked ? `[${unknown}]` : `[${pct.toFixed(1)}% / 100%]`;
        }
        if (valEl) {
            const curStr = masked ? unknown : formatGeoTons(remain);
            const maxStr = masked ? unknown : formatGeoTons(max);
            valEl.innerHTML = `${curStr}<span class="geo-cap-sep"> / </span>${maxStr}${trendSlotHtml(rate, dirKey)}`;
        }
        if (leftEl) {
            leftEl.textContent = `${t('geo.remaining') || 'Осталось'}: ${masked ? unknown : formatGeoTons(remain)}`;
        }
    });
}

export function getGeoCatalog() {
    try { globalThis.__geoCatalog = catalog; } catch (_) {}
    return catalog;
}
try { globalThis.getGeoCatalog = getGeoCatalog; } catch (_) {}
