/**
 * technologiesGraph.js — SVG-графы (связи) дерева технологий.
 * Крепление: левый/правый бок карточек. Состояния: locked / active / boost.
 */

import {
    techById,
    isTechRevealed,
    ensureTechProgress,
    getTechCatalog
} from './technologies.js';

/**
 * Собрать уникальные рёбра parent→child внутри текущего набора карточек.
 * Источники: unlocks, prerequisites, requirements.unlockParents.
 */
function collectEdges(techs) {
    const byId = new Map(techs.map(t => [t.id, t]));
    const edges = new Map(); // key "from>to" -> { fromId, toId }

    const add = (fromId, toId) => {
        if (!fromId || !toId || fromId === toId) return;
        if (!byId.has(toId)) return;
        // родитель может быть вне текущей категории — ребро рисуем только если оба на экране
        if (!byId.has(fromId)) return;
        const key = `${fromId}>${toId}`;
        if (!edges.has(key)) edges.set(key, { fromId, toId });
    };

    for (const tech of techs) {
        for (const pid of (tech.prerequisites || [])) add(pid, tech.id);
        const ups = tech.requirements?.unlockParents;
        if (Array.isArray(ups)) {
            for (const u of ups) add(u.techId || u.id, tech.id);
        }
        for (const cid of (tech.unlocks || [])) add(tech.id, cid);
    }

    // обратный проход по каталогу: дети, у которых родитель в текущем наборе
    const catalog = getTechCatalog()?.technologies || [];
    for (const child of catalog) {
        if (!byId.has(child.id)) continue;
        for (const pid of (child.prerequisites || [])) add(pid, child.id);
        const ups = child.requirements?.unlockParents;
        if (Array.isArray(ups)) {
            for (const u of ups) add(u.techId || u.id, child.id);
        }
    }
    for (const parent of techs) {
        for (const cid of (parent.unlocks || [])) add(parent.id, cid);
    }

    return [...edges.values()];
}

/** Состояние ребра */
function edgeState(fromId, toId) {
    const childRevealed = isTechRevealed(toId);
    const parentRes = !!ensureTechProgress(fromId)?.researching;
    const childRes = !!ensureTechProgress(toId)?.researching;

    if (!childRevealed) {
        // заблокированный ребёнок
        if (parentRes) return 'boost';
        return 'locked';
    }
    // ребёнок открыт
    if (parentRes || childRes) return 'boost';
    return 'active';
}

/**
 * Якоря на левом/правом боку.
 * Несколько рёбер от одной карточки слегка разводим по вертикали.
 */
function anchors(from, to, w, h, slotFrom, slotTo, slotsFromCount, slotsToCount) {
    const spread = Math.min(h * 0.32, 18);
    const fromOff = slotsFromCount > 1
        ? ((slotFrom / (slotsFromCount - 1)) - 0.5) * 2 * spread
        : 0;
    const toOff = slotsToCount > 1
        ? ((slotTo / (slotsToCount - 1)) - 0.5) * 2 * spread
        : 0;

    const fc = { x: from.x + w / 2, y: from.y + h / 2 };
    const tc = { x: to.x + w / 2, y: to.y + h / 2 };
    const dx = tc.x - fc.x;

    let x1, y1, x2, y2, dir;
    if (Math.abs(dx) < 12) {
        // почти одна колонка — выходим вправо у обоих, дуга снаружи
        x1 = from.x + w;
        y1 = from.y + h / 2 + fromOff;
        x2 = to.x + w;
        y2 = to.y + h / 2 + toOff;
        dir = 'vertical-right';
    } else if (dx > 0) {
        // ребёнок справа: parent RIGHT → child LEFT
        x1 = from.x + w;
        y1 = from.y + h / 2 + fromOff;
        x2 = to.x;
        y2 = to.y + h / 2 + toOff;
        dir = 'ltr';
    } else {
        // ребёнок слева: parent LEFT → child RIGHT
        x1 = from.x;
        y1 = from.y + h / 2 + fromOff;
        x2 = to.x + w;
        y2 = to.y + h / 2 + toOff;
        dir = 'rtl';
    }
    return { x1, y1, x2, y2, dir };
}

/** Кубическая кривая Безье без артефактов на острых углах */
function pathD(a) {
    const { x1, y1, x2, y2, dir } = a;
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);

    if (dir === 'vertical-right') {
        const bulge = Math.max(48, dy * 0.15 + 36);
        return `M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2} ${y2}`;
    }

    // горизонтальный развод: контроль по X, Y фиксируем у концов → гладкий S/C
    const c = Math.max(40, dx * 0.42);
    if (dir === 'ltr') {
        return `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
    }
    return `M ${x1} ${y1} C ${x1 - c} ${y1}, ${x2 + c} ${y2}, ${x2} ${y2}`;
}

/**
 * Построить SVG графа.
 * @param {object[]} techs
 * @param {Map} techPos id -> {x,y}
 * @param {number} worldW
 * @param {number} worldH
 * @param {{ w:number, h:number }} card
 */
export function buildTechLinksSvg(techs, techPos, worldW, worldH, card) {
    const w = card?.w || 132;
    const h = card?.h || 148;
    const edgeList = collectEdges(techs);
    if (!edgeList.length) return '';

    // слоты на каждой карточке: исходящие / входящие
    const outSlots = new Map(); // id -> [toId,...]
    const inSlots = new Map();
    for (const e of edgeList) {
        if (!outSlots.has(e.fromId)) outSlots.set(e.fromId, []);
        outSlots.get(e.fromId).push(e.toId);
        if (!inSlots.has(e.toId)) inSlots.set(e.toId, []);
        inSlots.get(e.toId).push(e.fromId);
    }
    // стабильный порядок по Y цели/источника
    for (const [id, arr] of outSlots) {
        arr.sort((a, b) => {
            const pa = techPos.get(a)?.y ?? 0;
            const pb = techPos.get(b)?.y ?? 0;
            return pa - pb || String(a).localeCompare(b);
        });
    }
    for (const [id, arr] of inSlots) {
        arr.sort((a, b) => {
            const pa = techPos.get(a)?.y ?? 0;
            const pb = techPos.get(b)?.y ?? 0;
            return pa - pb || String(a).localeCompare(b);
        });
    }

    const parts = [];
    // defs: градиенты + маркеры (один раз)
    parts.push(`<defs>
        <linearGradient id="tech-link-grad-active" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="rgba(40,160,200,0.35)"/>
            <stop offset="50%" stop-color="rgba(80,210,230,0.75)"/>
            <stop offset="100%" stop-color="rgba(40,160,200,0.35)"/>
        </linearGradient>
        <linearGradient id="tech-link-grad-boost" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="rgba(40,200,255,0.55)"/>
            <stop offset="50%" stop-color="rgba(120,255,240,0.95)"/>
            <stop offset="100%" stop-color="rgba(40,200,255,0.55)"/>
        </linearGradient>
        <filter id="tech-link-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="tech-link-glow-strong" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="3.4" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
    </defs>`);

    for (const e of edgeList) {
        const from = techPos.get(e.fromId);
        const to = techPos.get(e.toId);
        if (!from || !to) continue;

        const outs = outSlots.get(e.fromId) || [e.toId];
        const ins = inSlots.get(e.toId) || [e.fromId];
        const slotFrom = Math.max(0, outs.indexOf(e.toId));
        const slotTo = Math.max(0, ins.indexOf(e.fromId));

        const a = anchors(from, to, w, h, slotFrom, slotTo, outs.length, ins.length);
        const d = pathD(a);
        const state = edgeState(e.fromId, e.toId);
        const lenApprox = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) + 80;

        // подложка (толще, мягче) + основной штрих + «конвейер» dash
        parts.push(`<g class="tech-link tech-link--${state}" data-from="${e.fromId}" data-to="${e.toId}">
            <path class="tech-link-base" d="${d}" fill="none"/>
            <path class="tech-link-core" d="${d}" fill="none"/>
            <path class="tech-link-flow" d="${d}" fill="none" pathLength="100" style="--flow-len:${Math.round(lenApprox)}"/>
        </g>`);
    }

    return `<svg class="tech-links" width="${worldW}" height="${worldH}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

/**
 * Обновить классы состояния рёбер без пересборки SVG (каждый тик).
 * @param {HTMLElement|null} worldEl #tech-tree-world
 */
export function refreshTechLinkStates(worldEl) {
    if (!worldEl) return;
    const groups = worldEl.querySelectorAll('.tech-link[data-from][data-to]');
    if (!groups.length) return;
    for (const g of groups) {
        const fromId = g.dataset.from;
        const toId = g.dataset.to;
        const st = edgeState(fromId, toId);
        const want = `tech-link tech-link--${st}`;
        if (g.className.baseVal !== undefined) {
            // SVG element
            if (g.getAttribute('class') !== want) g.setAttribute('class', want);
        } else if (g.className !== want) {
            g.className = want;
        }
    }
}
