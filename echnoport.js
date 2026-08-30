/**
 * UI Технопорта: панель слотов, модалка юнита, мини-панель в космосе, маркеры на карте.
 */
import { state } from './state.js';
import { t, locName } from './settings.js';
import { currentLocation } from './camera.js';
import {
    UNIT_CATEGORIES,
    SLOTS_PER_CATEGORY,
    ensureLocationUnits,
    getTechnoportCapacityM2,
    getUsedCapacityM2,
    formatAreaM2,
    getUnitDef,
    unitDisplayName,
    unitFootprintM2,
    moveUnitSlot,
    startLaunch,
    startLanding,
    findOrbitUnit,
    getAllOrbitUnits,
    isWithinLandingZone,
    isTechnoportUnlocked
} from './units.js';

let activeTechCategory = 'space';
let selectedUnitInstanceId = null;
let dragFrom = null; // { category, slotIdx }
let unitModalContext = null; // { bodyId, category, slotIdx }
let markersRoot = null;
let lastTickUi = 0;

const LOCKED_CATS = new Set(['air', 'ground']);

export function initTechnoportUI() {
    ensurePanelDom();
    ensureUnitModalDom();
    ensureSpacePanelDom();
    ensureMarkersRoot();
    bindPanelEvents();
    bindModalEvents();
    bindSpacePanelEvents();
    console.log('Technoport UI ready');
}

function ensurePanelDom() {
    if (document.getElementById('technoport-panel')) return;
    const el = document.createElement('div');
    el.id = 'technoport-panel';
    el.setAttribute('data-ui', 'true');
    el.style.display = 'none';
    el.innerHTML = `
        <div class="technoport-header"></div>
        <div class="technoport-body">
            <div class="technoport-categories">
                <button type="button" class="technoport-cat-btn active" data-tech-cat="space" data-i18n="tech.cat.space">Космические корабли</button>
                <button type="button" class="technoport-cat-btn locked" data-tech-cat="air" data-i18n="tech.cat.air">Воздушный транспорт</button>
                <button type="button" class="technoport-cat-btn locked" data-tech-cat="ground" data-i18n="tech.cat.ground">Наземная техника</button>
            </div>
            <div class="technoport-grid" id="technoport-grid"></div>
            <div class="technoport-footer">
                <div class="technoport-cap-line">
                    <span data-i18n="tech.capacity">Вместимость:</span>
                    <span id="technoport-cap-values">0 / 0</span>
                    <span id="technoport-cap-pct">[0%]</span>
                </div>
            </div>
        </div>
    `;
    // рядом со списком зданий
    const bl = document.getElementById('building-list');
    if (bl && bl.parentNode) bl.parentNode.insertBefore(el, bl.nextSibling);
    else document.body.appendChild(el);
}

function ensureUnitModalDom() {
    if (document.getElementById('unit-tech-modal')) return;
    const el = document.createElement('div');
    el.id = 'unit-tech-modal';
    el.setAttribute('data-ui', 'true');
    el.style.display = 'none';
    el.innerHTML = `
        <div class="unit-tech-modal-inner">
            <div class="unit-tech-modal-header">
                <span id="unit-tech-modal-title">${t('tech.unitModalTitle') || 'Юнит в технопорте'}</span>
                <div class="unit-tech-modal-tabs">
                    <button type="button" class="unit-tech-tab active" data-unit-tab="main" data-i18n="tech.tab.main">Основное</button>
                    <button type="button" class="unit-tech-tab" data-unit-tab="flight" data-i18n="tech.tab.flight">Полётный лист</button>
                </div>
                <button type="button" class="unit-tech-modal-close" id="unit-tech-modal-close">×</button>
            </div>
            <div class="unit-tech-modal-body" id="unit-tech-modal-body">
                <div class="unit-tech-main-row">
                    <div class="unit-tech-avatar-wrap">
                        <img id="unit-tech-avatar" src="" alt="">
                    </div>
                    <div class="unit-tech-stats" id="unit-tech-stats"></div>
                </div>
                <div class="unit-tech-quick" id="unit-tech-quick">
                    <button type="button" class="unit-tech-launch-btn" id="unit-tech-launch-btn" data-i18n="tech.launch">Взлететь на орбиту</button>
                    <div class="unit-tech-launch-progress" id="unit-tech-launch-progress" style="display:none;">
                        <div class="unit-tech-launch-bar">
                            <div class="unit-tech-launch-mover">
                                <div class="unit-tech-launch-fill"></div>
                                <span class="unit-tech-launch-arrows">›››</span>
                            </div>
                        </div>
                        <div class="unit-tech-launch-timer" id="unit-tech-launch-timer">00:00</div>
                    </div>
                </div>
                <div class="unit-tech-flight-log" id="unit-tech-flight-log" style="display:none;">
                    <p data-i18n="tech.flightLogEmpty">Полётный лист пока пуст.</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(el);
}

function ensureSpacePanelDom() {
    if (document.getElementById('unit-space-panel')) return;
    const el = document.createElement('div');
    el.id = 'unit-space-panel';
    el.setAttribute('data-ui', 'true');
    el.style.display = 'none';
    el.innerHTML = `
        <div class="unit-space-avatar-wrap">
            <img id="unit-space-avatar" src="" alt="">
        </div>
        <div class="unit-space-info">
            <div class="unit-space-name" id="unit-space-name">—</div>
            <div class="unit-space-actions">
                <button type="button" class="unit-space-land-btn" id="unit-space-land-btn" title="Посадка">
                    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                        <path fill="currentColor" d="M12 3v10.5l3.5-3.5 1.4 1.4L12 17.8 7.1 11.4l1.4-1.4L12 13.5V3h0zM5 19h14v2H5z"/>
                    </svg>
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(el);
}

function ensureMarkersRoot() {
    if (markersRoot) return markersRoot;
    markersRoot = document.createElement('div');
    markersRoot.id = 'unit-map-markers';
    document.body.appendChild(markersRoot);
    return markersRoot;
}

function bindPanelEvents() {
    const panel = document.getElementById('technoport-panel');
    if (!panel) return;
    panel.querySelectorAll('.technoport-cat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const cat = btn.dataset.techCat;
            if (LOCKED_CATS.has(cat) || btn.classList.contains('locked')) return;
            activeTechCategory = cat;
            panel.querySelectorAll('.technoport-cat-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.techCat === cat);
                b.classList.toggle('inactive', b.dataset.techCat !== cat && !b.classList.contains('locked'));
            });
            renderTechnoportGrid();
        });
    });
}

function bindModalEvents() {
    document.getElementById('unit-tech-modal-close')?.addEventListener('click', closeUnitTechModal);
    document.querySelectorAll('.unit-tech-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const name = tab.dataset.unitTab;
            document.querySelectorAll('.unit-tech-tab').forEach(t => t.classList.toggle('active', t === tab));
            const main = document.querySelector('.unit-tech-main-row');
            const quick = document.getElementById('unit-tech-quick');
            const log = document.getElementById('unit-tech-flight-log');
            if (name === 'flight') {
                if (main) main.style.display = 'none';
                if (quick) quick.style.display = 'none';
                if (log) log.style.display = 'block';
            } else {
                if (main) main.style.display = 'flex';
                if (quick) quick.style.display = 'block';
                if (log) log.style.display = 'none';
            }
        });
    });
    document.getElementById('unit-tech-launch-btn')?.addEventListener('click', () => {
        if (!unitModalContext) return;
        const { bodyId, category, slotIdx } = unitModalContext;
        const res = startLaunch(bodyId, category, slotIdx);
        if (!res.ok) {
            console.warn('launch failed', res.reason);
            return;
        }
        refreshUnitModalLaunchUi();
        renderTechnoportGrid();
        updateTechnoportFooter();
    });
}

function bindSpacePanelEvents() {
    document.getElementById('unit-space-land-btn')?.addEventListener('click', () => {
        if (!selectedUnitInstanceId) return;
        const res = startLanding(selectedUnitInstanceId);
        if (!res.ok) {
            console.warn('landing failed', res.reason);
            return;
        }
        refreshSpacePanel();
    });
}

/** Показ панели при MB4 */
export function renderTechnoportSection(location, ctx = {}) {
    const panel = document.getElementById('technoport-panel');
    const buildingList = document.getElementById('building-list');
    if (!panel) return;

    const active = ctx.activeMenuButton === 'MB4';
    if (!active || !location || !isTechnoportUnlocked(location)) {
        panel.style.display = 'none';
        return;
    }

    if (buildingList) buildingList.style.display = 'none';
    panel.style.display = 'flex';

    // локализация кнопок категорий
    panel.querySelectorAll('[data-i18n]').forEach(node => {
        const key = node.getAttribute('data-i18n');
        if (key) node.textContent = t(key);
    });

    ensureLocationUnits(location.data.id);
    renderTechnoportGrid();
    updateTechnoportFooter();
}

function renderTechnoportGrid() {
    const grid = document.getElementById('technoport-grid');
    const loc = currentLocation;
    if (!grid || !loc) return;
    const bodyId = loc.data.id;
    const data = ensureLocationUnits(bodyId);
    const slots = data.slots[activeTechCategory] || [];

    grid.innerHTML = '';
    for (let i = 0; i < SLOTS_PER_CATEGORY; i++) {
        const slot = slots[i];
        const card = document.createElement('div');
        card.className = 'technoport-slot' + (slot ? '' : ' empty');
        card.dataset.slotIdx = String(i);
        card.dataset.category = activeTechCategory;
        card.draggable = !!slot;

        if (slot) {
            const def = getUnitDef(slot.unitTypeId);
            const img = document.createElement('img');
            img.src = def?.avatar || 'assets/textures/units/placeholder.png';
            img.alt = '';
            if (!(slot.count > 0)) img.classList.add('grayscale');
            const name = document.createElement('p');
            name.textContent = unitDisplayName(def);
            const cnt = document.createElement('span');
            cnt.textContent = `${slot.count || 0}x`;
            card.appendChild(img);
            card.appendChild(name);
            card.appendChild(cnt);
            if (!(slot.count > 0)) card.classList.add('grayscale');
        } else {
            card.innerHTML = `<div class="technoport-slot-empty">+</div>`;
        }

        card.addEventListener('click', (e) => {
            if (dragFrom) return;
            if (!slot || !(slot.count > 0)) return;
            openUnitTechModal(bodyId, activeTechCategory, i);
        });

        card.addEventListener('dragstart', (e) => {
            if (!slot) { e.preventDefault(); return; }
            dragFrom = { category: activeTechCategory, slotIdx: i };
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            dragFrom = null;
        });
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            card.classList.add('drag-over');
        });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.classList.remove('drag-over');
            if (!dragFrom) return;
            moveUnitSlot(bodyId, activeTechCategory, dragFrom.slotIdx, i);
            dragFrom = null;
            renderTechnoportGrid();
            updateTechnoportFooter();
        });

        grid.appendChild(card);
    }
}

function updateTechnoportFooter() {
    const loc = currentLocation;
    if (!loc) return;
    const used = getUsedCapacityM2(loc.data.id);
    const cap = getTechnoportCapacityM2(loc.data.id);
    const pct = cap > 0 ? Math.round((used / cap) * 1000) / 10 : 0;
    const v = document.getElementById('technoport-cap-values');
    const p = document.getElementById('technoport-cap-pct');
    if (v) v.textContent = `${formatAreaM2(used)} / ${formatAreaM2(cap)}`;
    if (p) p.textContent = `[${pct}%]`;
}

function openUnitTechModal(bodyId, category, slotIdx) {
    const data = ensureLocationUnits(bodyId);
    const slot = data.slots[category]?.[slotIdx];
    if (!slot) return;
    const def = getUnitDef(slot.unitTypeId);
    unitModalContext = { bodyId, category, slotIdx };

    const modal = document.getElementById('unit-tech-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    const title = document.getElementById('unit-tech-modal-title');
    if (title) title.textContent = unitDisplayName(def);
    const avatar = document.getElementById('unit-tech-avatar');
    if (avatar) {
        avatar.src = def?.avatar || '';
        avatar.classList.toggle('grayscale', !(slot.count > 0));
    }
    const stats = document.getElementById('unit-tech-stats');
    if (stats) {
        const fp = unitFootprintM2(def);
        stats.innerHTML = `
            <p><strong>${t('tech.stat.name') || 'Название:'}</strong> ${unitDisplayName(def)}</p>
            <p><strong>${t('tech.stat.count') || 'Количество:'}</strong> ${slot.count}x</p>
            <p><strong>${t('tech.stat.size') || 'Размер:'}</strong> ${def?.length || '—'}×${def?.width || '—'} ${def?.lengthUnit || 'm'}</p>
            <p><strong>${t('tech.stat.footprint') || 'Занимаемое место:'}</strong> ${formatAreaM2(fp)}</p>
            <p><strong>${t('tech.stat.category') || 'Категория:'}</strong> ${t('tech.cat.' + (def?.category || 'space'))}</p>
        `;
    }
    refreshUnitModalLaunchUi();
}

function refreshUnitModalLaunchUi() {
    if (!unitModalContext) return;
    const { bodyId, category, slotIdx } = unitModalContext;
    const data = ensureLocationUnits(bodyId);
    const slot = data.slots[category]?.[slotIdx];
    const launching = (data.inOrbit || []).find(
        u => u.status === 'launching' && u.category === category && u.fromSlot === slotIdx
    );
    const btn = document.getElementById('unit-tech-launch-btn');
    const prog = document.getElementById('unit-tech-launch-progress');
    const timer = document.getElementById('unit-tech-launch-timer');
    if (launching) {
        if (btn) btn.style.display = 'none';
        if (prog) prog.style.display = 'block';
        if (timer) timer.textContent = formatMs(launching.remainingMs);
    } else {
        if (btn) {
            btn.style.display = 'inline-flex';
            btn.disabled = !(slot && slot.count > 0);
        }
        if (prog) prog.style.display = 'none';
    }
}

export function closeUnitTechModal() {
    const modal = document.getElementById('unit-tech-modal');
    if (modal) modal.style.display = 'none';
    unitModalContext = null;
}

function formatMs(ms) {
    const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/* ========== Космос: выбор / маркеры / мини-панель ========== */

export function selectOrbitUnit(instanceId) {
    selectedUnitInstanceId = instanceId || null;
    refreshSpacePanel();
    updateMarkerSelection();
}

export function clearOrbitSelection() {
    selectedUnitInstanceId = null;
    refreshSpacePanel();
    updateMarkerSelection();
}

export function getSelectedOrbitUnitId() {
    return selectedUnitInstanceId;
}

function refreshSpacePanel() {
    const panel = document.getElementById('unit-space-panel');
    if (!panel) return;
    if (!selectedUnitInstanceId) {
        panel.style.display = 'none';
        return;
    }
    const found = findOrbitUnit(selectedUnitInstanceId);
    if (!found || found.unit.status === 'landing') {
        // при посадке оставляем панель до исчезновения
        if (!found) {
            panel.style.display = 'none';
            selectedUnitInstanceId = null;
            return;
        }
    }
    const def = getUnitDef(found.unit.unitTypeId);
    panel.style.display = 'flex';
    const av = document.getElementById('unit-space-avatar');
    if (av) av.src = def?.avatar || '';
    const nm = document.getElementById('unit-space-name');
    if (nm) nm.textContent = unitDisplayName(def);
    const landBtn = document.getElementById('unit-space-land-btn');
    if (landBtn) {
        const ok = found.unit.status === 'orbit' && isWithinLandingZone(found.unit);
        landBtn.disabled = !ok;
        landBtn.classList.toggle('disabled', !ok);
        landBtn.title = ok
            ? (t('tech.land') || 'Посадка')
            : (t('tech.landFar') || 'Слишком далеко от небесного тела');
    }
}

function updateMarkerSelection() {
    if (!markersRoot) return;
    markersRoot.querySelectorAll('.unit-map-marker').forEach(el => {
        el.classList.toggle('selected', el.dataset.instanceId === selectedUnitInstanceId);
    });
}

/** Обновление HTML-маркеров юнитов на карте (проекция как у labels) */
export function updateUnitMapMarkers() {
    const root = ensureMarkersRoot();
    const cam = state.camera;
    if (!cam) return;

    const units = getAllOrbitUnits().filter(u => u.status === 'orbit' || u.status === 'launching' || u.status === 'landing');
    const seen = new Set();

    for (const u of units) {
        // launching ещё в технопорте визуально на карте показываем только после orbit; но можно показать и во время launching
        if (u.status === 'launching') continue;
        seen.add(u.instanceId);
        let el = root.querySelector(`[data-instance-id="${u.instanceId}"]`);
        if (!el) {
            el = document.createElement('div');
            el.className = 'unit-map-marker';
            el.dataset.instanceId = u.instanceId;
            const img = document.createElement('img');
            const def = getUnitDef(u.unitTypeId);
            img.src = def?.tacticalAvatar || def?.avatar || '';
            img.alt = '';
            el.appendChild(img);
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                selectOrbitUnit(u.instanceId);
            });
            root.appendChild(el);
        }
        el.classList.toggle('selected', u.instanceId === selectedUnitInstanceId);

        const body = state.celestialBodies[u.bodyId] || state.celestialBodies[String(u.bodyId)];
        const vector = new THREE.Vector3(u.x, 0.05, u.z);
        vector.project(cam);
        const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-vector.y * 0.5 + 0.5) * window.innerHeight;
        const behind = vector.z > 1;
        el.style.display = behind ? 'none' : 'block';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    }

    // убрать старые
    root.querySelectorAll('.unit-map-marker').forEach(el => {
        if (!seen.has(el.dataset.instanceId)) el.remove();
    });
}

/** Тик UI (прогресс взлёта в модалке, мини-панель) */
export function tickTechnoportUI() {
    const now = performance.now();
    if (now - lastTickUi < 100) {
        updateUnitMapMarkers();
        return;
    }
    lastTickUi = now;
    if (unitModalContext) refreshUnitModalLaunchUi();
    if (selectedUnitInstanceId) refreshSpacePanel();
    updateUnitMapMarkers();
    // обновить футер если панель открыта
    const panel = document.getElementById('technoport-panel');
    if (panel && panel.style.display !== 'none') updateTechnoportFooter();
}

/** Сброс выбора при двойном клике по пустому полю — вызывать из camera */
export function onMapEmptyDoubleClick() {
    clearOrbitSelection();
}
