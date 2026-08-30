
/**
 * Контент пишем во внутренний слой firmScroll (если уже есть),
 * иначе — в сам host. После innerHTML треки сносятся → всегда
 * переподключаем firmScroll.
 */
function setScrollableHtml(host, html) {
    if (!host) return;
    const inner = host.querySelector(':scope > .firm-scroll-inner');
    if (inner) inner.innerHTML = html;
    else host.innerHTML = html;
}

function attachVhScroll(host) {
    if (!host) return;
    host.classList.add('vh-firm-scroll');
    // сброс флага — после замены HTML прежний attach мёртв
    host.dataset.firmScroll = '0';
    // убрать осиротевшие треки от прошлого attach
    host.querySelectorAll(':scope > .firm-scroll-track').forEach(t => t.remove());
    try {
        attachFirmScroll(host, { axis: 'y', host: 'self', fillHost: true, mirrorV: true });
        host.dataset.firmScroll = '1';
    } catch (e) {
        console.warn('vh firmScroll', e);
    }
    // после layout пересчитать бегунок
    requestAnimationFrame(() => {
        try { updateFirmScroll(host); } catch (_) {}
        requestAnimationFrame(() => {
            try { updateFirmScroll(host); } catch (_) {}
        });
    });
}

function ensureVhFirmScroll() {
    attachVhScroll(document.getElementById('vh-preview-body'));
    attachVhScroll(document.getElementById('vh-history-list'));
}

/**
 * Соцсети (левый низ) + кнопка сборок / превью / история версий.
 */
import { t, getLang, onLanguageChange, locName } from './settings.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';

let versionData = null;
let historyOpen = false;
let historyPage = 0;
const PAGE_SIZE = 4;

const TYPE_I18N = {
    patch: 'version.type.patch',
    update: 'version.type.update',
    major: 'version.type.major'
};

export async function loadVersionHistory() {
    try {
        const res = await fetch('versionHistory.json');
        versionData = await res.json();
        console.log('Version history loaded:', versionData?.builds?.length, 'builds');
    } catch (e) {
        console.error('Failed to load versionHistory.json', e);
        versionData = {
            meta: { currentBuild: '0.0.0', previewAvatar: 'assets/textures/npc/seleznev.png' },
            typeImages: {},
            builds: []
        };
    }
    return versionData;
}

function currentBuild() {
    return versionData?.meta?.currentBuild || versionData?.builds?.[0]?.build || '—';
}

function latestBuild() {
    return (versionData?.builds || [])[0] || null;
}

function typeLabel(type) {
    return t(TYPE_I18N[type] || 'version.type.update');
}

function typeClass(type) {
    if (type === 'major') return 'vh-type-major';
    if (type === 'patch') return 'vh-type-patch';
    return 'vh-type-update';
}

function formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-');
    const lang = getLang();
    if (lang === 'en') return `${m}/${d}/${y}`;
    if (lang === 'de') return `${d}.${m}.${y}`;
    return `${d}.${m}.${y}`;
}

function typeImage(type) {
    const map = versionData?.typeImages || {};
    return map[type] || map.update || 'assets/textures/icons/version_update.png';
}

/** compact=true — превью (иконка типа в рамке); иначе — полная история */
function entryHtml(build, compact = false) {
    if (!build) return '';
    const title = locName(build.title, build.build);
    const desc = locName(build.description, '');
    const type = build.type || 'update';
    const img = build.image || typeImage(type);
    return `
    <div class="vh-entry${compact ? ' vh-entry-compact' : ''}">
      <div class="vh-entry-top">
        <div class="vh-entry-image" style="--vh-img:url('${img}')"></div>
        <div class="vh-entry-meta">
          <div class="vh-entry-type ${typeClass(type)}">
            <span class="vh-entry-type-label">${t('version.typeLabel')}</span>
            <span class="vh-entry-type-value">${typeLabel(type)}</span>
          </div>
          <div class="vh-entry-title">${title}</div>
          <div class="vh-entry-build">${t('version.build')}: ${build.build}</div>
          <div class="vh-entry-date">${t('version.date')}: ${formatDate(build.date)}</div>
        </div>
      </div>
      ${desc ? `<div class="vh-entry-desc">${desc}</div>` : ''}
    </div>`;
}

function refreshPreview() {
    const body = document.getElementById('vh-preview-body');
    const avatar = document.getElementById('vh-preview-avatar');
    if (!body) return;
    const latest = latestBuild();
    const html = latest
        ? entryHtml(latest, true)
        : `<div class="vh-empty">${t('version.empty')}</div>`;
    setScrollableHtml(body, html);
    if (avatar) {
        avatar.src = versionData?.meta?.previewAvatar || 'assets/textures/npc/seleznev.png';
    }
    attachVhScroll(body);
}

function refreshBuildButton() {
    const num = document.getElementById('vh-build-number');
    if (num) num.textContent = currentBuild();
}

function refreshHistoryModal() {
    const list = document.getElementById('vh-history-list');
    const pageInfo = document.getElementById('vh-page-info');
    const prev = document.getElementById('vh-page-prev');
    const next = document.getElementById('vh-page-next');
    if (!list) return;

    const builds = versionData?.builds || [];
    const totalPages = Math.max(1, Math.ceil(builds.length / PAGE_SIZE));
    if (historyPage >= totalPages) historyPage = totalPages - 1;
    if (historyPage < 0) historyPage = 0;

    const slice = builds.slice(historyPage * PAGE_SIZE, historyPage * PAGE_SIZE + PAGE_SIZE);
    const listHtml = slice.map(b => entryHtml(b, false)).join('')
        || `<div class="vh-empty">${t('version.empty')}</div>`;
        setScrollableHtml(list, listHtml);
        attachVhScroll(list);
    if (pageInfo) pageInfo.textContent = `${historyPage + 1} / ${totalPages}`;
    if (prev) prev.disabled = historyPage <= 0;
    if (next) next.disabled = historyPage >= totalPages - 1;
}

export function openVersionHistory() {
    const modal = document.getElementById('vh-history-modal');
    if (!modal) return;
    historyOpen = true;
    historyPage = 0;
    refreshHistoryModal();
    modal.style.display = 'flex';
    document.getElementById('vh-build-btn')?.classList.add('active');
}

export function closeVersionHistory() {
    const modal = document.getElementById('vh-history-modal');
    if (modal) modal.style.display = 'none';
    historyOpen = false;
    document.getElementById('vh-build-btn')?.classList.remove('active');
}

/** Скрыть кнопку сборок при открытом большом NPC-диалоге */
export function setVersionButtonVisible(visible) {
    const btn = document.getElementById('vh-build-btn');
    if (btn) btn.style.display = visible ? '' : 'none';
    syncMenuOnlyUi();
}

export function refreshVersionVisibility() {
    const npc = document.getElementById('npc-dialogue-panel');
    const npcOpen = npc && npc.style.display !== 'none' && npc.style.display !== '';
    // если display:flex — открыто
    const open = npc && getComputedStyle(npc).display !== 'none';
    setVersionButtonVisible(!open);
}

function syncMenuOnlyUi() {
    const inMenu = document.body.classList.contains('main-menu-active');
    const social = document.getElementById('social-panel');
    const previewWrap = document.getElementById('vh-preview-wrap');
    const btn = document.getElementById('vh-build-btn');
    const btnHidden = btn && btn.style.display === 'none';

    if (social) social.style.display = inMenu ? '' : 'none';
    if (previewWrap) previewWrap.style.display = (inMenu && !btnHidden) ? '' : 'none';
}

export function initVersionHistoryUI() {
    refreshBuildButton();
    refreshPreview();
    syncMenuOnlyUi();

    document.getElementById('vh-build-btn')?.addEventListener('click', () => {
        if (historyOpen) closeVersionHistory();
        else openVersionHistory();
    });
    document.getElementById('vh-history-close')?.addEventListener('click', closeVersionHistory);
    document.getElementById('vh-page-prev')?.addEventListener('click', () => {
        historyPage -= 1;
        refreshHistoryModal();
    });
    document.getElementById('vh-page-next')?.addEventListener('click', () => {
        historyPage += 1;
        refreshHistoryModal();
    });

    // клик по фону модалки — закрыть
    document.getElementById('vh-history-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'vh-history-modal') closeVersionHistory();
    });

    onLanguageChange(() => {
        refreshBuildButton();
        refreshPreview();
        if (historyOpen) refreshHistoryModal();
    });

    // следим за сменой класса меню
    const obs = new MutationObserver(() => syncMenuOnlyUi());
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
