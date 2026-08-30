/**
 * Склады ресурсов.
 *
 * Категории:
 *  3a — solid + liquid
 *  3b — solid
 *  3c — liquid
 *  2a — solid + liquid + gas
 *  2b — gas
 *  1a — solid + liquid + gas + plasma + exotic
 *  1b — plasma
 *  1c — exotic
 *
 * Вместимость ресурса R на локации (максимум):
 *   storageStackSize(R) × Σ( baseMult(level)×count + bonusFromRecipes ) по складам, принимающим form(R).
 *   baseMult — ResourceStorageCapacity[level] (всегда).
 *   bonus — рецепт RCP_WAREHOUSE_MAINTENANCE (опционально расширяет).
 * Каждый ресурс имеет СВОЙ потолок — можно одновременно держать max по каждому.
 *
 * «Текущая заполненность» (percent) для UI:
 *   считаются ТОЛЬКО ресурсы с количеством > 0
 *   percent = Σ have / Σ cap  по этим ресурсам
 *   (пустые позиции не размывают процент)
 *
 * Пример: еда 10/100, салат 0/100 → 10/100 = 10%
 *         еда 10/100, салат 10/100 → 20/200 = 10%
 */
import { state } from './state.js';
import { getBuildingStorageBonusMultiplier, buildingHasStorageCapacityRecipe } from './recipes.js';
import { getLocationBuildingData } from './buildingHelpers.js';
import { isChapter2Done } from './uiMasks.js';

const CATEGORY_FORMS = {
    '3a': ['solid', 'liquid'],
    '3b': ['solid'],
    '3c': ['liquid'],
    '2a': ['solid', 'liquid', 'gas'],
    '2b': ['gas'],
    '1a': ['solid', 'liquid', 'gas', 'plasma', 'exotic'],
    '1b': ['plasma'],
    '1c': ['exotic']
};

const CATEGORY_SPECIFICITY = {
    '3b': 30, '3c': 30, '2b': 30, '1b': 30, '1c': 30,
    '3a': 20,
    '2a': 10,
    '1a': 5
};

function resourceCatalog() {
    if (globalThis.__resourceCatalog instanceof Map) {
        return Array.from(globalThis.__resourceCatalog.values());
    }
    return state.resources || [];
}

export function getStockMap(bodyData) {
    if (!bodyData) return {};
    if (!bodyData.resources) bodyData.resources = {};
    if (!bodyData.resources.stock || typeof bodyData.resources.stock !== 'object') {
        bodyData.resources.stock = {};
    }
    const stock = bodyData.resources.stock;
    if (Object.prototype.hasOwnProperty.call(stock, 'RES_SOIL')) {
        stock.RES_SAND = (Number(stock.RES_SAND) || 0) + (Number(stock.RES_SOIL) || 0);
        delete stock.RES_SOIL;
    }
    return stock;
}

export function getResourceMeta(resourceId) {
    if (globalThis.__resourceCatalog instanceof Map) {
        return globalThis.__resourceCatalog.get(resourceId) || null;
    }
    return resourceCatalog().find(r => r.id === resourceId) || null;
}

export function categoryAcceptsForm(category, form) {
    const forms = CATEGORY_FORMS[category];
    if (!forms || !form) return false;
    return forms.includes(form);
}

export function getStorageMultiplier(template, level) {
    const arr = template?.ResourceStorageCapacity;
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const lvl = Math.max(0, Number(level) || 0);
    const idx = Math.min(Math.max(lvl - 1, 0), arr.length - 1);
    return Number(arr[idx]) || 0;
}

export function isStorageBuilding(template) {
    return !!(template?.IsResourceStorage);
}

/**
 * Склад Базы Космистов: маска снята только после ЗАВЕРШЕНИЯ главы 2
 * (квест QST_INTRO_002 в completed). Пока глава 2 не пройдена — «неизвестно».
 */
export function isStorageInfoRevealed(buildingId) {
    // Как isBuildingInfoMasked: База Космистов маскируется до завершения главы II (QST_INTRO_003)
    if (buildingId !== 'CONSTRC001' && buildingId !== 'CONSTRC0011') return true;
    try {
        return isChapter2Done();
    } catch (_) {
        return false;
    }
}

export function listLocationStorageUnits(locationId) {
    const locId = Number(locationId);
    state.initializeLocationBuildings?.(locId);
    const locMap = state.locationBuildings?.[locId] || {};
    const units = [];
    for (const buildingId of Object.keys(locMap)) {
        const template = (state.buildings || []).find(b => b.id === buildingId);
        if (!isStorageBuilding(template)) continue;
        const locData = getLocationBuildingData(locId, buildingId) || locMap[buildingId];
        const count = Number(locData?.built_count) || 0;
        if (count <= 0) continue;
        const level = Number(locData?.currentLevel) || Number(template.currentLevel) || 1;
        const baseMult = getStorageMultiplier(template, level);
        // бонус от рецепта «Обслуживание склада» (уже включает count)
        let bonusTotal = 0;
        try {
            if (buildingHasStorageCapacityRecipe(buildingId)) {
                bonusTotal = getBuildingStorageBonusMultiplier(locId, buildingId);
            }
        } catch (_) { bonusTotal = 0; }
        // effective per-unit mult: base + bonus/count (count учтём снаружи как base*count + bonus)
        if (baseMult <= 0 && bonusTotal <= 0) continue;
        units.push({
            buildingId,
            category: template.ResourceStorageCategory || '3a',
            level,
            count,
            multiplier: baseMult,
            bonusMultiplierTotal: bonusTotal,
            template
        });
    }
    return units;
}

/**
 * Макс. вместимость одного ресурса (свой потолок):
 * stack × Σ(mult × count) по складам, принимающим form ресурса.
 */
export function getResourceMaxCapacity(locationId, resourceId) {
    const meta = getResourceMeta(resourceId);
    if (!meta) return 0;
    if (meta.infinite) return Infinity;
    const form = meta.form;
    if (!form || form === 'energy' || form === 'tech' || form === 'info' || meta.isEffect) return 0;
    const stack = Number(meta.storageStackSize) || 0;
    if (stack <= 0) return 0;

    let total = 0;
    for (const u of listLocationStorageUnits(locationId)) {
        if (!categoryAcceptsForm(u.category, form)) continue;
        // база: stack × mult × count  +  бонус рецепта: stack × bonusTotal
        total += stack * (u.multiplier * u.count + (Number(u.bonusMultiplierTotal) || 0));
    }
    return total;
}

/**
 * Процент заполненности по набору ресурсов.
 * Учитываются ТОЛЬКО ресурсы с have > 0.
 * percent = Σ have / Σ cap.
 */
function fillFromResourceList(locationId, bodyData, resourceList) {
    const stockMap = getStockMap(bodyData);
    let stored = 0;
    let max = 0;
    for (const res of resourceList) {
        if (!res || res.infinite || res.isEffect) continue;
        if (!res.form || res.form === 'energy' || res.form === 'tech' || res.form === 'info') continue;
        const cap = getResourceMaxCapacity(locationId, res.id);
        if (!Number.isFinite(cap) || cap <= 0) continue;
        const have = Math.max(0, Number(stockMap[res.id]) || 0);
        // пустая позиция не участвует ни в числителе, ни в знаменателе
        if (have <= 0) continue;
        stored += Math.min(have, cap);
        max += cap;
    }
    const percent = max > 0 ? (stored / max) * 100 : 0;
    return { stored, max, percent };
}

/** Заполненность всех складов локации (только ненулевые ресурсы) */
export function getLocationStorageFill(locationId, bodyData) {
    return fillFromResourceList(locationId, bodyData, resourceCatalog());
}

/**
 * Заполненность раздела (сырьё / материалы / продовольствие).
 * Только ресурсы раздела с количеством > 0.
 */
export function getSectionStorageFill(locationId, bodyData, sectionKey) {
    const map = {
        'Сырье': 'raw',
        'Материалы': 'materials',
        'Компоненты': 'components',
        'Продукция': 'products',
        'Продовольствие': 'food'
    };
    const key = map[sectionKey] || sectionKey;
    const list = resourceCatalog().filter(r => r.resourceBarSection === key);
    return fillFromResourceList(locationId, bodyData, list);
}

/**
 * Заполненность одного здания-склада.
 * Маска Базы Космистов — до завершения главы 2.
 */
export function getBuildingStorageFill(locationId, buildingId, bodyData) {
    const template = (state.buildings || []).find(b => b.id === buildingId);
    if (!isStorageBuilding(template)) return null;
    if (!isStorageInfoRevealed(buildingId)) {
        return { revealed: false, stored: 0, max: 0, percent: 0 };
    }

    const locData = getLocationBuildingData(locationId, buildingId);
    const count = Number(locData?.built_count) || 0;
    const level = Number(locData?.currentLevel) || 1;
    const baseMult = getStorageMultiplier(template, level);
    let bonusTotal = 0;
    try {
        if (buildingHasStorageCapacityRecipe(buildingId)) {
            bonusTotal = getBuildingStorageBonusMultiplier(locationId, buildingId);
        }
    } catch (_) { bonusTotal = 0; }
    const mult = baseMult + (count > 0 ? bonusTotal / count : 0);
    const category = template.ResourceStorageCategory || '3a';

    if (count <= 0 || (baseMult <= 0 && bonusTotal <= 0)) {
        return { revealed: true, stored: 0, max: 0, percent: 0, category, multiplier: mult, count, level, baseMultiplier: baseMult, bonusMultiplier: bonusTotal };
    }

    const accepted = resourceCatalog().filter(r => {
        if (!r || r.infinite || r.isEffect) return false;
        if (!r.form || r.form === 'energy' || r.form === 'tech' || r.form === 'info') return false;
        return categoryAcceptsForm(category, r.form);
    });

    const fill = fillFromResourceList(locationId, bodyData, accepted) || { stored: 0, max: 0, percent: 0 };
    const percent = Number.isFinite(fill.percent) ? fill.percent : 0;
    return {
        revealed: true,
        stored: Number(fill.stored) || 0,
        max: Number(fill.max) || 0,
        percent,
        category,
        multiplier: mult,
        count,
        level
    };
}

export function getResourceFreeSpace(locationId, resourceId, bodyData) {
    const cap = getResourceMaxCapacity(locationId, resourceId);
    if (!Number.isFinite(cap)) return Infinity;
    if (cap <= 0) return 0;
    const stockMap = getStockMap(bodyData);
    const have = Number(stockMap[resourceId]) || 0;
    return Math.max(0, cap - have);
}

export function isResourceStorageFull(locationId, resourceId, bodyData) {
    const meta = getResourceMeta(resourceId);
    // без меты/формы нельзя надёжно складировать → считаем «полным» (блокируем произв.)
    if (!meta || meta.infinite || meta.isEffect) return false;
    if (!meta.form || meta.form === 'energy' || meta.form === 'tech' || meta.form === 'info') return true;
    const cap = getResourceMaxCapacity(locationId, resourceId);
    if (!Number.isFinite(cap) || cap <= 0) return true;
    const stockMap = getStockMap(bodyData);
    const have = Number(stockMap[resourceId]) || 0;
    if (have > cap) stockMap[resourceId] = cap; // автоподрезка
    return have >= cap - 1e-9;
}

export function addResourceClamped(locationId, bodyData, resourceId, amount) {
    if (amount <= 0) return 0;
    const stockMap = getStockMap(bodyData);
    const cap = getResourceMaxCapacity(locationId, resourceId);
    // Нет склада / нулевая вместимость — нельзя складировать
    if (!Number.isFinite(cap) || cap <= 0) return 0;
    const have = Math.max(0, Number(stockMap[resourceId]) || 0);
    const free = Math.max(0, cap - have);
    if (free <= 0) {
        // подрезать возможный перелив с прошлых тиков
        if (have > cap) stockMap[resourceId] = cap;
        return 0;
    }
    const add = Math.min(amount, free);
    stockMap[resourceId] = Math.min(cap, have + add);
    return add;
}

/** Подрезать все стоки локации по актуальным потолкам склада. */
export function clampAllStocksToCapacity(locationId, bodyData) {
    if (!bodyData) return;
    const stockMap = getStockMap(bodyData);
    for (const id of Object.keys(stockMap)) {
        const cap = getResourceMaxCapacity(locationId, id);
        if (!Number.isFinite(cap) || cap <= 0) continue;
        const have = Number(stockMap[id]) || 0;
        if (have > cap) stockMap[id] = cap;
    }
}

export function getPreferredStorageCategory(form) {
    let best = null;
    let bestScore = -1;
    for (const [cat, forms] of Object.entries(CATEGORY_FORMS)) {
        if (!forms.includes(form)) continue;
        const score = CATEGORY_SPECIFICITY[cat] || 0;
        if (score > bestScore) {
            bestScore = score;
            best = cat;
        }
    }
    return best;
}

export function getCategoryForms(category) {
    return CATEGORY_FORMS[category] ? [...CATEGORY_FORMS[category]] : [];
}
