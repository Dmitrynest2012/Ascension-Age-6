/**
 * buildingResourceCosts.js — требования/возврат ресурсов при стройке и улучшении.
 *
 * JSON (buildings.json):
 *   ResourceCosts: [
 *     [ { resourceId, amount }, ... ],  // индекс = уровень здания
 *     ...
 *   ]
 *   ResourceRefundFactor?: number  // 0..1, по умолчанию 0.5 (доля возврата при разборе/ухудшении)
 *
 * build:     стоимость ResourceCosts[currentLevel] × 1
 * upgrade:   стоимость ResourceCosts[currentLevel+1] × built_count
 * dismantle: возврат sum(ResourceCosts[0..currentLevel]) × 1 × refundFactor
 *            (лом одной единицы на текущем уровне — накопленные вложения)
 * downgrade: возврат ResourceCosts[currentLevel] × built_count × refundFactor
 *            (только шаг последнего улучшения для всех единиц)
 *
 * Списание — в момент старта build/upgrade.
 * Возврат — по завершении dismantle/downgrade.
 */

import { locName, t } from './settings.js';
import { getResource, getStockAmount, setStockAmount } from './recipes.js';
import { getLocationBuildingData } from './buildingHelpers.js';

export const DEFAULT_REFUND_FACTOR = 0.5;

/** Нормализованный список {resourceId, amount} для уровня */
export function getLevelCostEntries(template, level) {
    if (!template) return [];
    const table = template.ResourceCosts || template.resourceCosts;
    if (!Array.isArray(table) || !table.length) return [];
    const lvl = Math.max(0, Math.floor(Number(level) || 0));
    const idx = Math.min(lvl, table.length - 1);
    const row = table[idx];
    if (!Array.isArray(row)) return [];
    return row
        .map(e => ({
            resourceId: e.resourceId || e.id,
            amount: Math.max(0, Number(e.amount) || 0)
        }))
        .filter(e => e.resourceId && e.amount > 0);
}

export function getRefundFactor(template) {
    const f = Number(template?.ResourceRefundFactor ?? template?.resourceRefundFactor);
    if (Number.isFinite(f) && f >= 0) return Math.min(1, f);
    return DEFAULT_REFUND_FACTOR;
}

/**
 * @param {'build'|'upgrade'|'dismantle'|'downgrade'} actionType
 * @returns {{ mode: 'cost'|'refund', entries: {resourceId, amount}[], levelUsed: number, mult: number } | null}
 * null — у здания нет ResourceCosts (старая логика без ресурсов)
 */
export function resolveActionResourceList(template, locData, actionType) {
    const table = template?.ResourceCosts || template?.resourceCosts;
    if (!Array.isArray(table) || !table.length) return null;

    const level = Math.max(0, Number(locData?.currentLevel) || 0);
    const count = Math.max(0, Number(locData?.built_count) || 0);

    if (actionType === 'build') {
        const entries = getLevelCostEntries(template, level);
        if (!entries.length) return { mode: 'cost', entries: [], levelUsed: level, mult: 1 };
        return {
            mode: 'cost',
            entries: entries.map(e => ({ ...e, amount: e.amount })),
            levelUsed: level,
            mult: 1
        };
    }
    if (actionType === 'upgrade') {
        const next = level + 1;
        const entries = getLevelCostEntries(template, next);
        const mult = Math.max(1, count);
        return {
            mode: 'cost',
            entries: entries.map(e => ({ resourceId: e.resourceId, amount: e.amount * mult })),
            levelUsed: next,
            mult
        };
    }
    if (actionType === 'dismantle') {
        // Накопленная стоимость одной единицы 0..level (стройка + все апгрейды до текущего)
        const factor = getRefundFactor(template);
        const merged = new Map();
        for (let lv = 0; lv <= level; lv++) {
            for (const e of getLevelCostEntries(template, lv)) {
                merged.set(e.resourceId, (merged.get(e.resourceId) || 0) + e.amount);
            }
        }
        return {
            mode: 'refund',
            entries: [...merged.entries()].map(([resourceId, amount]) => ({
                resourceId,
                amount: Math.floor(amount * factor)
            })).filter(e => e.amount > 0),
            levelUsed: level,
            mult: 1
        };
    }
    if (actionType === 'downgrade') {
        // Только стоимость шага level-1 → level (то, что платили при upgrade на этот уровень)
        // при level 0 кнопка и так locked
        const entries = getLevelCostEntries(template, level);
        const factor = getRefundFactor(template);
        const mult = Math.max(1, count);
        return {
            mode: 'refund',
            entries: entries.map(e => ({
                resourceId: e.resourceId,
                amount: Math.floor(e.amount * mult * factor)
            })).filter(e => e.amount > 0),
            levelUsed: level,
            mult
        };
    }
    return null;
}

export function hasResourceCostTable(template) {
    const table = template?.ResourceCosts || template?.resourceCosts;
    return Array.isArray(table) && table.length > 0;
}

/** Хватает ли набора entries на складе */
export function canAffordEntries(bodyData, entries) {
    if (!entries?.length) return true;
    for (const e of entries) {
        if (getStockAmount(bodyData, e.resourceId) + 1e-9 < (Number(e.amount) || 0)) return false;
    }
    return true;
}

export function spendEntries(bodyData, entries) {
    if (!entries?.length) return true;
    if (!canAffordEntries(bodyData, entries)) return false;
    for (const e of entries) {
        const have = getStockAmount(bodyData, e.resourceId);
        setStockAmount(bodyData, e.resourceId, have - (Number(e.amount) || 0));
    }
    return true;
}

export function refundEntries(bodyData, entries) {
    if (!entries?.length) return;
    for (const e of entries) {
        const have = getStockAmount(bodyData, e.resourceId);
        setStockAmount(bodyData, e.resourceId, have + (Number(e.amount) || 0));
    }
}

/** Хватает ли ресурсов на cost-действие (refund всегда «можно») */
export function canAffordAction(bodyData, template, locData, actionType) {
    const resolved = resolveActionResourceList(template, locData, actionType);
    if (!resolved) return true;
    if (resolved.mode === 'refund') return true;
    for (const e of resolved.entries) {
        if (getStockAmount(bodyData, e.resourceId) + 1e-9 < e.amount) return false;
    }
    return true;
}

/** Списать ресурсы (build/upgrade). false если не хватило. */
export function spendActionResources(bodyData, template, locData, actionType) {
    const resolved = resolveActionResourceList(template, locData, actionType);
    if (!resolved || resolved.mode !== 'cost') return true;
    if (!canAffordAction(bodyData, template, locData, actionType)) return false;
    for (const e of resolved.entries) {
        const have = getStockAmount(bodyData, e.resourceId);
        setStockAmount(bodyData, e.resourceId, have - e.amount);
    }
    return true;
}

/** Вернуть ресурсы (после dismantle/downgrade). */
export function refundActionResources(bodyData, template, locData, actionType) {
    const resolved = resolveActionResourceList(template, locData, actionType);
    if (!resolved || resolved.mode !== 'refund') return;
    for (const e of resolved.entries) {
        const have = getStockAmount(bodyData, e.resourceId);
        setStockAmount(bodyData, e.resourceId, have + e.amount);
    }
}

function formatPiecesCount(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)} ${t('unit.trillionPcs') || 'трлн шт.'}`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} ${t('unit.billionPcs') || 'млрд шт.'}`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} ${t('unit.millionPcs') || 'млн шт.'}`;
    if (n >= 1000) return `${(n / 1000).toFixed(2)} ${t('unit.thousandPcs') || 'тыс. шт.'}`;
    return `${n} ${t('unit.pcs') || 'шт.'}`;
}

/**
 * Штучный ресурс (isPieceItem): показываем количество штук, не кг.
 * amount в ResourceCosts / на складе — в кг; pcs = floor(kg / packageWeightKg).
 */
function formatAmount(amount, resMeta) {
    const n = Number(amount) || 0;
    if (resMeta?.isPieceItem) {
        const w = Number(resMeta.packageWeightKg) || 0;
        // если вес упаковки задан — переводим кг → шт.; иначе amount уже считается штуками
        const pcs = w > 0 ? Math.floor(Math.max(0, n) / w) : Math.floor(Math.max(0, n));
        return formatPiecesCount(pcs);
    }
    const unit = resMeta?.unit
        ? (typeof resMeta.unit === 'object' ? locName(resMeta.unit) : String(resMeta.unit))
        : (t('unit.kg') || 'кг');
    let num;
    if (n >= 1e6) num = (n / 1e6).toFixed(2) + ' ' + (t('prefix.million') || 'млн');
    else if (n >= 1e3) num = (n / 1e3).toFixed(2) + ' ' + (t('prefix.thousand') || 'тыс.');
    else num = (Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : n.toFixed(1));
    return `${num} ${unit}`;
}

const PLAN_HINT_FALLBACK = {
    sameLevel: 'Целевой уровень совпадает с текущим — операция не нужна',
    levelNotHigher: 'Для улучшения укажите уровень выше текущего',
    levelNotLower: 'Для ухудшения укажите уровень ниже текущего',
    sameCount: 'Целевое количество совпадает с текущим — операция не нужна',
    aboveMaxLevel: 'Нельзя улучшить здание выше максимального уровня',
    atMaxLevel: 'Здание уже на максимальном уровне',
    belowMinLevel: 'Уровень не может быть ниже 0',
    countNotHigher: 'Для постройки укажите количество больше текущего',
    countNotLower: 'Для разбора укажите количество меньше текущего',
    nothingToDismantle: 'Нечего разбирать — зданий нет',
    nothingToDowngrade: 'Нечего ухудшать — уровень уже минимальный',
    maxCount: 'Достигнут лимит количества зданий этого типа',
    invalid: 'Некорректное значение плана'
};

function resolvePlanHintHtml(resolved) {
    if (resolved?.noOp || resolved?.steps === 0 || (resolved && !resolved.entries?.length && resolved.reason)) {
        const reason = resolved?.reason || 'invalid';
        const key = 'plan.hint.' + reason;
        const text = t(key);
        // t() иногда возвращает сам ключ — тогда fallback на RU
        const safe = (text && text !== key) ? text : (PLAN_HINT_FALLBACK[reason] || PLAN_HINT_FALLBACK.invalid);
        return `<div class="brc-empty brc-hint">${safe}</div>`;
    }
    if (!resolved || !resolved.entries?.length) {
        const text = t('building.costs.none');
        const safe = (text && text !== 'building.costs.none') ? text : 'Нет требований по ресурсам';
        return `<div class="brc-empty">${safe}</div>`;
    }
    return null;
}

/** HTML карточек */
export function renderCostCardsHtml(bodyData, resolved, opts = {}) {
    const hint = resolvePlanHintHtml(resolved);
    if (hint) return hint;
    const isCost = resolved.mode === 'cost';
    const triClass = isCost ? 'brc-tri cost' : 'brc-tri refund';
    const tri = isCost ? '▼' : '▲';
    // пока операция идёт — ресурсы уже списаны, склад не сверяем
    const skipStock = !!(opts.skipStockCheck || resolved.skipStockCheck);

    return resolved.entries.map(e => {
        const meta = getResource(e.resourceId);
        const name = meta ? locName(meta.name) : e.resourceId;
        const icon = meta?.icon || '';
        const have = getStockAmount(bodyData, e.resourceId);
        const need = e.amount;
        let state = 'ok';
        if (isCost && !skipStock) {
            if (have <= 0) state = 'missing';
            else if (have + 1e-9 < need) state = 'lack';
        }
        const amtStr = formatAmount(need, meta);
        return `
        <div class="brc-card state-${state}" data-res="${e.resourceId}">
            <span class="${triClass}" aria-hidden="true">${tri}</span>
            <div class="brc-icon-wrap">${icon ? `<img src="${icon}" alt="">` : ''}</div>
            <div class="brc-text">
                <div class="brc-name">${name}</div>
                <div class="brc-amt">${amtStr}</div>
            </div>
        </div>`;
    }).join('');
}

/* ── UI panel ─────────────────────────────────────────────── */

let _hoverAction = null;

export function setCostHoverAction(actionTypeOrNull) {
    _hoverAction = actionTypeOrNull || null;
}

export function getCostHoverAction() {
    return _hoverAction;
}

export function ensureCostPanelDom() {
    let el = document.getElementById('building-resource-costs');
    if (el) return el;
    const parent = document.getElementById('building-controls-container');
    if (!parent) return null;
    el = document.createElement('div');
    el.id = 'building-resource-costs';
    el.className = 'building-resource-costs';
    el.innerHTML = '<div id="building-resource-costs-inner" class="building-resource-costs-inner"></div>';
    parent.appendChild(el);
    return el;
}

/**
 * Обновить панель.
 * @param {object} opts
 * @param {object} opts.template
 * @param {object} opts.locData
 * @param {object} opts.bodyData
 * @param {string} [opts.forceAction] — если идёт pending или hover
 * @param {boolean} [opts.open]
 */
export function updateBuildingCostPanel({ template, locData, bodyData, forceAction = null, open = false, resolvedOverride = null, skipStockCheck = false }) {
    const panel = ensureCostPanelDom();
    if (!panel) return;
    const inner = document.getElementById('building-resource-costs-inner');
    if (!inner) return;

    if (!hasResourceCostTable(template) && !resolvedOverride) {
        panel.classList.remove('open');
        inner.innerHTML = '';
        return;
    }

    const action = forceAction || _hoverAction;
    if (!open || !action) {
        panel.classList.remove('open');
        return;
    }

    const resolved = resolvedOverride || resolveActionResourceList(template, locData, action);
    if (!resolved) {
        panel.classList.remove('open');
        return;
    }
    inner.innerHTML = renderCostCardsHtml(bodyData, resolved, { skipStockCheck });
    panel.classList.add('open');
}

/**
 * Упрощённый API: показать/скрыть по hover + pending.
 */
export function refreshBuildingCostPanel(locationId, buildingId, template, bodyData, hoverAction = null) {
    const panel = ensureCostPanelDom();
    if (!panel) return;
    const inner = document.getElementById('building-resource-costs-inner');
    if (!inner) return;

    if (!hasResourceCostTable(template)) {
        panel.classList.remove('open');
        inner.innerHTML = '';
        return;
    }

    const locData = getLocationBuildingData(locationId, buildingId);
    const action = hoverAction || _hoverAction;
    const pending = locData?.pendingAction || null;

    if (!action && !pending) {
        panel.classList.remove('open');
        return;
    }

    const act = action || pending?.type;
    let resolved = null;
    if (pending && Array.isArray(pending.refundEntries) && pending.refundEntries.length && (pending.type === 'dismantle' || pending.type === 'downgrade')) {
        resolved = { mode: 'refund', entries: pending.refundEntries };
    } else if (pending && Array.isArray(pending.costEntries) && pending.costEntries.length) {
        // ресурсы уже списаны в момент старта
        resolved = { mode: 'cost', entries: pending.costEntries };
    } else if (pending && (pending.type === 'build' || pending.type === 'upgrade')) {
        resolved = resolveActionResourceList(template, locData, pending.type);
    } else {
        resolved = resolveActionResourceList(template, locData, act);
    }
    // пока операция идёт — не красим карточки по текущему складу
    const skipStock = !!pending;
    inner.innerHTML = renderCostCardsHtml(bodyData, resolved || { mode: 'cost', entries: [] }, { skipStockCheck: skipStock });
    panel.classList.add('open');
}

export function closeBuildingCostPanel() {
    const panel = document.getElementById('building-resource-costs');
    if (panel) panel.classList.remove('open');
    _hoverAction = null;
}
