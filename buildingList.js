/**
 * Генерация слотов зданий в #building-grid.
 * В HTML больше не нужно перечислять десятки .building-item —
 * достаточно списка суффиксов / диапазонов ниже.
 *
 * Формат элемента:
 *   "040"       → CONSTRC040
 *   "040-047"   → CONSTRC040 … CONSTRC047 (с сохранением ширины нулей)
 *   "0011"      → CONSTRC0011 (одиночный нестандартный id)
 *   "CONSTRC090"→ как есть (полный id тоже допускается)
 */

import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';

const ITEM_H = 125;
const GAP = 10;
/** Высота области сетки: 2 строки (обычный режим) / 3 (fullscreen). */
function gridMaxHeightPx() {
    const rows = document.fullscreenElement ? 3 : 2;
    return rows * ITEM_H + (rows - 1) * GAP;
}

let _bldListScroll = null;

export function refreshBuildingListViewport() {
    const host = document.getElementById('building-grid-scroll');
    const grid = document.getElementById('building-grid');
    if (!host && !grid) return;
    const h = gridMaxHeightPx();
    const target = host || grid;
    target.style.maxHeight = h + 'px';
    if (host && host.classList.contains('firm-scroll-host')) {
        const inner = host.querySelector(':scope > .firm-scroll-inner');
        if (inner) {
            inner.style.maxHeight = h + 'px';
            // inner — только viewport; flex остаётся на .building-grid
            inner.style.width = '100%';
        }
    }
    try { _bldListScroll?.update?.(); } catch (_) {}
}

/**
 * FirmScroll на сетке зданий + блок wheel → камера космоса.
 * Тон скролла: тёмно-серый (класс building-list-scroll).
 */
export function attachBuildingListScroll() {
    // Скролл на обёртке, а не на самой сетке — иначе flex-wrap ломается
    // (карточки уезжают в .firm-scroll-inner, а display:flex остаётся на host).
    let host = document.getElementById('building-grid-scroll');
    const grid = document.getElementById('building-grid');
    if (!grid) return null;
    if (!host) {
        host = document.createElement('div');
        host.id = 'building-grid-scroll';
        host.className = 'building-grid-scroll';
        grid.parentNode.insertBefore(host, grid);
        host.appendChild(grid);
    }
    host.classList.add('building-list-scroll');
    try {
        if (!_bldListScroll) {
            _bldListScroll = attachFirmScroll(host, {
                axis: 'y',
                mirrorV: true,
                host: 'self',
                fillHost: false
            });
        }
    } catch (e) {
        console.warn('building list firmScroll', e);
    }

    // не крутить высоту камеры, пока курсор над списком
    const body = document.querySelector('#building-list .building-list-body') || host;
    if (body && !body.dataset.wheelGuard) {
        body.dataset.wheelGuard = '1';
        body.addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, { passive: true, capture: true });
    }

    refreshBuildingListViewport();

    if (!window.__bldListFsBound) {
        window.__bldListFsBound = true;
        document.addEventListener('fullscreenchange', () => {
            refreshBuildingListViewport();
        });
    }
    return _bldListScroll;
}

export const BUILDING_SLOT_SPECS = [
    // Инфраструктура
    '001', '0011', '002', '0021', '003-007', '010', '011',
    // Добыча
    '020-025',
    // Энергетика
    '040-047',
    // Промышленность / наука / склады
    '060', '061', '062', '063', '064', '065', '066', '080', '090', '091', '092'
];

const PREFIX = 'CONSTRC';

/**
 * Раскрыть спецификации в полный список id зданий (порядок сохраняется, дубликаты убираются).
 * @param {string[]} specs
 * @returns {string[]}
 */
export function expandBuildingSlotSpecs(specs = BUILDING_SLOT_SPECS) {
    const out = [];
    const seen = new Set();

    const push = (id) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push(id);
    };

    for (const raw of specs) {
        const s = String(raw || '').trim();
        if (!s) continue;

        // полный id
        if (/^CONSTRC/i.test(s)) {
            push(s.toUpperCase().replace(/^constrc/i, 'CONSTRC'));
            continue;
        }

        // диапазон a-b
        const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
            const aStr = m[1];
            const bStr = m[2];
            const a = parseInt(aStr, 10);
            const b = parseInt(bStr, 10);
            if (Number.isNaN(a) || Number.isNaN(b)) continue;
            const from = Math.min(a, b);
            const to = Math.max(a, b);
            // ширина паддинга — по более длинному из концов (чтобы 040-047 → 040…047)
            const width = Math.max(aStr.length, bStr.length);
            for (let n = from; n <= to; n++) {
                push(PREFIX + String(n).padStart(width, '0'));
            }
            continue;
        }

        // одиночный суффикс (цифры, возможно с ведущими нулями / 0011)
        if (/^\d+$/.test(s)) {
            push(PREFIX + s);
            continue;
        }

        console.warn('[buildingList] unknown slot spec:', s);
    }
    return out;
}

/**
 * Создать пустые .building-item в #building-grid по BUILDING_SLOT_SPECS.
 * Идемпотентно: повторный вызов не дублирует элементы.
 */
export function ensureBuildingGridSlots() {
    const grid = document.getElementById('building-grid');
    if (!grid) return [];

    const ids = expandBuildingSlotSpecs(BUILDING_SLOT_SPECS);
    for (const id of ids) {
        if (grid.querySelector(`.building-item[data-building-id="${id}"]`)) continue;
        const el = document.createElement('div');
        el.className = 'building-item';
        el.dataset.buildingId = id;
        el.style.display = 'none';
        grid.appendChild(el);
    }
    grid.dataset.slotsReady = '1';
    try { attachBuildingListScroll(); } catch (_) {}
    return ids;
}

/** Все id слотов (без DOM). */
export function getBuildingSlotIds() {
    return expandBuildingSlotSpecs(BUILDING_SLOT_SPECS);
}
