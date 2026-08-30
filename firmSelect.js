/**
 * Фирменный селект (single / multi).
 * createFirmSelect(host, {
 *   options: [{ id, label, disabled? }],
 *   value: string | string[],
 *   multiple: bool,
 *   max: number,
 *   placeholder: string,
 *   onChange(value)
 * })
 */
export function createFirmSelect(host, opts = {}) {
    if (!host) return { destroy() {}, setOptions() {}, setValue() {}, getValue() { return opts.multiple ? [] : null; } };

    const multiple = !!opts.multiple;
    const max = Math.max(1, Number(opts.max) || (multiple ? 99 : 1));
    let options = Array.isArray(opts.options) ? opts.options.slice() : [];
    let value = multiple
        ? (Array.isArray(opts.value) ? opts.value.map(String) : [])
        : (opts.value != null ? String(opts.value) : null);
    const placeholder = opts.placeholder || '—';
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    host.classList.add('firm-select');
    host.innerHTML = `
        <button type="button" class="firm-select-trigger" data-ui>
            <span class="firm-select-label is-placeholder">${placeholder}</span>
            <span class="firm-select-chevron">▼</span>
        </button>
        <div class="firm-select-dropdown" data-ui>
            <div class="firm-select-list"></div>
        </div>`;

    const trigger = host.querySelector('.firm-select-trigger');
    const labelEl = host.querySelector('.firm-select-label');
    const list = host.querySelector('.firm-select-list');

    function isSelected(id) {
        const s = String(id);
        return multiple ? value.includes(s) : value === s;
    }

    function syncLabel() {
        if (multiple) {
            if (!value.length) {
                labelEl.textContent = placeholder;
                labelEl.classList.add('is-placeholder');
            } else {
                const names = value.map(id => options.find(o => String(o.id) === id)?.label || id);
                labelEl.textContent = names.join(', ');
                labelEl.classList.remove('is-placeholder');
            }
        } else {
            const opt = options.find(o => String(o.id) === value);
            if (!opt) {
                labelEl.textContent = placeholder;
                labelEl.classList.add('is-placeholder');
            } else {
                labelEl.textContent = opt.label;
                labelEl.classList.remove('is-placeholder');
            }
        }
    }

    function renderList() {
        const atMax = multiple && value.length >= max;
        list.innerHTML = options.map(o => {
            const id = String(o.id);
            const sel = isSelected(id);
            const dis = !!o.disabled || (atMax && !sel);
            return `<button type="button" class="firm-select-option${sel ? ' is-selected' : ''}${dis ? ' is-disabled' : ''}" data-id="${id}" ${dis ? 'disabled' : ''} data-ui>
                <span class="firm-select-check">${sel ? '✓' : ''}</span>
                <span>${o.label || id}</span>
            </button>`;
        }).join('');

        list.querySelectorAll('.firm-select-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (btn.disabled) return;
                const id = btn.getAttribute('data-id');
                if (!id) return;
                if (multiple) {
                    const i = value.indexOf(id);
                    if (i >= 0) value = value.filter(x => x !== id);
                    else if (value.length < max) value = [...value, id];
                    onChange(value.slice());
                } else {
                    value = id;
                    host.classList.remove('open');
                    onChange(value);
                }
                syncLabel();
                renderList();
            });
        });
    }

    function setOptions(next) {
        options = Array.isArray(next) ? next.slice() : [];
        if (multiple) {
            value = value.filter(id => options.some(o => String(o.id) === id));
        } else if (value != null && !options.some(o => String(o.id) === value)) {
            value = null;
        }
        syncLabel();
        renderList();
    }

    function setValue(v) {
        if (multiple) value = Array.isArray(v) ? v.map(String) : [];
        else value = v != null ? String(v) : null;
        syncLabel();
        renderList();
    }

    function getValue() {
        return multiple ? value.slice() : value;
    }

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        host.classList.toggle('open');
    });

    const onDoc = (e) => {
        if (!host.contains(e.target)) host.classList.remove('open');
    };
    document.addEventListener('mousedown', onDoc);

    syncLabel();
    renderList();

    return {
        setOptions,
        setValue,
        getValue,
        destroy() {
            document.removeEventListener('mousedown', onDoc);
            host.classList.remove('firm-select', 'open');
            host.innerHTML = '';
        }
    };
}
