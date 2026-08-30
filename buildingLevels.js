/**
 * buildingLevels.js — вкладка «Уровни» в модалке здания.
 * Таблица характеристик по уровням + попап требуемых ресурсов.
 */

import { t, locName } from './settings.js';
import { getLocationBuildingData, getStructureMax, getMaxForLevel } from './buildingHelpers.js';
import { getLevelCostEntries, hasResourceCostTable, renderCostCardsHtml } from './buildingResourceCosts.js';
import { formatValue } from './bodyParameters.js';
import { formatEnergy, formatEnergyWh } from './functions.js';
import { getRecipesForBuilding , getTheoreticalMaxEnergyCapacityWh, buildingHasEnergyCapacityRecipe } from './recipes.js';
import { isChapter2Done } from './uiMasks.js';
import { state } from './state.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';

const PANEL_ID = 'levels-panel';
const TABLE_ID = 'levels-table';
const POPOVER_ID = 'levels-cost-popover';

let _popoverBound = false;
let _outsideCloseBound = false;

function arrHasValues(arr) {
    return Array.isArray(arr) && arr.some(v => v != null && Number(v) !== 0);
}

/** Какие колонки показывать для шаблона здания */

let _levelsScroll = null;
function ensureLevelsFirmScroll() {
    const scroll = document.querySelector('.levels-table-scroll');
    if (!scroll) return;
    try {
        _levelsScroll = attachFirmScroll(scroll, { axis: 'both', mirrorV: true, host: 'self', fillHost: true });
    } catch (e) {
        console.warn('levels firmScroll', e);
    }
}

export function getLevelsColumns(template) {
    const cols = [
        { id: 'level', label: t('levels.col.level') || 'Уровень', always: true },
        { id: 'costs', label: t('levels.col.costs') || 'Требуемые ресурсы', always: true }
    ];

    const structure = template?.Structure || template?.structure;
    if (arrHasValues(structure) || (structure && structure.length)) {
        cols.push({ id: 'structure', label: t('levels.col.structure') || 'Структура' });
    }

    const area = template?.OccupiedArea || template?.occupiedArea;
    if (arrHasValues(area) || (area && area.length)) {
        cols.push({ id: 'area', label: t('levels.col.area') || 'Площадь' });
    }

    const needsEnergy = !!(template?.RequiresElectricity || template?.requiresElectricity);
    const cons = template?.EnergyConsumption || template?.energyConsumption;
    if (needsEnergy && (arrHasValues(cons) || (Array.isArray(cons) && cons.length))) {
        cols.push({ id: 'energyCons', label: t('levels.col.energyCons') || 'Макс. потребление энергии' });
    }

    const produces = !!(template?.ProducesElectricity || template?.producesElectricity);
    const prod = template?.EnergyProduction || template?.energyProduction;
    const hasElecRecipe = buildingHasElectricityRecipe(template);
    if (produces || hasElecRecipe || (Array.isArray(prod) && prod.length)) {
        cols.push({ id: 'energyProd', label: t('levels.col.energyProd') || 'Макс. производство энергии' });
    }

    const stores = !!(template?.StoresEnergy || template?.storesEnergy);
    const cap = template?.MaxEnergyCapacity || template?.maxEnergyCapacity;
    if (stores && (arrHasValues(cap) || (Array.isArray(cap) && cap.length))) {
        cols.push({ id: 'energyStored', label: t('levels.col.energyStored') || 'Накоплено энергии (макс.)' });
    }

    const isRes = !!(template?.IsResidential || template?.isResidential);
    const pop = template?.PopulationCapacity || template?.populationCapacity;
    if (isRes || arrHasValues(pop) || (Array.isArray(pop) && pop.length)) {
        cols.push({ id: 'population', label: t('levels.col.population') || 'Вместимость населения' });
    }

    return cols;
}

function levelCount(template) {
    const maxL = Math.max(0, Number(template?.maxLevel) || 0);
    // rows 0..maxLevel inclusive
    return maxL + 1;
}

function energyText(wattsOrObj) {
    if (wattsOrObj == null) return '—';
    if (typeof wattsOrObj === 'object' && wattsOrObj.text != null) return String(wattsOrObj.text);
    try {
        const r = formatEnergy(wattsOrObj);
        return (r && r.text != null) ? String(r.text) : String(wattsOrObj);
    } catch (_) {
        return String(wattsOrObj);
    }
}

function energyWhText(whOrObj) {
    if (whOrObj == null) return '—';
    if (typeof whOrObj === 'object' && whOrObj.text != null) return String(whOrObj.text);
    try {
        const r = formatEnergyWh(whOrObj);
        return (r && r.text != null) ? String(r.text) : String(whOrObj);
    } catch (_) {
        return String(whOrObj);
    }
}


/** Множитель EnergyProduction[level] (не ватты). */
function getEnergyProductionMultiplier(template, level) {
    const arr = template?.EnergyProduction || template?.energyProduction || [];
    if (!Array.isArray(arr) || !arr.length) return 1;
    const v = Number(getMaxForLevel(arr, level));
    return Number.isFinite(v) && v > 0 ? v : 1;
}

function buildingHasElectricityRecipe(template) {
    if (!template?.id) return false;
    try {
        const recipes = getRecipesForBuilding(template.id) || [];
        return recipes.some(r => (r.outputs || []).some(o => o.resourceId === 'RES_ELECTRICITY'));
    } catch (_) {
        return false;
    }
}

/**
 * Теоретический макс. выход электроэнергии (Вт) на уровне для 1 единицы здания:
 * 100% мощности здания, 100% мощности рецепта, полный штат специалистов.
 * Сумма по всем рецептам с RES_ELECTRICITY.
 */
function getTheoreticalMaxElectricityW(template, level) {
    const mult = getEnergyProductionMultiplier(template, level);
    let watts = 0;
    let recipeCount = 0;
    try {
        const recipes = getRecipesForBuilding(template.id) || [];
        for (const recipe of recipes) {
            for (const out of recipe.outputs || []) {
                if (out.resourceId !== 'RES_ELECTRICITY') continue;
                recipeCount++;
                const perMin = Number(out.perMinute) || 0;
                if (out.scaleWithBuildingEnergyProduction) {
                    watts += perMin * mult; // ×1 unit
                } else {
                    watts += perMin;
                }
            }
        }
    } catch (_) {}
    return { mult, watts, recipeCount };
}

function formatEnergyProdCell(template, level) {
    const { mult, watts, recipeCount } = getTheoreticalMaxElectricityW(template, level);
    const multStr = (Math.abs(mult - Math.round(mult)) < 1e-9)
        ? String(Math.round(mult))
        : (mult >= 10 ? mult.toFixed(1) : mult.toFixed(2));
    if (!(watts > 0) && recipeCount === 0) {
        // нет рецепта — только множитель здания
        return `×${multStr}`;
    }
    const wText = energyText(watts);
    return `×${multStr} [${wText}]`;
}

function formatStructure(v) {
    if (v == null || !(Number(v) >= 0)) return '—';
    return formatValue(Number(v), t('unit.HP') || 'ОЖ');  // литерал/перевод ОЖ
}

function formatArea(m2) {
    if (m2 == null || !(Number(m2) >= 0)) return '—';
    const n = Number(m2);
    const u = t('unit.m2') || 'м²';
    return formatValue(n, u);
}

function formatPop(v) {
    if (v == null || !(Number(v) >= 0)) return '—';
    return `${Math.round(Number(v))} ${t('unit.people') || 'чел.'}`;
}

function costsSummary(template, level) {
    const entries = getLevelCostEntries(template, level);
    if (!entries.length) return { text: '—', count: 0, entries };
    if (entries.length === 1) {
        const meta = null;
        return { text: '1…', count: 1, entries };
    }
    return { text: `${entries.length}…`, count: entries.length, entries };
}

function cellValue(template, colId, level) {
    switch (colId) {
        case 'level':
            return String(level);
        case 'costs': {
            if (!hasResourceCostTable(template)) return '—';
            const s = costsSummary(template, level);
            return s.text;
        }
        case 'structure':
            return formatStructure(getStructureMax(template, level));
        case 'area': {
            const arr = template.OccupiedArea || template.occupiedArea || [];
            return formatArea(getMaxForLevel(arr, level));
        }
        case 'energyCons': {
            const arr = template.EnergyConsumption || template.energyConsumption || [];
            const w = getMaxForLevel(arr, level);
            if (!(w > 0)) return '—';
            return energyText(w);
        }
        case 'energyProd':
            return formatEnergyProdCell(template, level);
        case 'energyStored': {
            // теоретический макс. при 100% мощности/штата (рецепт обслуживания) или сырой MaxEnergyCapacity
            let wh = 0;
            try {
                wh = getTheoreticalMaxEnergyCapacityWh(template, level);
            } catch (_) {
                const arr = template.MaxEnergyCapacity || template.maxEnergyCapacity || [];
                wh = getMaxForLevel(arr, level);
            }
            if (!(wh > 0)) return '—';
            // если есть рецепт — показываем множитель + [Вт·ч]
            if (buildingHasEnergyCapacityRecipe(template.id)) {
                const arr = template.MaxEnergyCapacity || template.maxEnergyCapacity || [];
                const mult = getMaxForLevel(arr, level);
                const multStr = Number.isFinite(mult) ? (Math.abs(mult - Math.round(mult)) < 1e-6 ? String(Math.round(mult)) : mult.toFixed(2)) : '—';
                return `${multStr} [${energyWhText(wh)}]`;
            }
            return energyWhText(wh);
        }
        case 'population': {
            const arr = template.PopulationCapacity || template.populationCapacity || [];
            return formatPop(getMaxForLevel(arr, level));
        }
        default:
            return '—';
    }
}

export function ensureLevelsPanelDom() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    const modal = document.getElementById('building-modal');
    if (!modal) return null;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'levels-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="levels-table-scroll">
            <table id="${TABLE_ID}" class="levels-table">
                <thead></thead>
                <tbody></tbody>
            </table>
        </div>
        <div id="${POPOVER_ID}" class="levels-cost-popover" hidden></div>
    `;
    // после schemes-panel если есть, иначе в конец modal-body
    const body = modal.querySelector('.modal-body') || modal;
    const schemes = document.getElementById('schemes-panel');
    if (schemes && schemes.parentElement) {
        schemes.parentElement.insertBefore(panel, schemes.nextSibling);
    } else {
        body.appendChild(panel);
    }
    return panel;
}

function hidePopover() {
    const pop = document.getElementById(POPOVER_ID);
    if (pop) {
        pop.hidden = true;
        pop.innerHTML = '';
    }
}

function showCostPopover(anchorEl, template, level, bodyData) {
    const pop = document.getElementById(POPOVER_ID);
    if (!pop) return;
    const entries = getLevelCostEntries(template, level);
    const resolved = { mode: 'cost', entries: entries.map(e => ({ ...e })) };
    const title = `${t('levels.costTitle') || 'Требуемые ресурсы'} — ${t('levels.col.level') || 'ур.'} ${level}`;
    pop.innerHTML = `
        <div class="levels-cost-popover-head">
            <span>${title}</span>
            <button type="button" class="levels-cost-popover-close" aria-label="close">✖</button>
        </div>
        <div class="levels-cost-popover-body building-resource-costs-inner">
            ${renderCostCardsHtml(bodyData, resolved)}
        </div>
    `;
    pop.hidden = false;

    const closeBtn = pop.querySelector('.levels-cost-popover-close');
    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        hidePopover();
    });

    // позиция у ячейки
    const scroll = pop.closest('.levels-panel')?.querySelector('.levels-table-scroll') || document.body;
    const ar = anchorEl.getBoundingClientRect();
    const pr = (scroll.getBoundingClientRect ? scroll.getBoundingClientRect() : { left: 0, top: 0 });
    let left = ar.left - pr.left + (scroll.scrollLeft || 0);
    let top = ar.bottom - pr.top + (scroll.scrollTop || 0) + 4;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;
}

/**
 * Отрисовать таблицу уровней для здания.
 */
export function renderLevelsTab(locationId, buildingId, bodyData) {
    const panel = ensureLevelsPanelDom();
    if (!panel) return;

    const template = (state.buildings || []).find(b => b.id === buildingId);
    const table = document.getElementById(TABLE_ID);
    if (!template || !table) {
        panel.style.display = 'none';
        return;
    }

    const locData = getLocationBuildingData(locationId, buildingId);
    const currentLevel = Math.max(0, Number(locData?.currentLevel) || 0);
    const cols = getLevelsColumns(template);
    const n = levelCount(template);

    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    thead.innerHTML = `<tr>${cols.map(c => `<th data-col="${c.id}">${c.label}</th>`).join('')}</tr>`;

    const rows = [];
    for (let lv = 0; lv < n; lv++) {
        const isCur = lv === currentLevel;
        const cells = cols.map(c => {
            if (c.id === 'costs' && hasResourceCostTable(template)) {
                const text = cellValue(template, 'costs', lv);
                const empty = text === '—';
                return `<td class="levels-cell-costs${empty ? ' is-empty' : ''}" data-level="${lv}" data-col="costs" tabindex="${empty ? -1 : 0}">${text}</td>`;
            }
            return `<td data-col="${c.id}">${cellValue(template, c.id, lv)}</td>`;
        }).join('');
        rows.push(`<tr class="levels-row${isCur ? ' is-current' : ''}" data-level="${lv}">${cells}</tr>`);
    }
    tbody.innerHTML = rows.join('');

    // hover row
    tbody.querySelectorAll('tr').forEach(tr => {
        tr.addEventListener('mouseenter', () => tr.classList.add('is-hover'));
        tr.addEventListener('mouseleave', () => tr.classList.remove('is-hover'));
    });

    // click costs cell
    tbody.querySelectorAll('td.levels-cell-costs:not(.is-empty)').forEach(td => {
        const open = (e) => {
            e.stopPropagation();
            const lv = Number(td.dataset.level);
            showCostPopover(td, template, lv, bodyData || {});
        };
        td.addEventListener('click', open);
        td.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open(e);
            }
        });
    });

    if (!_outsideCloseBound) {
        _outsideCloseBound = true;
        document.addEventListener('click', (e) => {
            const pop = document.getElementById(POPOVER_ID);
            if (!pop || pop.hidden) return;
            if (pop.contains(e.target)) return;
            if (e.target.closest?.('.levels-cell-costs')) return;
            hidePopover();
        });
    }

    hidePopover();
    panel.style.display = 'flex';
    try { ensureLevelsFirmScroll(); _levelsScroll?.update(); } catch (_) {}
}

export function showLevelsPanel(show) {
    const panel = document.getElementById(PANEL_ID) || ensureLevelsPanelDom();
    if (!panel) return;
    if (!show) {
        panel.style.display = 'none';
        hidePopover();
        return;
    }
    panel.style.display = 'flex';
    try { ensureLevelsFirmScroll(); _levelsScroll?.update(); } catch (_) {}
}

/** Заблокировать вкладку «Уровни» до главы 2 */
export function updateLevelsTabLock() {
    const btn = document.getElementById('modal-tab-levels');
    if (!btn) return;
    const locked = !isChapter2Done();
    btn.classList.toggle('locked', locked);
    btn.classList.toggle('tab-locked', locked);
    btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
    if (locked) {
        const hint = t('levels.lockedHint') || 'Доступно после главы 2';
        if (typeof window.setTip === 'function') window.setTip(btn, hint);
        else {
            btn.setAttribute('data-tip', hint);
            btn.removeAttribute('title');
        }
    } else {
        if (typeof window.clearTip === 'function') window.clearTip(btn);
        else {
            btn.removeAttribute('title');
            btn.removeAttribute('data-tip');
        }
    }
}

export function isLevelsTabLocked() {
    return !isChapter2Done();
}