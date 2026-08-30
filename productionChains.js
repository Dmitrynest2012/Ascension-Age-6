
function bindPcCardNameTips(root) {
    if (!root) return;
    root.querySelectorAll('.pc-card').forEach(card => {
        const nameEl = card.querySelector('.pc-card-name');
        if (!nameEl) return;
        const full = (nameEl.getAttribute('data-full-name') || nameEl.textContent || '').trim();
        if (!full) return;
        // после layout
        const truncated = nameEl.scrollWidth > nameEl.clientWidth + 1
            || nameEl.scrollHeight > nameEl.clientHeight + 1;
        if (truncated) {
            if (typeof window.setTip === 'function') window.setTip(card, full);
            else { card.setAttribute('data-tip', full); card.removeAttribute('title'); }
        } else {
            if (typeof window.clearTip === 'function') window.clearTip(card);
            else { card.removeAttribute('data-tip'); card.removeAttribute('title'); }
        }
    });
}

/**
 * Цепочки производства — единое поле без разделов, зум колёсиком (1× … 1/8×),
 * тонкий хэдер, входящие графы подсвечиваются при hover карточки.
 */
import { state } from './state.js';
import { currentLocation } from './camera.js';
import { getLang, onLanguageChange, t, locName } from './settings.js';
import {
    getRecipesForBuilding, getAllRecipes, getAllResources, getInputResourceIds,
    getRecipeLocalPower, getRecipeEffectiveness, getStockAmount,
    isGeoRecipeInput, resolveInputGeoId, getDepositRemainingKg
} from './recipes.js';
import { getLocationStockFlows, refreshLocationStockFlows } from './resourceUI.js';
import { isResourceStorageFull } from './resourceStorage.js';
import { getLocationBuildingData } from './buildingHelpers.js';
import { attachFirmScroll } from './firmScroll.js';

const COL_W = 220;
const ROW_H = 158;
const CARD_W = 148;
const CARD_H = 118;
const PAD_X = 48;
const PAD_Y = 84;

/** Стартовая строка ветки (визуальное разделение без сайдбара). */
const BRANCH_ROW0 = {
    iron: 0,
    copper: 6,
    carbon: 12,
    wood: 18,
    sulfur: 23,
    concrete: 27,
    silicon: 31,
    oil: 37,
    food: 43,
    mech: 0,
    default: 48
};

const ZOOM_MIN = 0.125;
const ZOOM_MAX = 1;
const ZOOM_STEP = 0.08;

let open = false;
let pan = { active: false, x: 0, y: 0, sl: 0, st: 0 };
let zoom = 1;
let tickTimer = null;
let firmScrollApi = null;

function liveStock(bodyData, resourceId) {
    if (!bodyData || !resourceId) return 0;
    try {
        const v = getStockAmount?.(bodyData, resourceId);
        if (Number.isFinite(Number(v))) return Math.max(0, Number(v));
    } catch (_) {}
    try {
        const s = bodyData.resources?.stock || bodyData.stock || {};
        return Math.max(0, Number(s[resourceId]) || 0);
    } catch (_) {}
    return 0;
}

function resolveBodyData(locId) {
    try {
        if (currentLocation?.data && Number(currentLocation.data.id) === Number(locId)) {
            return currentLocation.data;
        }
    } catch (_) {}
    try {
        const body = state.celestialBodies?.[locId] || state.celestialBodies?.[Number(locId)];
        if (body?.data) return body.data;
        if (body && body.resources) return body;
    } catch (_) {}
    return currentLocation?.data || null;
}

function resourcesCatalog() {
    try {
        const list = getAllResources?.();
        if (Array.isArray(list) && list.length) return list;
    } catch (_) {}
    return Array.isArray(state.resources) ? state.resources : [];
}

function chainResources() {
    return resourcesCatalog().filter(r => r && r.showInProductionChains === true);
}

function branchKey(res) {
    const b = res?.productionChainBranch;
    if (b && BRANCH_ROW0[b] != null) return b;
    const id = String(res?.id || '');
    if (id.includes('IRON') || id.includes('SCREW') || id.includes('REPAIR') || id.includes('CANISTER') || id.includes('TOOL')) return 'iron';
    if (id.includes('COPPER')) return 'copper';
    if (id.includes('CARBON') || id.includes('COAL') || id.includes('ROUGH')) return 'carbon';
    if (id.includes('SULF')) return 'sulfur';
    if (id.includes('LIME') || id.includes('GRAVEL') || id.includes('CONCRETE')) return 'concrete';
    if (id.includes('SILIC') || id.includes('GLASS') || id.includes('PHOTO')) return 'silicon';
    if (id.includes('OIL') || id.includes('CRUDE') || id.includes('ETHYL') || id.includes('PLASTIC') || id.includes('KEROS') || id.includes('ROCKET') || id.includes('OXYGEN') || id.includes('RUBBER')) return 'oil';
    if (id.includes('WOOD') || id.includes('TIMBER') || id.includes('PLANK')) return 'wood';
    if (id.includes('WATER') || id.includes('SAND') || id.includes('LETTUCE') || id.includes('FOOD')) return 'food';
    if (id.includes('STATOR') || id.includes('ROTOR') || id.includes('FRAME') || id.includes('PLATE') || id.includes('MOTOR')) return 'mech';
    return 'default';
}

function absoluteRow(res) {
    const base = BRANCH_ROW0[branchKey(res)] ?? BRANCH_ROW0.default;
    return base + (Number(res.productionChainRow) || 0);
}

function maxTier(list) {
    let m = 0;
    for (const r of list) {
        const tlv = Number(r.productionTechLevel);
        if (Number.isFinite(tlv) && tlv > m) m = tlv;
    }
    return m;
}

function maxAbsRow(list) {
    let m = 0;
    for (const r of list) {
        const row = absoluteRow(r);
        if (row > m) m = row;
    }
    return m;
}

function cardPosition(res) {
    const col = Math.max(0, Number(res.productionTechLevel) || 0);
    const row = absoluteRow(res);
    return {
        x: PAD_X + col * COL_W,
        y: PAD_Y + row * ROW_H
    };
}

function canvasSize(list) {
    const cols = maxTier(list) + 1;
    const rows = maxAbsRow(list) + 1;
    return {
        w: Math.max(900, PAD_X * 2 + cols * COL_W + 80),
        h: Math.max(600, PAD_Y * 2 + rows * ROW_H + 80)
    };
}

function activeLocationRecipes(locId) {
    const out = [];
    try { state.initializeLocationBuildings?.(locId); } catch (_) {}
    const locMap = state.locationBuildings?.[locId] || {};
    for (const buildingId of Object.keys(locMap)) {
        const ld = locMap[buildingId] || getLocationBuildingData?.(locId, buildingId);
        if ((ld?.built_count || 0) <= 0) continue;
        for (const recipe of getRecipesForBuilding(buildingId)) {
            out.push({ recipe, buildingId, locData: ld });
        }
    }
    return out;
}

function collectEdges(sectionResources) {
    const byId = new Map(sectionResources.map(r => [r.id, r]));
    const edges = new Map();
    const catalog = typeof getAllRecipes === 'function' ? getAllRecipes() : [];

    for (const recipe of catalog) {
        const outs = (recipe.outputs || []).filter(o => o.resourceId && byId.has(o.resourceId) && !o.isEffect);
        if (!outs.length) continue;
        const stockIns = (recipe.inputs || []).filter(inp => {
            if (isGeoRecipeInput?.(inp) || inp.geoResourceId) return false;
            const ids = getInputResourceIds?.(inp) || (inp.resourceId ? [inp.resourceId] : []);
            return ids.some(id => byId.has(id));
        });
        for (const inp of stockIns) {
            const ids = getInputResourceIds?.(inp) || (inp.resourceId ? [inp.resourceId] : []);
            for (const fromId of ids) {
                if (!byId.has(fromId)) continue;
                for (const out of outs) {
                    if (fromId === out.resourceId) continue;
                    const key = `${fromId}>${out.resourceId}`;
                    if (!edges.has(key)) edges.set(key, { fromId, toId: out.resourceId, recipeIds: new Set() });
                    edges.get(key).recipeIds.add(recipe.id);
                }
            }
        }
    }
    return [...edges.values()].map(e => ({ fromId: e.fromId, toId: e.toId, recipeIds: [...e.recipeIds] }));
}

function edgeState(locId, bodyData, edge, recipeBindings) {
    let anyPower = false;
    let anyStarved = false;
    let anyRunning = false;

    for (const bind of recipeBindings) {
        const { recipe, buildingId } = bind;
        if (!edge.recipeIds.includes(recipe.id)) continue;
        const localP = getRecipeLocalPower(locId, buildingId, recipe.id);
        if (localP <= 0) continue;
        anyPower = true;
        const eff = getRecipeEffectiveness(locId, buildingId, recipe);
        if (!(eff > 0)) continue;

        let inputOk = true;
        for (const inp of recipe.inputs || []) {
            if (isGeoRecipeInput?.(inp) || inp.geoResourceId) {
                const geoId = resolveInputGeoId?.(inp) || inp.geoResourceId;
                let rem = 0;
                try { rem = getDepositRemainingKg?.(bodyData, geoId) ?? 0; } catch (_) { rem = 0; }
                if (!(rem > 1e-9)) { inputOk = false; break; }
                continue;
            }
            const ids = getInputResourceIds?.(inp) || (inp.resourceId ? [inp.resourceId] : []);
            let haveAny = false;
            if (!ids.length) { inputOk = false; break; }
            for (const id of ids) {
                if (liveStock(bodyData, id) > 1e-9) { haveAny = true; break; }
            }
            if (!haveAny) { inputOk = false; break; }
        }
        if (!inputOk) {
            anyStarved = true;
            continue;
        }
        anyRunning = true;
    }

    const fromHave = liveStock(bodyData, edge.fromId);
    if (!(fromHave > 1e-9)) {
        if (anyPower) return 'starved';
        return 'idle';
    }
    if (anyRunning) return 'active';
    if (anyStarved && anyPower) return 'starved';
    return 'idle';
}

function formatRateLine(resourceId, ratePerMin) {
    const rate = Number(ratePerMin) || 0;
    const abs = Math.abs(rate);
    const res = resourcesCatalog().find(r => r.id === resourceId);
    let unit = res?.unit || 'кг';
    if (resourceId === 'RES_WATER') unit = t('unit.L') || 'л';
    const per = t('unit.min') || 'мин';
    if (abs < 1e-9) return `0 ${unit}/${per}`;
    const val = abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
    const sign = rate > 0 ? '+' : '−';
    return `${sign}${val} ${unit}/${per}`;
}

function trendClass(net) {
    if (net > 1e-9) return 'pc-trend-up';
    if (net < -1e-9) return 'pc-trend-down';
    return 'pc-trend-flat';
}

let _pcBound = false;
/** Анти-мерцание трендов в карточках цепочек (особенно LOX у потолка склада). */
const _pcTrendDir = Object.create(null);
const PC_TREND_HOLD = 0.08;
function stablePcNet(id, net, pot, cons, bodyData, locId) {
    let n = Number(net) || 0;
    const potV = Number(pot) || 0;
    const consV = Number(cons) || 0;
    try {
        if (typeof isResourceStorageFull === 'function' && isResourceStorageFull(locId, id, bodyData) && potV > 0) {
            if (potV >= consV - 1e-12) n = 0;
            else n = potV - consV;
        }
    } catch (_) {}
    const prev = _pcTrendDir[id] || 0;
    let dir = 0;
    if (n > 1e-9) dir = 1;
    else if (n < -1e-9) dir = -1;
    if (prev !== 0 && dir !== 0 && dir !== prev && Math.abs(n) < PC_TREND_HOLD) dir = prev;
    if (dir === 0 && prev !== 0 && Math.abs(n) > 1e-9 && Math.abs(n) < PC_TREND_HOLD) dir = prev;
    _pcTrendDir[id] = dir;
    if (dir === 0) return 0;
    if (dir > 0 && n <= 0) return Math.max(n, 1e-6);
    if (dir < 0 && n >= 0) return Math.min(n, -1e-6);
    return n;
}


function ensurePanel() {
    let panel = document.getElementById('production-chains-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'production-chains-panel';
        document.body.appendChild(panel);
    }
    panel.classList.add('pc-panel');
    panel.removeAttribute('style');

    // пересобираем разметку если нет фикс-слоя фона
    if (!panel.dataset.pcReady || !panel.querySelector('.pc-tree-bg')) {
        panel.dataset.pcReady = '';

        panel.innerHTML = `
            <div class="pc-header">
                <div class="pc-title">${t('pc.title') || 'Цепочки производства'}</div>
                <button type="button" class="pc-close" data-pc-close>×</button>
            </div>
            <div class="pc-body">
                <div class="pc-tree-bg" aria-hidden="true">
                    <div class="pc-tree-grid-fixed"></div>
                    <div class="pc-tree-glows"></div>
                </div>
                <div class="pc-tree-viewport" id="pc-tree-viewport">
                    <div class="pc-zoom-world" id="pc-zoom-world">
                        <div class="pc-tree-canvas" id="pc-tree-canvas"></div>
                    </div>
                </div>
            </div>
        `;
        panel.dataset.pcReady = '1';
        _pcBound = false; // переподключить слушатели после rebuild
    }

    if (!_pcBound) {
        _pcBound = true;
        panel.querySelector('[data-pc-close]')?.addEventListener('click', () => closeProductionChains());

        const vp = panel.querySelector('#pc-tree-viewport');
        if (vp) {
            vp.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                if (e.target.closest?.('.pc-card')) return;
                pan.active = true;
                pan.x = e.clientX;
                pan.y = e.clientY;
                pan.sl = vp.scrollLeft;
                pan.st = vp.scrollTop;
                vp.classList.add('pc-panning');
                try { vp.setPointerCapture(e.pointerId); } catch (_) {}
            });
            vp.addEventListener('pointermove', (e) => {
                if (!pan.active) return;
                vp.scrollLeft = pan.sl - (e.clientX - pan.x);
                vp.scrollTop = pan.st - (e.clientY - pan.y);
            });
            const endPan = (e) => {
                if (!pan.active) return;
                pan.active = false;
                vp.classList.remove('pc-panning');
                try { vp.releasePointerCapture(e.pointerId); } catch (_) {}
            };
            vp.addEventListener('pointerup', endPan);
            vp.addEventListener('pointercancel', endPan);

            vp.addEventListener('wheel', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = vp.getBoundingClientRect();
                const mx = e.clientX - rect.left + vp.scrollLeft;
                const my = e.clientY - rect.top + vp.scrollTop;
                const worldX = mx / zoom;
                const worldY = my / zoom;

                const dir = e.deltaY > 0 ? -1 : 1;
                const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + dir * ZOOM_STEP));
                if (Math.abs(next - zoom) < 1e-6) return;
                zoom = next;
                applyZoom(vp);

                vp.scrollLeft = worldX * zoom - (e.clientX - rect.left);
                vp.scrollTop = worldY * zoom - (e.clientY - rect.top);
            }, { passive: false });

            try {
                firmScrollApi = attachFirmScroll(vp, { axis: 'both' });
            } catch (e) {
                console.warn('firmScroll', e);
            }
        }
    }

    return panel;
}

function applyZoom(vp) {
    const world = document.getElementById('pc-zoom-world');
    const canvas = document.getElementById('pc-tree-canvas');
    if (!world || !canvas) return;
    const w = Number(canvas.dataset.worldW) || 900;
    const h = Number(canvas.dataset.worldH) || 600;
    canvas.style.transform = `scale(${zoom})`;
    canvas.style.transformOrigin = '0 0';
    world.style.width = `${Math.ceil(w * zoom)}px`;
    world.style.height = `${Math.ceil(h * zoom)}px`;
    try { firmScrollApi?.update(); } catch (_) {}
}

function bindCardEdgeHover(canvas) {
    if (!canvas) return;
    const svg = canvas.querySelector('.pc-edges');
    if (!svg) return;
    const clear = () => {
        svg.querySelectorAll('path.pc-edge-hl').forEach(p => p.classList.remove('pc-edge-hl'));
        canvas.querySelectorAll('.pc-card-parent-hl').forEach(c => c.classList.remove('pc-card-parent-hl'));
    };
    canvas.querySelectorAll('.pc-card').forEach(card => {
        card.addEventListener('pointerenter', () => {
            clear();
            const id = card.getAttribute('data-res-id');
            if (!id) return;
            svg.querySelectorAll(`path.pc-edge[data-to="${id}"]`).forEach(p => {
                p.classList.add('pc-edge-hl');
                const fromId = p.getAttribute('data-from');
                if (fromId) {
                    const parent = canvas.querySelector(`.pc-card[data-res-id="${fromId}"]`);
                    if (parent) parent.classList.add('pc-card-parent-hl');
                }
            });
        });
        card.addEventListener('pointerleave', clear);
    });
}

function renderTree() {
    const panel = ensurePanel();
    const canvas = panel.querySelector('#pc-tree-canvas');
    if (!canvas) return;

    const locId = Number(currentLocation?.data?.id);
    const bodyData = resolveBodyData(locId);
    try { refreshLocationStockFlows?.(locId, bodyData); } catch (_) {}
    const flows = getLocationStockFlows?.(locId) || { prod: {}, cons: {}, net: {} };
    const list = chainResources();
    const binds = activeLocationRecipes(locId);
    const edges = collectEdges(list);
    const size = canvasSize(list);

    canvas.dataset.worldW = String(size.w);
    canvas.dataset.worldH = String(size.h);
    canvas.style.width = size.w + 'px';
    canvas.style.height = size.h + 'px';

    let tierHtml = '';
    const tiers = maxTier(list);
    for (let i = 0; i <= tiers; i++) {
        const lx = PAD_X + i * COL_W - 36;
        tierHtml += `<div class="pc-tier-divider" data-tier="${i}" style="left:${lx}px;">
            <span class="pc-tier-label">T${i}</span>
        </div>`;
    }

    let bandHtml = '';
    const usedBranches = new Set(list.map(branchKey));
    const branchFallback = {
        iron: 'Железо', copper: 'Медь', carbon: 'Углерод', wood: 'Древесина',
        sulfur: 'Сера', concrete: 'Бетон', silicon: 'Кремний', oil: 'Каустобиолиты',
        food: 'Продовольствие', mech: 'Узлы', default: 'Прочее'
    };
    // mech делит вертикаль с iron — подпись «Узлы» не дублируем на той же высоте
    for (const [key, row0] of Object.entries(BRANCH_ROW0)) {
        if (key === 'default' || key === 'mech' || !usedBranches.has(key)) continue;
        const y = PAD_Y + row0 * ROW_H - 52;
        const raw = t(`pc.branch.${key}`);
        const label = (raw && raw !== `pc.branch.${key}`) ? raw : (branchFallback[key] || key);
        bandHtml += `<div class="pc-branch-label" style="top:${y}px;left:${Math.max(6, PAD_X - 12)}px;">
            <span class="pc-branch-label-text">${label}</span>
            <span class="pc-branch-label-line" aria-hidden="true"></span>
        </div>`;
    }

    let cardsHtml = '';
    const posMap = new Map();
    for (const res of list) {
        const pos = cardPosition(res);
        posMap.set(res.id, pos);
        const prod = Number(flows.prod?.[res.id]) || 0;
        const cons = Number(flows.cons?.[res.id]) || 0;
        let net = Number(flows.net?.[res.id]) || (prod - cons);
        net = stablePcNet(res.id, net, flows.potProd?.[res.id], cons, bodyData, locId);
        const name = locName(res.name) || res.id;
        const icon = res.icon || 'assets/textures/icons/unknown.png';
        const rateText = formatRateLine(res.id, net);
        const trCls = trendClass(net);
        cardsHtml += `
        <div class="pc-card" data-res-id="${res.id}" data-branch="${branchKey(res)}"
             style="left:${pos.x}px;top:${pos.y}px;width:${CARD_W}px;height:${CARD_H}px;">
            <div class="pc-card-icon-wrap">
                <img class="pc-card-icon" src="${icon}" alt="" draggable="false">
            </div>
            <div class="pc-card-name" data-full-name="${name.replace(/"/g, '&quot;')}">${name}</div>
            <div class="pc-card-rate ${trCls}">
                <span class="pc-trend-tri"></span>
                <span class="pc-rate-text">${rateText}</span>
            </div>
        </div>`;
    }

    let paths = '';
    for (const edge of edges) {
        const a = posMap.get(edge.fromId);
        const b = posMap.get(edge.toId);
        if (!a || !b) continue;
        const x1 = a.x + CARD_W;
        const y1 = a.y + CARD_H / 2;
        const x2 = b.x;
        const y2 = b.y + CARD_H / 2;
        const dx = Math.max(40, (x2 - x1) * 0.45);
        const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        const st = edgeState(locId, bodyData, edge, binds);
        paths += `<path class="pc-edge pc-edge-${st}" data-edge="${edge.fromId}>${edge.toId}" data-from="${edge.fromId}" data-to="${edge.toId}" d="${d}" fill="none" />`;
    }

    canvas.innerHTML = `
        ${tierHtml}
        ${bandHtml}
        <svg class="pc-edges" width="${size.w}" height="${size.h}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>
        ${cardsHtml}
    `;

    const vp = panel.querySelector('#pc-tree-viewport');
    applyZoom(vp);
    bindCardEdgeHover(canvas);
    try { firmScrollApi?.update(); } catch (_) {}
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            try { bindPcCardNameTips(canvas); } catch (_) {}
        });
    });

    const title = panel.querySelector('.pc-title');
    if (title) title.textContent = t('pc.title') || 'Цепочки производства';
}

function softUpdateTree() {
    const panel = document.getElementById('production-chains-panel');
    if (!panel || !open) return;
    const locId = Number(currentLocation?.data?.id);
    const bodyData = resolveBodyData(locId);
    try { refreshLocationStockFlows?.(locId, bodyData); } catch (_) {}
    const flows = getLocationStockFlows?.(locId) || { prod: {}, cons: {}, net: {} };
    const binds = activeLocationRecipes(locId);
    const edges = collectEdges(chainResources());

    try { bindPcCardNameTips(panel); } catch (_) {}
    panel.querySelectorAll('.pc-card').forEach(card => {
        const id = card.getAttribute('data-res-id');
        if (!id) return;
        let net = Number(flows.net?.[id]) || ((Number(flows.prod?.[id]) || 0) - (Number(flows.cons?.[id]) || 0));
        net = stablePcNet(id, net, flows.potProd?.[id], flows.cons?.[id], bodyData, locId);
        const rateEl = card.querySelector('.pc-card-rate');
        const textEl = card.querySelector('.pc-rate-text');
        if (rateEl) {
            rateEl.classList.remove('pc-trend-up', 'pc-trend-down', 'pc-trend-flat');
            rateEl.classList.add(trendClass(net));
        }
        if (textEl) textEl.textContent = formatRateLine(id, net);
    });

    const svg = panel.querySelector('.pc-edges');
    if (svg) {
        const edgeByKey = new Map(edges.map(e => [`${e.fromId}>${e.toId}`, e]));
        svg.querySelectorAll('path.pc-edge').forEach(path => {
            const key = path.getAttribute('data-edge');
            const edge = key ? edgeByKey.get(key) : null;
            if (!edge) return;
            const st = edgeState(locId, bodyData, edge, binds);
            const wasHl = path.classList.contains('pc-edge-hl');
            path.setAttribute('class', `pc-edge pc-edge-${st}${wasHl ? ' pc-edge-hl' : ''}`);
        });
    }
    try { firmScrollApi?.update(); } catch (_) {}
}


export function initProductionChainsUI() {
    try { ensurePanel(); } catch (_) {}
}

export function showProductionChainsPanel(show) {
    if (show) openProductionChains();
    else closeProductionChains();
}

export function refreshProductionChainsPanel() {
    if (open) softUpdateTree();
}

export function openProductionChains() {
    const panel = ensurePanel();
    open = true;
    zoom = 1;
    panel.classList.add('open');
    renderTree();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
        if (!open) return;
        softUpdateTree();
    }, 500);
}

export function closeProductionChains() {
    open = false;
    const panel = document.getElementById('production-chains-panel');
    if (panel) panel.classList.remove('open');
    if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
    }
}

export function toggleProductionChains() {
    if (open) closeProductionChains();
    else openProductionChains();
}

export function isProductionChainsOpen() {
    return open;
}

export function refreshProductionChainsIfOpen() {
    if (open) softUpdateTree();
}

try {
    onLanguageChange?.(() => {
        if (open) renderTree();
    });
} catch (_) {}
