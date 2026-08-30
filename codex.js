/**
 * Кодекс — энциклопедия игры.
 * API: openCodexToBuilding(id), openCodexToTech(id), openCodexSection(section),
 *      isCodexPanelOpen(), closeCodexPanel(), toggleCodexPanel()
 */
import { state } from './state.js';
import { t, locName, onLanguageChange, getBuildingVideoAvatars } from './settings.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';
import { getTechCatalog } from './technologies.js';

let open = false;
let activeSection = 'buildings';
/** @type {string|null} */
let selectedBuildingId = null;
/** @type {string|null} */
let selectedTechId = null;
/** свёрнутые папки key → true */
const collapsedFolders = new Set();
let searchQuery = '';
let _midScroll = null;

const BUILDING_CAT_ORDER = ['COP01', 'COP02', 'COP03', 'COP04', 'COP05', 'COP06'];
const TECH_CAT_ORDER = ['fundamental', 'infrastructure', 'transport', 'raw', 'production', 'energy', 'military'];

const SECTIONS = [
    { id: 'buildings', i18n: 'codex.section.buildings', locked: false },
    { id: 'technologies', i18n: 'codex.section.technologies', locked: false }
];

export function isCodexPanelOpen() {
    return !!open;
}

function stopDetailVideo() {
    try {
        const panel = document.getElementById('codex-panel');
        const v = panel?.querySelector('.codex-detail-avatar-wrap video');
        if (v) v.pause();
    } catch (_) {}
}

export function closeCodexPanel(skipHeader) {
    open = false;
    const panel = document.getElementById('codex-panel');
    if (panel) {
        panel.classList.remove('open');
        panel.style.display = '';
        panel.style.pointerEvents = '';
    }
    stopDetailVideo();
    if (!skipHeader) {
        try {
            import('./technologies.js').then(m => {
                import('./hero.js').then(h => {
                    if (m.isTechPanelOpen?.()) m.setHeaderMode?.('science');
                    else if (h.isHeroPanelOpen?.()) m.setHeaderMode?.('hero');
                    else m.setHeaderMode?.('map');
                }).catch(() => m.setHeaderMode?.('map'));
            }).catch(() => {});
        } catch (_) {}
    }
}

export function openCodexPanel() {
    open = true;
    try {
        import('./technologies.js').then(m => {
            if (m.isTechPanelOpen?.()) m.closeTechPanel?.();
            m.setHeaderMode?.('codex');
        }).catch(() => {});
        import('./hero.js').then(h => {
            if (h.isHeroPanelOpen?.()) h.closeHeroPanel?.(true);
        }).catch(() => {});
    } catch (_) {}
    const panel = document.getElementById('codex-panel');
    if (panel) {
        panel.classList.add('open');
        panel.style.display = 'block';
        panel.style.pointerEvents = 'auto';
    }
    renderCodexPanel();
    return true;
}

export function toggleCodexPanel() {
    if (open) {
        closeCodexPanel();
        return false;
    }
    return openCodexPanel();
}

/** API: открыть кодекс на здании */
export function openCodexToBuilding(buildingId) {
    if (!buildingId) return false;
    activeSection = 'buildings';
    selectedBuildingId = String(buildingId);
    selectedTechId = null;
    searchQuery = '';
    // развернуть папку категории
    const b = (state.buildings || []).find(x => x.id === buildingId);
    if (b?.category) collapsedFolders.delete(b.category);
    return openCodexPanel();
}

/** API: открыть кодекс на технологии */
export function openCodexToTech(techId) {
    if (!techId) return false;
    activeSection = 'technologies';
    selectedTechId = String(techId);
    selectedBuildingId = null;
    searchQuery = '';
    const cat = getTechCatalog();
    const tech = (cat?.technologies || []).find(x => x.id === techId);
    if (tech?.categoryId) collapsedFolders.delete(`tech:${tech.categoryId}`);
    return openCodexPanel();
}

/** API: открыть раздел кодекса */
export function openCodexSection(sectionId) {
    if (!sectionId) return openCodexPanel();
    activeSection = sectionId;
    selectedBuildingId = null;
    selectedTechId = null;
    searchQuery = '';
    return openCodexPanel();
}

function uniqueBuildings() {
    const list = Array.isArray(state.buildings) ? state.buildings : [];
    const seen = new Set();
    const out = [];
    for (const b of list) {
        if (!b || !b.id) continue;
        const nm = locName(b.name) || b.id;
        const key = String(nm).trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(b);
    }
    return out;
}

function buildingsByCategory(filterQ) {
    const q = (filterQ || '').trim().toLowerCase();
    const map = new Map();
    for (const id of BUILDING_CAT_ORDER) map.set(id, []);
    for (const b of uniqueBuildings()) {
        const name = String(locName(b.name) || b.id);
        if (q && !name.toLowerCase().includes(q)) continue;
        const cat = b.category || 'COP06';
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat).push(b);
    }
    for (const [, arr] of map) {
        arr.sort((a, b) => String(locName(a.name) || a.id).localeCompare(String(locName(b.name) || b.id), 'ru'));
    }
    return map;
}

function techsByCategory(filterQ) {
    const q = (filterQ || '').trim().toLowerCase();
    const cat = getTechCatalog() || {};
    const map = new Map();
    for (const id of TECH_CAT_ORDER) map.set(id, []);
    for (const tech of (cat.technologies || [])) {
        if (!tech?.id) continue;
        const name = String(locName(tech.name) || tech.id);
        if (q && !name.toLowerCase().includes(q)) continue;
        const cid = tech.categoryId || 'fundamental';
        if (!map.has(cid)) map.set(cid, []);
        map.get(cid).push(tech);
    }
    for (const [, arr] of map) {
        arr.sort((a, b) => {
            const ca = Number(a.column) || 0;
            const cb = Number(b.column) || 0;
            if (ca !== cb) return ca - cb;
            return (Number(a.row) || 0) - (Number(b.row) || 0);
        });
    }
    return map;
}

function buildingCatLabel(catId) {
    const k = `cat.${catId}`;
    const v = t(k);
    return (v && v !== k) ? v : catId;
}

function techCatLabel(catId) {
    const catalog = getTechCatalog() || {};
    const c = (catalog.categories || []).find(x => x.id === catId);
    if (c) return locName(c.name) || catId;
    const k = `tech.cat.${catId}`;
    const v = t(k);
    return (v && v !== k) ? v : catId;
}

function renderNav() {
    return SECTIONS.map(s => {
        const active = s.id === activeSection ? ' active' : '';
        const locked = s.locked ? ' locked' : '';
        const label = t(s.i18n) || s.id;
        return `<button type="button" class="codex-nav-item${active}${locked}" data-section="${s.id}">${label}</button>`;
    }).join('');
}

function renderFolder(folderKey, title, count, itemsHtml) {
    const collapsed = collapsedFolders.has(folderKey);
    const colCls = collapsed ? ' collapsed' : '';
    const chev = collapsed ? '▶' : '▼';
    return `<div class="codex-folder${colCls}" data-folder="${folderKey}">
        <button type="button" class="codex-folder-head" data-folder-toggle="${folderKey}">
            <span class="codex-folder-chevron">${chev}</span>
            <span>${title}</span>
            <span style="opacity:0.55;font-weight:500;margin-left:auto;font-size:11px;">${count}</span>
        </button>
        <div class="codex-folder-body">
            <div class="codex-folder-body-inner">${itemsHtml}</div>
        </div>
    </div>`;
}

function renderMidBuildings() {
    const byCat = buildingsByCategory(searchQuery);
    let html = '';
    let any = false;
    for (const catId of BUILDING_CAT_ORDER) {
        const items = byCat.get(catId) || [];
        if (!items.length) continue;
        any = true;
        let cards = '';
        for (const b of items) {
            const name = locName(b.name) || b.id;
            const icon = b.avatar || 'assets/textures/default.png';
            const act = b.id === selectedBuildingId ? ' active' : '';
            cards += `<div class="codex-card${act}" data-building-id="${b.id}">
                <img class="codex-card-icon" src="${icon}" alt="" onerror="this.style.opacity='0.3'">
                <span class="codex-card-name">${name}</span>
            </div>`;
        }
        html += renderFolder(catId, buildingCatLabel(catId), items.length, cards);
    }
    if (!any) {
        html = `<div class="codex-deep-empty">${t('codex.empty') || 'Нет данных'}</div>`;
    }
    return html;
}

function renderMidTechs() {
    const byCat = techsByCategory(searchQuery);
    let html = '';
    let any = false;
    const order = TECH_CAT_ORDER.slice();
    // append unknown cats
    for (const k of byCat.keys()) {
        if (!order.includes(k)) order.push(k);
    }
    for (const catId of order) {
        const items = byCat.get(catId) || [];
        if (!items.length) continue;
        any = true;
        let cards = '';
        for (const tech of items) {
            const name = locName(tech.name) || tech.id;
            const icon = tech.image || tech.icon || 'assets/textures/icons/technologies.png';
            const act = tech.id === selectedTechId ? ' active' : '';
            cards += `<div class="codex-card${act}" data-tech-id="${tech.id}">
                <img class="codex-card-icon" src="${icon}" alt="" onerror="this.style.opacity='0.3'">
                <span class="codex-card-name">${name}</span>
            </div>`;
        }
        html += renderFolder(`tech:${catId}`, techCatLabel(catId), items.length, cards);
    }
    if (!any) {
        html = `<div class="codex-deep-empty">${t('codex.empty') || 'Нет данных'}</div>`;
    }
    return html;
}

function renderDeepBuilding() {
    if (!selectedBuildingId) {
        return `<div class="codex-deep-empty">${t('codex.pickItem') || 'Выберите сооружение'}</div>`;
    }
    const b = (state.buildings || []).find(x => x.id === selectedBuildingId);
    if (!b) {
        return `<div class="codex-deep-empty">${t('codex.pickItem') || 'Выберите сооружение'}</div>`;
    }
    const name = locName(b.name) || b.id;
    const desc = locName(b.description) || '';
    const imgUrl = b.avatar || 'assets/textures/default.png';
    const videoUrl = (b.avatarVideo || b.avatar_video || '').trim();
    const allowVideo = (typeof getBuildingVideoAvatars === 'function') ? getBuildingVideoAvatars() : true;
    const useVideo = allowVideo && !!videoUrl;

    return `
    <div class="codex-detail-head">
        <div class="codex-detail-avatar-wrap${useVideo ? ' has-video' : ''}">
            <img src="${imgUrl}" alt="">
            ${useVideo ? `<video muted loop playsinline preload="metadata" data-src="${videoUrl}"></video>` : ''}
        </div>
        <div class="codex-detail-title-block">
            <div class="codex-detail-name">${name}</div>
            <div class="codex-detail-desc">${desc}</div>
        </div>
    </div>`;
}

function renderDeepTech() {
    if (!selectedTechId) {
        return `<div class="codex-deep-empty">${t('codex.pickTech') || 'Выберите технологию'}</div>`;
    }
    const catalog = getTechCatalog() || {};
    const tech = (catalog.technologies || []).find(x => x.id === selectedTechId);
    if (!tech) {
        return `<div class="codex-deep-empty">${t('codex.pickTech') || 'Выберите технологию'}</div>`;
    }
    const name = locName(tech.name) || tech.id;
    const desc = locName(tech.description) || '';
    const imgUrl = tech.image || tech.icon || 'assets/textures/icons/technologies.png';

    return `
    <div class="codex-detail-head">
        <div class="codex-detail-avatar-wrap">
            <img src="${imgUrl}" alt="">
        </div>
        <div class="codex-detail-title-block">
            <div class="codex-detail-name">${name}</div>
            <div class="codex-detail-desc">${desc}</div>
        </div>
    </div>`;
}

function bindDetailVideo(root) {
    const wrap = root?.querySelector?.('.codex-detail-avatar-wrap.has-video');
    if (!wrap) return;
    const video = wrap.querySelector('video');
    if (!video) return;
    const src = video.getAttribute('data-src') || '';
    if (!src) return;
    if (video.getAttribute('data-loaded') !== src) {
        video.src = src;
        video.setAttribute('data-loaded', src);
    }
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.loop = true;
    video.playsInline = true;
    const play = () => {
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    };
    if (video.readyState >= 2) play();
    else video.addEventListener('loadeddata', play, { once: true });
}

function ensureMidScroll() {
    const host = document.querySelector('#codex-panel .codex-mid-scroll');
    if (!host) return;
    try {
        _midScroll = attachFirmScroll(host, {
            axis: 'y',
            mirrorV: true,
            host: 'self',
            fillHost: true
        });
    } catch (e) {
        console.warn('codex scroll', e);
    }
}

export function renderCodexPanel() {
    const panel = document.getElementById('codex-panel');
    if (!panel) return;

    const title = panel.querySelector('.codex-panel-title');
    if (title) title.textContent = t('codex.title') || 'Кодекс';

    const nav = panel.querySelector('.codex-nav');
    const mid = panel.querySelector('.codex-mid');
    const deep = panel.querySelector('.codex-deep');

    if (nav) nav.innerHTML = renderNav();

    if (mid) {
        const placeholder = activeSection === 'technologies'
            ? (t('codex.searchTech') || 'Поиск технологии…')
            : (t('codex.searchBuilding') || 'Поиск сооружения…');
        const listHtml = activeSection === 'technologies' ? renderMidTechs() : renderMidBuildings();
        mid.innerHTML = `
            <div class="codex-search-wrap">
                <input type="search" class="codex-search" value="${searchQuery.replace(/"/g, '&quot;')}" placeholder="${placeholder}" autocomplete="off">
            </div>
            <div class="codex-mid-scroll">${listHtml}</div>`;
        ensureMidScroll();
        requestAnimationFrame(() => {
            try { updateFirmScroll?.(document.querySelector('#codex-panel .codex-mid-scroll')); } catch (_) {}
            try { _midScroll?.update?.(); } catch (_) {}
        });
    }

    if (deep) {
        if (activeSection === 'technologies') deep.innerHTML = renderDeepTech();
        else deep.innerHTML = renderDeepBuilding();
        bindDetailVideo(deep);
    }

    // nav
    nav?.querySelectorAll('.codex-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('locked')) return;
            const id = btn.getAttribute('data-section');
            if (!id || id === activeSection) return;
            activeSection = id;
            selectedBuildingId = null;
            selectedTechId = null;
            searchQuery = '';
            renderCodexPanel();
        });
    });

    // search
    const searchEl = mid?.querySelector('.codex-search');
    searchEl?.addEventListener('input', () => {
        searchQuery = searchEl.value || '';
        // partial re-render list only — keep focus
        const scrollHost = mid.querySelector('.codex-mid-scroll');
        const inner = scrollHost?.querySelector('.firm-scroll-inner') || scrollHost;
        if (!inner) return;
        const listHtml = activeSection === 'technologies' ? renderMidTechs() : renderMidBuildings();
        // if firm-scroll-inner exists, put content there
        if (scrollHost?.querySelector('.firm-scroll-inner')) {
            scrollHost.querySelector('.firm-scroll-inner').innerHTML = listHtml;
        } else {
            scrollHost.innerHTML = listHtml;
        }
        bindMidList(mid);
        try { updateFirmScroll?.(scrollHost); } catch (_) {}
    });

    bindMidList(mid);
}

function bindMidList(mid) {
    mid?.querySelectorAll('[data-folder-toggle]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-folder-toggle');
            if (!id) return;
            if (collapsedFolders.has(id)) collapsedFolders.delete(id);
            else collapsedFolders.add(id);
            const folder = mid.querySelector(`.codex-folder[data-folder="${id}"]`);
            if (folder) {
                folder.classList.toggle('collapsed', collapsedFolders.has(id));
                const chev = folder.querySelector('.codex-folder-chevron');
                if (chev) chev.textContent = collapsedFolders.has(id) ? '▶' : '▼';
            }
            requestAnimationFrame(() => {
                try { updateFirmScroll?.(mid.querySelector('.codex-mid-scroll')); } catch (_) {}
            });
        });
    });

    mid?.querySelectorAll('.codex-card[data-building-id]').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-building-id');
            if (!id) return;
            selectedBuildingId = id;
            selectedTechId = null;
            mid.querySelectorAll('.codex-card').forEach(c => c.classList.toggle('active', c === card));
            const deep = document.querySelector('#codex-panel .codex-deep');
            if (deep) {
                deep.innerHTML = renderDeepBuilding();
                bindDetailVideo(deep);
            }
        });
    });

    mid?.querySelectorAll('.codex-card[data-tech-id]').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-tech-id');
            if (!id) return;
            selectedTechId = id;
            selectedBuildingId = null;
            mid.querySelectorAll('.codex-card').forEach(c => c.classList.toggle('active', c === card));
            const deep = document.querySelector('#codex-panel .codex-deep');
            if (deep) deep.innerHTML = renderDeepTech();
        });
    });
}

export function initCodexUI() {
    const panel = document.getElementById('codex-panel');
    if (!panel) {
        console.warn('[codex] #codex-panel not in DOM');
        return;
    }

    panel.querySelector('.codex-panel-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeCodexPanel();
    });
    panel.querySelector('.codex-panel-backdrop')?.addEventListener('click', () => closeCodexPanel());

    // data-ui: camera.js не зумит карту над UI
    panel.setAttribute('data-ui', 'true');

    // Колесо: списки скроллятся, камера космоса — нет.
    // Не preventDefault на всём панеле (это ломало native scroll у firm-scroll-inner).
    // В capture вручную крутим scrollable-контейнер и stopPropagation → window.wheel камеры не срабатывает.
    if (panel.dataset.wheelBound !== '1') {
        panel.dataset.wheelBound = '1';
        panel.addEventListener('wheel', (e) => {
            if (!open) return;
            e.stopPropagation();

            const scrollEl =
                e.target.closest?.('.firm-scroll-inner') ||
                e.target.closest?.('.codex-deep') ||
                e.target.closest?.('.codex-nav');

            if (scrollEl) {
                const before = scrollEl.scrollTop;
                scrollEl.scrollTop += e.deltaY;
                // если реально проскроллили — блокируем default (иначе двойной скролл)
                if (scrollEl.scrollTop !== before) {
                    e.preventDefault();
                    try {
                        const host = scrollEl.closest('.firm-scroll-host') ||
                            panel.querySelector('.codex-mid-scroll');
                        if (host) updateFirmScroll(host);
                    } catch (_) {}
                } else {
                    // у края списка — всё равно не отдаём событие камере
                    e.preventDefault();
                }
            } else {
                e.preventDefault();
            }
        }, { passive: false, capture: true });
    }

    const btn = document.getElementById('header-btn-codex');
    if (btn && !btn.dataset.codexBound) {
        btn.dataset.codexBound = '1';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleCodexPanel();
        });
    }

    // API-кнопка «?» у модалки здания
    const bHelp = document.getElementById('building-modal-codex-btn');
    if (bHelp && !bHelp.dataset.codexBound) {
        bHelp.dataset.codexBound = '1';
        bHelp.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = bHelp.dataset.buildingId
                || document.getElementById('building-modal')?.dataset?.buildingId
                || null;
            if (id) openCodexToBuilding(id);
            else openCodexSection('buildings');
        });
    }

    // API-кнопка «?» у модалки технологии
    const tHelp = document.getElementById('tech-detail-codex-btn');
    if (tHelp && !tHelp.dataset.codexBound) {
        tHelp.dataset.codexBound = '1';
        tHelp.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = tHelp.dataset.techId
                || document.getElementById('tech-detail-modal')?.dataset?.selectedTechId
                || null;
            if (id) openCodexToTech(id);
            else openCodexSection('technologies');
        });
    }

    onLanguageChange?.(() => {
        if (open) renderCodexPanel();
    });

    console.debug('[codex] UI ready');
}
