/**
 * HUD 2D-карты: линейка масштаба, высотомер зума, dev-переключатель тумана.
 */
import { t } from './settings.js';
import {
    getMapView,
    diameterKmOf,
    setFogDisabled,
    isFogDisabled
} from './cartographyMap.js';

const MAX_ZOOM = 64;
const MIN_ZOOM = 1;

let bodyRef = null;
let chord = { ctrl: false, d: false, seven: false };

function $(id) {
    return document.getElementById(id);
}

/** «Красивое» число для линейки: 1, 2, 5 × 10^n */
function niceScale(km) {
    if (!(km > 0) || !Number.isFinite(km)) return { value: 1, unit: 'км' };
    const targets = [1, 2, 5];
    const exp = Math.floor(Math.log10(km));
    const base = Math.pow(10, exp);
    let best = targets[0] * base;
    let bestDiff = Infinity;
    for (let e = exp - 1; e <= exp + 1; e++) {
        const b = Math.pow(10, e);
        for (const t of targets) {
            const v = t * b;
            const d = Math.abs(v - km);
            if (d < bestDiff) {
                bestDiff = d;
                best = v;
            }
        }
    }
    if (best < 1) {
        return { value: Math.max(1, Math.round(best * 1000)), unit: 'м' };
    }
    if (best >= 1000) {
        return { value: Math.round(best / 1000 * 10) / 10, unit: 'тыс. км' };
    }
    return { value: best >= 10 ? Math.round(best) : Math.round(best * 10) / 10, unit: 'км' };
}

/**
 * Обновить линейку (слева-внизу контейнера карты).
 * Масштаб: доля viewW от экваториальной окружности тела.
 */
export function updateCartographyScale(body = bodyRef) {
    const el = $('carto-scale');
    const bar = $('carto-scale-bar');
    const label = $('carto-scale-label');
    if (!el || !bar || !label) return;
    bodyRef = body || bodyRef;
    const canvas = $('carto-canvas');
    if (!canvas || !bodyRef) {
        label.textContent = '—';
        return;
    }
    const v = getMapView();
    const zoom = Math.max(MIN_ZOOM, Number(v.zoom) || 1);
    // ширина видимой доли карты по долготе
    const fullAspect = 2;
    let viewH = 1 / zoom;
    let viewW = viewH * (canvas.width / Math.max(1, canvas.height)) / fullAspect;
    if (viewW > 1) {
        viewW = 1;
        viewH = viewW * fullAspect * (canvas.height / Math.max(1, canvas.width));
    }
    const circ = Math.PI * diameterKmOf(bodyRef);
    const kmAcrossScreen = viewW * circ;
    // целевая длина линейки ~ 80–120 px
    const targetPx = 100;
    const kmAtTarget = kmAcrossScreen * (targetPx / Math.max(1, canvas.width));
    const nice = niceScale(kmAtTarget);
    // обратный пересчёт ширины бара в px
    let kmShown = nice.value;
    if (nice.unit === 'м') kmShown = nice.value / 1000;
    if (nice.unit === 'тыс. км') kmShown = nice.value * 1000;
    const px = Math.max(24, Math.min(160, (kmShown / Math.max(1e-9, kmAcrossScreen)) * canvas.width));
    bar.style.width = `${px.toFixed(1)}px`;
    label.textContent = `${nice.value} ${nice.unit}`;
}

/** Высотомер зума (справа) */
export function updateCartographyAltimeter() {
    const fill = $('carto-alt-fill');
    const val = $('carto-alt-value');
    if (!fill || !val) return;
    const v = getMapView();
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(v.zoom) || 1));
    // 1× внизу, 64× вверху
    const t01 = (Math.log(z) - Math.log(MIN_ZOOM)) / (Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM));
    const pct = Math.max(0, Math.min(1, t01)) * 100;
    fill.style.height = `${pct}%`;
    val.textContent = `${z.toFixed(1)}×`;
}

export function refreshCartographyHud(body) {
    if (body) bodyRef = body;
    updateCartographyScale(bodyRef);
    updateCartographyAltimeter();
}

function onKeyDown(e) {
    if (e.key === 'Control') chord.ctrl = true;
    if (e.key === 'd' || e.key === 'D' || e.code === 'KeyD') chord.d = true;
    if (e.key === '7' || e.code === 'Digit7' || e.code === 'Numpad7') chord.seven = true;

    if (chord.ctrl && chord.d && chord.seven) {
        // только если открыта картография
        const panel = $('cartography-panel');
        if (panel && panel.style.display !== 'none') {
            const next = !isFogDisabled();
            setFogDisabled(next);
            const badge = $('carto-fog-dev');
            if (badge) {
                badge.style.display = next ? 'block' : 'none';
                badge.textContent = t('carto.fogOff') || 'Туман: ВЫКЛ';
            }
            e.preventDefault();
        }
        // сброс чтобы не триггерить каждый кадр
        chord.d = false;
        chord.seven = false;
    }
}

function onKeyUp(e) {
    if (e.key === 'Control') chord.ctrl = false;
    if (e.key === 'd' || e.key === 'D' || e.code === 'KeyD') chord.d = false;
    if (e.key === '7' || e.code === 'Digit7' || e.code === 'Numpad7') chord.seven = false;
}

export function initCartographyHud() {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
}

export { MAX_ZOOM, MIN_ZOOM };
