/**
 * Система подсказок: ^^текст^^ [[hintId]]
 * Подсветка через отдельный overlay — без scrollIntoView, без снятия clip-path
 * (чтобы карта/UI не прыгали).
 */
import { currentLocation } from './camera.js';
import { updateBodyMenu } from './ui.js';
import { showSpecialistsPanel } from './specialistsUI.js';

let activeOverlay = null; // HTMLElement
let activeTargetEl = null;
let activeHintId = null;

const POPUP_RELATED_HINTS = new Set([
    'population',
    'population-section',
    'resource-popup',
    'population-popup'
]);

function closeResourcePopup() {
    const popup = document.getElementById('resource-popup');
    if (popup) popup.style.display = 'none';
    document.querySelectorAll('.resource-container.active').forEach(c => c.classList.remove('active'));
}

function openPopulationPopup() {
    const el = document.querySelector('.resource-container[data-resource-id="Население"]');
    if (!el) return;
    if (!el.classList.contains('active')) el.click();
}

function isBuildingModalOpen() {
    const modal = document.getElementById('building-modal');
    return !!(modal && getComputedStyle(modal).display !== 'none');
}

function ensureBuildingModalOpen() {
    if (isBuildingModalOpen()) return true;
    const item = document.querySelector('.building-item[data-building-id="CONSTRC001"]');
    if (item) {
        // клик по уже активной карточке закрывает модалку — сначала снимем active
        if (item.classList.contains('active')) item.classList.replace('active', 'inactive');
        item.click();
    }
    return false;
}

function clickIfEnabled(sel) {
    const el = document.querySelector(sel);
    if (!el) return;
    if (el.classList.contains('locked')) return;
    el.click();
}

/** Строительство → Наземное → Инфраструктура → База Космистов, затем callback.
 *  Не закрывает уже открытую модалку базы (повторный клик по активной карточке — toggle). */
function openCosmistsBaseThen(thenFn) {
    clickIfEnabled('#MB3');
    setTimeout(() => {
        clickIfEnabled('#MC3');
        setTimeout(() => {
            clickIfEnabled('#COP01');
            setTimeout(() => {
                const item = document.querySelector('.building-item[data-building-id="CONSTRC001"]');
                if (item) {
                    const alreadyOpen = item.classList.contains('active') && isBuildingModalOpen();
                    if (!alreadyOpen) {
                        if (item.classList.contains('active')) {
                            item.classList.replace('active', 'inactive');
                        }
                        item.click();
                    }
                } else {
                    ensureBuildingModalOpen();
                }
                if (typeof thenFn === 'function') {
                    setTimeout(thenFn, 80);
                }
            }, 60);
        }, 40);
    }, 50);
}

const HINT_TARGETS = {
    'resource-bar': { selector: '#resource-bar' },
    'population': {
        selector: '#resource-popup',
        relatedPopup: true,
        open: () => openPopulationPopup()
    },
    'population-section': {
        selector: '#resource-popup',
        relatedPopup: true,
        open: () => openPopulationPopup()
    },
    'resource-popup': {
        selector: '#resource-popup',
        relatedPopup: true,
        open: () => openPopulationPopup()
    },
    'population-popup': {
        selector: '#resource-popup',
        relatedPopup: true,
        open: () => openPopulationPopup()
    },

    'body-menu': { selector: '#body-control-menu' },
    'menu-general': { selector: '#MB1', open: () => clickIfEnabled('#MB1') },
    'submenu-cartography': {
        selector: '#MAC',
        altSelectors: ['#cartography-panel', '#cartography-map-host'],
        open: () => {
            clickIfEnabled('#MB1');
            setTimeout(() => clickIfEnabled('#MAC'), 50);
        }
    },
    'cartography-panel': {
        selector: '#cartography-panel',
        altSelectors: ['#MAC'],
        open: () => {
            clickIfEnabled('#MB1');
            setTimeout(() => clickIfEnabled('#MAC'), 50);
        }
    },
    'menu-manage': { selector: '#MB2', open: () => clickIfEnabled('#MB2') },
    'menu-build': { selector: '#MB3', open: () => clickIfEnabled('#MB3') },
    'menu-technoport': { selector: '#MB4', open: () => clickIfEnabled('#MB4') },

    'specialists-panel': {
        selector: '#specialists-panel',
        open: () => {
            clickIfEnabled('#MB2');
            setTimeout(() => {
                clickIfEnabled('#MB2_1');
                showSpecialistsPanel(true);
                if (currentLocation) updateBodyMenu(currentLocation);
            }, 50);
        }
    },
    'spec-slider-engineers': {
        selector: '#spec-slider-engineers',
        open: () => {
            clickIfEnabled('#MB2');
            setTimeout(() => {
                clickIfEnabled('#MB2_1');
                showSpecialistsPanel(true);
            }, 50);
        }
    },

    'submenu-ground': {
        selector: '#MC3',
        open: () => {
            clickIfEnabled('#MB3');
            setTimeout(() => clickIfEnabled('#MC3'), 50);
        }
    },
    'building-category-infra': {
        selector: '#COP01',
        open: () => {
            clickIfEnabled('#MB3');
            setTimeout(() => {
                clickIfEnabled('#MC3');
                setTimeout(() => clickIfEnabled('#COP01'), 40);
            }, 50);
        }
    },
    'building-base': {
        selector: '.building-item[data-building-id="CONSTRC001"]',
        open: () => openCosmistsBaseThen(null)
    },
    'building-modal': {
        selector: '#building-modal',
        open: () => ensureBuildingModalOpen()
    },
    'modal-tab-main': {
        selector: '#modal-tab-main',
        open: () => {
            ensureBuildingModalOpen();
            setTimeout(() => clickIfEnabled('#modal-tab-main'), 80);
        }
    },
    'modal-tab-schemes': {
        selector: '#modal-tab-schemes',
        altSelectors: ['#schemes-panel'],
        open: () => openCosmistsBaseThen(() => {
            clickIfEnabled('#modal-tab-schemes');
            setTimeout(() => clickIfEnabled('#modal-tab-schemes'), 120);
        })
    },
    'schemes-panel': {
        selector: '#schemes-panel',
        altSelectors: ['#modal-tab-schemes'],
        open: () => openCosmistsBaseThen(() => {
            clickIfEnabled('#modal-tab-schemes');
            setTimeout(() => clickIfEnabled('#modal-tab-schemes'), 120);
        })
    },
    'recipe-photosynthesis': {
        // несколько возможных селекторов (карточка / рычаг)
        selector: '.recipe-card[data-recipe-id="RCP_PHOTOSYNTHESIS"]',
        altSelectors: [
            '[data-recipe-id="RCP_PHOTOSYNTHESIS"].recipe-card',
            '[data-recipe-id="RCP_PHOTOSYNTHESIS"]'
        ],
        open: () => openCosmistsBaseThen(() => clickIfEnabled('#modal-tab-schemes'))
    }
};

export function renderHintMarkup(text) {
    if (text == null) return '';
    let s = String(text);
    // Курсив: *^** текст **^*  (экранирование задаёт автор квеста)
    s = s.replace(/\*\^\*\*([\s\S]+?)\*\*\^\*/g, (_, inner) => {
        return `<em class="quest-em">${escapeHtml(inner.trim())}</em>`;
    });
    // Подсказки: ^^подпись^^ [[hintId]]
    s = s.replace(/\^\^([\s\S]+?)\^\^\s*\[\[([^\]]+)\]\]/g, (_, label, hintId) => {
        const safeLabel = escapeHtml(label.trim());
        const safeId = escapeHtml(hintId.trim());
        return `<span class="quest-hint-link" data-hint-id="${safeId}" tabindex="0">${safeLabel}</span>`;
    });
    return s;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function resolveTarget(hintId) {
    if (HINT_TARGETS[hintId]) return HINT_TARGETS[hintId];
    if (hintId.startsWith('#') || hintId.startsWith('.') || hintId.startsWith('[')) {
        return { selector: hintId };
    }
    return { selector: `#${hintId}` };
}

function findElement(target) {
    if (!target) return null;
    let el = document.querySelector(target.selector);
    if (el && isEffectivelyVisible(el)) return el;
    if (target.altSelectors) {
        for (const sel of target.altSelectors) {
            el = document.querySelector(sel);
            if (el && isEffectivelyVisible(el)) return el;
        }
    }
    // последний шанс — элемент есть, но ещё display:none (ждём open)
    el = document.querySelector(target.selector);
    return el || null;
}

function isEffectivelyVisible(el) {
    if (!el) return false;
    let p = el;
    while (p && p !== document.body) {
        const st = getComputedStyle(p);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        p = p.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

function clearHighlight() {
    if (activeOverlay) {
        activeOverlay.remove();
        activeOverlay = null;
    }
    activeTargetEl = null;
    // activeHintId не сбрасываем здесь всегда — deactivate сбрасывает
}

function positionOverlay(el) {
    if (!activeOverlay || !el) return;
    const r = el.getBoundingClientRect();
    // fixed overlay строго внутри viewport — без отрицательных left/top (иначе появляется гориз. скролл и UI «уездает»)
    const left = Math.max(0, Math.round(r.left) - 1);
    const top = Math.max(0, Math.round(r.top) - 1);
    const right = Math.min(window.innerWidth, Math.round(r.right) + 1);
    const bottom = Math.min(window.innerHeight, Math.round(r.bottom) + 1);
    activeOverlay.style.left = `${left}px`;
    activeOverlay.style.top = `${top}px`;
    activeOverlay.style.width = `${Math.max(0, right - left)}px`;
    activeOverlay.style.height = `${Math.max(0, bottom - top)}px`;
}

function applyHighlight(el, hintId) {
    if (!el) return;
    // уже подсвечиваем тот же элемент — только обновим позицию
    if (activeTargetEl === el && activeOverlay) {
        positionOverlay(el);
        return;
    }
    clearHighlight();
    activeTargetEl = el;
    activeHintId = hintId;

    const overlay = document.createElement('div');
    overlay.className = 'ui-hint-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(overlay);
    activeOverlay = overlay;
    positionOverlay(el);
}

/** Обновление позиции overlay (при resize / открытии UI) */
function tickOverlayPosition() {
    if (activeOverlay && activeTargetEl) {
        if (!document.body.contains(activeTargetEl) || !isEffectivelyVisible(activeTargetEl)) {
            // DOM перерисовался (например, схемы) — попробуем найти заново
            if (activeHintId) {
                const t = resolveTarget(activeHintId);
                const el = findElement(t);
                if (el && isEffectivelyVisible(el)) {
                    activeTargetEl = el;
                    positionOverlay(el);
                    return;
                }
            }
            return;
        }
        positionOverlay(activeTargetEl);
    }
}

export function activateHint(hintId) {
    const target = resolveTarget(hintId);
    if (!target) return;

    const keepsPopup = !!(target.relatedPopup || POPUP_RELATED_HINTS.has(hintId));
    if (!keepsPopup) closeResourcePopup();

    const tryHighlight = () => {
        const el = findElement(target);
        if (el && isEffectivelyVisible(el)) {
            applyHighlight(el, hintId);
            return true;
        }
        return false;
    };

    // уже на этой же подсказке
    if (activeHintId === hintId && activeOverlay && activeTargetEl && isEffectivelyVisible(activeTargetEl)) {
        positionOverlay(activeTargetEl);
        return;
    }

    if (typeof target.open === 'function') {
        target.open();
        let attempts = 0;
        const tick = () => {
            attempts += 1;
            if (tryHighlight() || attempts >= 20) return;
            setTimeout(tick, 80);
        };
        setTimeout(tick, 50);
    } else {
        tryHighlight();
    }
}

export function deactivateHint() {
    clearHighlight();
    activeHintId = null;
}

/** Принудительно снять все подсказки (закрытие окон, уход курсора с панели) */
export function clearAllHints() {
    deactivateHint();
}

/**
 * Навесить снятие подсветки при уходе курсора с контейнера-хоста (NPC-панель, модалка квеста и т.п.)
 * mouseleave срабатывает и когда курсор уходит на «пустое» место за пределами панели.
 */
export function bindHintHostPanel(panel) {
    if (!panel || panel.dataset.hintHostBound) return;
    panel.dataset.hintHostBound = '1';
    panel.addEventListener('mouseleave', () => {
        clearAllHints();
    });
}

export function bindHintLinks(container) {
    if (!container) return;
    container.querySelectorAll('.quest-hint-link').forEach(link => {
        if (link.dataset.hintBound) return;
        link.dataset.hintBound = '1';
        const id = link.dataset.hintId;
        link.addEventListener('mouseenter', () => activateHint(id));
        link.addEventListener('focus', () => activateHint(id));
        link.addEventListener('mouseleave', () => deactivateHint());
        link.addEventListener('blur', () => deactivateHint());
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            activateHint(id);
        });
    });
}

export function registerHintTarget(id, def) {
    HINT_TARGETS[id] = def;
}

// плавно обновлять overlay при ресайзе / анимации UI
if (typeof window !== 'undefined') {
    window.addEventListener('resize', tickOverlayPosition, { passive: true });
    // rAF-loop лёгкий: только если overlay активен
    const loop = () => {
        if (activeOverlay) tickOverlayPosition();
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}
