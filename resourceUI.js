import { formatEnergy, formatEnergyWh } from './functions.js';
import { calcLocationEnergyConsumption, calcLocationEnergyProduction, buildingBelongsToLocation, getLocationBuildingData } from './buildingHelpers.js';
import { calcLocationStorageTotals, calcLocationBatteryOutputW } from './energyStorage.js';
import { getPopulationStats, redistributePopulation } from './population.js';
import { getSpecialistStats, clampSpecialistsToSettled } from './specialists.js';
import { isStockSectionMasked } from './uiMasks.js';
import { t, locName } from './settings.js';
import { getResourceMaxCapacity, getLocationStorageFill, getSectionStorageFill, isResourceStorageFull, getResourceFreeSpace } from './resourceStorage.js';
import {
    getRecipesForBuilding,
    getRecipeLocalPower,
    getRecipeEffectiveness,
    getRecipeActualOutput,
    getResource,
    pickInputResource,
    calcLocationTechProduction,
    isGeoRecipeInput,
    resolveInputGeoId,
    getDepositRemainingKg
} from './recipes.js';
import { listConsumableResources } from './populationNeeds.js';
import { state } from './state.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';
import { chartsButtonHtml, bindChartsButtons } from './trendCharts.js';

const RESOURCE_KEY_MAP = {
    'Население': { key: 'population', unitKey: 'unit.people' },
    'Сырье': { key: 'raw', unitKey: 'unit.tons', unitPrefix: ' ' },
    'Материалы': { key: 'materials', unitKey: 'unit.tons', unitPrefix: ' ' },
    'Компоненты': { key: 'components', unitKey: 'unit.tons', unitPrefix: ' ' },
    'Продукция': { key: 'products', unitKey: 'unit.tons', unitPrefix: ' ' },
    'Продовольствие': { key: 'food', unitKey: 'unit.tons', unitPrefix: ' ' },
    'Энергия': { key: 'energy', unitKey: 'unit.watts', unitPrefix: ' ' },
    'Технологии': { key: 'technologies', unitKey: 'unit.techPerMin', unitPrefix: ' ' }
};

/** Разделы склада (маска гл. II, тренды, попапы) */
const STOCK_SECTION_IDS = ['Сырье', 'Материалы', 'Компоненты', 'Продукция', 'Продовольствие'];
function isStockBarSection(resourceId) {
    return STOCK_SECTION_IDS.includes(resourceId);
}
function resourceUnitText(meta) {
    if (!meta) return '';
    const u = t(meta.unitKey || 'unit.tons');
    return (meta.unitPrefix || '') + u;
}

function formatResourceValue(value) {
    const n = Number(value) || 0;
    if (Math.abs(n) >= 1000) return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
    if (Number.isInteger(n)) return String(n);
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}


/** Цвет/класс заголовка раздела */
const SECTION_CLASS = {
    'Энергия': 'section-energy',
    'Технологии': 'section-technologies',
    'Продовольствие': 'section-food',
    'Продукция': 'section-products',
    'Компоненты': 'section-components',
    'Материалы': 'section-materials',
    'Сырье': 'section-raw',
    'Население': 'section-population'
};

/**
 * Путь к ассету так же, как в попапе: относительный `assets/...`,
 * но резолвим от URL этого модуля — тогда работает и в Live Preview
 * (корень сайта), и на GitHub Pages (/имя-репо/), даже без / в конце URL.
 */
function assetUrl(rel) {
    const raw = String(rel || '').trim();
    if (!raw) return '';
    if (/^(?:https?:|data:|blob:)/i.test(raw)) return raw;
    const clean = raw.replace(/^\.\//, '').replace(/^\/+/, '');
    try {
        return new URL(clean, import.meta.url).href;
    } catch (_) {
        return clean;
    }
}

/** Плейсхолдеры иконок параметров (локальные пути — замените сами) */
const POPUP_ICONS = {
    balance: 'assets/textures/icons/energy_balance.png',
    production: 'assets/textures/icons/energy_production.png',
    consumption: 'assets/textures/icons/energy_consumption.png',
    storage: 'assets/textures/icons/energy_storage.png',
    capacity: 'assets/textures/icons/res_capacity.png',
    value: 'assets/textures/icons/resource_value.png',
    // Население
    popTotal: 'assets/textures/icons/pop_total.png',
    popHomeless: 'assets/textures/icons/pop_homeless.png',
    popSettled: 'assets/textures/icons/pop_settled.png',
    popDynamics: 'assets/textures/icons/pop_dynamics.png',
    popBirth: 'assets/textures/icons/pop_birth.png',
    popDeath: 'assets/textures/icons/pop_death.png',
    popIdle: 'assets/textures/icons/pop_idle.png',
    popCreators: 'assets/textures/icons/pop_creators.png',
    popEngineers: 'assets/textures/icons/pop_engineers.png',
    popAgronomists: 'assets/textures/icons/pop_agronomists.png',
    popScientists: 'assets/textures/icons/pop_scientists.png',
    popExpeditioners: 'assets/textures/icons/pop_expeditioners.png'
};

/** Иконки кнопок-разделов ресурсной полоски — те же локальные файлы, что в HTML */
const SECTION_ICONS = {
    'Население':      ['assets/textures/icons/population.png', 'assets/textures/icons/pop_total.png'],
    'Сырье':          ['assets/textures/icons/raw.png', 'assets/textures/icons/res_iron_mineral.png'],
    'Материалы':      ['assets/textures/icons/materials.png'],
    'Компоненты':     ['assets/textures/icons/components.png'],
    'Продукция':      ['assets/textures/icons/products.png', 'assets/textures/icons/res_repair_kit.png'],
    'Продовольствие': ['assets/textures/icons/food.png', 'assets/textures/icons/res_field_ration.png'],
    'Энергия':        ['assets/textures/icons/energy.png', 'assets/textures/icons/res_electricity.png'],
    'Технологии':     ['assets/textures/icons/technologies.png']
};

function bindIconFallbacks(img, paths) {
    if (!img || !paths || !paths.length) return;
    const list = paths.map(assetUrl).filter(Boolean);
    if (!list.length) return;
    let i = 0;
    img.src = list[0];
    img.onerror = () => {
        i += 1;
        if (i < list.length) img.src = list[i];
        else img.style.opacity = '0.25';
    };
}

function applyBarSectionIcons() {
    document.querySelectorAll('#resource-bar .resource-container').forEach(container => {
        const id = container.dataset.resourceId;
        const paths = SECTION_ICONS[id];
        if (!paths) return;
        let img = container.querySelector('img.resource-icon');
        if (!img) {
            img = document.createElement('img');
            img.className = 'resource-icon';
            img.alt = '';
            container.insertBefore(img, container.firstChild);
        }
        bindIconFallbacks(img, paths);
    });
}

const SECTION_I18N = {
    'Энергия': 'res.section.energy',
    'Технологии': 'res.section.technologies',
    'Продовольствие': 'res.section.food',
    'Продукция': 'res.section.products',
    'Компоненты': 'res.section.components',
    'Материалы': 'res.section.materials',
    'Сырье': 'res.section.raw',
    'Население': 'res.section.population'
};

function sectionTitleHtml(resourceId) {
    const cls = SECTION_CLASS[resourceId] || 'section-default';
    const title = t(SECTION_I18N[resourceId] || 'res.section.raw');
    const btn = (typeof chartsButtonHtml === 'function') ? chartsButtonHtml(resourceId) : '';
    return `<div class="popup-section-title ${cls}"><span class="popup-title-text">${title}</span>${btn}</div>`;
}

function popupRowHtml(iconSrc, label, valueHtml, opts = {}) {
    const extra = opts.resource ? ' is-resource' : (opts.extraClass ? ` ${opts.extraClass}` : '');
    const ridAttr = opts.rid ? ` data-rid="${opts.rid}"` : '';
    return `<div class="popup-row${extra}"${ridAttr}>
        <img class="popup-row-icon" src="${assetUrl(iconSrc)}" alt="" onerror="this.style.opacity='0.25'">
        <span class="popup-row-label">${label}</span>
        <span class="popup-row-value">${valueHtml}</span>
    </div>`;
}


/** Сколько хватит запаса: storedWh / consumptionW → секунды. */
/**
 * «Энергии хватит» — стабильная оценка запаса АКБ, НЕ зависящая от текущей выработки.
 *
 * rateW = min(потребление, maxDischargeW)
 *   • потребление — текущая нагрузка сети
 *   • maxDischargeW — сколько АКБ реально могут отдать (DischargeRate)
 *
 * Почему не учитываем производство:
 *   иначе при включённом фотосинтезе ETA считался от полного EC (1250 Вт),
 *   а после выключения — от DischargeRate (500 Вт), и 8 мин «магически»
 *   превращались в 40 мин. Игрок видел скачок без изменения запаса.
 *
 * Смысл числа: «на сколько игрового времени хватит текущего запаса,
 * если кормить нагрузку только с АКБ» — одно и то же до и после отключения генерации.
 *
 * timeSpeed не участвует: тик АКБ и часы масштабируются одинаково.
 */
function formatEnergyReserveRemain(storedWh, consumptionW, productionW, maxDischargeW, measuredDrainW) {
    const stored = Math.max(0, Number(storedWh) || 0);
    const cons = Math.max(0, Number(consumptionW) || 0);
    const maxDis = Math.max(0, Number(maxDischargeW) || 0);
    // productionW / measuredDrainW намеренно не влияют на ETA (стабильность UI)
    void productionW;
    void measuredDrainW;

    if (stored <= 1e-9) {
        return t('res.popup.noEnergyReserve') || 'нет резерва энергии';
    }
    if (cons <= 1e-9) {
        return t('res.popup.energyNoDrain') || 'нет расхода';
    }

    // Ограничение разряда АКБ — иначе ETA занижается относительно реального таяния
    const rateW = maxDis > 1e-9 ? Math.min(cons, maxDis) : cons;
    if (rateW <= 1e-12) {
        return t('res.popup.energyNoDrain') || 'нет расхода';
    }

    let sec = Math.floor((stored / rateW) * 3600 + 1e-9);
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const pad = (n, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, '0');
    const daysTotal = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const years = Math.floor(daysTotal / 365);
    const months = Math.floor((daysTotal % 365) / 30);
    const days = (daysTotal % 365) % 30;
    return `${pad(h)}:${pad(m)}:${pad(s)} ${pad(days)}:${pad(months)}:${years}`;
}


function energyRowHtml(key, iconSrc, label, valueHtml) {
    return `<div class="popup-row is-hoverable" data-energy-key="${key}">
        <img class="popup-row-icon" src="${assetUrl(iconSrc)}" alt="" onerror="this.style.opacity='0.25'">
        <span class="popup-row-label">${label}</span>
        <span class="popup-row-value">${valueHtml}</span>
    </div>`;
}

function computeEnergyPopupValues(container) {
    const balNum = Number(container.dataset.energyBalance) || 0;
    const prodNum = Number(container.dataset.energyProduction) || 0;
    const consNum = Number(container.dataset.energyConsumption) || 0;
    const storedWh = Number(container.dataset.storageStored) || 0;
    const smaxWh = Number(container.dataset.storageMax) || 0;
    // maxDischarge из totals + текущий batteryOutput (только юниты с запасом > 0)
    const maxDisW = Math.max(
        Number(container.dataset.storageMaxDischarge) || 0,
        Number(container.dataset.batteryOutput) || 0
    );
    const measuredDrainW = Number(container.dataset.batteryDrain) || 0;
    const bat = formatEnergy(Number(container.dataset.batteryOutput) || 0).text;
    const onBat = container.dataset.onBattery === '1';
    let balValue = formatEnergy(balNum).text;
    if (onBat) {
        balValue = `0 Вт <span style="color:#6cf">[${bat}]</span>`;
    }
    return {
        balance: balValue,
        production: formatEnergy(prodNum).text,
        consumption: formatEnergy(consNum).text,
        storage: `${formatEnergyWh(storedWh).text} / ${formatEnergyWh(smaxWh).text}`,
        remain: formatEnergyReserveRemain(storedWh, consNum, prodNum, maxDisW, measuredDrainW)
    };
}

function renderEnergyPopupContent(container, popup) {
    if (!container || !popup) return;
    const v = computeEnergyPopupValues(container);
    const remainIcon = POPUP_ICONS.capacity || POPUP_ICONS.storage || POPUP_ICONS.value;
    setResourcePopupHtml(popup, sectionTitleHtml('Энергия') +
        energyRowHtml('balance', POPUP_ICONS.balance, t('res.popup.balance'), v.balance) +
        energyRowHtml('production', POPUP_ICONS.production, t('res.popup.production'), v.production) +
        energyRowHtml('consumption', POPUP_ICONS.consumption, t('res.popup.consumption'), v.consumption) +
        energyRowHtml('storage', POPUP_ICONS.storage, t('res.popup.storage'), v.storage) +
        energyRowHtml('remain', remainIcon, t('res.popup.energyWillLast') || 'Энергии хватит', v.remain) +
        '<div class="popup-bottom-spacer"></div>');
    popup.dataset.energyReady = '1';
    try { refreshResourcePopupScroll(); } catch (_) {}
}

/** Живое обновление значений без пересборки DOM — сохраняет :hover */
function updateEnergyPopupValues(container, popup) {
    if (!container || !popup) return;
    if (popup.dataset.energyReady !== '1' || !popup.querySelector('[data-energy-key]')) {
        renderEnergyPopupContent(container, popup);
        return;
    }
    const v = computeEnergyPopupValues(container);
    for (const [key, html] of Object.entries(v)) {
        const el = popup.querySelector(`[data-energy-key="${key}"] .popup-row-value`);
        if (el) el.innerHTML = html;
    }
}

function renderGenericPopupContent(resourceId, label, valueText, popup) {
    setResourcePopupHtml(popup, sectionTitleHtml(resourceId) +
        popupRowHtml(POPUP_ICONS.value, label, valueText) +
        '<div class="popup-bottom-spacer"></div>');
    try { refreshResourcePopupScroll(); } catch (_) {}
}

/** Попап раздела «Технологии» — потоковая выработка */
function renderTechPopupContent(container, popup) {
    if (!container || !popup) return;
    const rate = Number(container.dataset.techProduction) || 0;
    const rateStr = `${formatResourceValue(rate)} ${t('unit.techPerMin') || 'тех./мин'}`;
    const techMeta = getResource('RES_TECH_OUTPUT');
    const icon = techMeta?.icon || POPUP_ICONS.value;
    const label = locName(techMeta?.name, t('res.popup.techOutput') || 'Текущая выработка технологий');
    setResourcePopupHtml(popup, sectionTitleHtml('Технологии') +
        popupRowHtml(icon, label, `${trendSlotHtml(rate)}${rateStr}`) +
        '<div class="popup-bottom-spacer"></div>');
    try { refreshResourcePopupScroll(); } catch (_) {}
}

/** Обновляет ресурсный бар под текущую локацию */
function formatPeople(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    return v.toLocaleString('ru-RU');
}

function dynamicsHtml(dynamics) {
    const d = Number(dynamics) || 0;
    const abs = Math.abs(d);
    const text = abs >= 10
        ? abs.toLocaleString('ru-RU', { maximumFractionDigits: 0 })
        : abs.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    if (d > 0.0001) return `<span style="color:#6d6">▲</span> ${text}`;
    if (d < -0.0001) return `<span style="color:#e66">▼</span> ${text}`;
    return `0`;
}

function popRowHtml(key, iconSrc, label, valueHtml) {
    return `<div class="popup-row is-hoverable" data-pop-key="${key}">
        <img class="popup-row-icon" src="${assetUrl(iconSrc)}" alt="" onerror="this.style.opacity='0.25'">
        <span class="popup-row-label">${label}</span>
        <span class="popup-row-value">${valueHtml}</span>
    </div>`;
}

function computePopulationPopupValues(container) {
    const total = Number(container.dataset.popTotal) || 0;
    const maxCap = Number(container.dataset.popMax) || 0;
    const homeless = Number(container.dataset.popHomeless) || 0;
    const settled = Number(container.dataset.popSettled) || 0;
    const dynamics = Number(container.dataset.popDynamics) || 0;
    const birth = Number(container.dataset.popBirth) || 0;
    const death = Number(container.dataset.popDeath) || 0;
    const birthPct = Number(container.dataset.popBirthPct) || 0;
    const deathPct = Number(container.dataset.popDeathPct) || 0;
    const birthDisp = container.dataset.popBirthDisplay || `${birthPct.toFixed(2)}%`;
    const deathDisp = container.dataset.popDeathDisplay || `${deathPct.toFixed(2)}%`;
    return {
        total: `${formatPeople(total)} / ${formatPeople(maxCap)}`,
        homeless: formatPeople(homeless),
        settled: formatPeople(settled),
        idlers: formatPeople(Number(container.dataset.popIdlers) || 0),
        creators: formatPeople(Number(container.dataset.popCreators) || 0),
        engineers: formatPeople(Number(container.dataset.popEngineers) || 0),
        agronomists: formatPeople(Number(container.dataset.popAgronomists) || 0),
        scientists: formatPeople(Number(container.dataset.popScientists) || 0),
        expeditioners: formatPeople(Number(container.dataset.popExpeditioners) || 0),
        dynamics: dynamicsHtml(dynamics),
        birth: `${formatPeople(birth)} ${t('res.perYearPeople')} [${birthDisp}]`,
        death: `${formatPeople(death)} ${t('res.perYearPeople')} [${deathDisp}]`
    };
}

function renderPopulationPopupContent(container, popup) {
    if (!container || !popup) return;
    const v = computePopulationPopupValues(container);
    setResourcePopupHtml(popup, sectionTitleHtml('Население') +
        popRowHtml('total', POPUP_ICONS.popTotal, t('pop.total'), v.total) +
        popRowHtml('homeless', POPUP_ICONS.popHomeless, t('pop.homeless'), v.homeless) +
        popRowHtml('settled', POPUP_ICONS.popSettled, t('pop.housed'), v.settled) +
        popRowHtml('idlers', POPUP_ICONS.popIdle, t('spec.idlers'), v.idlers) +
        popRowHtml('creators', POPUP_ICONS.popCreators, t('spec.creators'), v.creators) +
        popRowHtml('engineers', POPUP_ICONS.popEngineers, t('spec.engineers'), v.engineers) +
        popRowHtml('agronomists', POPUP_ICONS.popAgronomists, t('spec.agronomists'), v.agronomists) +
        popRowHtml('scientists', POPUP_ICONS.popScientists, t('spec.scientists'), v.scientists) +
        popRowHtml('expeditioners', POPUP_ICONS.popExpeditioners, t('spec.expeditioners'), v.expeditioners) +
        popRowHtml('dynamics', POPUP_ICONS.popDynamics, t('pop.dynamics'), v.dynamics) +
        popRowHtml('birth', POPUP_ICONS.popBirth, t('pop.birth'), v.birth) +
        popRowHtml('death', POPUP_ICONS.popDeath, t('pop.death'), v.death) +
        '<div class="popup-bottom-spacer"></div>');
    popup.dataset.popReady = '1';
    try { refreshResourcePopupScroll(); } catch (_) {}
}

function updatePopulationPopupValues(container, popup) {
    if (!container || !popup) return;
    if (popup.dataset.popReady !== '1' || !popup.querySelector('[data-pop-key]')) {
        renderPopulationPopupContent(container, popup);
        return;
    }
    const v = computePopulationPopupValues(container);
    for (const [key, html] of Object.entries(v)) {
        const el = popup.querySelector(`[data-pop-key="${key}"] .popup-row-value`);
        if (el) el.innerHTML = html;
    }
}



/** Сток ресурсов тела: { RES_ID: amount } */
function getBodyStock(bodyData) {
    const res = bodyData?.resources || {};
    if (res.stock && typeof res.stock === 'object') return { ...res.stock };
    // legacy fallback
    const stock = {};
    if (res.raw) stock.RES_WATER = Number(res.raw) * 1000;
    if (res.materials) stock.RES_METAL = Number(res.materials) * 1000;
    if (res.food) stock.RES_FOOD = Number(res.food) * 1000;
    return stock;
}

/** Каталог ресурсов из state (заполняется loadRecipesData) */
function resourceCatalog() {
    return globalThis.__resourceCatalog || new Map();
}

function sectionResourceIds(sectionKey) {
    // sectionKey: raw | materials | components | products | food
    const map = {
        'Сырье': 'raw',
        'Материалы': 'materials',
        'Компоненты': 'components',
        'Продукция': 'products',
        'Продовольствие': 'food'
    };
    const key = map[sectionKey] || sectionKey;
    const ids = [];
    for (const [id, r] of resourceCatalog()) {
        if (r.resourceBarSection === key) ids.push(id);
    }
    return ids;
}


/**
 * Порог нетто (ед/мин). Ниже — считаем баланс нулевым.
 * Гистерезис: чтобы сменить направление, нужен более сильный сигнал.
 */
const TREND_EPS = 1e-5;
const TREND_HOLD_EPS = 5e-5;

/** Нетто ед/мин по ресурсу: locId → { resourceId: net } */
const _stockRates = Object.create(null);
/** Производство / потребление для отладки и попапов: locId → { id: {prod, cons} } */
const _stockFlows = Object.create(null);
/** Стабилизированное направление: locId → { id: -1|0|1 } */
const _trendDir = Object.create(null);

function trendClassFromRate(rate, dirKey = null) {
    const r = Number(rate) || 0;
    let dir = 0;
    if (r > TREND_EPS) dir = 1;
    else if (r < -TREND_EPS) dir = -1;

    if (dirKey != null) {
        // bag по «корню» ключа (до первого ':') чтобы не плодить объекты
        const root = String(dirKey).split(':')[0] || '_';
        if (!_trendDir[root]) _trendDir[root] = Object.create(null);
        const bag = _trendDir[root];
        const prevDir = bag[dirKey] ?? 0;
        // гистерезис: слабый противоположный сигнал не переворачивает пирамидку
        if (prevDir !== 0 && dir !== 0 && dir !== prevDir && Math.abs(r) < TREND_HOLD_EPS) {
            dir = prevDir;
        }
        // в flat только при почти нулевом нетто
        if (dir === 0 && prevDir !== 0 && Math.abs(r) > TREND_EPS * 0.25) {
            dir = prevDir;
        }
        bag[dirKey] = dir;
    }

    if (dir > 0) return 'trend-up';
    if (dir < 0) return 'trend-down';
    return 'trend-flat';
}

function trendSlotHtml(rate, dirKey = null) {
    return `<span class="trend-slot ${trendClassFromRate(rate, dirKey)}" aria-hidden="true"></span>`;
}

function setTrendEl(el, rate, dirKey = null) {
    if (!el) return;
    el.classList.remove('trend-up', 'trend-down', 'trend-flat');
    el.classList.add(trendClassFromRate(rate, dirKey));
}

/**
 * Плановые потоки склада: производство и потребление (ед/мин).
 * Нетто = prod − cons — что «лидирует», то и показывает пирамидка.
 * Не смотрим на Δstock между кадрами (из‑за чередования тиков это мерцало).
 */
export function computeStockFlows(locationId, bodyData) {
    const locId = Number(locationId);
    const prod = Object.create(null);
    const cons = Object.create(null);
    /** Потенциальное производство (даже если склад полон — для «насыщения»). */
    const potProd = Object.create(null);
    const add = (map, id, v) => {
        if (!id || !(v > 0)) return;
        map[id] = (Number(map[id]) || 0) + v;
    };

    if (!Number.isFinite(locId) || !bodyData) {
        return { prod, cons, net: Object.create(null) };
    }

    try { state.initializeLocationBuildings?.(locId); } catch (_) {}
    const locMap = state.locationBuildings?.[locId] || {};

    for (const buildingId of Object.keys(locMap)) {
        try {
            if (!buildingBelongsToLocation(locId, buildingId)) continue;
        } catch (_) { /* ok */ }
        const locData = locMap[buildingId] || getLocationBuildingData?.(locId, buildingId);
        const count = locData?.built_count || 0;
        if (count <= 0) continue;

        for (const recipe of getRecipesForBuilding(buildingId)) {
            const localP = getRecipeLocalPower(locId, buildingId, recipe.id);
            if (localP <= 0) continue;
            const eff = getRecipeEffectiveness(locId, buildingId, recipe);
            if (eff <= 0) continue;

            // Склад полон по выходу → рецепт в тике не работает, но потенциал считаем
            let warehouseBlocked = false;
            try {
                warehouseBlocked = (recipe.outputs || []).some(out => {
                    const res = getResource(out.resourceId);
                    if (!res || res.isEffect || out.isEffect) return false;
                    if (out.resourceId === 'RES_ELECTRICITY' || out.resourceId === 'RES_TECH_OUTPUT') return false;
                    if (!res.form || res.form === 'energy' || res.form === 'tech' || res.form === 'info') return false;
                    return isResourceStorageFull(locId, out.resourceId, bodyData);
                });
            } catch (_) { warehouseBlocked = false; }

            // входы: складские и гео-залежи — без входа рецепт не «хочет» работать
            let inputOk = true;
            const inputPlan = [];
            for (const inp of recipe.inputs || []) {
                const isGeo = (typeof isGeoRecipeInput === 'function' && isGeoRecipeInput(inp))
                    || !!(inp && inp.geoResourceId);
                if (isGeo) {
                    const geoId = (typeof resolveInputGeoId === 'function' ? resolveInputGeoId(inp) : null) || inp.geoResourceId;
                    let rate = (Number(inp.perMinute) || 0) * count * eff;
                    try {
                        const out = (recipe.outputs || []).find(o => o?.resourceId);
                        if (out?.resourceId) {
                            rate = getRecipeActualOutput(locId, buildingId, recipe, out.resourceId);
                        }
                    } catch (_) {}
                    if (rate <= 0) continue;
                    let have = 0;
                    try { have = getDepositRemainingKg(bodyData, geoId); } catch (_) { have = 0; }
                    if (!(have > 1e-9)) { inputOk = false; break; }
                    continue;
                }
                const rate = (Number(inp.perMinute) || 0) * count * eff;
                if (rate <= 0) continue;
                const pick = pickInputResource(bodyData, inp, rate);
                if (!pick) { inputOk = false; break; }
                if (pick.infinite) continue;
                const have = Number(pick.have) || 0;
                // строго: нулевой сток = рецепт не производит
                if (!(have > 1e-9)) { inputOk = false; break; }
                // масштабируем расход/выход, если запаса меньше минутной нормы
                const scale = have >= rate ? 1 : (have / rate);
                inputPlan.push({ id: pick.resourceId, rate: rate * scale, scale });
            }
            if (!inputOk) continue;

            const inScale = inputPlan.length
                ? Math.min(1, ...inputPlan.map(c => (c.scale != null ? c.scale : 1)))
                : 1;

            // расход входов — только если рецепт реально идёт (склад не блокирует)
            if (!warehouseBlocked) {
                for (const c of inputPlan) add(cons, c.id, c.rate);
            }

            for (const out of recipe.outputs || []) {
                const res = getResource(out.resourceId);
                if (!res || res.isEffect || out.isEffect) continue;
                if (out.resourceId === 'RES_ELECTRICITY' || out.resourceId === 'RES_TECH_OUTPUT') continue;
                if (!res.form || res.form === 'energy' || res.form === 'tech' || res.form === 'info') continue;
                let rate = 0;
                try {
                    rate = getRecipeActualOutput(locId, buildingId, recipe, out.resourceId);
                } catch (_) {
                    rate = (Number(out.perMinute) || 0) * count * eff;
                }
                rate *= inScale;
                if (!(rate > 0)) continue;
                // потенциал всегда
                add(potProd, out.resourceId, rate);
                // фактический поток — только если склад принимает
                if (!warehouseBlocked) {
                    add(prod, out.resourceId, rate);
                }
            }
        }
    }

    // население
    try {
        const stats = getPopulationStats(locId, bodyData);
        const people = Math.max(0, Number(stats?.total) || 0);
        if (people > 0) {
            const list = listConsumableResources();
            const solid = list.filter(r => r.foodType === 'solid');
            const liquid = list.filter(r => r.foodType === 'liquid');
            for (const group of [solid, liquid]) {
                const available = group.filter(r => {
                    const res = getResource(r.id);
                    if (res?.infinite) return true;
                    return (Number(getBodyStock(bodyData)[r.id]) || 0) > 1e-12;
                });
                if (!available.length) continue;
                let minP = 9;
                for (const r of available) minP = Math.min(minP, r.priority);
                const tier = available.filter(r => r.priority === minP);
                const n = tier.length || 1;
                for (const r of tier) {
                    const rate = (Number(r.perPersonPerMinute) || 0) * people / n;
                    add(cons, r.id, rate);
                }
            }
        }
    } catch (_) {}

    const net = Object.create(null);
    const ids = new Set([...Object.keys(prod), ...Object.keys(cons), ...Object.keys(potProd)]);
    for (const id of ids) {
        const p = Number(prod[id]) || 0;
        const c = Number(cons[id]) || 0;
        const pot = Number(potProd[id]) || 0;
        let n = p - c;
        // Склад полон, производство «упирается» в потолок: не показываем падение,
        // если потенциал ≥ потребления (сток удерживается у максимума).
        try {
            if (isResourceStorageFull(locId, id, bodyData) && pot > 0) {
                if (pot >= c - 1e-12) n = 0;
                else n = pot - c; // потребление сильнее потенциала — реально падает
            }
        } catch (_) {}
        net[id] = n;
    }
    return { prod, cons, net, potProd };
}

/**
 * Обновить плановые нетто-скорости (ед/мин) по локации.
 */
function updateStockRates(locationId, bodyData) {
    const locId = Number(locationId);
    if (!Number.isFinite(locId)) return {};
    const { prod, cons, net, potProd } = computeStockFlows(locId, bodyData);
    _stockFlows[locId] = { prod, cons, potProd: potProd || {} };
    _stockRates[locId] = net;
    return net;
}

function sectionNetRate(locationId, sectionKey) {
    const rates = _stockRates[Number(locationId)] || {};
    const ids = sectionResourceIds(sectionKey);
    let sum = 0;
    for (const id of ids) sum += Number(rates[id]) || 0;
    return sum;
}

function resourceRate(locationId, resourceId) {
    return Number((_stockRates[Number(locationId)] || {})[resourceId]) || 0;
}

/** Публичный доступ к нетто / prod / cons (ед/мин) по ресурсу локации */
export function getResourceNetRate(locationId, resourceId) {
    return resourceRate(locationId, resourceId);
}
export function getLocationStockFlows(locationId) {
    const locId = Number(locationId);
    const flows = _stockFlows[locId];
    if (flows) {
        return {
            prod: { ...flows.prod },
            cons: { ...flows.cons },
            potProd: { ...(flows.potProd || {}) },
            net: { ...(_stockRates[locId] || {}) }
        };
    }
    return { prod: {}, cons: {}, potProd: {}, net: {} };
}

/** Пересчитать и закэшировать потоки склада по локации (для панелей вне resource-bar). */
export function refreshLocationStockFlows(locationId, bodyData) {
    return updateStockRates(locationId, bodyData);
}

function formatMassKg(kg) {
    const n = Number(kg) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} ${t('unit.millionT')}`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} ${t('unit.thousandT')}`;
    if (n >= 1000) return `${(n / 1000).toFixed(2)} ${t('unit.t')}`;
    return `${Math.round(n)} ${t('unit.kg')}`;
}

/** Штуки с приставками: 2 шт. / 1.5 тыс. шт. / … (целое до тысяч) */
function formatPieces(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)} ${t('unit.trillionPcs')}`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} ${t('unit.billionPcs')}`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} ${t('unit.millionPcs')}`;
    if (n >= 1000) return `${(n / 1000).toFixed(2)} ${t('unit.thousandPcs')}`;
    return `${n} ${t('unit.pcs')}`;
}

/**
 * Для штучного ресурса: [N шт.] перед массой.
 * count = floor(mass / packageWeightKg)
 */
function piecePrefixHtml(meta, amountKg) {
    if (!meta?.isPieceItem) return '';
    const w = Number(meta.packageWeightKg) || 0;
    if (w <= 0) return '';
    const pcs = Math.floor(Math.max(0, Number(amountKg) || 0) / w);
    return `<span class="res-piece-count">[${formatPieces(pcs)}]</span>`;
}


/** Обновить только значения в уже отрисованных строках (сохраняет :hover) */
function updateStockSectionPopupValues(resourceId, bodyData, popup) {
    if (!popup || isStockSectionMasked()) return;
    const stock = getBodyStock(bodyData);
    const ids = sectionResourceIds(resourceId);
    const locId = bodyData?.id != null
        ? Number(bodyData.id)
        : (globalThis.__currentBodyData?.id != null ? Number(globalThis.__currentBodyData.id) : null);
    for (const rid of ids) {
        const row = popup.querySelector(`.popup-row.is-resource[data-rid="${rid}"]`);
        if (!row) continue;
        const meta = resourceCatalog().get(rid) || { name: [rid], icon: POPUP_ICONS.value };
        const amount = Number(stock[rid]) || 0;
        const rate = locId != null ? resourceRate(locId, rid) : 0;
        const dirKey = locId != null ? `${locId}:${rid}` : null;
        const cap = locId != null ? getResourceMaxCapacity(locId, rid) : 0;
        const amountStr = formatMassKg(amount);
        const capStr = (Number.isFinite(cap) && cap > 0) ? formatMassKg(cap) : '—';
        const pieceHtml = piecePrefixHtml(meta, amount);
        const valueHtml = `${trendSlotHtml(rate, dirKey)}${pieceHtml}${amountStr}<span class="res-cap-sep"> / </span><span class="res-cap-max">${capStr}</span>`;
        const valEl = row.querySelector('.popup-row-value');
        if (valEl) valEl.innerHTML = valueHtml;
    }
    // вместимость раздела — последняя строка без is-resource или с storage
    // пересчитаем через лёгкий вызов только capacity строки если есть
    const capRow = popup.querySelector('.popup-row[data-capacity="1"] .popup-row-value');
    if (capRow && locId != null) {
        try {
            // renderStockSectionPopup строит capacity — дублируем формулу ниже при полном рендере
        } catch (_) {}
    }
}

function renderStockSectionPopup(resourceId, bodyData, popup) {
    popup.dataset.stockSection = resourceId || '';
    if (isStockSectionMasked()) {
        setResourcePopupHtml(popup, sectionTitleHtml(resourceId) +
            popupRowHtml(POPUP_ICONS.value || '', t('res.popup.contents'), t('common.unknownLower')) +
            '<div class="popup-bottom-spacer"></div>');
        return;
    }
    const stock = getBodyStock(bodyData);
    const ids = sectionResourceIds(resourceId);
    const locId = bodyData?.id != null
        ? Number(bodyData.id)
        : (globalThis.__currentBodyData?.id != null ? Number(globalThis.__currentBodyData.id) : null);
    const rows = [];
    for (const rid of ids) {
        const meta = resourceCatalog().get(rid) || { name: [rid], icon: POPUP_ICONS.value };
        const amount = Number(stock[rid]) || 0;
        const icon = meta.icon || POPUP_ICONS.value;
        const label = locName(meta.name, rid);
        const rate = locId != null ? resourceRate(locId, rid) : 0;
        const dirKey = locId != null ? `${locId}:${rid}` : null;
        const cap = locId != null ? getResourceMaxCapacity(locId, rid) : 0;
        const amountStr = formatMassKg(amount);
        const capStr = (Number.isFinite(cap) && cap > 0) ? formatMassKg(cap) : '—';
        // [N шт.] текущая_масса / макс_масса  (пробелы вокруг слэша)
        const pieceHtml = piecePrefixHtml(meta, amount);
        const valueHtml = `${trendSlotHtml(rate, dirKey)}${pieceHtml}${amountStr}<span class="res-cap-sep"> / </span><span class="res-cap-max">${capStr}</span>`;
        rows.push(popupRowHtml(icon, label, valueHtml, { resource: true, rid }));
    }
    if (!rows.length) {
        rows.push(popupRowHtml(
            POPUP_ICONS.value,
            t('res.popup.inDev') || 'В разработке',
            `${trendSlotHtml(0)}—`
        ));
    }
    // Вместимость раздела: только ресурсы этого раздела
    // stored = Σ min(have_i, cap_i), max = Σ cap_i  →  percent
    let capacityRow = '';
    if (locId != null) {
        const fill = getSectionStorageFill(locId, bodyData, resourceId);
        if (fill.max > 0) {
            let secRate = 0;
            for (const rid of ids) secRate += resourceRate(locId, rid) || 0;
            const pct = Math.min(100, Math.max(0, fill.percent));
            const pctStr = `${pct.toFixed(1)}% / 100%`;
            capacityRow = popupRowHtml(
                POPUP_ICONS.capacity || POPUP_ICONS.storage || POPUP_ICONS.value || '',
                t('res.popup.capacity'),
                `${trendSlotHtml(secRate, `${locId}:section:${resourceId}`)}${pctStr}`
            );
        }
    }
    setResourcePopupHtml(popup, sectionTitleHtml(resourceId) +
        capacityRow +
        rows.join('') +
        '<div class="popup-bottom-spacer"></div>');
    try { refreshResourcePopupScroll(); } catch (_) {}
}


export function updateResourceBar(currentLocation) {
    const bar = document.getElementById('resource-bar');
    if (!bar) return;
    applyBarSectionIcons();

    const colonized = !!(currentLocation && currentLocation.data && currentLocation.data.colonized);
    globalThis.__currentBodyData = currentLocation?.data || null;
    const resources = (currentLocation && currentLocation.data && currentLocation.data.resources) || {};

    // Тренды стока (сырьё / материалы / еда) — обязательно до setTrendEl
    if (colonized && currentLocation?.data?.id != null) {
        updateStockRates(currentLocation.data.id, currentLocation.data);
    }

    let energyConsumption = 0;
    let energyProduction = 0;
    let storageStored = 0;
    let storageMax = 0;
    let storageMaxDischargeW = 0;
    let batteryOutputW = 0;
    // lid должен быть виден во всём forEach (сток / технологии / тренды)
    const lid = (colonized && currentLocation?.data?.id != null)
        ? currentLocation.data.id
        : null;
    if (lid != null) {
        energyConsumption = calcLocationEnergyConsumption(lid);
        energyProduction = calcLocationEnergyProduction(lid);
        const st = calcLocationStorageTotals(lid);
        storageStored = st.storedWh;
        storageMax = st.maxWh;
        storageMaxDischargeW = Number(st.maxDischargeW) || 0;
        batteryOutputW = calcLocationBatteryOutputW(lid);
    }
    const energyBalance = Math.max(0, energyProduction - energyConsumption);
    const onBattery = energyBalance <= 0 && storageMax > 0 && batteryOutputW > 0;

    document.querySelectorAll('.resource-container').forEach(container => {
        const resourceId = container.dataset.resourceId;
        const meta = RESOURCE_KEY_MAP[resourceId];
        if (!meta) {
            container.style.display = colonized ? '' : 'none';
            return;
        }

        if (!colonized) {
            container.style.display = 'none';
            return;
        }

        container.style.display = '';
        let value;
        const valueEl = container.querySelector('.resource-value');
        const unitEl = container.querySelector('.resource-unit');

        if (resourceId === 'Энергия') {
            const fe = formatEnergy(energyBalance);
            if (valueEl) {
                if (onBattery) {
                    // 0 Вт + голубым [мощность с аккумуляторов]
                    const bat = formatEnergy(batteryOutputW);
                    valueEl.innerHTML = `${formatEnergy(0, { withUnit: false }).text}<span class="energy-battery-hint"> [${bat.text}]</span>`;
                    valueEl.style.color = '';
                } else {
                    valueEl.textContent = formatEnergy(energyBalance, { withUnit: false }).text;
                    valueEl.style.color = '';
                }
            }
            if (unitEl) unitEl.textContent = onBattery ? '' : (' ' + fe.unit);

            container.dataset.resourceValue = String(energyBalance);
            container.dataset.resourceLabel = 'Текущий энергетический баланс';
            container.dataset.energyProduction = String(energyProduction);
            container.dataset.energyConsumption = String(energyConsumption);
            container.dataset.energyBalance = String(energyBalance);
            container.dataset.storageStored = String(storageStored);
            container.dataset.storageMax = String(storageMax);
            container.dataset.storageMaxDischarge = String(storageMaxDischargeW);
            container.dataset.batteryOutput = String(batteryOutputW);
            try {
                const drain = Number(state.locationFlags?.[lid]?.lastBatteryDrainW) || 0;
                container.dataset.batteryDrain = String(drain);
            } catch (_) {
                container.dataset.batteryDrain = '0';
            }
            container.dataset.onBattery = onBattery ? '1' : '0';
        } else if (resourceId === 'Население') {
            const stats = getPopulationStats(currentLocation.data.id, currentLocation.data);
            // подстрахуем распределение при обновлении UI
            redistributePopulation(currentLocation.data.id, currentLocation.data);
            const stats2 = getPopulationStats(currentLocation.data.id, currentLocation.data);

            if (valueEl) {
                valueEl.textContent = formatResourceValue(Math.floor(stats2.total));
            }
            if (unitEl) unitEl.textContent = t('unit.people');

            container.dataset.resourceValue = String(stats2.total);
            container.dataset.resourceLabel = t('pop.total');
            clampSpecialistsToSettled(currentLocation.data.id);
            const sp = getSpecialistStats(currentLocation.data.id);
            container.dataset.popTotal = String(stats2.total);
            container.dataset.popMax = String(stats2.maxCapacity);
            container.dataset.popHomeless = String(stats2.homeless);
            container.dataset.popSettled = String(stats2.settled);
            container.dataset.popIdlers = String(sp.idlers);
            container.dataset.popCreators = String(sp.creators);
            container.dataset.popEngineers = String(sp.engineers);
            container.dataset.popAgronomists = String(sp.agronomists);
            container.dataset.popScientists = String(sp.scientists);
            container.dataset.popExpeditioners = String(sp.expeditioners || 0);
            container.dataset.popDynamics = String(stats2.dynamics);
            container.dataset.popBirth = String(stats2.birthsPerYear);
            container.dataset.popDeath = String(stats2.deathsPerYear);
            container.dataset.popBirthPct = String(stats2.birthRatePct);
            container.dataset.popDeathPct = String(stats2.deathRatePct);
            setTrendEl(
                container.querySelector('[data-trend]'),
                Number(stats2.dynamics) || ((Number(stats2.birthsPerYear)||0) - (Number(stats2.deathsPerYear)||0)),
                `${currentLocation.data.id}:pop`
            );
            container.dataset.popBirthDisplay = stats2.birthDisplay || `${Number(stats2.birthRatePct || 0).toFixed(2)}%`;
            container.dataset.popDeathDisplay = stats2.deathDisplay || `${Number(stats2.deathRatePct || 0).toFixed(2)}%`;
            if (stats2.famine) container.dataset.popFamine = stats2.famine;
            else delete container.dataset.popFamine;

            delete container.dataset.energyProduction;
            delete container.dataset.energyConsumption;
            delete container.dataset.energyBalance;
            delete container.dataset.storageStored;
            delete container.dataset.storageMax;
            delete container.dataset.batteryOutput;
            delete container.dataset.onBattery;
        } else if (resourceId === 'Технологии') {
            let techProd = 0;
            try {
                if (lid != null) techProd = calcLocationTechProduction(lid) || 0;
            } catch (_) {
                techProd = 0;
            }
            if (valueEl) valueEl.textContent = formatResourceValue(techProd);
            if (unitEl) unitEl.textContent = resourceUnitText(meta);
            container.dataset.resourceValue = String(techProd);
            container.dataset.techProduction = String(techProd);
            container.dataset.resourceLabel = t('res.popup.techOutput') || 'Текущая выработка технологий';
            setTrendEl(
                container.querySelector('[data-trend]'),
                techProd,
                lid != null ? `${lid}:tech` : null
            );
        } else if (isStockBarSection(resourceId)) {
            if (isStockSectionMasked()) {
                if (valueEl) valueEl.textContent = t('common.unknownLower');
                if (unitEl) unitEl.textContent = '';
                container.dataset.resourceValue = 'masked';
                container.dataset.resourceLabel = resourceId;
                container.dataset.stockSection = resourceId;
                container.dataset.stockMasked = '1';
                setTrendEl(container.querySelector('[data-trend]'), 0);
            } else {
                delete container.dataset.stockMasked;
                const stock = getBodyStock(currentLocation.data);
                const ids = sectionResourceIds(resourceId);
                let totalKg = 0;
                for (const rid of ids) totalKg += Number(stock[rid]) || 0;
                if (!ids.length) {
                    totalKg = (Number(resources[meta.key]) || 0) * 1000;
                }
                const massStr = formatMassKg(totalKg);
                // единица может быть локализована — отрезаем последний токен
                const parts = massStr.trim().split(/\s+/);
                const unitTok = parts.length > 1 ? parts[parts.length - 1] : 'кг';
                const numTok = parts.length > 1 ? parts.slice(0, -1).join(' ') : massStr;
                if (valueEl) valueEl.textContent = numTok;
                if (unitEl) unitEl.textContent = ' ' + unitTok;
                container.dataset.resourceValue = String(totalKg);
                container.dataset.resourceLabel = resourceId;
                container.dataset.stockSection = resourceId;
                const net = lid != null ? sectionNetRate(lid, resourceId) : 0;
                setTrendEl(container.querySelector('[data-trend]'), net, lid != null ? `${lid}:section:${resourceId}` : null);
            }
        } else {
            const value = resources[meta.key] ?? 0;
            if (valueEl) valueEl.textContent = formatResourceValue(value);
            if (unitEl && meta.unitKey) unitEl.textContent = resourceUnitText(meta);
            container.dataset.resourceValue = String(value);
            container.dataset.resourceLabel = t('res.popup.value');
        }
    });

    // Сам resource-bar всегда видим; скрывается только контент (resource-container)
    bar.style.display = '';

    // Если popup открыт — обновить живьём (энергия, население, сырьё/материалы/еда)
    const popup = document.getElementById('resource-popup');
    if (popup && popup.style.display === 'block') {
        const active = document.querySelector('.resource-container.active');
        if (!active) return;
        const rid = active.dataset.resourceId;
        if (rid === 'Энергия') {
            updateEnergyPopupValues(active, popup);
        } else if (rid === 'Население') {
            updatePopulationPopupValues(active, popup);
        } else if (rid === 'Технологии') {
            updateTechPopupValues(active, popup);
        } else if (isStockBarSection(rid)) {
            const bodyData = globalThis.__currentBodyData || currentLocation?.data || null;
            // не пересоздаём DOM строк — иначе :hover сбрасывается каждый тик
            if (popup.dataset.stockSection === rid && popup.querySelector('.popup-row.is-resource')) {
                updateStockSectionPopupValues(rid, bodyData, popup);
            } else {
                renderStockSectionPopup(rid, bodyData, popup);
            }
        } else {
            const label = active.dataset.resourceLabel || t('res.popup.value');
            const unitText = active.querySelector('.resource-unit')?.textContent || '';
            const valueText = (active.querySelector('.resource-value')?.textContent || '0') + (unitText || '');
            renderGenericPopupContent(rid, label, valueText, popup);
        }
    }
}


/** Инициализация кликов по ресурсному бару и popup */

let _resPopupScroll = null;
function ensureResourcePopupScroll() {
    const popup = document.getElementById('resource-popup');
    if (!popup) return null;
    try {
        _resPopupScroll = attachFirmScroll(popup, {
            axis: 'y',
            mirrorV: true,
            host: 'self',
            fillHost: false
        });
    } catch (e) {
        console.warn('resource popup firmScroll', e);
    }
    const inner = popup.querySelector(':scope > .firm-scroll-inner');
    if (inner) {
        // жёстко ограничиваем высоту, иначе height:auto раздувает и скролла нет
        inner.style.maxHeight = '70vh';
        inner.style.height = 'auto';
        inner.style.overflowY = 'auto';
        inner.style.overflowX = 'hidden';
    }
    return inner || popup;
}
function refreshResourcePopupScroll() {
    try { _resPopupScroll?.update(); } catch (_) {}
    try { updateFirmScroll(document.getElementById('resource-popup')); } catch (_) {}
}
/** Пишем HTML во внутренний слой firmScroll, не снося треки */
function setResourcePopupHtml(popup, html) {
    if (!popup) return;
    const root = ensureResourcePopupScroll();
    const target = (root && root.classList && root.classList.contains('firm-scroll-inner'))
        ? root
        : (popup.querySelector(':scope > .firm-scroll-inner') || popup);
    target.innerHTML = html;
    // после layout — пересчитать бегунок (попап уже display:block)
    const kick = () => {
        try {
            ensureResourcePopupScroll();
            refreshResourcePopupScroll();
        } catch (_) {}
    };
    requestAnimationFrame(() => requestAnimationFrame(kick));
    try { bindChartsButtons(popup); } catch (_) {}
}


/** Открыть попап раздела ресурсной полоски программно (для «Назад» из графиков трендов) */
export function openResourceSectionPopup(sectionKey) {
    const popup = document.getElementById('resource-popup');
    if (!popup || sectionKey == null) return false;
    const container = document.querySelector(`.resource-container[data-resource-id="${sectionKey}"]`);
    if (!container) return false;

    document.querySelectorAll('.resource-container').forEach(c => c.classList.remove('active'));
    container.classList.add('active');

    const rect = container.getBoundingClientRect();
    const offsetY = 1;
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + offsetY}px`;
    popup.style.opacity = '';
    popup.style.display = 'block';
    try { ensureResourcePopupScroll(); } catch (_) {}

    const resourceId = container.dataset.resourceId;
    const unitText = container.querySelector('.resource-unit')?.textContent || '';
    if (resourceId === 'Энергия') {
        renderEnergyPopupContent(container, popup);
    } else if (resourceId === 'Население') {
        renderPopulationPopupContent(container, popup);
    } else if (resourceId === 'Технологии') {
        renderTechPopupContent(container, popup);
    } else if (isStockBarSection(resourceId)) {
        const bodyData = globalThis.__currentBodyData || null;
        renderStockSectionPopup(resourceId, bodyData, popup);
    } else {
        const label = container.dataset.resourceLabel || t('res.popup.value');
        const valueText = (container.querySelector('.resource-value')?.textContent || '0') + (unitText || '');
        renderGenericPopupContent(resourceId, label, valueText, popup);
    }
    try { refreshResourcePopupScroll(); } catch (_) {}
    try { bindChartsButtons(popup); } catch (_) {}
    // синхронизировать activeContainer внутри init, если он уже инициализирован
    try {
        if (typeof globalThis.__setResourcePopupActive === 'function') {
            globalThis.__setResourcePopupActive(container);
        }
    } catch (_) {}
    return true;
}

export function initResourcePopup() {
    const popup = document.getElementById('resource-popup');
    let activeContainer = null;
    globalThis.__setResourcePopupActive = (el) => { activeContainer = el || null; };

    document.querySelectorAll('.resource-container').forEach(container => {
        container.addEventListener('click', (e) => {
            e.stopPropagation(); // Предотвращаем всплытие, чтобы не сработал document click
            if (activeContainer === container) {
                // Если кликнули на уже активный контейнер, скрываем popup
                container.classList.remove('active');
                popup.style.display = 'none';
                activeContainer = null;
            } else {
                // Снимаем active с других контейнеров
                document.querySelectorAll('.resource-container').forEach(c => {
                    c.classList.remove('active');
                });
                // Активируем текущий
                container.classList.add('active');
                activeContainer = container;

                // Получаем координаты и размеры контейнера
                const rect = container.getBoundingClientRect();
                const popupWidth = 307; // width в CSS (230 + 1/3)
                const offsetY = 1; // Отступ под контейнером

                // Позиционируем popup
                popup.style.left = `${rect.left}px`;
                popup.style.top = `${rect.bottom + offsetY}px`;
                popup.style.opacity = '';
                popup.style.display = 'block';
                try { ensureResourcePopupScroll(); } catch (_) {}

                const resourceId = container.dataset.resourceId;
                const unitText = container.querySelector('.resource-unit')?.textContent || '';
                if (resourceId === 'Энергия') {
                    renderEnergyPopupContent(container, popup);
                } else if (resourceId === 'Население') {
                    renderPopulationPopupContent(container, popup);
                } else if (resourceId === 'Технологии') {
                    renderTechPopupContent(container, popup);
                } else if (isStockBarSection(resourceId)) {
                    const bodyData = globalThis.__currentBodyData || null;
                    renderStockSectionPopup(resourceId, bodyData, popup);
                } else {
                    const label = container.dataset.resourceLabel || t('res.popup.value');
                    const valueText = (container.querySelector('.resource-value')?.textContent || '0') + (unitText || '');
                    renderGenericPopupContent(resourceId, label, valueText, popup);
                }
                try { refreshResourcePopupScroll(); } catch (_) {}
            }
        });
    });

    // Закрытие popup при клике вне контейнера
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.resource-container') && !e.target.closest('#resource-popup')) {
            if (activeContainer) {
                activeContainer.classList.remove('active');
                popup.style.display = 'none';
                activeContainer = null;
            }
        }
    });

    // Колёсико над попапом — только скролл списка, не высота камеры космоса
    if (popup && popup.dataset.wheelBound !== '1') {
        popup.dataset.wheelBound = '1';
        popup.setAttribute('data-ui', 'true');
        popup.addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, { passive: true, capture: true });
    }
    ensureResourcePopupScroll();
}