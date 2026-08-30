/**
 * Панель «Технологии» (вкладка Наука в хэдере).
 * Дерево технологий: категории, группы, карточки, пан/скролл.
 */
import { state } from './state.js';
import { currentLocation } from './camera.js';
import { getLang, onLanguageChange, t, locName } from './settings.js';
import { calcLocationTechProduction } from './recipes.js';
import { startTime, formatTime } from './ui.js';
import { initTechExtras, tickTechExtras, setTechFuturePreview, refreshTechExtras } from './technologiesExtras.js';
import { buildTechLinksSvg, refreshTechLinkStates } from './technologiesGraph.js';

let catalog = null;
let open = false;
let activeCategory = 'fundamental';
/** scrollLeft/Top viewport по каждому разделу наук */
const categoryScroll = Object.create(null);

function saveCategoryScroll(catId) {
    const vp = document.getElementById('tech-tree-viewport');
    if (!vp || !catId) return;
    categoryScroll[catId] = { left: vp.scrollLeft, top: vp.scrollTop };
}
function restoreCategoryScroll(catId) {
    const vp = document.getElementById('tech-tree-viewport');
    if (!vp || !catId) return;
    const s = categoryScroll[catId];
    if (!s) {
        vp.scrollLeft = 0;
        vp.scrollTop = 0;
        return;
    }
    vp.scrollLeft = s.left || 0;
    vp.scrollTop = s.top || 0;
}
let pan = { active: false, x: 0, y: 0, sl: 0, st: 0 };
/** Открытая в детальном модальном окне технология */
let selectedTechId = null;
let detailOpen = false;
let panAnim = null;
/** Снимок прогресса, если apply пришёл до загрузки catalog */
let _pendingTechProgressSnap = null;

/** Прогресс изучения: state.techProgress[techId] = { level, invested, researching } */
function ensureProgressStore() {
    if (!state.techProgress || typeof state.techProgress !== 'object') {
        state.techProgress = {};
    }
    return state.techProgress;
}

export function ensureTechProgress(techId) {
    const store = ensureProgressStore();
    if (!store[techId]) {
        const tech = (catalog?.technologies || []).find(x => x.id === techId);
        store[techId] = {
            level: Math.max(0, Number(tech?.level) || 0),
            invested: 0,
            researching: false
        };
    }
    return store[techId];
}

export function getTechLevel(techId) {
    return ensureTechProgress(techId).level;
}

export function getLevelCost(tech, level) {
    const costs = tech?.levelCosts;
    if (!Array.isArray(costs) || level < 0 || level >= costs.length) return null;
    const v = Number(costs[level]);
    return Number.isFinite(v) && v > 0 ? v : null;
}

/** Родители, открывающие карточку (ключевой уровень появления) */
function getUnlockParents(tech) {
    const u = tech?.requirements?.unlockParents;
    if (Array.isArray(u) && u.length) return u;
    return (tech?.prerequisites || []).map(id => ({ techId: id, level: 1 }));
}

/** Требования к родителям для перехода currentLevel → currentLevel+1 */
function getReqsForNextLevel(tech) {
    if (!tech) return [];
    const level = getTechLevel(tech.id);
    const per = tech.requirements?.perLevel;
    if (Array.isArray(per) && per[level] != null) {
        return (per[level] || []).map(r => ({
            techId: r.techId || r.id,
            level: Math.max(0, Number(r.level) || 0)
        })).filter(r => r.techId);
    }
    return (tech.prerequisites || []).map(id => ({ techId: id, level: 1 }));
}

/** Карточка видна (не «неизвестная») */
export function isTechRevealed(techOrId) {
    const tech = typeof techOrId === 'string' ? techById(techOrId) : techOrId;
    if (!tech) return false;
    if (tech.discovered === false) return false;
    const parents = getUnlockParents(tech);
    if (!parents.length) return true;
    return parents.every(r => getTechLevel(r.techId) >= Math.max(1, Number(r.level) || 1));
}

/** Можно ли запускать изучение следующего уровня */
function prereqsMet(tech) {
    if (!tech) return false;
    if (!isTechRevealed(tech)) return false;
    const maxL = Math.max(0, Number(tech.maxLevel) || 0);
    if (getTechLevel(tech.id) >= maxL) return false;
    const reqs = getReqsForNextLevel(tech);
    if (!reqs.length) return true;
    return reqs.every(r => getTechLevel(r.techId) >= (Number(r.level) || 0));
}

function calcGlobalTechRatePerMin() {
    let total = 0;
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        try {
            total += Number(calcLocationTechProduction(id)) || 0;
        } catch (_) {}
    }
    if (total <= 0 && currentLocation?.data?.id != null) {
        try {
            total = Number(calcLocationTechProduction(currentLocation.data.id)) || 0;
        } catch (_) {}
    }
    return Math.max(0, total);
}

function countResearching() {
    const store = ensureProgressStore();
    let n = 0;
    for (const id of Object.keys(store)) {
        if (store[id]?.researching) n++;
    }
    return n;
}

function formatRemainDuration(secTotal) {
    const s = Math.max(0, Math.floor(secTotal));
    const days = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    if (days > 0) return `${days}д ${hh}:${mm}:${ss}`;
    return `${hh}:${mm}:${ss}`;
}

function formatGameStamp(date) {
    try {
        if (typeof formatTime === 'function') return formatTime(date);
    } catch (_) {}
    if (!(date instanceof Date)) return '—';
    const dd = String(date.getDate()).padStart(2, '0');
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss} ${dd}.${mo}.${yyyy}`;
}

/** Тик исследования (игровые секунды с учётом timeSpeed) */
export function tickTechResearch(dtGameSec) {
    const dt = Number(dtGameSec) || 0;
    if (dt <= 0) return false;
    // пока каталог не загружен — не трогаем флаги researching (иначе сейв сбрасывается)
    const techs = catalog?.technologies;
    if (!Array.isArray(techs) || !techs.length) return false;

    const store = ensureProgressStore();
    const activeIds = Object.keys(store).filter(id => store[id]?.researching);
    if (!activeIds.length) return false;

    const ratePerMin = calcGlobalTechRatePerMin();
    if (ratePerMin <= 0) return false;

    const share = ratePerMin / activeIds.length;
    const gain = share * (dt / 60);
    if (gain <= 0) return false;

    let leveled = false;
    for (const id of activeIds) {
        const tech = techs.find(x => x.id === id);
        // нет в каталоге — пропускаем, НЕ снимаем researching
        if (!tech) continue;
        const p = store[id];
        // требования не выполнены — пауза и сброс фальстарта (вложенные очки → 0)
        if (!prereqsMet(tech)) {
            if ((Number(p.invested) || 0) > 0) p.invested = 0;
            continue;
        }
        const maxL = Math.max(0, Number(tech.maxLevel) || 0);
        if (p.level >= maxL) {
            p.researching = false;
            p.level = maxL;
            p.invested = 0;
            continue;
        }
        p.invested = (Number(p.invested) || 0) + gain;
        let guard = 0;
        while (guard++ < 20 && p.level < maxL) {
            const cost = getLevelCost(tech, p.level);
            if (cost == null) {
                p.researching = false;
                break;
            }
            if (p.invested + 1e-9 < cost) break;
            p.invested -= cost;
            p.level += 1;
            leveled = true;
            // остаток после уровня: если следующий шаг недоступен — обнулить
            if (!prereqsMet(tech)) {
                p.invested = 0;
                break;
            }
            if (p.level >= maxL) {
                p.level = maxL;
                p.invested = 0;
                p.researching = false;
                break;
            }
        }
        tech.level = p.level;
    }
    return leveled;
}

export function toggleTechResearch(techId) {
    const tech = (catalog?.technologies || []).find(x => x.id === techId);
    if (!tech) return false;
    const p = ensureTechProgress(techId);
    const maxL = Math.max(0, Number(tech.maxLevel) || 0);
    if (p.level >= maxL) {
        p.researching = false;
        return false;
    }
    if (!prereqsMet(tech)) {
        p.researching = false;
        return false;
    }
    p.researching = !p.researching;
    return p.researching;
}


export function listResearchingTechIds() {
    const store = ensureProgressStore();
    return Object.keys(store).filter(id => store[id]?.researching);
}

export function captureTechProgressSnapshot() {
    return JSON.parse(JSON.stringify(ensureProgressStore()));
}

export function applyTechProgressSnapshot(snap) {
    if (snap && typeof snap === 'object') {
        _pendingTechProgressSnap = JSON.parse(JSON.stringify(snap));
    } else {
        _pendingTechProgressSnap = null;
    }
    const store = ensureProgressStore();
    for (const k of Object.keys(store)) delete store[k];
    if (snap && typeof snap === 'object') {
        for (const id of Object.keys(snap)) {
            if (!id || id === '__proto__' || id === 'constructor') continue;
            const s = snap[id] || {};
            const researchingRaw = s.researching;
            // true / 1 / "true" / "1"
            const researching = researchingRaw === true
                || researchingRaw === 1
                || researchingRaw === 'true'
                || researchingRaw === '1';
            store[id] = {
                level: Math.max(0, Number(s.level) || 0),
                invested: Math.max(0, Number(s.invested) || 0),
                researching
            };
            const tech = (catalog?.technologies || []).find(x => x.id === id);
            if (tech) tech.level = store[id].level;
        }
    }
    // только дополняем отсутствующие записи; НЕ затираем researching у существующих
    for (const tech of (catalog?.technologies || [])) {
        if (!store[tech.id]) {
            store[tech.id] = {
                level: Math.max(0, Number(tech.level) || 0),
                invested: 0,
                researching: false
            };
        } else {
            tech.level = store[tech.id].level;
        }
    }
}

/** Режим шапки: map | science | hero */
let headerMode = 'map';

export function isTechPanelOpen() {
    return open;
}

export function getHeaderMode() {
    return headerMode;
}

/**
 * Единая точка переключения «Карта / Наука / Герой».
 * Одновременно активен только один раздел.
 */
export function setHeaderMode(mode) {
    headerMode = (mode === 'science' || mode === 'hero' || mode === 'codex') ? mode : 'map';

    const mapBtn = document.getElementById('header-btn-map');
    const sciBtn = document.getElementById('header-btn-science');
    const codexBtn = document.getElementById('header-btn-codex');
    if (mapBtn) {
        mapBtn.classList.toggle('active', headerMode === 'map');
        mapBtn.classList.toggle('inactive', headerMode !== 'map');
    }
    if (sciBtn) {
        sciBtn.classList.toggle('active', headerMode === 'science');
        sciBtn.classList.toggle('inactive', headerMode !== 'science');
    }
    if (codexBtn) {
        codexBtn.classList.toggle('active', headerMode === 'codex');
        codexBtn.classList.toggle('inactive', headerMode !== 'codex');
    }

    // аватарка героя — визуальный active через data-атрибут рамки
    const frame = document.querySelector('#header-left .header-icon-frame');
    if (frame) {
        frame.classList.toggle('header-mode-active', headerMode === 'hero');
    }
}

export function getTechCatalog() { return catalog; }

export async function loadTechnologiesData() {
    try {
        const res = await fetch('technologies.json');
        catalog = await res.json();
        console.log('[tech] loaded', catalog?.technologies?.length || 0, 'technologies');
    } catch (e) {
        console.warn('technologies.json load failed', e);
        catalog = { categories: [], groups: [], technologies: [], meta: {} };
    }
    // seed progress from catalog defaults (не затирая уже загруженный сейв / researching)
    for (const tech of (catalog.technologies || [])) {
        const p = ensureTechProgress(tech.id);
        tech.level = p.level;
    }
    // сейв мог примениться до catalog — вернуть researching из pending
    if (_pendingTechProgressSnap) {
        const pending = _pendingTechProgressSnap;
        _pendingTechProgressSnap = null;
        const store = ensureProgressStore();
        for (const id of Object.keys(pending)) {
            const s = pending[id] || {};
            const flag = s.researching === true || s.researching === 1 || s.researching === 'true' || s.researching === '1';
            if (!store[id]) {
                store[id] = {
                    level: Math.max(0, Number(s.level) || 0),
                    invested: Math.max(0, Number(s.invested) || 0),
                    researching: flag
                };
            } else {
                if (flag) store[id].researching = true;
                if (s.level != null) store[id].level = Math.max(Number(store[id].level) || 0, Number(s.level) || 0);
                if (s.invested != null) store[id].invested = Math.max(Number(store[id].invested) || 0, Number(s.invested) || 0);
            }
            const tech = (catalog.technologies || []).find(x => x.id === id);
            if (tech) tech.level = store[id].level;
        }
    }
    return catalog;
}

export function closeTechPanel() {
    closeTechDetail(true);
    open = false;
    const panel = document.getElementById('tech-panel');
    if (panel) {
        panel.classList.remove('open');
        panel.style.display = '';
        panel.style.pointerEvents = '';
    }
    if (headerMode === 'science') setHeaderMode('map');
}

export function techById(id) {
    return (catalog?.technologies || []).find(x => x.id === id) || null;
}

function stageDefs() {
    return catalog?.stageDefs || [];
}

/** Определить этап развития по текущему уровню и stageRanges технологии */
function resolveStage(tech) {
    const level = Math.max(0, Number(tech?.level) || 0);
    const ranges = tech?.stageRanges || {};
    const defs = stageDefs();
    const order = ['divine', 'super', 'advanced', 'primitive', 'basic', 'none'];
    for (const id of order) {
        const r = ranges[id];
        if (!Array.isArray(r) || r.length < 2) continue;
        if (level >= r[0] && level <= r[1]) {
            const def = defs.find(d => d.id === id) || { id, color: '#6a6a6a', name: { ru: id } };
            return { id, color: def.color || '#6a6a6a', name: def.name, range: r };
        }
    }
    // fallback: 0 → none, иначе basic
    if (level <= 0) {
        const def = defs.find(d => d.id === 'none') || { id: 'none', color: '#6a6a6a', name: { ru: 'Не изучена' } };
        return { id: 'none', color: def.color, name: def.name, range: [0, 0] };
    }
    const def = defs.find(d => d.id === 'basic') || { id: 'basic', color: '#8b6914', name: { ru: 'Базовая' } };
    return { id: 'basic', color: def.color, name: def.name, range: [1, 1] };
}

/**
 * Что открывает tech: явный unlocks + дети, у которых tech в unlockParents.
 * Возвращает [{ techId, level }] — level = ключевой уровень появления у родителя.
 */
function getUnlockEntries(tech) {
    if (!tech) return [];
    const map = new Map();
    for (const id of (tech.unlocks || [])) {
        map.set(id, { techId: id, level: 1 });
    }
    for (const child of (catalog?.technologies || [])) {
        for (const u of getUnlockParents(child)) {
            if (u.techId === tech.id) {
                const lv = Math.max(1, Number(u.level) || 1);
                const prev = map.get(child.id);
                map.set(child.id, { techId: child.id, level: prev ? Math.min(prev.level, lv) : lv });
            }
        }
        // также если в perLevel встречается этот родитель
        if ((child.prerequisites || []).includes(tech.id) && !map.has(child.id)) {
            map.set(child.id, { techId: child.id, level: 1 });
        }
    }
    return [...map.values()];
}

function getUnlocks(tech) {
    return getUnlockEntries(tech).map(e => e.techId);
}

/**
 * @param {string} techId
 * @param {{ level?: number, kind?: 'requires'|'unlocks' }} opts
 */
function miniCardHtml(techId, opts = {}) {
    const tech = techById(techId);
    const reqLevel = opts.level != null ? Number(opts.level) : null;
    const levelLine = reqLevel != null
        ? `<div class="tech-mini-card-level">${t('techTree.atLevel') || 'на уровне'}: ${reqLevel}</div>`
        : '';
    if (!tech) {
        return `<button type="button" class="tech-mini-card unknown locked" data-tech-id="${techId}" data-need-level="${reqLevel ?? ''}" data-kind="${opts.kind || ''}" disabled>
            <div class="tech-mini-card-img">?</div>
            <div class="tech-mini-card-text">
                <div class="tech-mini-card-name">${techId}</div>
                ${levelLine}
            </div>
        </button>`;
    }
    const revealed = isTechRevealed(tech);
    const name = revealed
        ? pick(tech.name, tech.id)
        : (t('techTree.unknown') || 'Неизвестная технология');
    const img = revealed && tech.image
        ? `style="background-image:url('${tech.image}')"`
        : '';
    const cls = [
        revealed ? '' : ' unknown locked',
        opts.kind === 'unlocks' && !revealed ? ' locked' : ''
    ].join('');
    const disabled = revealed ? '' : ' disabled';
    const needAttr = reqLevel != null ? ` data-need-level="${reqLevel}"` : '';
    const kindAttr = opts.kind ? ` data-kind="${opts.kind}"` : '';
    let unmet = '';
    if (opts.kind === 'requires' && reqLevel != null && revealed) {
        if (getTechLevel(tech.id) < reqLevel) unmet = ' req-unmet';
    }
    return `<button type="button" class="tech-mini-card${cls}${unmet}" data-tech-id="${tech.id}"${needAttr}${kindAttr}${disabled}>
        <div class="tech-mini-card-img" ${img}>${revealed ? '' : '?'}</div>
        <div class="tech-mini-card-text">
            <div class="tech-mini-card-name">${name}</div>
            ${levelLine}
        </div>
    </button>`;
}

/** Переход к технологии: смена раздела наук → пан → модалка */
export function navigateToTech(techId) {
    const tech = techById(techId);
    if (!tech || !open) return false;
    const needSwitch = tech.categoryId && tech.categoryId !== activeCategory;
    if (needSwitch) {
        activeCategory = tech.categoryId;
        const keepId = techId;
        selectedTechId = null;
        detailOpen = false;
        setTreeDimmed(false);
        const modal = document.getElementById('tech-detail-modal');
        if (modal) {
            modal.classList.remove('open');
            modal.setAttribute('aria-hidden', 'true');
        }
        renderRateBadge();
        renderNav();
        renderTree();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => openTechDetail(keepId));
        });
        return true;
    }
    return openTechDetail(techId);
}

function setSelectedCardHighlight(techId) {
    document.querySelectorAll('.tech-card-wrap.selected').forEach(el => el.classList.remove('selected'));
    if (!techId) return;
    const el = document.querySelector(`.tech-card-wrap[data-tech-id="${techId}"]`);
    if (el) el.classList.add('selected');
}

/** Плавный пан viewport так, чтобы карточка оказалась в левом-верхнем углу области */
function panViewportToCard(techId) {
    const vp = document.getElementById('tech-tree-viewport');
    const card = document.querySelector(`.tech-card-wrap[data-tech-id="${techId}"]`);
    if (!vp || !card) return;

    const pad = 28;
    const targetLeft = Math.max(0, card.offsetLeft - pad);
    const targetTop = Math.max(0, card.offsetTop - pad);

    if (panAnim) {
        cancelAnimationFrame(panAnim);
        panAnim = null;
    }
    const startL = vp.scrollLeft;
    const startT = vp.scrollTop;
    const dL = targetLeft - startL;
    const dT = targetTop - startT;
    if (Math.abs(dL) < 1 && Math.abs(dT) < 1) {
        vp.scrollLeft = targetLeft;
        vp.scrollTop = targetTop;
        saveCategoryScroll(activeCategory);
        return;
    }
    const duration = 620;
    const t0 = performance.now();
    // smoothstep-подобный easing — мягкий разгон и торможение
    const ease = (x) => {
        const t = Math.max(0, Math.min(1, x));
        return t * t * (3 - 2 * t);
    };
    const step = (now) => {
        const u = Math.min(1, (now - t0) / duration);
        const e = ease(u);
        vp.scrollLeft = startL + dL * e;
        vp.scrollTop = startT + dT * e;
        if (u < 1) panAnim = requestAnimationFrame(step);
        else {
            panAnim = null;
            saveCategoryScroll(activeCategory);
        }
    };
    panAnim = requestAnimationFrame(step);
}

function setTreeDimmed(on) {
    const win = document.querySelector('#tech-panel .tech-panel-window');
    if (win) win.classList.toggle('detail-open', !!on);
}

export function closeTechDetail(silent) {
    detailOpen = false;
    selectedTechId = null;
    const modal = document.getElementById('tech-detail-modal');
    if (modal) {
        delete modal.dataset.selectedTechId;
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
    }
    setTreeDimmed(false);
    setSelectedCardHighlight(null);
}

export function openTechDetail(techId) {
    const tech = techById(techId);
    if (!tech || !open) return false;
    if (!isTechRevealed(tech)) return false;

    selectedTechId = techId;
    detailOpen = true;
    setSelectedCardHighlight(techId);
    setTreeDimmed(true);
    panViewportToCard(techId);
    const relRoot = document.querySelector('.tech-detail-rel');
    if (relRoot) delete relRoot.dataset.sig;
    renderTechDetail(tech);

    const modal = document.getElementById('tech-detail-modal');
    if (modal) {
        modal.dataset.selectedTechId = techId;
        const help = document.getElementById('tech-detail-codex-btn');
        if (help) help.dataset.techId = techId;
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'false');
        // двойной rAF — плавный fade/scale вместе с паном камеры
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                modal.classList.add('open');
            });
        });
    }
    try { refreshTechExtras(); } catch (_) {}
    return true;
}

function renderTechDetail(tech) {
    if (!tech) return;
    const level = getTechLevel(tech.id);
    tech.level = level;
    const stage = resolveStage(tech);
    const maxLevel = Math.max(level, Number(tech.maxLevel) || level || 1);
    const name = pick(tech.name, tech.id);
    const desc = pick(tech.description, '');

    const avatar = document.getElementById('tech-detail-avatar');
    if (avatar) {
        if (tech.image && tech.discovered !== false) {
            avatar.style.backgroundImage = `url('${tech.image}')`;
            avatar.classList.remove('empty');
        } else {
            avatar.style.backgroundImage = '';
            avatar.classList.add('empty');
        }
    }

    const titleEl = document.getElementById('tech-detail-title');
    if (titleEl) titleEl.textContent = name;

    const stageBox = document.getElementById('tech-detail-stage');
    if (stageBox) {
        stageBox.style.setProperty('--stage-color', stage.color || '#8b6914');
        stageBox.dataset.stage = stage.id || 'none';
    }
    const stageLevel = document.getElementById('tech-detail-stage-level');
    if (stageLevel) {
        const prefix = t('techTree.levelOf') || 'Ур.';
        stageLevel.textContent = `${prefix} ${level} / ${maxLevel}`;
    }
    const stageName = document.getElementById('tech-detail-stage-name');
    if (stageName) {
        stageName.textContent = pick(stage.name, t(`techTree.stage.${stage.id}`) || stage.id);
    }

    const upgradeArt = document.getElementById('tech-detail-upgrade-art');
    if (upgradeArt) {
        const src = catalog?.meta?.upgradeImage || 'assets/textures/technologies/scientist_microscope.png';
        upgradeArt.style.backgroundImage = `url('${src}')`;
    }

    const descEl = document.getElementById('tech-detail-desc');
    if (descEl) descEl.textContent = desc;

    renderUpgradePanel(tech);
    renderTechRelations(tech);
}

/** Требует / Открывает — можно вызывать каждый тик при открытой модалке */
function renderTechRelations(tech) {
    if (!tech) return;
    let reqEntries = getReqsForNextLevel(tech);
    if (!reqEntries.length) {
        reqEntries = getUnlockParents(tech).map(u => ({
            techId: u.techId,
            level: Math.max(1, Number(u.level) || 1)
        }));
    }
    {
        const m = new Map();
        for (const e of reqEntries) {
            const prev = m.get(e.techId);
            if (!prev || e.level > prev.level) m.set(e.techId, e);
        }
        reqEntries = [...m.values()];
    }
    const unlockEntries = getUnlockEntries(tech);

    // сигнатура — не пересобирать DOM без нужды (сохраняем hover-классы родителя upgrade)
    const sig = JSON.stringify({
        r: reqEntries.map(e => [e.techId, e.level, getTechLevel(e.techId), isTechRevealed(e.techId)]),
        u: unlockEntries.map(e => [e.techId, e.level, isTechRevealed(e.techId)])
    });
    const relRoot = document.querySelector('.tech-detail-rel');
    if (relRoot && relRoot.dataset.sig === sig) return;
    if (relRoot) relRoot.dataset.sig = sig;

    const reqBlock = document.querySelector('.tech-detail-rel-block[data-rel="requires"]')
        || document.getElementById('tech-detail-requires')?.closest('.tech-detail-rel-block');
    const unlBlock = document.querySelector('.tech-detail-rel-block[data-rel="unlocks"]')
        || document.getElementById('tech-detail-unlocks')?.closest('.tech-detail-rel-block');

    const reqTitle = document.getElementById('tech-detail-requires-title');
    if (reqTitle) reqTitle.textContent = t('techTree.requires') || 'Требует';
    const unlTitle = document.getElementById('tech-detail-unlocks-title');
    if (unlTitle) unlTitle.textContent = t('techTree.unlocks') || 'Открывает';

    const reqBox = document.getElementById('tech-detail-requires');
    if (reqBox) {
        if (reqEntries.length) {
            reqBox.innerHTML = reqEntries.map(e => miniCardHtml(e.techId, { level: e.level, kind: 'requires' })).join('');
            if (reqBlock) reqBlock.style.display = '';
        } else {
            reqBox.innerHTML = '';
            if (reqBlock) reqBlock.style.display = 'none';
        }
    }
    const unlBox = document.getElementById('tech-detail-unlocks');
    if (unlBox) {
        if (unlockEntries.length) {
            unlBox.innerHTML = unlockEntries.map(e => miniCardHtml(e.techId, { level: e.level, kind: 'unlocks' })).join('');
            if (unlBlock) unlBlock.style.display = '';
        } else {
            unlBox.innerHTML = '';
            if (unlBlock) unlBlock.style.display = 'none';
        }
    }

    const bottom = document.querySelector('.tech-detail-bottom');
    if (bottom) {
        bottom.style.display = (reqEntries.length || unlockEntries.length) ? '' : 'none';
    }

    if (relRoot && relRoot.dataset.relClickBound !== '1') {
        relRoot.dataset.relClickBound = '1';
        relRoot.addEventListener('click', (e) => {
            const btn = e.target.closest('.tech-mini-card[data-tech-id]');
            if (!btn || btn.disabled || btn.classList.contains('locked')) return;
            e.preventDefault();
            e.stopPropagation();
            const id = btn.dataset.techId;
            if (id && id !== selectedTechId && isTechRevealed(id)) navigateToTech(id);
        });
    }
}

export function openTechPanel() {
    open = true;
    setHeaderMode('science');
    // закрыть героя / кодекс, если открыты
    try {
        import('./hero.js').then(m => {
            if (m.isHeroPanelOpen?.()) m.closeHeroPanel?.(true);
        }).catch(() => {});
    } catch (_) {}
    try {
        import('./codex.js').then(m => {
            if (m.isCodexPanelOpen?.()) m.closeCodexPanel?.(true);
        }).catch(() => {});
    } catch (_) {}

    const panel = document.getElementById('tech-panel');
    if (panel) {
        panel.classList.add('open');
        panel.style.display = 'block';
        panel.style.pointerEvents = 'auto';
    }
    renderTechPanel();
    try { refreshTechExtras(); } catch (_) {}
    return true;
}

export function toggleTechPanel() {
    if (open) {
        closeTechPanel();
        return false;
    }
    return openTechPanel();
}

function pick(obj, fallback = '') {
    if (!obj) return fallback;
    if (typeof obj === 'string') return obj;
    const L = getLang?.() || 'ru';
    return obj[L] || obj.ru || obj.en || obj.de || fallback;
}

function meta() {
    return catalog?.meta || {};
}

function categories() {
    return [...(catalog?.categories || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function groupsInCategory(catId) {
    return [...(catalog?.groups || [])]
        .filter(g => g.categoryId === catId)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function techsInCategory(catId) {
    return (catalog?.technologies || []).filter(t => t.categoryId === catId);
}

function cardSize() {
    const m = meta();
    return {
        w: Number(m.cardWidth) || 132,
        h: Number(m.cardHeight) || 148,
        gx: Number(m.gapX) || 56,
        gy: Number(m.gapY) || 36,
        px: Number(m.padX) || 64,
        py: Number(m.padY) || 64,
        labelH: 28,
        labelGap: 14,
        groupGap: 56
    };
}

/**
 * Вертикальная раскладка: группы стопкой сверху вниз.
 * column/row у технологии — локальные внутри своей группы.
 * Возвращает абсолютные координаты карточек и подписей групп.
 */
function layoutCategory(catId) {
    const { w, h, gx, gy, px, py, labelH, labelGap, groupGap } = cardSize();
    const groups = groupsInCategory(catId);
    const techs = techsInCategory(catId);
    const byGroup = new Map();
    for (const g of groups) byGroup.set(g.id, []);
    const orphan = [];
    for (const tech of techs) {
        const gid = tech.groupId;
        if (gid && byGroup.has(gid)) byGroup.get(gid).push(tech);
        else orphan.push(tech);
    }

    const techPos = new Map(); // id -> {x,y}
    const groupPos = []; // { id, name, x, y }
    let y = py;
    let maxCol = 0;
    let maxX = 0;

    const placeGroupBlock = (groupMeta, list) => {
        const labelX = px;
        const labelY = y;
        if (groupMeta) {
            groupPos.push({
                id: groupMeta.id,
                name: groupMeta.name,
                x: labelX,
                y: labelY
            });
            y += labelH + labelGap;
        }
        let blockBottom = y;
        let blockMaxCol = 0;
        for (const tech of list) {
            const col = Math.max(0, Number(tech.column) || 0);
            const row = Math.max(0, Number(tech.row) || 0);
            const x = px + col * (w + gx);
            const ty = y + row * (h + gy);
            techPos.set(tech.id, { x, y: ty });
            blockBottom = Math.max(blockBottom, ty + h);
            blockMaxCol = Math.max(blockMaxCol, col);
            maxX = Math.max(maxX, x + w);
        }
        maxCol = Math.max(maxCol, blockMaxCol);
        y = blockBottom + groupGap;
    };

    if (groups.length) {
        for (const g of groups) placeGroupBlock(g, byGroup.get(g.id) || []);
        if (orphan.length) placeGroupBlock(null, orphan);
    } else {
        placeGroupBlock(null, techs);
    }

    // Запас = размер viewport, чтобы любую карточку (даже у правого/нижнего края)
    // можно было прокрутить в левый-верхний угол области просмотра.
    const vp = document.getElementById('tech-tree-viewport');
    const viewW = Math.max(640, vp?.clientWidth || 900);
    const viewH = Math.max(400, vp?.clientHeight || 600);
    const worldW = Math.max(
        1800,
        maxX + viewW + px + 48,
        px * 2 + (maxCol + 2) * (w + gx) + viewW
    );
    const worldH = Math.max(1200, y + viewH + py + 48);
    return { techPos, groupPos, worldW, worldH, techs };
}

function renderNav() {
    const nav = document.getElementById('tech-nav');
    if (!nav) return;
    const cats = categories();
    if (!cats.find(c => c.id === activeCategory) && cats[0]) {
        activeCategory = cats[0].id;
    }
    nav.innerHTML = cats.map(c => {
        const active = c.id === activeCategory ? ' active' : '';
        const name = pick(c.name, c.id);
        const icon = c.icon || '';
        return `<button type="button" class="tech-nav-item${active}" data-cat="${c.id}">
            <img class="tech-nav-icon" src="${icon}" alt="" onerror="this.style.opacity=0.25">
            <span class="tech-nav-label">${name}</span>
        </button>`;
    }).join('');

    nav.querySelectorAll('.tech-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.cat;
            if (!next || next === activeCategory) return;
            saveCategoryScroll(activeCategory);
            activeCategory = next;
            renderTechPanel();
            // после перестройки дерева — позиция этого раздела
            requestAnimationFrame(() => restoreCategoryScroll(activeCategory));
        });
    });
}

function renderRateBadge() {
    const el = document.getElementById('tech-panel-rate-value');
    if (!el) return;
    let rate = 0;
    try {
        const lid = currentLocation?.data?.id;
        if (lid != null) rate = calcLocationTechProduction(lid) || 0;
    } catch (_) {}
    const v = Number(rate) || 0;
    const text = v >= 10 ? v.toFixed(1) : (v >= 0.1 ? v.toFixed(2) : v.toFixed(3));
    el.textContent = `+${text} ${t('unit.techPerMin') || 'тех./мин'}`;
}



function cardHtml(tech, pos) {
    const { w, h } = cardSize();
    const revealed = isTechRevealed(tech);
    const name = revealed
        ? pick(tech.name, tech.id)
        : (t('techTree.unknown') || 'Неизвестная технология');
    const level = getTechLevel(tech.id);
    tech.level = level;
    const p = ensureTechProgress(tech.id);
    const maxLevel = Math.max(level, Number(tech.maxLevel) || level || 1);
    const cost = getLevelCost(tech, level);
    const atMax = level >= maxLevel || cost == null;
    const reqsOk = revealed ? prereqsMet(tech) : false;
    // треугольник только при реально идущем исследовании
    if (p.researching && (atMax || !reqsOk)) p.researching = false;
    const researching = !!(revealed && p.researching && !atMax && reqsOk);
    const lvlLabel = revealed
        ? `${t('techTree.levelShort') || 'Ур.'} ${level}`
        : `${t('techTree.levelShort') || 'Ур.'} ?`;
    const img = revealed && tech.image
        ? `style="background-image:url('${tech.image}')"`
        : '';
    const unk = revealed ? '' : ' unknown locked';
    const sel = selectedTechId === tech.id && revealed ? ' selected' : '';
    const resCls = researching ? ' is-researching' : '';
    const tri = researching
        ? '<span class="tech-card-research-tri" aria-hidden="true">▲</span>'
        : '';
    // мишень по 4 углам — на обёртке, чтобы clip-path карточки не резал
    const aims = '<span class="tech-card-aim tl" aria-hidden="true"></span>'
        + '<span class="tech-card-aim tr" aria-hidden="true"></span>'
        + '<span class="tech-card-aim bl" aria-hidden="true"></span>'
        + '<span class="tech-card-aim br" aria-hidden="true"></span>';
    return `<div class="tech-card-wrap${sel}${revealed ? '' : ' is-locked'}${resCls}" data-tech-id="${tech.id}" data-locked="${revealed ? '0' : '1'}" data-researching="${researching ? '1' : '0'}"
        style="left:${pos.x}px;top:${pos.y}px;width:${w}px;height:${h}px">
        ${aims}
        <div class="tech-card${unk}">
            <div class="tech-card-img" ${img}>
                ${revealed ? '' : '<span class="tech-card-unknown-mark">?</span>'}
                <span class="tech-card-level">${lvlLabel}</span>
                ${tri}
            </div>
            <div class="tech-card-name">${name}</div>
        </div>
    </div>`;
}

/** Лёгкая синхронизация ▲ / is-researching без полной перестройки дерева */
function syncTreeResearchIndicators() {
    const world = document.getElementById('tech-tree-world');
    if (!world) return;
    world.querySelectorAll('.tech-card-wrap[data-tech-id]').forEach(wrap => {
        const id = wrap.dataset.techId;
        const tech = techById(id);
        if (!tech || !isTechRevealed(tech)) {
            wrap.classList.remove('is-researching');
            wrap.dataset.researching = '0';
            wrap.querySelector('.tech-card-research-tri')?.remove();
            return;
        }
        const p = ensureTechProgress(id);
        const level = p.level;
        tech.level = level;
        const maxLevel = Math.max(level, Number(tech.maxLevel) || level || 1);
        const cost = getLevelCost(tech, level);
        const atMax = level >= maxLevel || cost == null;
        const reqsOk = prereqsMet(tech);
        if (p.researching && (atMax || !reqsOk)) p.researching = false;
        const on = !!(p.researching && !atMax && reqsOk);
        const was = wrap.dataset.researching === '1';
        if (on === was) {
            // всё равно убедимся, что DOM-элемент соответствует
            const hasTri = !!wrap.querySelector('.tech-card-research-tri');
            if (on && !hasTri) {
                const imgEl = wrap.querySelector('.tech-card-img');
                if (imgEl) {
                    const tri = document.createElement('span');
                    tri.className = 'tech-card-research-tri';
                    tri.setAttribute('aria-hidden', 'true');
                    tri.textContent = '▲';
                    imgEl.appendChild(tri);
                }
            } else if (!on && hasTri) {
                wrap.querySelector('.tech-card-research-tri')?.remove();
            }
            return;
        }
        wrap.dataset.researching = on ? '1' : '0';
        wrap.classList.toggle('is-researching', on);
        const imgEl = wrap.querySelector('.tech-card-img');
        let tri = wrap.querySelector('.tech-card-research-tri');
        if (on) {
            if (!tri && imgEl) {
                tri = document.createElement('span');
                tri.className = 'tech-card-research-tri';
                tri.setAttribute('aria-hidden', 'true');
                tri.textContent = '▲';
                imgEl.appendChild(tri);
            }
        } else {
            tri?.remove();
        }
    });
}

function renderTree() {
    const world = document.getElementById('tech-tree-world');
    if (!world) return;

    const layout = layoutCategory(activeCategory);
    const { techPos, groupPos, worldW, worldH, techs } = layout;
    world.style.width = worldW + 'px';
    world.style.height = worldH + 'px';

    const groupHtml = groupPos.map(g => {
        const label = pick(g.name, g.id);
        return `<div class="tech-group-label" style="left:${g.x}px;top:${g.y}px">
            <span class="tech-group-label-text">${label}</span>
            <span class="tech-group-label-line" aria-hidden="true"></span>
        </div>`;
    }).join('');

    const cardsHtml = techs.map(tech => {
        const pos = techPos.get(tech.id) || { x: 0, y: 0 };
        return cardHtml(tech, pos);
    }).join('');

    const { w: cw, h: ch } = cardSize();
    const links = buildTechLinksSvg(techs, techPos, worldW, worldH, { w: cw, h: ch });
    const empty = (!techs.length && !groupPos.length)
        ? `<div class="tech-tree-empty">${t('techTree.empty') || 'Нет технологий в этом разделе'}</div>`
        : '';

    world.innerHTML = links + groupHtml + cardsHtml + empty;

    // клик по карточке → детальное окно
    world.querySelectorAll('.tech-card-wrap').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = el.dataset.techId;
            if (!id || el.dataset.locked === '1') return;
            openTechDetail(id);
        });
    });

    if (selectedTechId) setSelectedCardHighlight(selectedTechId);
}

export function renderTechPanel() {
    if (!open) return;
    const title = document.getElementById('tech-panel-title');
    if (title) title.textContent = t('techTree.title') || 'Технологии';
    renderRateBadge();
    renderNav();
    renderTree();
    if (detailOpen && selectedTechId) {
        const tech = techById(selectedTechId);
        if (tech && tech.categoryId === activeCategory) {
            renderTechDetail(tech);
            setSelectedCardHighlight(selectedTechId);
        } else {
            // при смене категории закрываем детали чужой технологии
            closeTechDetail(true);
        }
    }
}

function bindPan() {
    const vp = document.getElementById('tech-tree-viewport');
    if (!vp || vp.dataset.panBound === '1') return;
    vp.dataset.panBound = '1';

    vp.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.tech-card-wrap')) return;
        pan.active = true;
        pan.x = e.clientX;
        pan.y = e.clientY;
        pan.sl = vp.scrollLeft;
        pan.st = vp.scrollTop;
        vp.classList.add('dragging');
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!pan.active) return;
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        vp.scrollLeft = pan.sl - dx;
        vp.scrollTop = pan.st - dy;
    });
    window.addEventListener('mouseup', () => {
        if (!pan.active) return;
        pan.active = false;
        vp.classList.remove('dragging');
        saveCategoryScroll(activeCategory);
    });

    // Колёсико по дереву — скролл области + блок камеры космоса / 2D-карты
    const blockWheel = (e) => {
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        vp.scrollTop += e.deltaY;
        vp.scrollLeft += e.deltaX;
        saveCategoryScroll(activeCategory);
    };
    vp.addEventListener('wheel', blockWheel, { passive: false, capture: true });
    const panel = document.getElementById('tech-panel');
    if (panel && panel.dataset.wheelBound !== '1') {
        panel.dataset.wheelBound = '1';
        panel.addEventListener('wheel', (e) => {
            if (!open) return;
            // сайдбар категорий — свой скролл, не трогаем
            if (e.target.closest('.tech-nav')) return;
            e.preventDefault();
            e.stopPropagation();
            // если колесо над панелью, но не над nav — крутим viewport дерева
            if (!e.target.closest('#tech-tree-viewport')) {
                vp.scrollTop += e.deltaY;
                vp.scrollLeft += e.deltaX;
            }
        }, { passive: false, capture: true });
    }
}

export function initTechUI() {
    const panel = document.getElementById('tech-panel');
    if (!panel) {
        console.warn('[tech] #tech-panel not in DOM');
        return;
    }

    panel.querySelector('.tech-panel-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTechPanel();
    });
    panel.querySelector('.tech-panel-backdrop')?.addEventListener('click', () => closeTechPanel());

    // закрытие детального окна
    document.getElementById('tech-detail-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTechDetail();
    });
    const detailModal = document.getElementById('tech-detail-modal');
    detailModal?.addEventListener('click', (e) => e.stopPropagation());
    detailModal?.addEventListener('mousedown', (e) => e.stopPropagation());
    detailModal?.addEventListener('wheel', (e) => {
        e.stopPropagation();
    }, { passive: true });

    // старт / пауза исследования + подсветка невыполненных «Требует»
    const upgradeBtn = document.getElementById('tech-detail-upgrade');
    if (upgradeBtn && upgradeBtn.dataset.bound !== '1') {
        upgradeBtn.dataset.bound = '1';
        const onToggle = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedTechId) return;
            toggleTechResearch(selectedTechId);
            const tech = techById(selectedTechId);
            if (tech) renderUpgradePanel(tech);
            try { syncTreeResearchIndicators(); } catch (_) {}
        };
        upgradeBtn.addEventListener('click', onToggle);
        upgradeBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') onToggle(e);
        });
        const setReqHighlight = (on) => {
            document.querySelectorAll('#tech-detail-requires .tech-mini-card.req-unmet').forEach(card => {
                card.classList.toggle('req-unmet-hl', !!on);
            });
            try { setTechFuturePreview(!!on); } catch (_) {}
        };
        upgradeBtn.addEventListener('mouseenter', () => setReqHighlight(true));
        upgradeBtn.addEventListener('mouseleave', () => setReqHighlight(false));
    }

    // клик по дереву вне карточки и вне модала → закрыть детали
    const vp = document.getElementById('tech-tree-viewport');
    vp?.addEventListener('click', (e) => {
        if (!detailOpen) return;
        if (e.target.closest('.tech-card-wrap')) return;
        if (e.target.closest('#tech-detail-modal')) return;
        closeTechDetail();
    });
    panel.querySelector('.tech-tree-host')?.addEventListener('click', (e) => {
        if (!detailOpen) return;
        if (e.target.closest('.tech-card-wrap')) return;
        if (e.target.closest('#tech-detail-modal')) return;
        if (e.target.closest('#tech-tree-viewport') || e.target.classList.contains('tech-tree-bg') || e.target.classList.contains('tech-tree-grid')) {
            closeTechDetail();
        }
    });

    const sciBtn = document.getElementById('header-btn-science');
    if (sciBtn && !sciBtn.dataset.techBound) {
        sciBtn.dataset.techBound = '1';
        sciBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleTechPanel();
        });
    }

    const mapBtn = document.getElementById('header-btn-map');
    if (mapBtn && !mapBtn.dataset.techBound) {
        mapBtn.dataset.techBound = '1';
        mapBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (open) closeTechPanel();
            try {
                import('./hero.js').then(m => {
                    if (m.isHeroPanelOpen?.()) m.closeHeroPanel?.(true);
                }).catch(() => {});
            } catch (_) {}
            try {
                import('./codex.js').then(m => {
                    if (m.isCodexPanelOpen?.()) m.closeCodexPanel?.(true);
                }).catch(() => {});
            } catch (_) {}
            setHeaderMode('map');
        });
    }

    bindPan();

    onLanguageChange?.(() => {
        if (open) {
            renderTechPanel();
            if (detailOpen && selectedTechId) {
                const tech = techById(selectedTechId);
                if (tech) renderTechDetail(tech);
            }
        }
    });

    setHeaderMode('map');
    try { initTechExtras(); } catch (e) { console.warn('tech extras', e); }
    console.debug('[tech] UI ready');
}

function renderUpgradePanel(tech) {
    if (!tech) return;
    const p = ensureTechProgress(tech.id);
    // sync display level from progress
    const level = p.level;
    tech.level = level;
    const maxLevel = Math.max(level, Number(tech.maxLevel) || level || 1);
    const cost = getLevelCost(tech, level);
    const atMax = level >= maxLevel || cost == null;
    const reqsOk = prereqsMet(tech);
    // фальстарт: если требования не выполнены — обнулить вложенные очки
    if (!reqsOk && (Number(p.invested) || 0) > 0) p.invested = 0;
    const invested = Number(p.invested) || 0;
    if (p.researching && atMax) p.researching = false;
    const researching = !!p.researching && !atMax && reqsOk;

    const ratePerMin = calcGlobalTechRatePerMin();
    const researchingN = Math.max(1, countResearching());
    const share = researching ? (ratePerMin / researchingN) : 0;

    const upgrade = document.getElementById('tech-detail-upgrade');
    if (upgrade) {
        upgrade.classList.toggle('is-researching', researching);
        upgrade.classList.toggle('is-max', atMax);
        upgrade.classList.toggle('is-blocked', !reqsOk && !atMax);
        upgrade.classList.toggle('is-idle', !researching && !atMax && reqsOk);
    }

    const label = document.getElementById('tech-detail-upgrade-label');
    if (label) {
        label.textContent = researching
            ? (t('techTree.stopResearch') || 'Остановить исследования')
            : (t('techTree.upgrade') || 'Улучшить технологию');
    }

    const statusEl = document.getElementById('tech-detail-upgrade-status');
    if (statusEl) {
        let key = 'idle';
        let cls = 'idle';
        if (atMax) { key = 'max'; cls = 'max'; }
        else if (!reqsOk) { key = 'reqs'; cls = 'reqs'; }
        else if (researching) { key = 'researching'; cls = 'researching'; }
        else if (ratePerMin <= 0) { key = 'idle'; cls = 'idle'; }
        else { key = 'idle'; cls = 'idle'; }
        statusEl.dataset.status = cls;
        statusEl.textContent =
            t(`techTree.status.${key}`) ||
            ({ idle: 'Исследования не ведутся', researching: 'Идут исследования…', max: 'Достигнут макс. уровень', reqs: 'Не выполнены требования' })[key];
    }

    const fill = document.getElementById('tech-detail-upgrade-bar-fill');
    const bar = fill?.parentElement;
    if (fill && bar) {
        const pct = atMax ? 100 : (cost > 0 ? Math.min(100, (invested / cost) * 100) : 0);
        fill.style.width = pct.toFixed(2) + '%';
        bar.classList.toggle('active', researching);
        bar.style.display = atMax ? 'none' : '';
    }

    const etaEl = document.getElementById('tech-detail-upgrade-eta');
    if (etaEl) {
        if (atMax || !reqsOk || !researching || share <= 0 || cost == null) {
            etaEl.textContent = '';
            etaEl.style.display = 'none';
        } else {
            const need = Math.max(0, cost - invested);
            const minutes = need / share;
            const sec = minutes * 60;
            const remainStr = formatRemainDuration(sec);
            let completeStr = '—';
            try {
                const base = startTime instanceof Date ? new Date(startTime.getTime()) : new Date();
                base.setTime(base.getTime() + sec * 1000);
                completeStr = formatGameStamp(base);
            } catch (_) {}
            etaEl.style.display = '';
            const remainLabel = t('techTree.remain') || 'Осталось';
            const readyLabel = t('techTree.readyAt') || 'Готовность';
            etaEl.innerHTML = `<div class="tech-detail-upgrade-eta-remain">${remainLabel}: ${remainStr}</div>`
                + `<div class="tech-detail-upgrade-eta-ready">${readyLabel}: ${completeStr}</div>`;
        }
    }

    const ptsEl = document.getElementById('tech-detail-upgrade-pts');
    if (ptsEl) {
        // при макс. уровне параметр ед. технологий скрываем
        if (atMax || cost == null) {
            ptsEl.textContent = '';
            ptsEl.style.display = 'none';
        } else {
            ptsEl.style.display = '';
            const invStr = invested >= 10 ? invested.toFixed(1) : invested.toFixed(2);
            const costStr = cost >= 10 ? String(Math.round(cost)) : String(cost);
            ptsEl.textContent = `${t('techTree.points') || 'Ед. технологий'}: ${invStr} / ${costStr}`;
        }
    }

    // обновить бейдж уровня в шапке модалки
    const stage = resolveStage({ ...tech, level });
    const stageBox = document.getElementById('tech-detail-stage');
    if (stageBox) {
        stageBox.style.setProperty('--stage-color', stage.color || '#8b6914');
        stageBox.dataset.stage = stage.id || 'none';
    }
    const stageLevel = document.getElementById('tech-detail-stage-level');
    if (stageLevel) {
        const prefix = t('techTree.levelOf') || 'Ур.';
        stageLevel.textContent = `${prefix} ${level} / ${maxLevel}`;
    }
    const stageName = document.getElementById('tech-detail-stage-name');
    if (stageName) {
        stageName.textContent = pick(stage.name, t(`techTree.stage.${stage.id}`) || stage.id);
    }

    // динамика «Требует / Открывает»
    renderTechRelations(tech);
}

/** Бейдж + тик исследований + живое обновление модалки */
export function tickTechUI(dtGameSec) {
    const leveled = tickTechResearch(dtGameSec);
    if (open) {
        renderRateBadge();
        if (detailOpen && selectedTechId) {
            const tech = techById(selectedTechId);
            if (tech) {
                renderUpgradePanel(tech);
            }
        }
        if (leveled) {
            renderTree();
            if (detailOpen && selectedTechId) setSelectedCardHighlight(selectedTechId);
        } else {
            try { syncTreeResearchIndicators(); } catch (_) {}
        }
        try { tickTechExtras(dtGameSec, { open, detailOpen, selectedTechId, leveled }); } catch (_) {}
        try {
            const world = document.getElementById('tech-tree-world');
            refreshTechLinkStates(world);
        } catch (_) {}
    } else {
        try { tickTechExtras(dtGameSec, { open: false, detailOpen: false, selectedTechId: null, leveled: false }); } catch (_) {}
    }
}
