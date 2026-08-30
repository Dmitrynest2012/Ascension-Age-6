/**
 * Фирменные подсказки вместо браузерного title.
 * API: setTip(el, text), clearTip(el), initTooltips(), harvestTooltips(root)
 */
(function (global) {
    const SHOW_DELAY = 200;
    const HIDE_DELAY = 0;
    const GAP = 10;

    let tipEl = null;
    let showTimer = null;
    let hideTimer = null;
    let activeTarget = null;
    let inited = false;
    let lastPointer = { x: 0, y: 0 };

    function ensureTipEl() {
        if (tipEl && tipEl.isConnected) return tipEl;
        tipEl = document.getElementById('game-tooltip');
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.id = 'game-tooltip';
            tipEl.setAttribute('role', 'tooltip');
            tipEl.className = 'is-hidden';
            (document.body || document.documentElement).appendChild(tipEl);
        }
        return tipEl;
    }

    function isSkippable(el) {
        if (!el || el.nodeType !== 1) return true;
        const tag = el.tagName;
        if (tag === 'TITLE' || tag === 'HTML' || tag === 'HEAD' || tag === 'BODY' ||
            tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META') return true;
        if (el.dataset && (el.dataset.keepTitle === '1' || el.dataset.nativeTitle === '1')) return true;
        return false;
    }

    /** Элемент реально видим (без жёсткой проверки opacity у предков) */
    function isEffectivelyVisible(el) {
        if (!el || !el.isConnected) return false;
        let p = el;
        while (p && p.nodeType === 1) {
            if (p.hidden) return false;
            const st = window.getComputedStyle(p);
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            p = p.parentElement;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        if (rect.bottom < -2 || rect.right < -2 || rect.top > window.innerHeight + 2 || rect.left > window.innerWidth + 2) {
            return false;
        }
        return true;
    }

    function harvest(el) {
        if (isSkippable(el)) return;
        const native = el.getAttribute('title');
        if (native == null) return;
        if (native !== '') el.setAttribute('data-tip', native);
        else el.removeAttribute('data-tip');
        el.removeAttribute('title');
    }

    function harvestTree(root) {
        if (!root) return;
        if (root.nodeType === 1) harvest(root);
        if (root.querySelectorAll) root.querySelectorAll('[title]').forEach(harvest);
    }

    function getTipText(el) {
        if (!el || isSkippable(el)) return '';
        const tip = el.getAttribute('data-tip');
        if (tip != null && String(tip).trim() !== '') return String(tip).trim();
        const t = el.getAttribute('title');
        return t && String(t).trim() ? String(t).trim() : '';
    }

    function findTipTarget(start) {
        let el = start;
        while (el && el !== document.body && el !== document.documentElement) {
            if (el.nodeType === 1) {
                const text = getTipText(el);
                if (text) return el;
                if (el.hasAttribute('data-tip') && !text) return null;
            }
            el = el.parentElement;
        }
        return null;
    }

    function positionTip(target) {
        const box = ensureTipEl();
        const rect = target.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;

        box.style.left = '-9999px';
        box.style.top = '0px';
        const tw = Math.max(box.offsetWidth || 0, 48);
        const th = Math.max(box.offsetHeight || 0, 28);
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = rect.left + rect.width / 2 - tw / 2;
        let top = rect.bottom + GAP;
        const prefer = target.getAttribute('data-tip-pos') || 'auto';

        if (prefer === 'top' || (prefer === 'auto' && top + th > vh - 8 && rect.top > th + GAP + 8)) {
            top = rect.top - th - GAP;
        }
        if (prefer === 'left') {
            left = rect.left - tw - GAP;
            top = rect.top + rect.height / 2 - th / 2;
        } else if (prefer === 'right') {
            left = rect.right + GAP;
            top = rect.top + rect.height / 2 - th / 2;
        }

        left = Math.max(8, Math.min(left, vw - tw - 8));
        top = Math.max(8, Math.min(top, vh - th - 8));
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        return true;
    }

    function showTip(target) {
        if (!target || !target.isConnected) {
            hideTip(true);
            return;
        }
        // видимость — мягкая; если элемент в DOM с data-tip, всё равно пробуем
        if (!isEffectivelyVisible(target)) {
            hideTip(true);
            return;
        }
        const text = getTipText(target);
        if (!text) {
            hideTip(true);
            return;
        }
        const box = ensureTipEl();
        // всегда в конец body — поверх модалок
        if (box.parentElement !== document.body && document.body) {
            document.body.appendChild(box);
        }
        box.textContent = text;
        if (!positionTip(target)) {
            hideTip(true);
            return;
        }
        box.classList.remove('is-hidden');
        void box.offsetWidth;
        box.classList.add('is-visible');
        activeTarget = target;
        requestAnimationFrame(() => {
            if (activeTarget === target) positionTip(target);
        });
    }

    function hideTip(immediate) {
        const box = tipEl;
        if (!box) return;
        activeTarget = null;
        box.classList.remove('is-visible');
        if (immediate) {
            box.classList.add('is-hidden');
            box.textContent = '';
            return;
        }
        // плавный fade, затем прячем
        window.setTimeout(() => {
            if (!box.classList.contains('is-visible')) {
                box.classList.add('is-hidden');
                if (!box.classList.contains('is-visible')) box.textContent = '';
            }
        }, 160);
    }

    function scheduleShow(target) {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        showTimer = window.setTimeout(() => {
            if (!target || !target.isConnected) return;
            showTip(target);
        }, SHOW_DELAY);
    }

    function scheduleHide() {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        if (HIDE_DELAY <= 0) {
            hideTip(false);
            return;
        }
        hideTimer = window.setTimeout(() => hideTip(false), HIDE_DELAY);
    }

    function onPointerMove(e) {
        lastPointer.x = e.clientX;
        lastPointer.y = e.clientY;
        // если tip открыт — слегка держим
        if (activeTarget && tipEl && tipEl.classList.contains('is-visible')) {
            // если ушли с цели — скроем через out
        }
    }

    function onPointerOver(e) {
        lastPointer.x = e.clientX;
        lastPointer.y = e.clientY;
        const target = findTipTarget(e.target);
        if (!target) {
            if (activeTarget) scheduleHide();
            return;
        }
        if (target === activeTarget) {
            clearTimeout(hideTimer);
            return;
        }
        scheduleShow(target);
    }

    function onPointerOut(e) {
        const to = e.relatedTarget;
        if (activeTarget && to && (activeTarget === to || activeTarget.contains(to))) return;
        if (to && findTipTarget(to) === activeTarget) return;
        // мгновенно прячем — не оставляем «висящие» tip
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        hideTip(false); // плавное исчезновение через CSS transition
    }

    function onScrollOrResize() {
        if (activeTarget && tipEl && tipEl.classList.contains('is-visible')) {
            if (!isEffectivelyVisible(activeTarget)) hideTip(true);
            else positionTip(activeTarget);
        }
    }

    function setTip(el, text) {
        if (!el) return;
        const s = text == null ? '' : String(text);
        if (s) el.setAttribute('data-tip', s);
        else el.removeAttribute('data-tip');
        el.removeAttribute('title');
    }

    function clearTip(el) {
        if (!el) return;
        el.removeAttribute('data-tip');
        el.removeAttribute('title');
        if (activeTarget === el) hideTip(true);
    }

    function patchTitleProperty() {
        try {
            const proto = HTMLElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'title');
            if (!desc || !desc.configurable) return;
            Object.defineProperty(proto, 'title', {
                configurable: true,
                enumerable: desc.enumerable,
                get() {
                    if (isSkippable(this)) {
                        return desc.get ? desc.get.call(this) : (this.getAttribute('title') || '');
                    }
                    return this.getAttribute('data-tip') || '';
                },
                set(v) {
                    if (isSkippable(this)) {
                        if (desc.set) desc.set.call(this, v);
                        else this.setAttribute('title', v == null ? '' : String(v));
                        return;
                    }
                    setTip(this, v);
                }
            });
        } catch (e) {
            console.warn('tooltips: title patch failed', e);
        }
    }

    function initTooltips() {
        if (inited) {
            harvestTree(document);
            return;
        }
        inited = true;
        patchTitleProperty();
        ensureTipEl();
        harvestTree(document);

        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerover', onPointerOver, true);
        document.addEventListener('pointerout', onPointerOut, true);
        window.addEventListener('scroll', onScrollOrResize, true);
        window.addEventListener('resize', onScrollOrResize);

        try {
            const mo = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type === 'attributes' && m.attributeName === 'title') {
                        if (m.target.hasAttribute('title')) harvest(m.target);
                    } else if (m.type === 'childList') {
                        m.addedNodes.forEach((n) => {
                            if (n.nodeType === 1) harvestTree(n);
                        });
                    }
                }
            });
            mo.observe(document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['title']
            });
        } catch (e) {
            console.warn('tooltips: observer failed', e);
        }

        window.setTimeout(() => harvestTree(document), 0);
        window.setTimeout(() => harvestTree(document), 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTooltips);
    } else {
        initTooltips();
    }


    /** Явный показ у якоря (для схем/рецептов и сложных UI) */
    function showGameTooltip(anchor, text, pos) {
        if (!text) return;
        ensureTipEl();
        const box = tipEl;
        if (document.body && box.parentElement !== document.body) {
            document.body.appendChild(box);
        }
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        box.textContent = String(text);
        box.classList.remove('is-hidden');
        void box.offsetWidth;
        box.classList.add('is-visible');

        const target = (anchor && anchor.nodeType === 1) ? anchor : null;
        if (target) {
            if (pos) target.setAttribute('data-tip-pos', pos);
            activeTarget = target;
            positionTip(target);
            requestAnimationFrame(() => positionTip(target));
        } else {
            // у курсора
            const tw = Math.max(box.offsetWidth || 0, 48);
            const th = Math.max(box.offsetHeight || 0, 28);
            let left = lastPointer.x + 14;
            let top = lastPointer.y + 16;
            left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
            top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
            box.style.left = left + 'px';
            box.style.top = top + 'px';
            activeTarget = null;
        }
    }

    function hideGameTooltip() {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        hideTip(true);
    }

    global.initTooltips = initTooltips;
    global.setTip = setTip;
    global.clearTip = clearTip;
    global.harvestTooltips = harvestTree;
    global.showGameTooltip = showGameTooltip;
    global.hideGameTooltip = hideGameTooltip;
})(typeof window !== 'undefined' ? window : globalThis);
