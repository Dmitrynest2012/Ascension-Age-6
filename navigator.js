/**
 * Навигатор небесных тел.
 * Дерево: родитель на вершине ствола, дети — ветви влево.
 * Одинарный клик — фокус дерева. Двойной — перелёт камеры.
 * Подчиняется оптическому туману войны.
 */
import { state } from './state.js';
import { locName, t, onLanguageChange } from './settings.js';
import { focusBodyAtHeight, currentLocation } from './camera.js';
import { getOpticalBodyState, isOpticalFogEnabled, getOpticalUnknownName } from './opticalScan.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';

const HOME_BODY_ID = 3;
const HOME_SYSTEM_ID = 1000;
const NODE_PARENT = 56;
const NODE_CHILD = 40;
const TREE_W = 272;
const SCROLL_GUTTER = 18;
const CHILD_GAP = 64;
const TREE_VIEW_H = 78 + 5 * CHILD_GAP; // окно на ~5 детей, остальные скроллом

let enabled = false;
let focusId = HOME_BODY_ID;
let pinId = null;          // ручной фокус; не сбрасывается тиком камеры
let rootEl = null;
let treeEl = null;
let svgEl = null;
let treeInner = null;
let scrollApi = null;
let morphTimer = null;
let lastLocId = null;
let lastSig = '';
let converter = null;
let drawTimer = null;

function entryById(id) {
    if (id == null) return null;
    return state.celestialBodies?.[id]
        || state.celestialBodies?.[String(id)]
        || state.celestialBodies?.[Number(id)]
        || null;
}

function typeOf(entry) {
    return entry?.data?.type || '';
}

function parentOf(entry) {
    if (!entry?.data) return null;
    const p = entry.data.parent;
    if (p != null && p !== '' && Number(p) !== Number(entry.data.id)) {
        const e = entryById(p);
        if (e) return e;
    }
    if (entry.data.starSystemId != null) {
        const e = entryById(entry.data.starSystemId);
        if (e) return e;
    }
    if (entry.data.nebulaId != null) {
        const e = entryById(entry.data.nebulaId);
        if (e) return e;
    }
    if (entry.data.galaxyId != null) {
        const e = entryById(entry.data.galaxyId);
        if (e) return e;
    }
    return null;
}

const NAV_CHILD_TYPES = {
    star: ['planet'],
    planet: ['moon'],
    moon: [],
    starSystem: ['star'],
    interstellarNebula: ['starSystem'],
    galaxy: ['interstellarNebula'],
    universe: ['galaxy'],
    multiverse: ['universe']
};

function childrenOf(entry) {
    if (!entry?.data) return [];
    const pid = Number(entry.data.id);
    const tpe = typeOf(entry);
    const allowed = NAV_CHILD_TYPES[tpe] || null;
    const ids = [];
    const pushId = (id) => {
        if (id == null || id === '' || Number(id) === pid) return;
        if (!ids.some(x => Number(x) === Number(id))) ids.push(id);
    };
    if (Array.isArray(entry.data.children)) entry.data.children.forEach(pushId);
    Object.values(state.celestialBodies || {}).forEach(e => {
        if (!e?.data || e === entry) return;
        const ct = typeOf(e);
        const rawParent = e.data.parent;
        // Number(null) === 0 — иначе у Солнца (id 0) детьми становятся все «без родителя», включая мультивселенную
        if (rawParent != null && rawParent !== '' && Number(rawParent) === pid) pushId(e.data.id);
        if (tpe === 'starSystem' && ct === 'star' && e.data.starSystemId != null && Number(e.data.starSystemId) === pid) {
            pushId(e.data.id);
        }
        if (tpe === 'interstellarNebula' && ct === 'starSystem' && e.data.nebulaId != null && Number(e.data.nebulaId) === pid) {
            pushId(e.data.id);
        }
        if (tpe === 'galaxy' && ct === 'interstellarNebula' && e.data.galaxyId != null && Number(e.data.galaxyId) === pid) {
            pushId(e.data.id);
        }
    });
    return ids.map(entryById).filter(e => {
        if (!e) return false;
        if (!allowed) return true;
        return allowed.includes(typeOf(e));
    });
}

/** Со звезды вверх — сразу в туманность, минуя starSystem. */
function parentForNav(entry) {
    const p = parentOf(entry);
    if (typeOf(entry) === 'star' && typeOf(p) === 'starSystem') return parentOf(p) || p;
    return p;
}

function opticalState(entry) {
    try {
        if (!isOpticalFogEnabled()) return 'full';
        return getOpticalBodyState(entry);
    } catch (_) {
        return 'full';
    }
}

/** Ребёнок в дереве: полное знание или «неизвестно». hidden = тела нет. */
function isNavListed(entry) {
    if (!entry) return false;
    if (Number(entry.data?.id) === HOME_BODY_ID) return true;
    if (entry.data?.colonized || entry.data?.developed) return true;
    const st = opticalState(entry);
    return st === 'full' || st === 'detect';
}

function isAncestorOf(maybeAnc, start) {
    let cur = start;
    for (let i = 0; i < 10 && cur; i++) {
        if (Number(cur.data?.id) === Number(maybeAnc.data?.id)) return true;
        cur = parentOf(cur);
    }
    return false;
}

/** Корень можно держать, даже если оптика считает звезду/систему hidden. */
function isNavFocusable(entry) {
    if (!entry) return false;
    if (isNavListed(entry)) return true;
    const tpe = typeOf(entry);
    if (tpe === 'star' || tpe === 'starSystem' || tpe === 'interstellarNebula'
        || tpe === 'galaxy' || tpe === 'universe' || tpe === 'multiverse') {
        if (isAncestorOf(entry, entryById(HOME_BODY_ID))) return true;
        if (isAncestorOf(entry, currentBody())) return true;
        if (pinId != null && isAncestorOf(entry, entryById(pinId))) return true;
    }
    return false;
}

function isNavVisible(entry) {
    return isNavListed(entry);
}

function isNavUnknown(entry) {
    if (!entry) return false;
    const tpe = typeOf(entry);
    if (tpe !== 'planet' && tpe !== 'moon') return false;
    if (entry.data?.colonized || entry.data?.developed) return false;
    return opticalState(entry) === 'detect';
}

function displayName(entry) {
    if (!entry) return '';
    if (isNavUnknown(entry)) return getOpticalUnknownName();
    const custom = state.bodyCustomNames?.[String(entry.data.id)];
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
    return locName(entry.data.name, '') || String(entry.data.id);
}

function heightForTravel(entry) {
    const tpe = typeOf(entry);
    if (tpe === 'moon' || tpe === 'planet') return 3;
    if (tpe === 'star') return 480;          // 4ZC, минуя систему
    if (tpe === 'starSystem') return 60;
    if (tpe === 'interstellarNebula') return 900;
    if (tpe === 'galaxy') return 8000;
    if (tpe === 'universe') return 40000;
    if (tpe === 'multiverse') return 200000;
    return 3;
}

function homeFallback() {
    return entryById(HOME_BODY_ID) || entryById(0) || entryById(HOME_SYSTEM_ID);
}

function currentBody() {
    return (typeof window !== 'undefined' && window.__currentLocation) || currentLocation || null;
}

/** Планета под камерой — корень дерева (чтобы были видны её луны). Луна → её планета. */
function treeRootFor(entry) {
    if (!entry) return null;
    if (typeOf(entry) === 'moon') {
        const p = parentOf(entry);
        if (p && isNavVisible(p)) return p;
    }
    return entry;
}

function ensureFocusVisible() {
    let e = entryById(focusId);
    if (e && isNavFocusable(e)) return e;
    if (pinId != null) {
        const pinned = entryById(pinId);
        if (pinned && isNavFocusable(pinned)) {
            focusId = pinned.data.id;
            return pinned;
        }
    }
    const cur = treeRootFor(currentBody());
    if (cur && isNavFocusable(cur)) {
        focusId = cur.data.id;
        return cur;
    }
    const fb = homeFallback();
    if (fb) focusId = fb.data.id;
    return fb;
}

/* ---------- 2D-преобразователь (сфера + свет слева) ---------- */
function ensureConverter() {
    if (converter) return converter;
    if (typeof THREE === 'undefined') return null;
    try {
        const renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: true,
            preserveDrawingBuffer: true
        });
        renderer.setSize(64, 64);
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(1);
        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1.05, 1.05, 1.05, -1.05, 0.1, 10);
        camera.position.set(0, 0, 3);
        camera.lookAt(0, 0, 0);
        const geo = new THREE.SphereGeometry(1, 32, 24);
        const mat = new THREE.MeshPhongMaterial({
            color: 0xffffff,
            shininess: 18,
            specular: 0x333333
        });
        const mesh = new THREE.Mesh(geo, mat);
        scene.add(mesh);
        const key = new THREE.DirectionalLight(0xfff4d8, 1.15);
        key.position.set(-2.2, 0.35, 1.4);
        scene.add(key);
        scene.add(new THREE.AmbientLight(0x33444c, 0.35));
        const fill = new THREE.DirectionalLight(0x1a2230, 0.35);
        fill.position.set(2.0, -0.2, 0.6);
        scene.add(fill);
        converter = { renderer, scene, camera, mesh, mat, cache: new Map() };
        return converter;
    } catch (e) {
        console.warn('[navigator] converter', e);
        return null;
    }
}

function paintOrb(canvas, entry, unknown) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (unknown) {
        const g = ctx.createRadialGradient(w * 0.35, h * 0.4, 2, w * 0.5, h * 0.5, w * 0.5);
        g.addColorStop(0, '#1a1a22');
        g.addColorStop(1, '#050508');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 0.5, 0, Math.PI * 2); ctx.fill();
        return;
    }

    const tpe = typeOf(entry);
    const conv = ensureConverter();
    const tex = entry?.data?.texture;
    if (conv && tex && (tpe === 'planet' || tpe === 'moon' || tpe === 'star')) {
        const key = tex + ':' + (entry.data.atmosphereColor || '');
        const cached = conv.cache.get(key);
        if (cached) {
            ctx.drawImage(cached, 0, 0, w, h);
            return;
        }
        const loader = new THREE.TextureLoader();
        loader.load(tex, (map) => {
            try {
                map.minFilter = THREE.LinearFilter;
                conv.mat.map = map;
                conv.mat.emissive = new THREE.Color(tpe === 'star' ? 0x332200 : 0x000000);
                conv.mat.emissiveIntensity = tpe === 'star' ? 0.35 : 0;
                conv.mat.needsUpdate = true;
                conv.renderer.render(conv.scene, conv.camera);
                const src = conv.renderer.domElement;
                const off = document.createElement('canvas');
                off.width = 64; off.height = 64;
                off.getContext('2d').drawImage(src, 0, 0);
                conv.cache.set(key, off);
                ctx.drawImage(off, 0, 0, w, h);
            } catch (_) {}
        }, undefined, () => paintFallback(ctx, w, h, entry, tpe));
        paintFallback(ctx, w, h, entry, tpe);
        return;
    }
    paintFallback(ctx, w, h, entry, tpe);
}

function paintFallback(ctx, w, h, entry, tpe) {
    const colors = entry?.data?.nebulaColors;
    let c0 = '#6a8caf', c1 = '#1a2430';
    if (tpe === 'star') { c0 = entry?.data?.atmosphereColor || '#ffb45a'; c1 = '#7a3a10'; }
    else if (tpe === 'galaxy' || tpe === 'universe' || tpe === 'multiverse') { c0 = '#c8b070'; c1 = '#2a1a08'; }
    else if (tpe === 'starSystem') { c0 = '#ffe8a0'; c1 = '#101018'; }
    else if (Array.isArray(colors) && colors.length) { c0 = colors[0]; c1 = colors[colors.length - 1]; }
    const g = ctx.createRadialGradient(w * 0.34, h * 0.38, 2, w * 0.5, h * 0.5, w * 0.52);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 0.5, 0, Math.PI * 2); ctx.fill();
}

/* ---------- DOM ---------- */
function ensureDom() {
    if (rootEl && document.body.contains(rootEl) && treeEl && svgEl) return;
    rootEl = document.getElementById('navigator');
    if (!rootEl) {
        rootEl = document.createElement('div');
        rootEl.id = 'navigator';
        rootEl.setAttribute('data-ui', 'true');
        document.body.appendChild(rootEl);
    }
    rootEl.innerHTML = `
        <div class="nav-shell">
            <div class="nav-title" data-i18n="navigator.title">${t('navigator.title') || 'Навигатор'}</div>
            <div class="nav-tree">
                <svg class="nav-svg" xmlns="http://www.w3.org/2000/svg"></svg>
            </div>
        </div>`;
    treeEl = rootEl.querySelector('.nav-tree');
    svgEl = rootEl.querySelector('.nav-svg');
    try {
        scrollApi = attachFirmScroll(treeEl, {
            axis: 'y',
            mirrorV: true,
            host: 'self',
            fillHost: true
        });
    } catch (e) {
        console.warn('[navigator] firmScroll', e);
    }
    treeInner = treeEl.querySelector(':scope > .firm-scroll-inner') || treeEl;
    if (treeInner && svgEl && svgEl.parentElement !== treeInner) {
        treeInner.insertBefore(svgEl, treeInner.firstChild);
    }
    treeInner.addEventListener('wheel', (e) => {
        e.stopPropagation();
    }, { passive: true });
}

function makeNode(entry, kind) {
    const el = document.createElement('div');
    el.className = 'nav-node nav-' + kind;
    el.dataset.id = String(entry.data.id);
    const orb = document.createElement('div');
    orb.className = 'nav-orb';
    const tpe = typeOf(entry);
    if (tpe === 'star') orb.classList.add('is-star');
    if (tpe === 'interstellarNebula') orb.classList.add('is-nebula');
    const unknown = isNavUnknown(entry);
    if (unknown) orb.classList.add('is-unknown');
    const size = kind === 'parent' ? NODE_PARENT : NODE_CHILD;
    const canvas = document.createElement('canvas');
    canvas.width = size * 2;
    canvas.height = size * 2;
    orb.appendChild(canvas);
    paintOrb(canvas, entry, unknown);
    const card = document.createElement('div');
    card.className = 'nav-card';
    const label = document.createElement('div');
    label.className = 'nav-label';
    label.textContent = displayName(entry);
    card.appendChild(label);
    el.appendChild(orb);
    el.appendChild(card);

    let clicks = 0;
    el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        clicks += 1;
        setTimeout(() => {
            if (clicks === 1) onSingleClick(entry, kind);
            clicks = 0;
        }, 240);
    });
    el.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        clicks = 0;
        onDoubleClick(entry);
    });
    return el;
}

function onSingleClick(entry, kind) {
    if (kind === 'parent') {
        const up = parentForNav(entry);
        if (up) {
            pinId = up.data.id;
            setFocus(up.data.id, true);
        }
        return;
    }
    pinId = entry.data.id;
    setFocus(entry.data.id, true);
}

function onDoubleClick(entry) {
    pinId = null;
    try {
        focusBodyAtHeight(entry.data.id, heightForTravel(entry));
    } catch (e) {
        console.warn('[navigator] fly', e);
    }
    const root = treeRootFor(entry) || entry;
    setFocus(root.data.id, true);
}

function setFocus(id, animate) {
    const next = entryById(id);
    if (!next) return;
    const same = Number(focusId) === Number(next.data.id);
    focusId = next.data.id;
    if (same && !animate) {
        rebuild();
        return;
    }
    lastSig = '';
    if (animate && rootEl && enabled) {
        rootEl.classList.add('nav-morph');
        clearTimeout(morphTimer);
        morphTimer = setTimeout(() => {
            rebuild();
            requestAnimationFrame(() => {
                requestAnimationFrame(() => rootEl.classList.remove('nav-morph'));
            });
        }, 220);
    } else {
        rebuild();
    }
}

function rebuild() {
    if (!enabled) return;
    ensureDom();
    const parent = ensureFocusVisible();
    if (!parent || !treeEl) return;

    const kids = childrenOf(parent).filter(isNavListed);
    const host = treeInner || treeEl;

    treeEl.querySelectorAll('.nav-node').forEach(n => n.remove());

    lastSig = treeSignature(parent, kids);

    const parentNode = makeNode(parent, 'parent');
    host.appendChild(parentNode);
    kids.forEach(k => host.appendChild(makeNode(k, 'child')));

    const hereId = currentBody()?.data?.id;
    treeEl.querySelectorAll('.nav-node').forEach(n => {
        n.classList.toggle('is-here', hereId != null && Number(n.dataset.id) === Number(hereId));
    });

    layout(parentNode, kids.length);
    scheduleDraw(kids.length);
    try { scrollApi?.update?.() || updateFirmScroll(treeEl); } catch (_) {}
}

function treeSignature(parent, kids) {
    const bits = [String(parent.data.id), displayName(parent), isNavUnknown(parent) ? 'u' : 'k'];
    kids.forEach(k => {
        bits.push(String(k.data.id), displayName(k), isNavUnknown(k) ? 'u' : 'k', isNavVisible(k) ? 'v' : 'h');
    });
    bits.push('f' + focusId, 'p' + pinId, 'c' + (currentBody()?.data?.id ?? ''));
    return bits.join('|');
}

function layout(parentNode, kidCount) {
    const treeW = TREE_W;
    const startY = NODE_PARENT + 22;
    const contentH = Math.max(108, 78 + kidCount * CHILD_GAP);
    const viewH = Math.min(contentH, TREE_VIEW_H);
    treeEl.style.width = (treeW + SCROLL_GUTTER) + 'px';
    treeEl.style.height = viewH + 'px';
    if (treeInner && treeInner !== treeEl) {
        treeInner.style.width = treeW + 'px';
        treeInner.style.marginRight = SCROLL_GUTTER + 'px';
        treeInner.style.height = viewH + 'px';
        treeInner.style.maxHeight = TREE_VIEW_H + 'px';
        const spacer = contentH;
        treeInner.style.setProperty('--nav-content-h', spacer + 'px');
        // абсолютные узлы не растягивают scrollHeight — якорь высоты
        let pad = treeInner.querySelector('.nav-scroll-pad');
        if (!pad) {
            pad = document.createElement('div');
            pad.className = 'nav-scroll-pad';
            treeInner.appendChild(pad);
        }
        pad.style.height = spacer + 'px';
    }

    parentNode.style.right = '4px';
    parentNode.style.top = '2px';
    parentNode.style.left = 'auto';

    const childNodes = treeEl.querySelectorAll('.nav-node.nav-child');
    childNodes.forEach((n, i) => {
        n.style.right = (NODE_PARENT + 28) + 'px';
        n.style.top = (startY + i * CHILD_GAP) + 'px';
        n.style.left = 'auto';
    });
}

function scheduleDraw(kidCount) {
    clearTimeout(drawTimer);
    const run = () => drawBranches(kidCount);
    requestAnimationFrame(() => requestAnimationFrame(run));
    drawTimer = setTimeout(run, 40);
}

function relBox(el) {
    const tr = treeEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
        left: r.left - tr.left,
        right: r.right - tr.left,
        top: r.top - tr.top,
        bottom: r.bottom - tr.top,
        cx: r.left - tr.left + r.width / 2,
        cy: r.top - tr.top + r.height / 2
    };
}

function drawBranches(kidCount) {
    if (!svgEl || !treeEl) return;
    const treeW = TREE_W;
    const treeH = Math.max(108, 78 + kidCount * CHILD_GAP);
    svgEl.setAttribute('viewBox', `0 0 ${treeW} ${treeH}`);
    svgEl.setAttribute('width', treeW);
    svgEl.setAttribute('height', treeH);

    const defs = `
        <defs>
            <linearGradient id="nav-link-grad" x1="1" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#9af6ff"/>
                <stop offset="55%" stop-color="#3ec8dc"/>
                <stop offset="100%" stop-color="#1a7a96"/>
            </linearGradient>
            <filter id="nav-link-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="1.8" result="b"/>
                <feMerge>
                    <feMergeNode in="b"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>`;

    // координаты из layout, без getBoundingClientRect (он врал во время morph)
    const parentRight = 4;
    const parentTop = 2;
    const pOrb = NODE_PARENT;
    const cOrb = NODE_CHILD;
    const childRight = NODE_PARENT + 28;
    const startY = NODE_PARENT + 22;

    const px1 = treeW - parentRight - pOrb;       // левый край орба родителя
    const py1 = parentTop + pOrb / 2;
    const pBottom = parentTop + pOrb;

    let paths = '';
    if (kidCount > 0) {
        const lastCy = startY + (kidCount - 1) * CHILD_GAP + cOrb / 2;
        const trunkD = `M ${px1} ${pBottom - 2} C ${px1} ${pBottom + 12}, ${px1} ${lastCy}, ${px1} ${lastCy}`;
        paths += `<g class="nav-link">
            <path class="nav-link-base" d="${trunkD}"/>
            <path class="nav-link-core" d="${trunkD}"/>
            <path class="nav-link-flow" d="${trunkD}"/>
        </g>`;
    }

    for (let i = 0; i < kidCount; i++) {
        const x2 = treeW - childRight;
        const y2 = startY + i * CHILD_GAP + cOrb / 2;
        const dx = Math.max(16, (px1 - x2) * 0.4);
        const d = `M ${px1} ${y2} C ${px1 - dx} ${y2}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
        paths += `<g class="nav-link">
            <path class="nav-link-base" d="${d}"/>
            <path class="nav-link-core" d="${d}"/>
            <path class="nav-link-flow" d="${d}"/>
        </g>`;
    }

    svgEl.innerHTML = defs + paths;
}

function gameChromeHidden() {
    if (document.body.classList.contains('main-menu-active')) return true;
    const intro = document.getElementById('intro-screen');
    if (intro) {
        const st = getComputedStyle(intro);
        if (st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.05) {
            const shown = intro.classList.contains('active') || intro.style.display === 'block' || intro.style.opacity === '1';
            if (shown || (intro.offsetParent !== null && st.display !== 'none')) {
                // intro.css прячет через display; если элемент занимает экран — прячем навигатор
                if (intro.offsetWidth > 100 && intro.offsetHeight > 100 && st.display !== 'none') return true;
            }
        }
    }
    return false;
}

export function setNavigatorEnabled(on) {
    enabled = !!on;
    if (!rootEl) ensureDom();
    if (rootEl) rootEl.classList.toggle('nav-off', !enabled);
    if (enabled) rebuild();
}

export function isNavigatorEnabled() {
    return !!enabled;
}

export function tickNavigator() {
    if (!enabled) {
        if (rootEl) rootEl.classList.add('nav-off');
        return;
    }
    if (gameChromeHidden()) {
        if (rootEl) rootEl.style.display = 'none';
        return;
    }
    if (rootEl) rootEl.style.display = '';
    const cur = currentBody();
    const cid = cur?.data?.id;
    if (cid != null && cid !== lastLocId) {
        lastLocId = cid;
        if (pinId == null) {
            const root = treeRootFor(cur);
            if (root && Number(focusId) !== Number(root.data.id)) {
                setFocus(root.data.id, true);
            }
        }
    }
    const focused = entryById(focusId);
    if (!focused) {
        pinId = null;
        const fb = homeFallback();
        if (fb) setFocus(fb.data.id, true);
        return;
    }
    // живое обновление: оптика / имена / состав детей
    const kidsAll = childrenOf(focused).filter(isNavListed);
    const sig = treeSignature(focused, kidsAll);
    if (sig !== lastSig) rebuild();
}

export function initNavigator(startEnabled = false) {
    enabled = !!startEnabled;
    ensureDom();
    rootEl.classList.toggle('nav-off', !enabled);
    pinId = null;
    try {
        const cur = window.__currentLocation || currentLocation;
        if (cur?.data?.id != null) focusId = treeRootFor(cur)?.data?.id ?? cur.data.id;
    } catch (_) {}
    if (enabled) rebuild();
    onLanguageChange(() => { if (enabled) rebuild(); });
}

export function refreshNavigator() {
    if (enabled) rebuild();
}
