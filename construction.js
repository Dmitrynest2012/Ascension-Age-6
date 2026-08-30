import { state } from './state.js';
import { getLocationBuildingData, updateLocationBuildingData, getStructureMax, getStructureInitial } from './buildingHelpers.js';
import { t } from './settings.js';
import { refundActionResources, refundEntries } from './buildingResourceCosts.js';

export const FORWARD_ACTIONS = new Set(['build', 'upgrade']);
export const BACKWARD_ACTIONS = new Set(['dismantle', 'downgrade']);

function actionLabel(type) {
    const map = {
        build: 'construction.building',
        upgrade: 'construction.upgrading',
        dismantle: 'construction.demolishing',
        downgrade: 'construction.downgrading'
    };
    return t(map[type] || 'construction.operating');
}

function actionPreviewLabel(type) {
    const map = {
        build: 'construction.build',
        upgrade: 'construction.upgrade',
        dismantle: 'construction.demolish',
        downgrade: 'construction.downgrade'
    };
    return t(map[type] || 'construction.operation');
}

/** @deprecated используйте actionLabel() — оставлено для совместимости */
export const ACTION_LABELS = new Proxy({}, {
    get: (_, prop) => actionLabel(prop)
});

export const ACTION_PREVIEW_LABELS = new Proxy({}, {
    get: (_, prop) => actionPreviewLabel(prop)
});

export function getActionDurationMs(buildingTemplate, locData, actionType) {
    const times = buildingTemplate.BuildTime || buildingTemplate.buildTime || [];
    const level = locData.currentLevel || 0;
    const count = locData.built_count || 0;
    const dismantlePen = Number(buildingTemplate.DismantlePenalty ?? buildingTemplate.dismantlePenalty ?? 0.5);
    const downgradePen = Number(buildingTemplate.DowngradePenalty ?? buildingTemplate.downgradePenalty ?? 0.5);

    const timeAt = (lvl) => {
        if (!times.length) return 60;
        const i = Math.max(0, Math.min(lvl, times.length - 1));
        return Number(times[i]) || 60;
    };

    let seconds = 60;
    switch (actionType) {
        case 'build':
            seconds = timeAt(level);
            break;
        case 'upgrade':
            seconds = Math.max(1, count) * timeAt(level + 1);
            break;
        case 'dismantle':
            seconds = timeAt(level) * dismantlePen;
            break;
        case 'downgrade':
            seconds = Math.max(1, count) * timeAt(level) * downgradePen;
            break;
        default:
            seconds = timeAt(level);
    }
    return Math.max(1, seconds) * 1000;
}

export function getPendingAction(locationId, buildingId) {
    const data = getLocationBuildingData(locationId, buildingId);
    return data.pendingAction || null;
}

export function hasPendingAction(locationId, buildingId) {
    return !!getPendingAction(locationId, buildingId);
}

export function startConstruction(locationId, buildingId, actionType, buildingTemplate, locData, gameNowMs, plan = null) {
    if (hasPendingAction(locationId, buildingId)) return false;
    const durationMs = (plan && Number(plan.durationMs) > 0)
        ? Number(plan.durationMs)
        : getActionDurationMs(buildingTemplate, locData, actionType);
    const pending = {
        type: actionType,
        startGameTime: gameNowMs,
        durationMs
    };
    if (plan) {
        if (plan.targetLevel != null && plan.targetLevel !== undefined) {
            pending.targetLevel = Number(plan.targetLevel);
        }
        if (plan.targetCount != null && plan.targetCount !== undefined) {
            pending.targetCount = Number(plan.targetCount);
        }
        if (plan.steps != null) pending.steps = Number(plan.steps);
        if (plan.fromLevel != null) pending.fromLevel = Number(plan.fromLevel);
        if (plan.fromCount != null) pending.fromCount = Number(plan.fromCount);
        if (plan.mode === 'refund' && Array.isArray(plan.entries) && plan.entries.length) {
            pending.refundEntries = plan.entries.map(e => ({
                resourceId: e.resourceId,
                amount: Number(e.amount) || 0
            }));
        }
        if (plan.mode === 'cost' && Array.isArray(plan.entries) && plan.entries.length) {
            // уже списано со склада — для UI панели на время операции
            pending.costEntries = plan.entries.map(e => ({
                resourceId: e.resourceId,
                amount: Number(e.amount) || 0
            }));
        }
    }
    updateLocationBuildingData(locationId, buildingId, { pendingAction: pending });
    return true;
}

export function getRemainingMs(pending, gameNowMs) {
    if (!pending) return 0;
    return Math.max(0, pending.startGameTime + pending.durationMs - gameNowMs);
}

export function getProgress01(pending, gameNowMs) {
    if (!pending || !pending.durationMs) return 1;
    return Math.min(1, Math.max(0, (gameNowMs - pending.startGameTime) / pending.durationMs));
}

export function formatConstructionRemaining(remainingMs) {
    let totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
    const SEC_YEAR = 365.25 * 24 * 3600;
    const SEC_MONTH = 30 * 24 * 3600;
    const SEC_DAY = 24 * 3600;

    let years = Math.floor(totalSec / SEC_YEAR);
    totalSec -= years * SEC_YEAR;
    let months = Math.floor(totalSec / SEC_MONTH);
    totalSec -= months * SEC_MONTH;
    let days = Math.floor(totalSec / SEC_DAY);
    totalSec -= days * SEC_DAY;
    let hours = Math.floor(totalSec / 3600);
    totalSec -= hours * 3600;
    let minutes = Math.floor(totalSec / 60);
    let seconds = Math.floor(totalSec % 60);

    let overflow = false;
    if (years > 9999) {
        overflow = true;
        years = 9999;
    }

    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const timePart = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    const datePart = `${pad(days)}:${pad(months)}:${pad(years, 4)}`;
    return overflow ? `>${timePart} ${datePart}` : `${timePart} ${datePart}`;
}

function applyCompletedAction(locationId, buildingId, pending) {
    const locData = getLocationBuildingData(locationId, buildingId);
    const updates = { pendingAction: null };
    const template = state.buildings.find(b => b.id === buildingId);

    // возврат ресурсов до изменения count/level (dismantle / downgrade)
    if (template && (pending.type === 'dismantle' || pending.type === 'downgrade')) {
        try {
            const body = state.celestialBodies?.[locationId] || state.celestialBodies?.[String(locationId)];
            const bodyData = body?.data || body;
            if (bodyData) {
                if (Array.isArray(pending.refundEntries) && pending.refundEntries.length) {
                    refundEntries(bodyData, pending.refundEntries);
                } else {
                    refundActionResources(bodyData, template, locData, pending.type);
                }
            }
        } catch (e) { console.warn('refundActionResources', e); }
    }

    switch (pending.type) {
        case 'build': {
            const targetC = pending.targetCount != null
                ? Math.max((locData.built_count || 0) + 1, Number(pending.targetCount) || 0)
                : (locData.built_count || 0) + 1;
            const newCount = Math.max(0, targetC);
            updates.built_count = newCount;
            if (template) {
                const level = locData.currentLevel || 0;
                const maxPer = getStructureMax(template, level);
                const cur = Number(locData.currentStructure) || 0;
                // новая единица — полная структура (не StartingStructure; он только для стартового сида)
                updates.currentStructure = cur + maxPer;
            }
            break;
        }
        case 'dismantle': {
            const oldCount = locData.built_count || 0;
            const newCount = pending.targetCount != null
                ? Math.max(0, Math.min(oldCount, Number(pending.targetCount) || 0))
                : Math.max(0, oldCount - 1);
            updates.built_count = newCount;
            if (newCount <= 0) {
                updates.currentLevel = 0;
                updates.currentStructure = 0;
            } else if (template && oldCount > 0) {
                // пропорционально убираем долю одной единицы
                const cur = Number(locData.currentStructure) || 0;
                updates.currentStructure = cur * (newCount / oldCount);
            }
            break;
        }
        case 'upgrade':
            if ((locData.built_count || 0) > 0) {
                const oldLevel = locData.currentLevel || 0;
                const maxL = Math.max(oldLevel, Number(template?.maxLevel) || oldLevel);
                const newLevel = pending.targetLevel != null
                    ? Math.min(maxL, Math.max(oldLevel + 1, Number(pending.targetLevel) || oldLevel + 1))
                    : oldLevel + 1;
                updates.currentLevel = newLevel;
                if (template) {
                    const oldMax = getStructureMax(template, oldLevel) * (locData.built_count || 0);
                    const newMax = getStructureMax(template, newLevel) * (locData.built_count || 0);
                    const cur = Number(locData.currentStructure) || 0;
                    const ratio = oldMax > 0 ? cur / oldMax : 1;
                    updates.currentStructure = Math.min(newMax, newMax * ratio);
                }
            }
            break;
        case 'downgrade': {
            const oldLevel = locData.currentLevel || 0;
            const newLevel = pending.targetLevel != null
                ? Math.max(0, Math.min(oldLevel, Number(pending.targetLevel) || 0))
                : Math.max(0, oldLevel - 1);
            updates.currentLevel = newLevel;
            if (template && (locData.built_count || 0) > 0) {
                const oldMax = getStructureMax(template, oldLevel) * (locData.built_count || 0);
                const newMax = getStructureMax(template, newLevel) * (locData.built_count || 0);
                const cur = Number(locData.currentStructure) || 0;
                const ratio = oldMax > 0 ? cur / oldMax : 1;
                updates.currentStructure = Math.min(newMax, newMax * ratio);
            }
            break;
        }
    }

    updateLocationBuildingData(locationId, buildingId, updates);
}

export function processConstructions(gameNowMs) {
    let any = false;
    const all = state.locationBuildings || {};
    for (const locId of Object.keys(all)) {
        const buildings = all[locId];
        for (const buildingId of Object.keys(buildings)) {
            const pending = buildings[buildingId]?.pendingAction;
            if (!pending) continue;
            if (getRemainingMs(pending, gameNowMs) > 0) continue;
            applyCompletedAction(Number(locId), buildingId, pending);
            any = true;
        }
    }
    return any;
}

function getTimerEls() {
    return {
        wrap: document.getElementById('construction-timer-wrap'),
        textEl: document.getElementById('construction-timer-text'),
        bar: document.getElementById('construction-progress-bar'),
        labelEl: document.getElementById('construction-action-label')
    };
}

function showTimerPanel(wrap, textEl, bar, labelEl, opts) {
    wrap.style.setProperty('display', 'flex');
    wrap.classList.toggle('is-preview', !!opts.isPreview);
    wrap.classList.toggle('is-active', !opts.isPreview);
    if (labelEl) {
        labelEl.textContent = opts.label || '';
        labelEl.style.display = opts.label ? 'block' : 'none';
    }
    if (textEl) textEl.textContent = opts.timeText;
    if (bar) {
        bar.classList.toggle('forward', !!opts.isForward);
        bar.classList.toggle('backward', !opts.isForward);
        // display управляется CSS-классами forward/backward
    }
}

function hideTimerPanel(wrap, bar, labelEl) {
    if (wrap) {
        wrap.style.setProperty('display', 'none');
        wrap.classList.remove('is-preview', 'is-active');
    }
    if (bar) bar.classList.remove('forward', 'backward');
    if (labelEl) {
        labelEl.textContent = '';
        labelEl.style.display = 'none';
    }
}

let currentPreview = null;

export function setConstructionPreview(preview) {
    currentPreview = preview;
}

export function getConstructionPreview() {
    return currentPreview;
}

export function updateConstructionUI(gameNowMs, locationId, buildingId) {
    const els = getTimerEls();
    const wrap = els.wrap, textEl = els.textEl, bar = els.bar, labelEl = els.labelEl;
    if (!wrap || !textEl || !bar) return;

    if (locationId == null || locationId === undefined || !buildingId) {
        hideTimerPanel(wrap, bar, labelEl);
        return;
    }

    const pending = getPendingAction(locationId, buildingId);
    if (pending) {
        showTimerPanel(wrap, textEl, bar, labelEl, {
            label: actionLabel(pending.type),
            timeText: formatConstructionRemaining(getRemainingMs(pending, gameNowMs)),
            isForward: FORWARD_ACTIONS.has(pending.type),
            isPreview: false
        });
        return;
    }

    if (currentPreview && currentPreview.type) {
        showTimerPanel(wrap, textEl, bar, labelEl, {
            label: actionPreviewLabel(currentPreview.type),
            timeText: formatConstructionRemaining(currentPreview.durationMs || 0),
            isForward: FORWARD_ACTIONS.has(currentPreview.type),
            isPreview: true
        });
        return;
    }

    hideTimerPanel(wrap, bar, labelEl);
}
