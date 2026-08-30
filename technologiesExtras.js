/**
 * technologiesExtras.js — активные исследования (хэдер панели) +
 * характеристики технологии (нижний правый блок модалки).
 * Не дублирует core-логику из technologies.js.
 */

import {
    techById,
    getTechLevel,
    ensureTechProgress,
    getLevelCost,
    isTechRevealed,
    navigateToTech,
    listResearchingTechIds
} from './technologies.js';
import { t, getLang } from './settings.js';

let futurePreview = false; // hover на «Улучшить»
let lastActiveSig = '';
let lastStatsSig = '';
let bound = false;

function pick(obj, fallback = '') {
    if (!obj || typeof obj !== 'object') return fallback;
    const lang = (typeof getLang === 'function' ? getLang() : null) || 'ru';
    return obj[lang] || obj.ru || obj.en || obj.de || fallback;
}

function fmtStat(v, unit) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    let s;
    if (Math.abs(n) >= 100) s = String(Math.round(n));
    else if (Math.abs(n) >= 10) s = (Math.round(n * 10) / 10).toString();
    else s = (Math.round(n * 100) / 100).toString();
    return unit ? `${s} ${unit}` : s;
}

/** Значение характеристики на уровне (values[level]) */
function statAt(stat, level) {
    const vals = Array.isArray(stat.values) ? stat.values : [];
    if (!vals.length) return null;
    const i = Math.max(0, Math.min(level, vals.length - 1));
    const v = Number(vals[i]);
    return Number.isFinite(v) ? v : null;
}

export function setTechFuturePreview(on) {
    futurePreview = !!on;
    // немедленный refresh stats
    const id = document.getElementById('tech-detail-modal')?.dataset?.techId
        || window.__techSelectedId;
    // selected id передаётся через DOM data на модалке
    const modal = document.getElementById('tech-detail-modal');
    const techId = modal?.dataset?.selectedTechId;
    if (techId) renderTechStats(techById(techId), true);
    else renderTechStats(null, true);
}

export function initTechExtras() {
    if (bound) return;
    bound = true;
    const host = document.getElementById('tech-active-research');
    if (host && host.dataset.bound !== '1') {
        host.dataset.bound = '1';
        host.addEventListener('click', (e) => {
            const card = e.target.closest('[data-active-tech]');
            if (!card) return;
            e.preventDefault();
            e.stopPropagation();
            const id = card.dataset.activeTech;
            if (id && isTechRevealed(id)) navigateToTech(id);
        });
    }
    renderActiveResearch();
}

export function refreshTechExtras() {
    lastActiveSig = '';
    lastStatsSig = '';
    renderActiveResearch();
    const modal = document.getElementById('tech-detail-modal');
    const techId = modal?.dataset?.selectedTechId;
    if (techId) renderTechStats(techById(techId), true);
}

export function tickTechExtras(_dt, ctx = {}) {
    if (!ctx.open) {
        // панель закрыта — можно не трогать
        return;
    }
    renderActiveResearch();
    if (ctx.detailOpen && ctx.selectedTechId) {
        const modal = document.getElementById('tech-detail-modal');
        if (modal) modal.dataset.selectedTechId = ctx.selectedTechId;
        renderTechStats(techById(ctx.selectedTechId), false);
    }
}

/* ========== Активные исследования (хэдер) ========== */

function renderActiveResearch() {
    const host = document.getElementById('tech-active-research');
    if (!host) return;

    const ids = listResearchingTechIds();
    const rows = [];
    for (const id of ids) {
        const tech = techById(id);
        if (!tech || !isTechRevealed(tech)) continue;
        const p = ensureTechProgress(id);
        const level = p.level || 0;
        const maxL = Math.max(0, Number(tech.maxLevel) || 0);
        if (level >= maxL) continue;
        const cost = getLevelCost(tech, level);
        const invested = Number(p.invested) || 0;
        const pct = cost > 0 ? Math.min(100, Math.max(0, (invested / cost) * 100)) : 0;
        rows.push({
            id,
            name: pick(tech.name, id),
            image: tech.image || '',
            from: level,
            to: level + 1,
            pct: Math.round(pct)
        });
    }

    const sig = JSON.stringify(rows);
    if (sig === lastActiveSig) return;
    lastActiveSig = sig;

    if (!rows.length) {
        host.innerHTML = '';
        host.hidden = true;
        return;
    }
    host.hidden = false;
    host.innerHTML = rows.map(r => {
        const img = r.image
            ? `style="background-image:url('${r.image}')"`
            : '';
        return `<button type="button" class="tech-active-card" data-active-tech="${r.id}" title="${r.name}">
            <div class="tech-active-card-img" ${img}></div>
            <div class="tech-active-card-body">
                <div class="tech-active-card-name">${r.name}</div>
                <div class="tech-active-card-meta">
                    <span class="tech-active-card-lvl">${t('techTree.levelShort') || 'Ур.'} ${r.from} &gt; ${r.to}</span>
                    <span class="tech-active-card-pct">[${r.pct}/100%]</span>
                </div>
            </div>
        </button>`;
    }).join('');
}

/* ========== Характеристики в модалке ========== */

function renderTechStats(tech, force = false) {
    const box = document.getElementById('tech-detail-stats');
    const list = document.getElementById('tech-detail-stats-list');
    const title = document.getElementById('tech-detail-stats-title');
    if (!box || !list) return;

    if (title) {
        title.textContent = t('techTree.statsTitle') || 'Характеристики технологии:';
    }

    if (!tech || !isTechRevealed(tech)) {
        box.hidden = true;
        list.innerHTML = '';
        lastStatsSig = '';
        return;
    }

    const stats = Array.isArray(tech.stats) ? tech.stats : [];
    if (!stats.length) {
        box.hidden = true;
        list.innerHTML = '';
        lastStatsSig = '';
        return;
    }

    box.hidden = false;
    const p = ensureTechProgress(tech.id);
    const level = p.level || 0;
    const maxL = Math.max(0, Number(tech.maxLevel) || 0);
    const atMax = level >= maxL;
    const researching = !!p.researching && !atMax;
    const showFuture = !atMax && (futurePreview || researching);

    const sig = JSON.stringify({
        id: tech.id,
        level,
        showFuture,
        futurePreview,
        researching,
        stats: stats.map(s => [s.id, statAt(s, level), showFuture ? statAt(s, level + 1) : null])
    });
    if (!force && sig === lastStatsSig) return;
    lastStatsSig = sig;

    list.innerHTML = stats.map(stat => {
        const name = pick(stat.name, stat.id);
        const unit = pick(stat.unit, '') || (typeof stat.unit === 'string' ? stat.unit : '');
        const cur = statAt(stat, level);
        const next = showFuture ? statAt(stat, level + 1) : null;
        const pol = (stat.polarity === 'negative') ? 'neg' : 'pos';
        const tri = showFuture && next != null
            ? `<span class="tech-stat-tri ${pol}" aria-hidden="true">${pol === 'neg' ? '▼' : '▲'}</span>`
            : '';
        const futureHtml = showFuture && next != null
            ? `<span class="tech-stat-future">${tri}${fmtStat(next, unit)}</span>`
            : `<span class="tech-stat-future is-empty"></span>`;
        return `<div class="tech-stat-row" data-stat-id="${stat.id}">
            <span class="tech-stat-name">${name}</span>
            <span class="tech-stat-cur">${fmtStat(cur, unit)}</span>
            ${futureHtml}
        </div>`;
    }).join('');
}
