/**
 * calculator.js — внутриигровой калькулятор.
 * История (до 10 записей) сохраняется в сессии.
 */

import { state } from './state.js';
import { bringUtilityWindowToFront } from './notepad.js';

const MAX_HISTORY = 10;
const OPS = {
    '+': (a, b) => a + b,
    '−': (a, b) => a - b,
    '×': (a, b) => a * b,
    '÷': (a, b) => (b === 0 ? NaN : a / b)
};

let open = false;
let bound = false;

/** { display, accumulator, operator, fresh, error } */
let calc = {
    display: '0',
    accumulator: null,
    operator: null,
    fresh: true, // следующий digit заменяет display
    error: false
};

function ensureHistory() {
    if (!Array.isArray(state.calculatorHistory)) state.calculatorHistory = [];
    return state.calculatorHistory;
}

export function captureCalculatorSnapshot() {
    return ensureHistory().slice(0, MAX_HISTORY);
}

export function applyCalculatorSnapshot(list) {
    state.calculatorHistory = Array.isArray(list)
        ? list.slice(0, MAX_HISTORY).map(x => String(x)).filter(Boolean)
        : [];
    if (open) renderHistory();
}

function formatNum(n) {
    if (!Number.isFinite(n)) return 'Ошибка';
    // убираем лишние нули, максимум ~12 значащих
    const s = Number(n.toPrecision(12)).toString();
    return s.replace('.', ',');
}

function parseDisplay(str) {
    const t = String(str).replace(/\s/g, '').replace(',', '.');
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

/** Верхняя строка: текущая операция, как в Windows 11 Calculator */
function setExpression(text) {
    const el = document.getElementById('calc-expression');
    if (el) el.textContent = text || '';
}

function refreshExpression() {
    if (calc.error) {
        setExpression('');
        return;
    }
    if (calc.operator != null && calc.accumulator != null) {
        // 15 ×   или  15 × 3 =  (после equals expression задаётся отдельно)
        if (calc.fresh) {
            setExpression(`${formatNum(calc.accumulator)} ${calc.operator}`);
        } else {
            setExpression(`${formatNum(calc.accumulator)} ${calc.operator}`);
        }
    } else {
        setExpression('');
    }
}

function setDisplay(text, { flash = true } = {}) {
    calc.display = text;
    const el = document.getElementById('calc-display');
    if (!el) return;
    el.textContent = text;
    if (flash) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
    }
    refreshExpression();
}

function pushHistory(entry) {
    const h = ensureHistory();
    h.unshift(entry);
    if (h.length > MAX_HISTORY) h.length = MAX_HISTORY;
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('calc-history-list');
    if (!list) return;
    const h = ensureHistory();
    if (!h.length) {
        list.innerHTML = `<div class="calc-history-empty">—</div>`;
        return;
    }
    list.innerHTML = h.map(e => `<div class="calc-history-item">${escapeHtml(e)}</div>`).join('');
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function inputDigit(d) {
    if (calc.error) clearAll();
    if (calc.fresh || calc.display === '0') {
        setDisplay(String(d));
        calc.fresh = false;
    } else {
        if (calc.display.replace(',', '').replace('-', '').length >= 14) return;
        setDisplay(calc.display + d);
    }
}

function inputComma() {
    if (calc.error) clearAll();
    if (calc.fresh) {
        setDisplay('0,');
        calc.fresh = false;
        return;
    }
    if (calc.display.includes(',')) return;
    setDisplay(calc.display + ',');
}

function clearAll() {
    calc = { display: '0', accumulator: null, operator: null, fresh: true, error: false };
    setExpression('');
    setDisplay('0');
}

/** Сброс только текущего ввода (CE), операция сохраняется */
function clearEntry() {
    if (calc.error) {
        clearAll();
        return;
    }
    setDisplay('0');
    calc.fresh = true;
}

function backspace() {
    if (calc.error) {
        clearAll();
        return;
    }
    if (calc.fresh) return;
    if (calc.display.length <= 1 || (calc.display.length === 2 && calc.display.startsWith('-'))) {
        setDisplay('0');
        calc.fresh = true;
        return;
    }
    setDisplay(calc.display.slice(0, -1));
}

function applyOp(opSymbol) {
    if (calc.error) clearAll();
    const current = parseDisplay(calc.display);
    if (!Number.isFinite(current)) {
        calc.error = true;
        setDisplay('Ошибка');
        return;
    }
    if (calc.operator && !calc.fresh && calc.accumulator != null) {
        // цепочка: 2 + 3 + → сначала посчитать 2+3
        const result = OPS[calc.operator](calc.accumulator, current);
        if (!Number.isFinite(result)) {
            calc.error = true;
            setDisplay('Ошибка');
            calc.operator = null;
            calc.accumulator = null;
            return;
        }
        const expr = `${formatNum(calc.accumulator)} ${calc.operator} ${formatNum(current)} = ${formatNum(result)}`;
        pushHistory(expr);
        calc.accumulator = result;
        setDisplay(formatNum(result));
    } else {
        calc.accumulator = current;
    }
    calc.operator = opSymbol;
    calc.fresh = true;
    // Windows-стиль: число остаётся на дисплее, сверху «15 ×»
    refreshExpression();
}

function equals() {
    if (calc.error) {
        clearAll();
        return;
    }
    if (calc.operator == null || calc.accumulator == null) return;
    const current = parseDisplay(calc.display);
    if (!Number.isFinite(current)) {
        calc.error = true;
        setExpression('');
        setDisplay('Ошибка');
        return;
    }
    const result = OPS[calc.operator](calc.accumulator, current);
    const left = formatNum(calc.accumulator);
    const right = formatNum(current);
    const op = calc.operator;
    const expr = `${left} ${op} ${right} = ${Number.isFinite(result) ? formatNum(result) : 'Ошибка'}`;
    pushHistory(expr);
    if (!Number.isFinite(result)) {
        calc.error = true;
        setExpression(`${left} ${op} ${right} =`);
        setDisplay('Ошибка');
        calc.operator = null;
        calc.accumulator = null;
        calc.fresh = true;
        return;
    }
    calc.accumulator = result;
    calc.operator = null;
    calc.fresh = true;
    setDisplay(formatNum(result));
    setExpression(`${left} ${op} ${right} =`);
}

async function pasteIntoDisplay() {
    try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const cleaned = String(text).trim().replace(/\s/g, '').replace('.', ',');
        if (!/^-?\d+(,\d+)?$/.test(cleaned)) return;
        calc.error = false;
        calc.fresh = false;
        setDisplay(cleaned);
    } catch (_) {
        // нет разрешения на буфер
    }
}

async function copyDisplay() {
    const el = document.getElementById('calc-display');
    const text = (el?.textContent || calc.display || '').replace(',', '.');
    try {
        await navigator.clipboard.writeText(text);
        el?.classList.add('copied');
        setTimeout(() => el?.classList.remove('copied'), 400);
    } catch (_) {}
}

export function openCalculator() {
    const modal = document.getElementById('calculator-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    open = true;
    document.getElementById('calculator-btn')?.classList.add('active');
    try { bringUtilityWindowToFront('calculator-modal'); } catch (_) {}
    setDisplay(calc.display, { flash: false });
    refreshExpression();
    renderHistory();
}

export function closeCalculator() {
    const modal = document.getElementById('calculator-modal');
    if (modal) modal.style.display = 'none';
    open = false;
    document.getElementById('calculator-btn')?.classList.remove('active');
}

export function toggleCalculator() {
    if (open) closeCalculator();
    else openCalculator();
}

export function isCalculatorOpen() {
    return open;
}

export function initCalculator() {
    if (bound) return;
    bound = true;
    ensureHistory();

    document.getElementById('calculator-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCalculator();
    });
    document.getElementById('calculator-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeCalculator();
    });
    document.getElementById('calculator-modal')?.addEventListener('click', (e) => {
        if (e.target?.id === 'calculator-modal') closeCalculator();
    });
    document.querySelector('#calculator-modal .calc-window')?.addEventListener('mousedown', () => {
        try { bringUtilityWindowToFront('calculator-modal'); } catch (_) {}
    });

    document.getElementById('calc-copy')?.addEventListener('click', (e) => {
        e.stopPropagation();
        copyDisplay();
    });
    document.getElementById('calc-paste')?.addEventListener('click', (e) => {
        e.stopPropagation();
        pasteIntoDisplay();
    });

    // кнопки
    document.querySelectorAll('.calc-key').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.classList.add('pressed');
            setTimeout(() => btn.classList.remove('pressed'), 140);
            const action = btn.dataset.action;
            const digit = btn.dataset.digit;
            if (digit != null) inputDigit(digit);
            else if (action === 'comma') inputComma();
            else if (action === 'clear') clearAll();
            else if (action === 'ce') clearEntry();
            else if (action === 'back') backspace();
            else if (action === 'eq') equals();
            else if (action === 'add') applyOp('+');
            else if (action === 'sub') applyOp('−');
            else if (action === 'mul') applyOp('×');
            else if (action === 'div') applyOp('÷');
        });
    });

    // клавиатура, когда калькулятор открыт
    document.addEventListener('keydown', (e) => {
        if (!open) return;
        // не мешаем блокноту / инпутам
        const tag = (e.target?.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'INPUT') return;

        const k = e.key;
        if (k >= '0' && k <= '9') {
            e.preventDefault();
            inputDigit(k);
        } else if (k === '.' || k === ',') {
            e.preventDefault();
            inputComma();
        } else if (k === 'Enter' || k === '=') {
            e.preventDefault();
            equals();
        } else if (k === 'Escape') {
            e.preventDefault();
            closeCalculator();
        } else if (k === 'Backspace') {
            e.preventDefault();
            backspace();
        } else if (k === 'Delete' || k.toLowerCase() === 'c') {
            e.preventDefault();
            clearAll();
        } else if (k === '+') {
            e.preventDefault();
            applyOp('+');
        } else if (k === '-') {
            e.preventDefault();
            applyOp('−');
        } else if (k === '*') {
            e.preventDefault();
            applyOp('×');
        } else if (k === '/') {
            e.preventDefault();
            applyOp('÷');
        }
    });

    // вставка в дисплей по Ctrl+V когда фокус не в textarea
    document.getElementById('calc-display')?.addEventListener('click', () => {
        // фокус-маркер
        document.getElementById('calc-display-wrap')?.classList.add('focused');
    });
}
