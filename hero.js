
function applyHeroHeaderTip() {
    const frame = document.querySelector('.header-icon-frame');
    if (!frame) return;
    const tipFn = typeof tUi === 'function' ? tUi : (typeof t === 'function' ? t : null);
    const tip = tipFn ? (tipFn('header.heroTip') || 'Герой') : 'Герой';
    if (typeof window.setTip === 'function') window.setTip(frame, tip);
    else { frame.setAttribute('data-tip', tip); frame.removeAttribute('title'); }
}

/**
 * Окно управления героем: досье, экипировка, навыки, история поручений, почта.
 */
import { state } from './state.js';
import { getPlayerGender } from './quests.js';
import {
    getQuestChain,
    getQuestChainItem,
    bindQuestTimeModule
} from './quests.js';
import { isQuestCompleted, isChapter1Done } from './uiMasks.js';
import { getLang, onLanguageChange, t as tUi } from './settings.js';
import { startTime, formatTime } from './ui.js';

const BIRTH = new Date(1986, 3, 2); // 2 апреля 1986
let dossier = null;
let open = false;
let section = 'dossier'; // dossier | equipment | skills | quests | mail
let questFilter = 'main'; // main | side
let selectedQuestId = null;

function lang() {
    const L = getLang?.() || 'ru';
    return ['ru', 'en', 'de'].includes(L) ? L : 'ru';
}

function pick(obj, fallback = '') {
    if (!obj) return fallback;
    if (typeof obj === 'string') return obj;
    const L = lang();
    return obj[L] || obj.ru || obj.en || fallback;
}

function t(key) {
    const ui = dossier?.ui?.[key];
    return pick(ui, key);
}

export async function loadHeroDossier() {
    try {
        const res = await fetch('heroDossier.json');
        dossier = await res.json();
    } catch (e) {
        console.warn('heroDossier.json load failed', e);
        dossier = { meta: { birthDate: '1986-04-02' }, name: {}, bio: {}, ui: {} };
    }
    return dossier;
}

/**
 * Панель доступна после пролога / старта Главы 1:
 * — выбран пол, или
 * — QST_INTRO_001 в completed, или
 * — QST_INTRO_002/003 active|completed.
 */
export function isHeroPanelUnlocked() {
    try {
        const qs = state.quests || {};
        const active = qs.active || [];
        const completed = qs.completed || [];
        // пол выбран в прологе
        if (qs.playerGender === 'male' || qs.playerGender === 'female') return true;
        if (qs.flags && qs.flags.playerGenderSet) return true;
        if (completed.includes('QST_INTRO_001')) return true;
        if (active.includes('QST_INTRO_002') || completed.includes('QST_INTRO_002')) return true;
        if (active.includes('QST_INTRO_003') || completed.includes('QST_INTRO_003')) return true;
        if (typeof isQuestCompleted === 'function') {
            if (isQuestCompleted('QST_INTRO_001') || isQuestCompleted('QST_INTRO_002')) return true;
        }
        return false;
    } catch (_) {
        return false;
    }
}

function heroAvatarSrc() {
    const g = getPlayerGender();
    if (g === 'male') return 'assets/textures/icons/manhero.png';
    if (g === 'female') return 'assets/textures/icons/womanhero.png';
    return 'assets/textures/icons/gender_unknown.png';
}

function heroFullName() {
    const g = getPlayerGender();
    const names = dossier?.name || {};
    if (g === 'male') return pick(names.male, '—');
    if (g === 'female') return pick(names.female, '—');
    return pick(names.unknown, '—');
}

function calcAgeYears() {
    const now = startTime instanceof Date ? startTime : new Date(2108, 2, 30);
    let years = now.getFullYear() - BIRTH.getFullYear();
    const m = now.getMonth() - BIRTH.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < BIRTH.getDate())) years--;
    return Math.max(0, years);
}

function genderLabel() {
    const g = getPlayerGender();
    if (g === 'male') return t('gender.male');
    if (g === 'female') return t('gender.female');
    return t('gender.unknown');
}

export function isHeroPanelOpen() {
    return open;
}

export function closeHeroPanel(skipHeader = false) {
    open = false;
    const panel = document.getElementById('hero-panel');
    if (panel) {
        panel.classList.remove('open');
        panel.style.display = '';
        panel.style.pointerEvents = '';
    }
    if (!skipHeader) {
        try {
            import('./technologies.js').then(m => {
                if (!m.isTechPanelOpen?.()) m.setHeaderMode?.('map');
            }).catch(() => {});
        } catch (_) {}
    }
}

export function openHeroPanel() {
    if (!isHeroPanelUnlocked()) return false;
    open = true;
    // Наука / карта / кодекс: герой — единственный активный раздел
    try {
        import('./technologies.js').then(m => {
            if (m.isTechPanelOpen?.()) m.closeTechPanel?.();
            m.setHeaderMode?.('hero');
        }).catch(() => {});
        import('./codex.js').then(m => {
            if (m.isCodexPanelOpen?.()) m.closeCodexPanel?.(true);
        }).catch(() => {});
    } catch (_) {}
    const panel = document.getElementById('hero-panel');
    if (panel) {
        panel.classList.add('open');
        panel.style.display = 'block';
        panel.style.pointerEvents = 'auto';
    }
    renderHeroPanel();
    return true;
}

export function toggleHeroPanel() {
    if (open) {
        closeHeroPanel();
        return false;
    }
    return openHeroPanel();
}

function setSection(id) {
    if (id === 'equipment' || id === 'mail') return; // locked
    section = id;
    renderHeroPanel();
}

function fieldHtml(label, value) {
    return `<div class="hero-field"><span class="hero-field-label">${label}</span><span class="hero-field-value">${value}</span></div>`;
}

function renderDossierMid() {
    return `
        <img class="hero-avatar-lg" src="${heroAvatarSrc()}" alt="">
        <div class="hero-mid-data">
            ${fieldHtml(t('field.fio'), heroFullName())}
            ${fieldHtml(t('field.age'), `${calcAgeYears()} ${t('years')}`)}
            ${fieldHtml(t('field.gender'), genderLabel())}
        </div>`;
}

function renderDossierDeep() {
    return `
        <div class="hero-deep-title">${t('field.bio')}</div>
        <div class="hero-bio-text">${pick(dossier?.bio, '—')}</div>`;
}

function renderLockedMid() {
    return `
        <img class="hero-avatar-lg" src="${heroAvatarSrc()}" alt="">
        <div class="hero-empty">${t('locked')}</div>`;
}

function renderSkillsMid() {
    return `
        <img class="hero-avatar-lg" src="${heroAvatarSrc()}" alt="">
        <div class="hero-empty">${t('skills.empty')}</div>`;
}

function renderQuestsMid() {
    const mainActive = questFilter === 'main' ? 'active' : '';
    const sideActive = questFilter === 'side' ? 'active' : '';
    return `
        <div class="hero-quest-tabs hero-quest-tabs-stack">
            <button type="button" class="hero-quest-tab ${mainActive}" data-qfilter="main">${t('quests.main')}</button>
            <button type="button" class="hero-quest-tab ${sideActive}" data-qfilter="side">${t('quests.side')}</button>
        </div>`;
}

function formatStamp(stamp) {
    // маска времени до завершения главы I (как часы в хэдере)
    if (!isChapter1Done()) {
        return tUi('common.unknownLower') || 'неизвестно';
    }
    if (!stamp) return '—';
    if (stamp.label) return stamp.label;
    if (stamp.ms) {
        try { return formatTime(new Date(stamp.ms)); } catch (_) {}
    }
    return stamp.iso || '—';
}

function visibleQuestChain(filter) {
    // только взятые / завершённые / проваленные — без будущих (ещё не выданных)
    return getQuestChain(filter).filter(item =>
        item.status === 'active' || item.status === 'completed' || item.status === 'failed'
    );
}

function renderChainDeep() {
    if (questFilter === 'side') {
        return `
            <div class="hero-deep-title">${t('quests.chain')}</div>
            <div class="hero-side-stub">${t('quests.sideStub')}</div>`;
    }
    const chain = visibleQuestChain('main');
    if (!chain.length) {
        return `<div class="hero-deep-title">${t('quests.chain')}</div><div class="hero-empty">${t('quests.empty')}</div>`;
    }

    const nodes = chain.map(item => {
        let timeLine = '';
        if (item.status === 'completed' && item.completedAt) {
            timeLine = `${t('quests.completedAt')}: ${formatStamp(item.completedAt)}`;
        } else if (item.status === 'failed' && item.failedAt) {
            timeLine = `${t('quests.failedAt')}: ${formatStamp(item.failedAt)}`;
        } else {
            timeLine = `${t('quests.takenAt')}: ${formatStamp(item.activatedAt)}`;
        }
        const statusLabel = t(`quests.status.${item.status}`) || item.status;
        const objs = (item.objectives || []).map(o => {
            const cls = o.status === 'completed' ? 'done' : o.status === 'failed' ? 'fail' : 'pend';
            return `<li class="${cls}">${o.label || o.id}</li>`;
        }).join('');

        let failExtra = '';
        if (item.status === 'failed') {
            const fo = item.failedObjectives;
            const detail = !fo || fo === 'all'
                ? t('quests.failedAll')
                : (Array.isArray(fo) ? fo.join(', ') : String(fo));
            failExtra = `<div class="hero-chain-meta">${t('quests.failedObjectives')}: ${detail}</div>`;
        }

        return `
            <div class="hero-chain-node st-${item.status}" data-qid="${item.questId}">
                <div class="hero-chain-title">${item.title || item.questId}</div>
                <div class="hero-chain-meta">${statusLabel} · ${timeLine}</div>
                ${failExtra}
                <ul class="hero-chain-objs">${objs}</ul>
            </div>`;
    }).join('');

    return `
        <div class="hero-deep-title">${t('quests.chain')}</div>
        <div class="hero-chain">${nodes}</div>`;
}

export function renderHeroPanel() {
    const panel = document.getElementById('hero-panel');
    if (!panel || !open) return;

    const titleEl = panel.querySelector('.hero-panel-title');
    if (titleEl) titleEl.textContent = t('title');

    // nav active
    panel.querySelectorAll('.hero-nav-item').forEach(btn => {
        const id = btn.dataset.section;
        btn.classList.toggle('active', id === section);
        const labelKey = {
            dossier: 'section.dossier',
            equipment: 'section.equipment',
            skills: 'section.skills',
            quests: 'section.quests',
            mail: 'section.mail'
        }[id];
        if (labelKey) btn.textContent = t(labelKey);
    });

    const mid = panel.querySelector('.hero-mid');
    const deep = panel.querySelector('.hero-deep');
    if (!mid || !deep) return;

    if (section === 'dossier') {
        mid.innerHTML = renderDossierMid();
        deep.innerHTML = renderDossierDeep();
    } else if (section === 'equipment' || section === 'mail') {
        mid.innerHTML = renderLockedMid();
        deep.innerHTML = `<div class="hero-empty">${t('locked')}</div>`;
    } else if (section === 'skills') {
        mid.innerHTML = renderSkillsMid();
        deep.innerHTML = `<div class="hero-empty">${t('skills.empty')}</div>`;
    } else if (section === 'quests') {
        mid.innerHTML = renderQuestsMid();
        deep.innerHTML = renderChainDeep();
        mid.querySelectorAll('[data-qfilter]').forEach(btn => {
            btn.addEventListener('click', () => {
                questFilter = btn.dataset.qfilter;
                selectedQuestId = null;
                renderHeroPanel();
            });
        });
        mid.querySelectorAll('[data-qid]').forEach(el => {
            el.addEventListener('click', () => {
                selectedQuestId = el.dataset.qid;
                renderHeroPanel();
            });
        });
    }
}

export function initHeroUI() {
    try { applyHeroHeaderTip(); } catch (_) {}

    bindQuestTimeModule({ startTime, formatTime });

    const panel = document.getElementById('hero-panel');
    if (!panel) {
        console.warn('[hero] #hero-panel not in DOM');
        return;
    }

    panel.querySelector('.hero-panel-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeHeroPanel();
    });
    panel.querySelector('.hero-panel-backdrop')?.addEventListener('click', () => closeHeroPanel());

    panel.querySelectorAll('.hero-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.section;
            if (btn.classList.contains('locked')) return;
            setSection(id);
        });
    });

    // делегирование: клик по рамке аватарки в хэдере (надёжнее прямого listener)
    if (!document.body.dataset.heroAvatarBound) {
        document.body.dataset.heroAvatarBound = '1';
        document.addEventListener('click', (e) => {
            const frame = e.target && e.target.closest && e.target.closest('#header-left .header-icon-frame, .header-icon-frame');
            if (!frame) return;
            // только в игровом хэдере
            if (!frame.closest('#header')) return;
            e.preventDefault();
            e.stopPropagation();
            if (!isHeroPanelUnlocked()) {
                console.debug('[hero] locked', {
                    gender: state.quests?.playerGender,
                    active: state.quests?.active,
                    completed: state.quests?.completed
                });
                return;
            }
            toggleHeroPanel();
        }, true); // capture — раньше других обработчиков
    }

    const frame = document.querySelector('#header-left .header-icon-frame');
    if (frame) {
        frame.style.cursor = 'pointer';
        frame.style.pointerEvents = 'auto';
        frame.setAttribute('role', 'button');
        if (typeof window.setTip === 'function') {
            window.setTip(frame, (typeof tUi === 'function' ? tUi('header.heroTip') : null) || 'Герой');
        } else {
            frame.setAttribute('data-tip', (typeof tUi === 'function' ? tUi('header.heroTip') : null) || 'Герой');
            frame.removeAttribute('title');
        }
    }

    onLanguageChange?.(() => {
        try { applyHeroHeaderTip(); } catch (_) {}
        if (open) renderHeroPanel();
    });

    console.debug('[hero] UI ready, unlocked=', isHeroPanelUnlocked());
}

/** Обновить панель если открыта (после тика квестов) */
export function tickHeroUI() {
    if (open) renderHeroPanel();
}
