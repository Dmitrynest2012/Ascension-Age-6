import { getRecipeKnowledgeState } from './uiMasks.js';
import { currentLocation } from './camera.js';
import { getRecipesForBuilding, getResource, getRecipeLocalPower, setRecipeLocalPower, getRecipeEffectiveness, getRecipeBaseOutput, getRecipeActualOutput, getRecipeProcessingEfficiency, formatSpecialistNeed, formatSpecialistAmount, syncBuildingSpecialistsFromRecipes, getStockAmount, getInputResourceIds, pickInputResource, isRecipeWarehouseBlocked,
    isGeoRecipeInput, resolveInputGeoId, getDepositRemainingKg, getRecipeInputReturnPerMin } from './recipes.js';
import { getLocationBuildingData } from './buildingHelpers.js';
import { updateResourceBar } from './resourceUI.js';
import { formatEnergy, formatEnergyWh } from './functions.js';
import { state } from './state.js';
import { t, locName } from './settings.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';
import { formatValue } from './bodyParameters.js';

function formatOpticalRadius(km) {
    const v = Number(km) || 0;
    if (!(v > 0)) return '—';
    const LY = 9.46073e12;
    if (v >= LY * 0.05) {
        const ly = v / LY;
        const n = ly >= 100 ? ly.toFixed(0) : (ly >= 10 ? ly.toFixed(1) : ly.toFixed(2));
        return `${n} ${t('unit.ly') || 'св.лет'}`;
    }
    try { return formatValue(v, 'км'); } catch (_) { return `${Math.round(v)} км`; }
}


/** Мягкий доступ к гео-каталогу без жёсткого import-цикла с geodata.js */
function getGeoCatalog() {
    try {
        const g = globalThis.__geoCatalog;
        if (Array.isArray(g) && g.length) return g;
    } catch (_) {}
    try {
        // geodata.js выставляет catalog через getGeoCatalog на global при load — fallback пустой
        if (typeof globalThis.getGeoCatalog === 'function') {
            const c = globalThis.getGeoCatalog();
            if (Array.isArray(c)) return c;
        }
    } catch (_) {}
    return [];
}


const ROLE_LABEL = {
    engineers: () => t('spec.engineers'),
    agronomists: () => t('spec.agronomists'),
    scientists: () => t('spec.scientists'),
    expeditioners: () => t('spec.expeditioners')
};
const ROLE_ICON = {
    engineers: 'assets/textures/icons/specialist_engineer.png',
    agronomists: 'assets/textures/icons/specialist_agronomist.png',
    scientists: 'assets/textures/icons/specialist_scientist.png',
    expeditioners: 'assets/textures/icons/specialist_expeditioner.png'
};


const ENERGY_ICON = 'assets/textures/icons/energy.png';

function escAttr(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** После рендера: tip только у обрезанных имён ресурсов + специалисты / энергия */
function bindRecipeResourceTips(root) {
    if (!root) return;

    const show = (anchor, text, pos) => {
        if (!text) return;
        if (typeof window.showGameTooltip === 'function') {
            window.showGameTooltip(anchor, text, pos || 'top');
        }
    };
    const hide = () => {
        if (typeof window.hideGameTooltip === 'function') window.hideGameTooltip();
    };

    root.querySelectorAll('.recipe-io-chip').forEach(chip => {
        const card = chip.closest('.recipe-card');
        if (card && (card.classList.contains('recipe-card-locked') || card.classList.contains('recipe-card-unknown'))) {
            return;
        }
        const nameEl = chip.querySelector('.recipe-io-name');
        const full = (chip.getAttribute('data-full-name') || nameEl?.textContent || '').trim();
        if (!full || !nameEl) return;

        // только если текст реально обрезан (многоточие)
        const truncated = nameEl.scrollWidth > nameEl.clientWidth + 1;
        if (!truncated) {
            chip.removeAttribute('data-tip');
            chip.removeAttribute('title');
            chip.style.cursor = '';
            return;
        }

        chip.setAttribute('data-tip', full);
        chip.setAttribute('data-tip-pos', 'top');
        chip.removeAttribute('title');
        chip.style.cursor = 'help';

        chip.addEventListener('pointerenter', (e) => {
            e.stopPropagation();
            show(chip, full, 'top');
        });
        chip.addEventListener('pointerleave', (e) => {
            e.stopPropagation();
            hide();
        });
    });

    root.querySelectorAll('.recipe-spec-item img[data-full-tip]').forEach(img => {
        const card = img.closest('.recipe-card');
        if (card && (card.classList.contains('recipe-card-locked') || card.classList.contains('recipe-card-unknown'))) {
            return;
        }
        const tip = (img.getAttribute('data-full-tip') || '').trim();
        if (!tip) return;

        img.setAttribute('data-tip', tip);
        img.setAttribute('data-tip-pos', 'left');
        img.removeAttribute('title');
        img.style.cursor = 'help';

        img.addEventListener('pointerenter', (e) => {
            e.stopPropagation();
            show(img, tip, 'left');
        });
        img.addEventListener('pointerleave', (e) => {
            e.stopPropagation();
            hide();
        });
    });

    root.querySelectorAll('.recipe-energy-badge').forEach(img => {
        const card = img.closest('.recipe-card');
        if (card && (card.classList.contains('recipe-card-locked') || card.classList.contains('recipe-card-unknown'))) {
            return;
        }
        const tip = (t('recipes.needsEnergy') || img.getAttribute('data-tip') || img.getAttribute('title') || '').trim();
        if (!tip) return;
        img.setAttribute('data-tip', tip);
        img.removeAttribute('title');
        img.style.cursor = 'help';
        img.addEventListener('pointerenter', (e) => {
            e.stopPropagation();
            show(img, tip, 'top');
        });
        img.addEventListener('pointerleave', (e) => {
            e.stopPropagation();
            hide();
        });
    });
}




const DEFAULT_GRADIENT = ['rgba(0, 192, 206, 0.14)', 'rgba(82, 82, 82, 0.28)'];

function formatRate(n, isEnergy, isInfinite, unitLabel = '') {
    if (isInfinite) return '∞' + (unitLabel ? ' ' + unitLabel : '') + t('recipes.perMin');
    const v = Number(n) || 0;
    if (isEnergy) {
        return formatEnergy(v, { withUnit: true }).text + t('recipes.perMin');
    }
    let num;
    if (v >= 100) num = `${Math.round(v)}`;
    else if (v >= 10) num = `${v.toFixed(1)}`;
    else if (v >= 0.01) num = `${v.toFixed(2)}`;
    else if (v >= 0.001) num = `${v.toFixed(3)}`;
    else if (v > 0) num = `${v.toFixed(4)}`;
    else num = '0';
    const u = unitLabel ? ` ${unitLabel}` : '';
    return num + u + t('recipes.perMin');
}

/** Единица для потока рецепта: вода → л, твёрдое → кг, иначе unit ресурса. */
function rateUnitForResource(resourceId) {
    if (!resourceId) return '';
    if (resourceId === 'RES_WATER' || resourceId === 'RES_PACKED_WATER') {
        return t('unit.L') || 'л';
    }
    const res = getResource(resourceId);
    if (!res) return t('unit.kg') || 'кг';
    if (res.form === 'liquid') return t('unit.L') || res.unit || 'л';
    if (res.form === 'solid' || res.form === 'gas') return t('unit.kg') || res.unit || 'кг';
    return res.unit || (t('unit.kg') || 'кг');
}

function rateUnitForGeo(geoId) {
    if (!geoId) return t('unit.kg') || 'кг';
    if (geoId === 'GEO_WATER') return t('unit.L') || 'л';
    return t('unit.kg') || 'кг';
}

/** Нехватка: ни один из вариантов входа не покрывает расход */
function isInputShort(bodyData, inp, localP, builtCount, effectiveness) {
    const ids = getInputResourceIds(inp);
    if (!ids.length) return false;
    // infinite в любом слоте — ок
    for (const id of ids) {
        if (getResource(id)?.infinite) return false;
    }
    const baseNeed = (Number(inp.perMinute) || 0) * Math.max(1, builtCount);
    if (baseNeed <= 0) return false;
    const needPerMin = baseNeed * (Math.max(0, localP) / 100) * Math.max(0, effectiveness || 0);
    // суммарный запас по всем альтернативам
    let total = 0;
    for (const id of ids) total += getStockAmount(bodyData, id);
    if (localP <= 0 || effectiveness <= 0) return total <= 0;
    return total + 1e-9 < needPerMin * 0.05;
}

function buildCompactIO(locationId, buildingId, recipe, effectiveness, localP, bodyData) {
    const locData = getLocationBuildingData(locationId, buildingId);
    const built = locData?.built_count || 0;

    const inputs = (recipe.inputs || []).map(inp => {
        // --- гео-вход (залежи) ---
        if (typeof isGeoRecipeInput === 'function' && isGeoRecipeInput(inp)) {
            const geoId = (typeof resolveInputGeoId === 'function' ? resolveInputGeoId(inp) : null) || inp.geoResourceId || '';
            let geoMeta = null;
            try {
                const cat = typeof getGeoCatalog === 'function' ? getGeoCatalog() : [];
                geoMeta = (Array.isArray(cat) ? cat : []).find(g => g && g.id === geoId) || null;
            } catch (_) { geoMeta = null; }
            const name = geoMeta ? locName(geoMeta.name, geoId) : (geoId || '—');
            const icon = geoMeta?.icon || 'assets/textures/icons/res_water.png';
            let actual = (Number(inp.perMinute) || 0) * Math.max(0, effectiveness);
            try {
                const out = (recipe.outputs || []).find(o => o && o.resourceId) || (recipe.outputs || [])[0];
                if (out?.resourceId) {
                    actual = getRecipeActualOutput(locationId, buildingId, recipe, out.resourceId);
                }
            } catch (_) {}
            let have = Infinity;
            try {
                if (typeof getDepositRemainingKg === 'function') have = getDepositRemainingKg(bodyData, geoId);
            } catch (_) {}
            const short = Number.isFinite(have) && have + 1e-9 < actual;
            const tip = name;
            const geoUnit = rateUnitForGeo(geoId);
            return `<div class="recipe-io-chip${short ? ' recipe-io-short' : ''}" data-full-name="${escAttr(tip)}">
            <img src="${icon}" alt="">
            <span class="recipe-io-rate">${formatRate(actual, false, false, geoUnit)}</span>
            <span class="recipe-io-name">${name}</span>
        </div>`;
        }

        const ids = getInputResourceIds(inp);
        const names = [];
        let icon = '';
        let infinite = false;
        for (const id of ids) {
            const res = getResource(id);
            if (!icon && res?.icon) icon = res.icon;
            if (res?.infinite) infinite = true;
            names.push(locName(res?.name, id));
        }
        const name = names.join(' / ');
        const actual = (Number(inp.perMinute) || 0) * Math.max(0, effectiveness);
        const short = isInputShort(bodyData, inp, localP, built, effectiveness);
        // какой сейчас берётся (приоритет)
        const pick = pickInputResource(bodyData, inp, Math.max(actual, 1e-9));
        const pickName = pick ? (locName(getResource(pick.resourceId)?.name, pick.resourceId)) : '';
        const nowLbl = t('recipes.now') || 'сейчас';
        const tip = pickName && names.length > 1 ? `${name} (${nowLbl}: ${pickName})` : name;
        return `<div class="recipe-io-chip${short ? ' recipe-io-short' : ''}" data-full-name="${escAttr(tip)}">
            <img src="${icon}" alt="">
            <span class="recipe-io-rate">${formatRate(actual, false, infinite, rateUnitForResource(ids[0] || ''))}</span>
            <span class="recipe-io-name">${name}</span>
        </div>`;
    }).join('');

    let outputs = (recipe.outputs || []).flatMap(out => {
        if (out.effectId === 'EFF_OPTICAL_SCAN' || (out.isEffect && (out.a1RadiusKm || out.a2RadiusKm))) {
            const eff = Math.max(0, effectiveness);
            const data = getLocationBuildingData(locationId, buildingId) || {};
            const level = Number(data.currentLevel) || 0;
            const count = Math.max(1, Number(data.built_count) || 1);
            const tpl = (state.buildings || []).find(b => b.id === buildingId) || {};
            const a1m = Number((tpl.OpticalScanA1Mult || [])[Math.min(level, 8)] ?? (1 + level * 0.18)) || 1;
            const a2m = Number((tpl.OpticalScanA2Mult || [])[Math.min(level, 8)] ?? (1 + level * 0.16)) || 1;
            const chips = [];
            if (out.a1RadiusKm) {
                const r = Number(out.a1RadiusKm) * a1m * count * eff;
                const name = t('optical.layerA1') || 'A1';
                chips.push(`<div class="recipe-io-chip recipe-io-out" data-full-name="${escAttr(name)}">
            <span class="recipe-io-rate">${formatOpticalRadius(r)}</span>
            <span class="recipe-io-name">${name}</span>
        </div>`);
            }
            if (out.a2RadiusKm) {
                const r = Number(out.a2RadiusKm) * a2m * count * eff;
                const name = t('optical.layerA2') || 'A2';
                chips.push(`<div class="recipe-io-chip recipe-io-out" data-full-name="${escAttr(name)}">
            <span class="recipe-io-rate">${formatOpticalRadius(r)}</span>
            <span class="recipe-io-name">${name}</span>
        </div>`);
            }
            return chips;
        }
        const res = getResource(out.resourceId);
        const isEnergyCap = !!(out.resourceId === 'RES_ENERGY_CAPACITY' || out.scaleWithBuildingMaxEnergyCapacity);
        const isStorageCap = !!(out.resourceId === 'RES_STORAGE_CAPACITY' || out.scaleWithBuildingResourceStorageCapacity);
        const isPopCap = !!(out.resourceId === 'RES_POPULATION_CAPACITY' || out.scaleWithBuildingPopulationCapacity);
        const isCap = !!(out.isCapacity || isEnergyCap || isStorageCap || isPopCap);
        const icon = res?.icon || (isEnergyCap ? 'assets/textures/icons/energy.png' : (isStorageCap || isPopCap ? 'assets/textures/icons/energy.png' : ''));
        const name = isEnergyCap
            ? (t('recipes.energyCapacity') || 'Энергоёмкость')
            : (isStorageCap
                ? (t('recipes.storageCapacity') || 'Вместимость склада')
                : (isPopCap
                    ? (t('recipes.populationCapacity') || 'Жилплощадь')
                    : locName(res?.name, out.resourceId)));
        const isEnergy = out.resourceId === 'RES_ELECTRICITY';
        const actual = getRecipeActualOutput(locationId, buildingId, recipe, out.resourceId || 'RES_ENERGY_CAPACITY');
        // для эффектов показываем effectValuePerMinute * eff
        let rate = actual;
        if (out.isEffect || res?.isEffect) {
            rate = (Number(out.effectValuePerMinute ?? out.perMinute) || 0) * Math.max(0, effectiveness);
        }
        let rateStr;
        if (isEnergyCap) {
            rateStr = (formatEnergyWh(rate) || {}).text || String(Math.round(rate));
        } else if (isStorageCap) {
            // бонусный множитель склада (без /мин)
            const v = Number(rate) || 0;
            rateStr = (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(2)) + '×';
        } else if (isPopCap) {
            const v = Number(rate) || 0;
            const unit = t('unit.people') || t('unit.person') || 'чел.';
            rateStr = (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + unit;
        } else if (out.isEffect || res?.isEffect || out.effectId === 'EFF_REPAIR_STRUCTURE' || out.resourceId === 'RES_STRUCT_REPAIR') {
            rateStr = formatRate(rate, false, false, t('unit.HP') || 'ОЖ');
        } else {
            rateStr = formatRate(rate, isEnergy, false, rateUnitForResource(out.resourceId));
        }
        return `<div class="recipe-io-chip recipe-io-out" data-full-name="${escAttr(name)}">
            <img src="${icon}" alt="">
            <span class="recipe-io-rate">${rateStr}</span>
            <span class="recipe-io-name">${name}</span>
        </div>`;
    }).join('');

    // Возврат тары (пустая канистра), если сейчас расходуется упакованная вода
    try {
        const locDataIO = getLocationBuildingData(locationId, buildingId);
        const builtIO = locDataIO?.built_count || 0;
        for (const inp of recipe.inputs || []) {
            const ret = getRecipeInputReturnPerMin(bodyData, recipe, inp, effectiveness, builtIO);
            if (!ret) continue;
            const retRes = getResource(ret.resourceId);
            const name = locName(retRes?.name, ret.resourceId);
            const icon = retRes?.icon || '';
            outputs += `<div class="recipe-io-chip recipe-io-out recipe-io-return" data-full-name="${escAttr(name)}">
            <img src="${icon}" alt="">
            <span class="recipe-io-rate">${formatRate(ret.perMinute, false, false, rateUnitForResource(ret.resourceId))}</span>
            <span class="recipe-io-name">${name}</span>
        </div>`;
        }
    } catch (_) {}

    // Бонус рождаемости (перинатальный / больница)
    let birthHtml = '';
    if (Number(recipe.birthRateBonus) > 0) {
        const scaleMap = recipe.buildingBirthBonusScale || {};
        const scale = scaleMap[buildingId] != null ? Number(scaleMap[buildingId]) : 1;
        const s = Number.isFinite(scale) ? scale : 1;
        const base = Number(recipe.birthRateBonus) * s;
        const actual = base * Math.max(0, effectiveness);
        const pct = (actual * 100).toFixed(2).replace(/\.?0+$/, '');
        const name = t('recipes.birthBonus') || 'Рождаемость';
        birthHtml = `<div class="recipe-io-chip recipe-io-birth" data-full-name="${escAttr(name)}">
            <img src="assets/textures/icons/pop_birth.png" alt="">
            <span class="recipe-io-rate">+${pct}%/${t('unit.year') || 'год'}</span>
            <span class="recipe-io-name">${name}</span>
        </div>`;
    }


    return `<div class="recipe-io">
        <div class="recipe-io-row">
            <span class="recipe-io-label">${t('recipes.requires')}</span>
            <div class="recipe-io-chips">${inputs || '<span class="recipe-io-empty">—</span>'}</div>
        </div>
        <div class="recipe-io-row">
            <span class="recipe-io-label">${t('recipes.produces')}</span>
            <div class="recipe-io-chips">${(outputs || '') + (birthHtml || '') || '<span class="recipe-io-empty">—</span>'}</div>
        </div>
    </div>`;
}

function buildSpecialistsHtml(locationId, buildingId, recipe) {
    const roles = ['engineers', 'agronomists', 'scientists', 'expeditioners'];
    const parts = [];
    for (const role of roles) {
        const needBase = Number(recipe.specialists?.[role]) || 0;
        if (needBase <= 0) continue;
        const needInfo = formatSpecialistNeed(locationId, buildingId, recipe, role) || {};
        const need = Number(needInfo.need) || 0;
        const can = Number(needInfo.can) || 0;
        const hired = Number(needInfo.hired ?? needInfo.globalFree) || 0;
        const usedOthers = Number(needInfo.usedOthers) || 0;
        const assigned = Math.min(need, can);
        const short = need > can + 1e-6;
        const needL = t('recipes.spec.need') || 'нужно';
        const availL = t('recipes.spec.available') || 'доступно';
        const hiredL = t('recipes.spec.hired') || 'нанято';
        const busyL = t('recipes.spec.busyOthers') || 'занято другими';
        const tip = `${ROLE_LABEL[role]()}: ${needL} ${formatSpecialistAmount(need)}, ${availL} ${formatSpecialistAmount(can)} (${hiredL} ${formatSpecialistAmount(hired)}, ${busyL} ${formatSpecialistAmount(usedOthers)})`;
        parts.push(`<div class="recipe-spec-item">
            <img src="${ROLE_ICON[role]}" alt="${ROLE_LABEL[role]()}" data-full-tip="${escAttr(tip)}">
            <span class="recipe-spec-count${short ? ' recipe-spec-short' : ''}">${formatSpecialistAmount(assigned)} / ${formatSpecialistAmount(can)}</span>
        </div>`);
    }
    if (!parts.length) return '<div class="recipe-spec-empty">—</div>';
    return parts.join('');
}


/** Статус-подсказка для карточки рецепта */
function buildRecipeHint(locationId, buildingId, recipe, localP, effectiveness) {
    const roles = ['engineers', 'agronomists', 'scientists', 'expeditioners'];
    let needsSpecs = false;
    let hasSpecs = true;
    for (const role of roles) {
        const base = Number(recipe.specialists?.[role]) || 0;
        if (base <= 0) continue;
        needsSpecs = true;
        const { need, can } = formatSpecialistNeed(locationId, buildingId, recipe, role);
        // can — доступный пул; при мощности 0 need = превью, can = пул
        if (can <= 0 || (localP > 0 && need > can + 1e-6)) {
            hasSpecs = false;
        }
    }

    let energyOk = true;
    if (recipe.requiresEnergy) {
        const flags = state.locationFlags?.[Number(locationId)];
        if (flags && flags.noEnergyForBuildings) energyOk = false;
        // если баланс 0 и флаг ещё не выставлен — считаем ок (заглушка),
        // подсказка по энергии только при явном noEnergy
    }

    const hasPower = localP > 0;

    // Полностью активен
    const bodyData = globalThis.__currentBodyData || null;
    const warehouseBlocked = bodyData ? isRecipeWarehouseBlocked(locationId, bodyData, recipe) : false;
    if (warehouseBlocked) {
        return { text: t('recipe.status.warehouseFull') || 'Склад переполнен', cls: 'recipe-hint-warn' };
    }
    if (hasPower && (!needsSpecs || hasSpecs) && energyOk && effectiveness > 0) {
        return { text: t('recipes.active'), cls: 'recipe-hint-active' };
    }

    // Энергия (если требует и её нет)
    if (recipe.requiresEnergy && !energyOk) {
        if (!hasPower && needsSpecs && !hasSpecs) {
            return { text: t('recipes.hint.needPowerSpecsEnergy'), cls: 'recipe-hint-energy' };
        }
        if (!hasPower) {
            return { text: t('recipes.hint.setPowerAndEnergy'), cls: 'recipe-hint-energy' };
        }
        if (needsSpecs && !hasSpecs) {
            return { text: t('recipes.hint.needSpecsAndEnergy'), cls: 'recipe-hint-energy' };
        }
        return { text: t('recipes.hint.needEnergy'), cls: 'recipe-hint-energy' };
    }

    // Мощность есть, специалистов нет
    if (hasPower && needsSpecs && !hasSpecs) {
        return { text: t('recipes.hint.needSpecs'), cls: 'recipe-hint-warn' };
    }

    // Мощности нет
    if (!hasPower) {
        if (needsSpecs && !hasSpecs) {
            return { text: t('recipes.hint.setPowerAndHire'), cls: 'recipe-hint-need' };
        }
        return { text: t('recipes.hint.setPower'), cls: 'recipe-hint-need' };
    }

    // Мощность есть, но eff=0 по другим причинам
    if (effectiveness <= 0) {
        return { text: t('recipes.inactive'), cls: 'recipe-hint-idle' };
    }

    return { text: t('recipes.active'), cls: 'recipe-hint-active' };
}

function cardGradientStyle(recipe) {
    const g = Array.isArray(recipe.gradient) && recipe.gradient.length >= 2
        ? recipe.gradient
        : DEFAULT_GRADIENT;
    return `background: linear-gradient(to right, ${g[0]}, ${g[1]});`;
}


let _schemesScroll = null;
function ensureSchemesFirmScroll() {
    const panel = document.getElementById('schemes-panel');
    if (!panel) return;
    try {
        _schemesScroll = attachFirmScroll(panel, { axis: 'y', mirrorV: true, host: 'self', fillHost: true });
    } catch (e) {
        console.warn('schemes firmScroll', e);
    }
}

export function renderSchemesTab(locationId, buildingId) {
    const container = document.getElementById('schemes-list');
    if (!container) return;

    const recipes = getRecipesForBuilding(buildingId);
    const locData = getLocationBuildingData(locationId, buildingId);
    const built = locData?.built_count || 0;
    const bodyData = currentLocation?.data || null;

    if (!recipes.length) {
        container.innerHTML = '<div class="schemes-empty">' + t('recipes.none') + '</div>';
        try { ensureSchemesFirmScroll(); _schemesScroll?.update(); } catch (_) {}
        return;
    }

    if (built <= 0) {
        container.innerHTML = '<div class="schemes-empty">' + t('recipes.needBuilt') + '</div>';
        try { ensureSchemesFirmScroll(); _schemesScroll?.update(); } catch (_) {}
        return;
    }

    container.innerHTML = recipes.map(recipe => {
        const knowledge = getRecipeKnowledgeState(recipe.id, buildingId);

        // --- неизвестная схема ---
        if (knowledge === 'unknown') {
            return `<div class="recipe-card recipe-card-unknown" data-recipe-id="${recipe.id}" data-knowledge="unknown">
                <div class="recipe-unknown-inner">
                    <div class="recipe-unknown-q">?</div>
                    <div class="recipe-unknown-label">${t('recipes.unknownScheme')}</div>
                </div>
            </div>`;
        }

        const localP = knowledge === 'unlocked' ? getRecipeLocalPower(locationId, buildingId, recipe.id) : 0;
        const locDataR = getLocationBuildingData(locationId, buildingId);
        const buildingCap = (locDataR?.currentBuildingCapacity ?? 100) / 100;
        const effectivePct = Math.round(localP * buildingCap);
        const eff = knowledge === 'unlocked' ? getRecipeEffectiveness(locationId, buildingId, recipe) : 0;
        const name = locName(recipe.name, recipe.id);
        const bgImg = recipe.backgroundImage || recipe.bgImage || '';
        const needsEnergy = !!recipe.requiresEnergy;

        const bgLayer = bgImg
            ? `<div class="recipe-card-bg" style="background-image:url('${bgImg}')"></div>`
            : '';

        const energyBadge = needsEnergy
            ? `<img class="recipe-energy-badge" src="${ENERGY_ICON}" alt="${t('recipes.needsEnergy')}" title="${t('recipes.needsEnergy')}">`
            : '';

        let hint = { text: t('recipes.schemeLocked') || 'Схема не изучена', cls: 'recipe-hint-idle' };
        if (knowledge === 'unlocked') {
            try {
                const h = buildRecipeHint(locationId, buildingId, recipe, localP, eff);
                if (h && typeof h === 'object') hint = h;
                else if (typeof h === 'string') hint = { text: h, cls: 'recipe-hint-warn' };
            } catch (_) {
                hint = { text: t('recipes.inactive') || '—', cls: 'recipe-hint-idle' };
            }
        }

        const lockedCls = knowledge === 'locked' ? ' recipe-card-locked' : '';
        const leverDisabled = knowledge !== 'unlocked' ? 'disabled' : '';
        let ioHtml = '';
        let specsHtml = '';
        let procHtml = '';
        try {
            if (recipe.processingEfficiency != null && Number.isFinite(Number(recipe.processingEfficiency))) {
                const proc = typeof getRecipeProcessingEfficiency === 'function'
                    ? getRecipeProcessingEfficiency(recipe)
                    : Math.max(0, Math.min(1, Number(recipe.processingEfficiency)));
                const pct = Math.round(proc * 100);
                const label = t('recipes.processingEfficiency') || 'Эффективность переработки';
                procHtml = `<div class="recipe-proc-eff" title="">${label}: <strong>${pct}%</strong></div>`;
            }
        } catch (_) { procHtml = ''; }
        try {
            ioHtml = buildCompactIO(locationId, buildingId, recipe, eff, localP, bodyData);
        } catch (_) {
            ioHtml = '<div class="recipe-io-empty">—</div>';
        }
        try {
            specsHtml = buildSpecialistsHtml(locationId, buildingId, recipe);
        } catch (_) {
            specsHtml = '<div class="recipe-spec-empty">—</div>';
        }

        return `<div class="recipe-card${lockedCls}" data-recipe-id="${recipe.id}" data-knowledge="${knowledge}" style="${cardGradientStyle(recipe)}">
            ${bgLayer}
            ${knowledge === 'locked' ? '<div class="recipe-locked-stripes" aria-hidden="true"></div>' : ''}
            <div class="recipe-card-header">
                <div class="recipe-card-title-row">
                    <div class="recipe-card-title">${name}</div>
                    ${energyBadge}
                </div>
            </div>
            <div class="recipe-card-body">
                <div class="recipe-lever-block" data-recipe-id="${recipe.id}" data-max="100">
                    <div class="recipe-lever-track">
                        <div class="recipe-lever-gradient"></div>
                        <input type="range" min="0" max="100" value="${localP}" step="1"
                            class="recipe-lever" data-recipe-id="${recipe.id}" ${leverDisabled}
                            style="writing-mode: vertical-lr; direction: rtl;">
                    </div>
                    <div class="recipe-lever-labels">
                        <span class="recipe-lever-pct">${localP}% [${effectivePct}%]</span>
                    </div>
                </div>
                <div class="recipe-io-wrap">
                    ${ioHtml}
                    ${procHtml}
                </div>
                <div class="recipe-specs">
                    ${specsHtml}
                </div>
            </div>
            <div class="recipe-hint ${hint.cls || ''}">${hint.text || ''}</div>
        </div>`;
    }).join('');

    container.querySelectorAll('.recipe-lever:not([disabled])').forEach(lever => {
        lever.addEventListener('input', onLeverInput);
        lever.addEventListener('change', onLeverInput);
    });

    // Колёсико — только у разблокированных
    container.querySelectorAll('.recipe-card[data-knowledge="unlocked"] .recipe-lever-block').forEach(block => {
        block.addEventListener('wheel', onLeverWheel, { passive: false });
    });

    // Фирменные тултипы: полное имя при «…», специалисты на иконке
    // двойной rAF — layout готов, scrollWidth для «…» корректен
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            try { bindRecipeResourceTips(container); } catch (e) { console.warn('recipe tips', e); }
            try { ensureSchemesFirmScroll(); _schemesScroll?.update(); } catch (_) {}
        });
    });

}

function applyLeverValue(lever, value) {
    const recipeId = lever.dataset.recipeId;
    const bid = document.getElementById('schemes-list')?.dataset?.buildingId;
    if (!recipeId || !bid || !currentLocation?.data?.id) return;
    const locId = currentLocation.data.id;
    const max = Number(lever.max) || 100;
    const v = Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
    setRecipeLocalPower(locId, bid, recipeId, v);
    renderSchemesTab(locId, bid);
    syncBuildingSpecialistsFromRecipes(locId, bid);
    updateResourceBar(currentLocation);
    document.dispatchEvent(new CustomEvent('recipes-changed', { detail: { locationId: locId, buildingId: bid } }));
}

function onLeverInput(e) {
    applyLeverValue(e.target, e.target.value);
}

function onLeverWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const block = e.currentTarget;
    const lever = block.querySelector('.recipe-lever');
    if (!lever) return;
    const max = Number(lever.max) || 100;
    const cur = Number(lever.value) || 0;
    // тонкий шаг: 1% за «щелчок», Shift — 5%
    const step = e.shiftKey ? 5 : 1;
    const delta = e.deltaY < 0 ? step : -step;
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) return;
    lever.value = String(next);
    applyLeverValue(lever, next);
}

export function showSchemesPanel(show, buildingId) {
    const schemes = document.getElementById('schemes-panel');
    if (schemes) {
        schemes.style.display = show ? 'flex' : 'none';
        if (show) {
            try { ensureSchemesFirmScroll(); _schemesScroll?.update(); } catch (_) {}
        }
    }
    const list = document.getElementById('schemes-list');
    if (list && buildingId) list.dataset.buildingId = buildingId;
}

export function refreshSchemesIfOpen(locationId, buildingId) {
    const schemes = document.getElementById('schemes-panel');
    if (!schemes || schemes.style.display === 'none') return;
    if (buildingId) renderSchemesTab(locationId, buildingId);
}

// --- public API (buildingUI / main) ---