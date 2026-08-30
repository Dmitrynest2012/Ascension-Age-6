/**
 * Фирменные скроллбары со скошенными углами (эталон).
 *
 * attachFirmScroll(el, {
 *   axis: 'both'|'y'|'x',
 *   mirrorV: false,   // вертикальный: скосы справа (отражение по горизонтали)
 *   host: 'parent'|'self'  // self — треки на самом el, контент в .firm-scroll-inner
 * })
 */
const INSTANCES = new WeakMap();

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

function ensureSelfHost(el, axis, fillHost) {
    el.classList.add('firm-scroll-host');
    if (getComputedStyle(el).position === 'static') {
        el.style.position = 'relative';
    }

    let inner = null;
    for (const ch of el.children) {
        if (ch.classList?.contains('firm-scroll-inner')) {
            inner = ch;
            break;
        }
    }
    if (!inner) {
        inner = document.createElement('div');
        inner.className = 'firm-scroll-inner';
        const move = [];
        for (const ch of [...el.childNodes]) {
            if (ch.nodeType === 1 && ch.classList?.contains('firm-scroll-track')) continue;
            move.push(ch);
        }
        for (const n of move) inner.appendChild(n);
        el.insertBefore(inner, el.firstChild);
    }

    // overflow переносим на inner
    el.style.overflow = 'hidden';
    if (axis === 'x') {
        inner.style.overflowX = 'auto';
        inner.style.overflowY = 'hidden';
    } else if (axis === 'y') {
        inner.style.overflowY = 'auto';
        inner.style.overflowX = 'hidden';
    } else {
        inner.style.overflow = 'auto';
    }
    inner.style.boxSizing = 'border-box';
    inner.style.width = '100%';
    inner.style.minHeight = '0';
    // height:100% ломает host с height:auto (попап) — только по запросу
    if (fillHost) {
        inner.style.height = '100%';
        inner.style.maxHeight = 'inherit';
    } else {
        inner.style.height = '';
        // max-height пусть задаёт CSS хоста / .firm-scroll-inner
    }

    return { host: el, viewport: inner };
}

export function attachFirmScroll(el, options = {}) {
    if (!el) return { update() {}, destroy() {} };

    const axis = options.axis || 'both';
    const mirrorV = !!options.mirrorV;
    const hostMode = options.host || 'parent';

    let host, viewport;
    if (hostMode === 'self') {
        ({ host, viewport } = ensureSelfHost(el, axis, !!options.fillHost));
    } else {
        viewport = el;
        host = el.parentElement;
        if (!host) return { update() {}, destroy() {} };
        if (getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
        }
    }

    const prev = INSTANCES.get(viewport);
    // уже подключено и треки на месте — только обновить
    if (prev && host.querySelector(':scope > .firm-scroll-track')) {
        if (mirrorV) host.classList.add('firm-scroll-mirror-v');
        else host.classList.remove('firm-scroll-mirror-v');
        try { prev.update(); } catch (_) {}
        return prev;
    }
    if (prev) prev.destroy();

    viewport.classList.add('firm-scroll-viewport');
    if (mirrorV) host.classList.add('firm-scroll-mirror-v');
    else host.classList.remove('firm-scroll-mirror-v');

    let vTrack = null, vThumb = null, hTrack = null, hThumb = null;

    if (axis === 'both' || axis === 'y') {
        vTrack = document.createElement('div');
        vTrack.className = 'firm-scroll-track firm-scroll-track-v' + (axis === 'y' ? ' firm-scroll-track-v-only' : '');
        vThumb = document.createElement('div');
        vThumb.className = 'firm-scroll-thumb firm-scroll-thumb-v';
        vTrack.appendChild(vThumb);
        host.appendChild(vTrack);
    }
    if (axis === 'both' || axis === 'x') {
        hTrack = document.createElement('div');
        hTrack.className = 'firm-scroll-track firm-scroll-track-h';
        hThumb = document.createElement('div');
        hThumb.className = 'firm-scroll-thumb firm-scroll-thumb-h';
        hTrack.appendChild(hThumb);
        host.appendChild(hTrack);
    }

    let drag = null;

    function metrics() {
        const cw = viewport.clientWidth;
        const ch = viewport.clientHeight;
        const sw = viewport.scrollWidth;
        const sh = viewport.scrollHeight;
        return {
            cw, ch, sw, sh,
            maxX: Math.max(0, sw - cw),
            maxY: Math.max(0, sh - ch)
        };
    }

    function update() {
        const m = metrics();
        const needV = m.maxY > 1;
        const needH = m.maxX > 1;

        if (vTrack) {
            vTrack.classList.toggle('firm-scroll-hidden', !needV);
            if (needV) {
                const trackH = vTrack.clientHeight || m.ch;
                const ratio = m.ch / Math.max(1, m.sh);
                const thumbH = clamp(Math.round(trackH * ratio), 28, trackH);
                const maxTop = Math.max(0, trackH - thumbH);
                const top = m.maxY > 0 ? (viewport.scrollTop / m.maxY) * maxTop : 0;
                vThumb.style.height = thumbH + 'px';
                vThumb.style.transform = `translateY(${top}px)`;
            }
        }
        if (hTrack) {
            hTrack.classList.toggle('firm-scroll-hidden', !needH);
            if (needH) {
                const trackW = hTrack.clientWidth || m.cw;
                const ratio = m.cw / Math.max(1, m.sw);
                const thumbW = clamp(Math.round(trackW * ratio), 28, trackW);
                const maxLeft = Math.max(0, trackW - thumbW);
                const left = m.maxX > 0 ? (viewport.scrollLeft / m.maxX) * maxLeft : 0;
                hThumb.style.width = thumbW + 'px';
                hThumb.style.transform = `translateX(${left}px)`;
            }
        }
        host.classList.toggle('firm-scroll-has-v', needV);
        host.classList.toggle('firm-scroll-has-h', needH);
    }

    function onScroll() { update(); }

    function onVPointerDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const m = metrics();
        const trackH = vTrack.clientHeight;
        const thumbH = vThumb.offsetHeight;
        const maxTop = Math.max(0, trackH - thumbH);
        const rect = vTrack.getBoundingClientRect();
        const y = e.clientY - rect.top - thumbH / 2;
        const top = clamp(y, 0, maxTop);
        viewport.scrollTop = maxTop > 0 ? (top / maxTop) * m.maxY : 0;
        drag = { axis: 'y', start: e.clientY, scroll: viewport.scrollTop };
        vThumb.classList.add('firm-scroll-dragging');
        try { vThumb.setPointerCapture(e.pointerId); } catch (_) {}
    }
    function onHPointerDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const m = metrics();
        const trackW = hTrack.clientWidth;
        const thumbW = hThumb.offsetWidth;
        const maxLeft = Math.max(0, trackW - thumbW);
        const rect = hTrack.getBoundingClientRect();
        const x = e.clientX - rect.left - thumbW / 2;
        const left = clamp(x, 0, maxLeft);
        viewport.scrollLeft = maxLeft > 0 ? (left / maxLeft) * m.maxX : 0;
        drag = { axis: 'x', start: e.clientX, scroll: viewport.scrollLeft };
        hThumb.classList.add('firm-scroll-dragging');
        try { hThumb.setPointerCapture(e.pointerId); } catch (_) {}
    }
    function onPointerMove(e) {
        if (!drag) return;
        const m = metrics();
        if (drag.axis === 'y' && vTrack) {
            const trackH = vTrack.clientHeight;
            const thumbH = vThumb.offsetHeight;
            const maxTop = Math.max(0, trackH - thumbH);
            const dy = e.clientY - drag.start;
            viewport.scrollTop = clamp(drag.scroll + (maxTop > 0 ? (dy / maxTop) * m.maxY : 0), 0, m.maxY);
        } else if (drag.axis === 'x' && hTrack) {
            const trackW = hTrack.clientWidth;
            const thumbW = hThumb.offsetWidth;
            const maxLeft = Math.max(0, trackW - thumbW);
            const dx = e.clientX - drag.start;
            viewport.scrollLeft = clamp(drag.scroll + (maxLeft > 0 ? (dx / maxLeft) * m.maxX : 0), 0, m.maxX);
        }
    }
    function onPointerUp() {
        if (!drag) return;
        vThumb?.classList.remove('firm-scroll-dragging');
        hThumb?.classList.remove('firm-scroll-dragging');
        drag = null;
    }

    viewport.addEventListener('scroll', onScroll, { passive: true });
    vThumb?.addEventListener('pointerdown', onVPointerDown);
    hThumb?.addEventListener('pointerdown', onHPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => update()) : null;
    try { ro?.observe(viewport); } catch (_) {}
    try { if (viewport.firstElementChild) ro?.observe(viewport.firstElementChild); } catch (_) {}

    requestAnimationFrame(update);

    const api = {
        update,
        destroy() {
            viewport.removeEventListener('scroll', onScroll);
            vThumb?.removeEventListener('pointerdown', onVPointerDown);
            hThumb?.removeEventListener('pointerdown', onHPointerDown);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            try { ro?.disconnect(); } catch (_) {}
            vTrack?.remove();
            hTrack?.remove();
            viewport.classList.remove('firm-scroll-viewport');
            INSTANCES.delete(viewport);
            try { INSTANCES.delete(host); } catch (_) {}
        }
    };
    INSTANCES.set(viewport, api);
    INSTANCES.set(host, api);
    return api;
}

export function updateFirmScroll(el) {
    if (!el) return;
    const api = INSTANCES.get(el) || INSTANCES.get(el.querySelector?.('.firm-scroll-inner'));
    try { api?.update(); } catch (_) {}
}
