/**
 * buildingPlanInputs.js — инпуты целевого уровня / количества у кнопок стройки.
 * Доступны только если у небесного тела plannedConstruction === true.
 */
import { t } from './settings.js';
import {
    getLevelCostEntries,
    getRefundFactor,
    hasResourceCostTable,
    canAffordEntries
} from './buildingResourceCosts.js';
import { getActionDurationMs } from './construction.js';
import { getLocationBuildingData } from './buildingHelpers.js';

const ACTION_META = {
    build:     { btn: 'BUILNG001', input: 'plan-input-build',     mode: 'count', dir: +1 },
    dismantle: { btn: 'BUILNG002', input: 'plan-input-dismantle', mode: 'count', dir: -1 },
    upgrade:   { btn: 'BUILNG003', input: 'plan-input-upgrade',   mode: 'level', dir: +1 },
    downgrade: { btn: 'BUILNG004', input: 'plan-input-downgrade', mode: 'level', dir: -1 }
};

/** @type {Record<string, string>} raw value by action */
const inputValues = {
    build: '', dismantle: '', upgrade: '', downgrade: ''
};

/** @type {((action: string, value: string) => void) | null} */
let planOnChange = null;
let planListenersBound = false;

export function isPlannedConstructionEnabled(bodyData) {
    if (!bodyData) return false;
    return bodyData.plannedConstruction === true || bodyData.PlannedConstruction === true;
}

/**
 * Суммарные ресурсы и длительность для целевого уровня/кол-ва.
 * @returns {{ mode:'cost'|'refund', entries: {resourceId,amount}[], durationMs:number, steps:number, targetLevel?:number, targetCount?:number }|null}
 */
export function resolvePlanAction(template, locData, actionType, targetRaw) {
    if (!template || !locData) return null;
    const level = Math.max(0, Number(locData.currentLevel) || 0);
    const count = Math.max(0, Number(locData.built_count) || 0);
    const maxLevel = Math.max(0, Number(template.maxLevel) || level || 0);
    const maxCount = template.max_count != null ? Number(template.max_count) : (template.maxCount != null ? Number(template.maxCount) : Infinity);
    const target = parsePlanTarget(targetRaw);

    const noOp = (reason, extra = {}) => ({
        mode: actionType === 'dismantle' || actionType === 'downgrade' ? 'refund' : 'cost',
        entries: [],
        durationMs: 0,
        steps: 0,
        noOp: true,
        reason,
        fromCount: count,
        fromLevel: level,
        ...extra
    });

    if (target == null) {
        // одиночный шаг по умолчанию — но тоже ловим «уже максимум / нечего»
        if (actionType === 'upgrade' && level >= maxLevel) return noOp('atMaxLevel', { targetLevel: level });
        if (actionType === 'downgrade' && level <= 0) return noOp('nothingToDowngrade', { targetLevel: 0 });
        if (actionType === 'dismantle' && count <= 0) return noOp('nothingToDismantle', { targetCount: 0 });
        if (actionType === 'build' && Number.isFinite(maxCount) && count >= maxCount) return noOp('maxCount', { targetCount: count });
        return resolveDefaultStep(template, locData, actionType);
    }

    if (actionType === 'build') {
        let targetCount = Math.floor(Number(target));
        if (!Number.isFinite(targetCount) || targetCount < 0) return noOp('invalid');
        if (Number.isFinite(maxCount) && targetCount > maxCount) {
            return noOp('maxCount', { targetCount });
        }
        if (targetCount <= count) {
            return noOp(targetCount === count ? 'sameCount' : 'countNotHigher', { targetCount });
        }
        const steps = targetCount - count;
        const base = getLevelCostEntries(template, level);
        const entries = base.map(e => ({ resourceId: e.resourceId, amount: e.amount * steps }));
        const oneMs = getActionDurationMs(template, locData, 'build');
        return { mode: 'cost', entries, durationMs: oneMs * steps, steps, targetCount, fromCount: count, fromLevel: level };
    }

    if (actionType === 'dismantle') {
        let targetCount = Math.floor(Number(target));
        if (!Number.isFinite(targetCount) || targetCount < 0) return noOp('invalid');
        if (count <= 0) return noOp('nothingToDismantle', { targetCount: 0 });
        if (targetCount >= count) {
            return noOp(targetCount === count ? 'sameCount' : 'countNotLower', { targetCount });
        }
        const steps = count - targetCount;
        const factor = getRefundFactor(template);
        const perUnit = new Map();
        for (let lv = 0; lv <= level; lv++) {
            for (const e of getLevelCostEntries(template, lv)) {
                perUnit.set(e.resourceId, (perUnit.get(e.resourceId) || 0) + (Number(e.amount) || 0));
            }
        }
        const entries = [...perUnit.entries()].map(([resourceId, amount]) => ({
            resourceId,
            amount: Math.floor(amount * factor) * steps
        })).filter(e => e.amount > 0);
        let durationMs = 0;
        for (let s = 0; s < steps; s++) {
            const virt = { ...locData, built_count: count - s, currentLevel: level };
            durationMs += getActionDurationMs(template, virt, 'dismantle');
        }
        return {
            mode: 'refund',
            entries,
            durationMs: Math.max(1, durationMs),
            steps,
            targetCount,
            fromCount: count,
            fromLevel: level
        };
    }

    if (actionType === 'upgrade') {
        let targetLevel = Math.floor(Number(target));
        if (!Number.isFinite(targetLevel) || targetLevel < 0) return noOp('invalid');
        // выше максимума — режим дурака, без карточек ресурсов
        if (targetLevel > maxLevel) {
            return noOp('aboveMaxLevel', { targetLevel, maxLevel });
        }
        if (level >= maxLevel) {
            return noOp('atMaxLevel', { targetLevel: level, maxLevel });
        }
        if (targetLevel < level) {
            return noOp('levelNotHigher', { targetLevel });
        }
        if (targetLevel === level) {
            return noOp('sameLevel', { targetLevel });
        }
        const steps = targetLevel - level;
        const mult = Math.max(1, count);
        const merged = new Map();
        let durationMs = 0;
        for (let L = level + 1; L <= targetLevel; L++) {
            for (const e of getLevelCostEntries(template, L)) {
                merged.set(e.resourceId, (merged.get(e.resourceId) || 0) + e.amount * mult);
            }
            const virt = { ...locData, currentLevel: L - 1 };
            durationMs += getActionDurationMs(template, virt, 'upgrade');
        }
        const entries = [...merged.entries()].map(([resourceId, amount]) => ({ resourceId, amount }));
        return { mode: 'cost', entries, durationMs, steps, targetLevel, fromCount: count, fromLevel: level };
    }

    if (actionType === 'downgrade') {
        let targetLevel = Math.floor(Number(target));
        if (!Number.isFinite(targetLevel)) return noOp('invalid');
        if (targetLevel < 0) return noOp('belowMinLevel', { targetLevel: 0 });
        if (level <= 0) return noOp('nothingToDowngrade', { targetLevel: 0 });
        if (targetLevel > level) {
            return noOp('levelNotLower', { targetLevel });
        }
        if (targetLevel === level) {
            return noOp('sameLevel', { targetLevel });
        }
        const steps = level - targetLevel;
        const mult = Math.max(1, count);
        const factor = getRefundFactor(template);
        const merged = new Map();
        let durationMs = 0;
        for (let step = 0; step < steps; step++) {
            const L = level - step;
            for (const e of getLevelCostEntries(template, L)) {
                const add = Math.floor((Number(e.amount) || 0) * mult * factor);
                if (add > 0) merged.set(e.resourceId, (merged.get(e.resourceId) || 0) + add);
            }
            const virt = { ...locData, currentLevel: L, built_count: count };
            durationMs += getActionDurationMs(template, virt, 'downgrade');
        }
        const entries = [...merged.entries()]
            .map(([resourceId, amount]) => ({ resourceId, amount }))
            .filter(e => e.amount > 0);
        return {
            mode: 'refund',
            entries,
            durationMs: Math.max(1, durationMs),
            steps,
            targetLevel,
            fromCount: count,
            fromLevel: level
        };
    }
    return null;
}

function resolveDefaultStep(template, locData, actionType) {
    const level = Math.max(0, Number(locData.currentLevel) || 0);
    const count = Math.max(0, Number(locData.built_count) || 0);
    if (actionType === 'build') {
        const base = getLevelCostEntries(template, level);
        return {
            mode: 'cost',
            entries: base.map(e => ({ ...e })),
            durationMs: getActionDurationMs(template, locData, 'build'),
            steps: 1,
            targetCount: count + 1,
            fromCount: count,
            fromLevel: level
        };
    }
    if (actionType === 'dismantle') {
        const factor = getRefundFactor(template);
        const merged = new Map();
        for (let lv = 0; lv <= level; lv++) {
            for (const e of getLevelCostEntries(template, lv)) {
                merged.set(e.resourceId, (merged.get(e.resourceId) || 0) + e.amount);
            }
        }
        return {
            mode: 'refund',
            entries: [...merged.entries()].map(([resourceId, amount]) => ({
                resourceId, amount: Math.floor(amount * factor)
            })).filter(e => e.amount > 0),
            durationMs: getActionDurationMs(template, locData, 'dismantle'),
            steps: 1,
            targetCount: Math.max(0, count - 1),
            fromCount: count,
            fromLevel: level
        };
    }
    if (actionType === 'upgrade') {
        const mult = Math.max(1, count);
        const next = level + 1;
        const base = getLevelCostEntries(template, next);
        return {
            mode: 'cost',
            entries: base.map(e => ({ resourceId: e.resourceId, amount: e.amount * mult })),
            durationMs: getActionDurationMs(template, locData, 'upgrade'),
            steps: 1,
            targetLevel: next,
            fromCount: count,
            fromLevel: level
        };
    }
    if (actionType === 'downgrade') {
        const mult = Math.max(1, count);
        const factor = getRefundFactor(template);
        const base = getLevelCostEntries(template, level);
        return {
            mode: 'refund',
            entries: base.map(e => ({
                resourceId: e.resourceId,
                amount: Math.floor(e.amount * mult * factor)
            })).filter(e => e.amount > 0),
            durationMs: getActionDurationMs(template, locData, 'downgrade'),
            steps: 1,
            targetLevel: Math.max(0, level - 1),
            fromCount: count,
            fromLevel: level
        };
    }
    return null;
}

export function parsePlanTarget(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    if (!s) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

export function getPlanInputValue(actionType) {
    return inputValues[actionType] || '';
}

export function getPlanForAction(template, locData, actionType) {
    // всегда читаем живое значение из DOM (не только кэш)
    const meta = ACTION_META[actionType];
    const el = meta ? document.getElementById(meta.input) : null;
    const raw = el ? String(el.value || '') : (inputValues[actionType] || '');
    if (el) inputValues[actionType] = raw;
    return resolvePlanAction(template, locData, actionType, raw);
}

/** Может ли тело позволить cost-план (для refund всегда true по ресурсам) */
export function canAffordPlan(bodyData, plan) {
    if (!plan) return false;
    if (plan.noOp) return false;
    if (plan.mode !== 'cost') return true;
    if (!plan.entries?.length) return true;
    return canAffordEntries(bodyData, plan.entries);
}

/** План без изменений (тот же уровень / то же кол-во) */
export function isPlanNoOp(plan) {
    if (!plan) return false;
    if (plan.noOp || plan.steps === 0) return true;
    if (plan.targetLevel != null && plan.fromLevel != null && Number(plan.targetLevel) === Number(plan.fromLevel)) return true;
    if (plan.targetCount != null && plan.fromCount != null && Number(plan.targetCount) === Number(plan.fromCount)) return true;
    return false;
}

const PLAN_REASON_KEYS = {
    sameLevel: 'plan.hint.sameLevel',
    levelNotHigher: 'plan.hint.levelNotHigher',
    levelNotLower: 'plan.hint.levelNotLower',
    sameCount: 'plan.hint.sameCount',
    aboveMaxLevel: 'plan.hint.aboveMaxLevel',
    atMaxLevel: 'plan.hint.atMaxLevel',
    belowMinLevel: 'plan.hint.belowMinLevel',
    countNotHigher: 'plan.hint.countNotHigher',
    countNotLower: 'plan.hint.countNotLower',
    nothingToDismantle: 'plan.hint.nothingToDismantle',
    nothingToDowngrade: 'plan.hint.nothingToDowngrade',
    maxCount: 'plan.hint.maxCount',
    invalid: 'plan.hint.invalid'
};

export function planReasonHintKey(reason) {
    return PLAN_REASON_KEYS[reason] || 'plan.hint.invalid';
}

export function planHintText(plan) {
    if (!plan) return t('building.costs.none') || '';
    if (plan.noOp || plan.steps === 0) {
        const key = planReasonHintKey(plan.reason);
        return t(key) || key;
    }
    if (!plan.entries?.length) return t('building.costs.none') || '';
    return '';
}


export function ensurePlanInputDom() {
    for (const [action, meta] of Object.entries(ACTION_META)) {
        const btn = document.getElementById(meta.btn);
        if (!btn) continue;
        btn.dataset.action = action;

        // Текст кнопки → span.label (один раз)
        let label = btn.querySelector('.building-button-label');
        if (!label) {
            const text = (btn.textContent || '').trim();
            // убрать прежние текстовые узлы, сохранив input если уже был
            const existingInput = btn.querySelector('.plan-target-input');
            btn.innerHTML = '';
            if (existingInput) btn.appendChild(existingInput);
            label = document.createElement('span');
            label.className = 'building-button-label';
            label.textContent = text;
            btn.appendChild(label);
        }

        let input = btn.querySelector('.plan-target-input');
        if (!input) {
            input = document.createElement('input');
            input.type = 'text';
            input.inputMode = 'numeric';
            input.maxLength = 6;
            input.className = 'plan-target-input';
            input.id = meta.input;
            input.dataset.action = action;
            input.placeholder = '';
            input.setAttribute('data-ui', 'true');
            input.autocomplete = 'off';
            input.title = '';
            btn.insertBefore(input, label);
        } else {
            input.placeholder = '';
        }
    }
}

export function syncPlanInputs({ bodyData, template, locData, masked, pending }) {
    ensurePlanInputDom();
    const enabled = isPlannedConstructionEnabled(bodyData) && !masked && !pending;
    for (const [action, meta] of Object.entries(ACTION_META)) {
        const btn = document.getElementById(meta.btn);
        const input = document.getElementById(meta.input) || btn?.querySelector('.plan-target-input');
        if (!btn || !input) continue;
        const locked = btn.classList.contains('locked');
        const show = enabled && !locked;
        btn.classList.toggle('plan-open', show);
        input.disabled = !show;
        if (!show) {
            btn.classList.remove('plan-unaffordable');
            continue;
        }
        if (template && locData) {
            const plan = getPlanForAction(template, locData, action);
            const noop = isPlanNoOp(plan);
            btn.classList.toggle('plan-noop', noop);
            if (noop) {
                btn.classList.remove('plan-unaffordable');
            } else if (action === 'build' || action === 'upgrade') {
                const ok = canAffordPlan(bodyData, plan);
                btn.classList.toggle('plan-unaffordable', !ok);
            } else {
                btn.classList.remove('plan-unaffordable');
            }
        } else {
            btn.classList.remove('plan-unaffordable', 'plan-noop');
        }
    }
}

export function bindPlanInputs(onChange) {
    // колбэк всегда актуальный (модалка/локация могут меняться)
    planOnChange = typeof onChange === 'function' ? onChange : null;
    ensurePlanInputDom();

    if (planListenersBound) return;
    planListenersBound = true;

    // делегирование: один раз на document — работает и для пересозданных инпутов
    document.addEventListener('input', (e) => {
        const input = e.target?.closest?.('.plan-target-input');
        if (!input) return;
        const action = input.dataset.action;
        if (!action) return;
        let v = String(input.value || '').replace(/\D/g, '').slice(0, 6);
        if (input.value !== v) input.value = v;
        inputValues[action] = v;
        try { planOnChange?.(action, v); } catch (err) { console.warn('planOnChange', err); }
    }, true);

    const block = (e) => {
        if (!e.target?.closest?.('.plan-target-input')) return;
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };
    document.addEventListener('click', block, true);
    document.addEventListener('mousedown', block, true);
    document.addEventListener('mouseup', block, true);
    document.addEventListener('pointerdown', block, true);
    document.addEventListener('pointerup', block, true);
    document.addEventListener('keydown', (e) => {
        if (!e.target?.closest?.('.plan-target-input')) return;
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
    }, true);
}

export function clearPlanInputs() {
    for (const k of Object.keys(inputValues)) inputValues[k] = '';
    document.querySelectorAll('.plan-target-input').forEach(el => {
        el.value = '';
    });
    // снять no-op / unaffordable со всех 4 кнопок
    for (const meta of Object.values(ACTION_META)) {
        const btn = document.getElementById(meta.btn);
        if (!btn) continue;
        btn.classList.remove('plan-noop', 'plan-unaffordable');
    }
}


/** После возврата из главного меню — снова показать инпуты, если модалка открыта */
export function restorePlanInputsIfNeeded(ctx = {}) {
    const modal = document.getElementById('building-modal');
    if (!modal) return;
    const visible = modal.style.display !== 'none' && getComputedStyle(modal).display !== 'none';
    if (!visible) return;
    ensurePlanInputDom();
    const { bodyData, template, locData, masked, pending } = ctx;
    if (bodyData && template && locData) {
        syncPlanInputs({ bodyData, template, locData, masked: !!masked, pending: !!pending });
    } else {
        // хотя бы открыть инпуты у незаблокированных кнопок
        document.querySelectorAll('.building-button').forEach(btn => {
            if (btn.classList.contains('locked')) return;
            const input = btn.querySelector('.plan-target-input');
            if (input) {
                btn.classList.add('plan-open');
                input.disabled = false;
            }
        });
    }
}
