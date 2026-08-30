/**
 * 2D-карта небесного тела: текстура, соты, туман, день/ночь, маркеры, pan/zoom.
 * Координаты: долгота −180…180, широта −90…90 (для Святой Руси ≈ Земля).
 */
import { state } from './state.js';
import { timeSpeed as uiTimeSpeed } from './ui.js';

const HEX_LETTERS = 'АБВГДЕЖЗИЙК';  // морской бой: А–К, без Ё

/** @type {HTMLCanvasElement|null} */
let canvas = null;
/** @type {CanvasRenderingContext2D|null} */
let ctx = null;
/** @type {HTMLElement|null} */
let host = null;

const MAP_MAX_ZOOM = 64;
const MAP_MIN_ZOOM = 1;

let view = { zoom: MAP_MAX_ZOOM, panX: 0.5, panY: 0.5 }; // pan 0..1 centre of view in map UV
let targetZoom = MAP_MAX_ZOOM;
let fogDisabled = false;
let dragging = false;
let lastMx = 0, lastMy = 0;
let cursorLon = 0, cursorLat = 0;
let mapReady = false;

/** textures */
const tex = { surface: null, specular: null, clouds: null, lights: null };
/** кэш иконок маркеров ресурсов */
const iconCache = new Map();
let bodyRef = null;
let cloudOffset = 0;
let cursorInsideMap = false;

/** fog: OffscreenCanvas or canvas, 1 = fogged, 0 = clear */
let fogCanvas = null;
let fogCtx = null;
const FOG_RES = 512;

let markers = []; // {type, id, lon, lat, icon, label, meta}
let pathLine = null; // {from, to, pulse:boolean, style?:string}
let missionPaths = []; // persistent [{from,to,style:'mine'}]
let pickMode = false;
let onPickCoord = null;
let pickFrom = null; // {lon,lat} origin while picking
let onMarkerClick = null;
let onBackgroundClick = null;
let animId = 0;

/** hover / stack layout */
const CLUSTER_PX = 26;
const STACK_GAP = 24;
let hoverMarkerKey = null;
/** @type {Map<string, number>} key → scale 1..1.4 */
const hoverScaleMap = new Map();
/** last frame layout for hit-test: [{key, m, x, y}] */
let lastLayout = [];

function markerKey(m) {
    return `${m.type || 'x'}:${m.id != null ? m.id : `${m.lon},${m.lat}`}`;
}

export function getMapView() { return { ...view, cursorLon, cursorLat }; }
export function isPickMode() { return pickMode; }

export function setPickMode(on, cb = null, from = null) {
    pickMode = !!on;
    onPickCoord = on ? cb : null;
    pickFrom = on && from ? from : null;
    if (canvas) canvas.style.cursor = on ? 'crosshair' : 'grab';
    if (!on) pickFrom = null;
}

export function setPathLine(from, to, pulse = false, style = null) {
    pathLine = from && to ? { from, to, pulse: !!pulse, style: style || null } : null;
}

export function setFogDisabled(off) {
    fogDisabled = !!off;
}

export function isFogDisabled() {
    return fogDisabled;
}

/** Постоянные маршруты миссий (добыча и т.п.) — рисуются всегда */
export function setMissionPaths(list) {
    missionPaths = Array.isArray(list) ? list : [];
}

/** Зелёная круговая стрелка на конце вектора добычи */
function drawMineEndArrow(ctx, x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    // кольцо
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(60, 220, 120, 0.95)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // внутренняя дуга-стрелка
    ctx.beginPath();
    ctx.arc(0, 0, 5.5, -0.9, 0.9);
    ctx.strokeStyle = 'rgba(120, 255, 160, 0.95)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // наконечник
    ctx.beginPath();
    ctx.moveTo(5.2, 4.2);
    ctx.lineTo(8.5, 0.2);
    ctx.lineTo(4.0, -1.2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(100, 255, 150, 0.95)';
    ctx.fill();
    ctx.restore();
}

function drawPathSegment(ctx, a, b, style, pulse) {
    if (!a || !b) return;
    const isMine = style === 'mine';
    const isReturn = style === 'return';
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    if (isMine) {
        g.addColorStop(0, 'rgba(40, 200, 100, 0.95)');
        g.addColorStop(1, 'rgba(40, 200, 100, 0.25)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([8, 5]);
    } else if (isReturn) {
        g.addColorStop(0, 'rgba(255, 190, 70, 0.95)');
        g.addColorStop(1, 'rgba(255, 190, 70, 0.22)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 2.25;
        ctx.setLineDash([7, 5]);
    } else {
        g.addColorStop(0, 'rgba(0,200,255,0.95)');
        g.addColorStop(1, 'rgba(0,200,255,0.2)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 2.25;
        ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (isMine) {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        drawMineEndArrow(ctx, a.x, a.y, ang + Math.PI);
        drawMineEndArrow(ctx, b.x, b.y, ang);
    } else {
        let sz = 7;
        if (pulse) {
            const p = 0.5 + 0.5 * Math.sin(performance.now() / 220);
            sz = 6 + p * 5;
        }
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 220, 80, 0.95)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x - sz, b.y - sz, sz * 2, sz * 2);
        ctx.strokeStyle = 'rgba(255, 220, 80, 0.35)';
        ctx.strokeRect(b.x - sz * 1.45, b.y - sz * 1.45, sz * 2.9, sz * 2.9);
        ctx.restore();
    }
}

/** Центр вида на lon/lat и зум (1–64) */
export function focusMapOn(lon, lat, zoom = MAP_MAX_ZOOM) {
    targetZoom = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, zoom));
    view.zoom = targetZoom;
    const { u, v } = lonLatToUv(lon, lat);
    view.panX = ((u % 1) + 1) % 1;
    // clamp panY to view window
    const fullAspect = 2;
    let viewH = 1 / view.zoom;
    if (canvas) {
        let viewW = viewH * (canvas.width / canvas.height) / fullAspect;
        if (viewW > 1) {
            viewW = 1;
            viewH = viewW * fullAspect * (canvas.height / canvas.width);
        }
        viewH = Math.min(1, viewH);
        view.panY = Math.max(viewH / 2, Math.min(1 - viewH / 2, v));
    } else {
        view.panY = Math.max(0.05, Math.min(0.95, v));
    }
}

/** % открытой карты (по альфе тумана: 0 = открыто) */
export function getFogRevealedPercent() {
    ensureFog();
    try {
        const data = fogCtx.getImageData(0, 0, FOG_RES, FOG_RES).data;
        let clear = 0;
        const n = FOG_RES * FOG_RES;
        // sample every 4th pixel for speed
        for (let i = 3; i < data.length; i += 16) {
            if (data[i] < 120) clear++;
        }
        const samples = Math.floor(data.length / 16);
        return Math.max(0, Math.min(100, (clear / Math.max(1, samples)) * 100));
    } catch (_) {
        return 0;
    }
}

export function setMarkers(list) {
    markers = Array.isArray(list) ? list : [];
}

export function setMarkerClickHandler(fn) {
    onMarkerClick = fn;
}

export function setBackgroundClickHandler(fn) {
    onBackgroundClick = fn;
}

export function diameterKmOf(body) {
    const d = Number(body?.data?.diameterKm);
    if (Number.isFinite(d) && d > 0) return d;
    // fallbacks
    const id = body?.data?.id;
    if (id === 3) return 12742;
    if (id === 4) return 3474.8;
    return 10000;
}

export function circumferenceKm(body) {
    return Math.PI * diameterKmOf(body);
}

/** km → fraction of map width (equator) */
export function kmToMapFrac(body, km) {
    return km / circumferenceKm(body);
}

export function lonLatToUv(lon, lat) {
    const u = (lon + 180) / 360;
    const v = (90 - lat) / 180;
    return { u, v };
}

export function uvToLonLat(u, v) {
    // seamless u
    let uu = u - Math.floor(u);
    const lon = uu * 360 - 180;
    const lat = 90 - Math.max(0, Math.min(1, v)) * 180;
    return { lon, lat };
}

function loadImage(src) {
    return new Promise((resolve) => {
        if (!src) return resolve(null);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

function ensureFog() {
    if (fogCanvas) return;
    fogCanvas = document.createElement('canvas');
    fogCanvas.width = FOG_RES;
    fogCanvas.height = FOG_RES;
    fogCtx = fogCanvas.getContext('2d');
    // full fog
    fogCtx.fillStyle = '#000';
    fogCtx.fillRect(0, 0, FOG_RES, FOG_RES);
}

/** clear circle in fog at lon/lat with radiusKm */
export function revealFog(body, lon, lat, radiusKm) {
    ensureFog();
    const { u, v } = lonLatToUv(lon, lat);
    const r = kmToMapFrac(body, radiusKm) * FOG_RES;
    const x = u * FOG_RES;
    const y = v * FOG_RES;
    fogCtx.globalCompositeOperation = 'destination-out';
    // seamless: draw at x and x±FOG_RES
    for (const ox of [-FOG_RES, 0, FOG_RES]) {
        const g = fogCtx.createRadialGradient(x + ox, y, 0, x + ox, y, Math.max(1, r));
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(0.7, 'rgba(0,0,0,0.85)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        fogCtx.fillStyle = g;
        fogCtx.beginPath();
        fogCtx.arc(x + ox, y, Math.max(1, r), 0, Math.PI * 2);
        fogCtx.fill();
    }
    fogCtx.globalCompositeOperation = 'source-over';
}

export function resetFogFull() {
    ensureFog();
    fogCtx.globalCompositeOperation = 'source-over';
    fogCtx.fillStyle = '#000';
    fogCtx.fillRect(0, 0, FOG_RES, FOG_RES);
}

export function exportFogData() {
    ensureFog();
    return fogCanvas.toDataURL('image/png');
}

export function importFogData(dataUrl) {
    ensureFog();
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
        fogCtx.globalCompositeOperation = 'source-over';
        fogCtx.clearRect(0, 0, FOG_RES, FOG_RES);
        fogCtx.drawImage(img, 0, 0, FOG_RES, FOG_RES);
    };
    img.src = dataUrl;
}

export async function loadBodyTextures(body) {
    bodyRef = body;
    const d = body?.data || {};
    const [s, sp, c, l] = await Promise.all([
        loadImage(d.texture),
        loadImage(d.specularMap),
        loadImage(d.cloudMap),
        loadImage(d.cityLightsMap)
    ]);
    tex.surface = s;
    tex.specular = sp;
    tex.clouds = c;
    tex.lights = l;
    mapReady = !!s;
    return mapReady;
}

function sunLonFromBody(body) {
    // синхрон с 3D: угол вращения mesh + орбитальный свет ≈ -rotation.y * 180/π
    try {
        const ry = body?.mesh?.rotation?.y;
        if (Number.isFinite(ry)) {
            let lon = -ry * (180 / Math.PI);
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            return lon;
        }
    } catch (_) {}
    // fallback по игровому времени
    const t = state.gameTime || {};
    const hours = (t.hour || 0) + (t.minute || 0) / 60;
    return (hours / 24) * 360 - 180;
}

function canvasToMapUv(cx, cy) {
    if (!canvas) return { u: 0.5, v: 0.5 };
    const rect = canvas.getBoundingClientRect();
    const x = (cx - rect.left) / rect.width;
    const y = (cy - rect.top) / rect.height;
    const aspect = canvas.width / canvas.height;
    const visW = 1 / view.zoom;
    const visH = (1 / view.zoom) / (aspect / 2); // equirect 2:1
    const visH2 = Math.min(1, 1 / view.zoom);
    const visW2 = Math.min(1, (canvas.width / canvas.height) * visH2 / 2) * (2 / (canvas.width / canvas.height));
    // simpler: map shows full equirect scaled by zoom, pan is centre
    const fullAspect = 2; // lon:lat
    let viewH = 1 / view.zoom;
    let viewW = viewH * (canvas.width / canvas.height) / fullAspect;
    if (viewW > 1) { viewW = 1; viewH = viewW * fullAspect * (canvas.height / canvas.width); }
    const u0 = view.panX - viewW / 2;
    const v0 = view.panY - viewH / 2;
    return {
        u: u0 + x * viewW,
        v: Math.max(0, Math.min(1, v0 + y * viewH))
    };
}

function viewWindow() {
    if (!canvas) return { u0: 0, v0: 0, viewW: 1, viewH: 1 };
    const fullAspect = 2;
    let viewH = 1 / view.zoom;
    let viewW = viewH * (canvas.width / canvas.height) / fullAspect;
    if (viewW > 1) {
        viewW = 1;
        viewH = viewW * fullAspect * (canvas.height / canvas.width);
    }
    viewH = Math.min(1, viewH);
    let u0 = view.panX - viewW / 2;
    let v0 = Math.max(0, Math.min(1 - viewH, view.panY - viewH / 2));
    return { u0, v0, viewW, viewH };
}

function drawSeamless(img, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (!img) return;
    // sx may be outside 0..img.width — wrap
    const iw = img.width;
    let sxx = ((sx % iw) + iw) % iw;
    if (sxx + sw <= iw) {
        ctx.drawImage(img, sxx, sy, sw, sh, dx, dy, dw, dh);
    } else {
        const w1 = iw - sxx;
        const w2 = sw - w1;
        ctx.drawImage(img, sxx, sy, w1, sh, dx, dy, dw * (w1 / sw), dh);
        ctx.drawImage(img, 0, sy, w2, sh, dx + dw * (w1 / sw), dy, dw * (w2 / sw), dh);
    }
}

function drawMap() {
    if (!ctx || !canvas) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05080c';
    ctx.fillRect(0, 0, W, H);

    const { u0, v0, viewW, viewH } = viewWindow();
    const img = tex.surface;

    if (img) {
        const sx = u0 * img.width;
        const sy = v0 * img.height;
        const sw = viewW * img.width;
        const sh = viewH * img.height;
        drawSeamless(img, sx, sy, sw, sh, 0, 0, W, H);

        // day/night terminator
        const sunLon = sunLonFromBody(bodyRef);
        const sunU = (sunLon + 180) / 360;
        // soft night overlay
        const grd = ctx.createLinearGradient(0, 0, W, 0);
        // map u across view
        for (let i = 0; i <= 8; i++) {
            const t = i / 8;
            const u = u0 + t * viewW;
            const uu = u - Math.floor(u);
            let d = Math.abs(uu - sunU);
            if (d > 0.5) d = 1 - d;
            // day when close to sunU in longitude sense: actually day is hemisphere
            // angle from sun: (uu - sunU) * 360
            let ang = (uu - sunU) * 360;
            while (ang > 180) ang -= 360;
            while (ang < -180) ang += 360;
            const night = Math.max(0, Math.min(1, (Math.abs(ang) - 70) / 40));
            grd.addColorStop(t, `rgba(0,4,18,${0.72 * night})`);
        }
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, W, H);

        // city lights on night side
        if (tex.lights) {
            ctx.save();
            ctx.globalAlpha = 0.85;
            ctx.globalCompositeOperation = 'screen';
            drawSeamless(tex.lights, sx, sy, sw, sh, 0, 0, W, H);
            ctx.globalCompositeOperation = 'destination-in';
            // only night
            const ng = ctx.createLinearGradient(0, 0, W, 0);
            for (let i = 0; i <= 8; i++) {
                const t = i / 8;
                const u = u0 + t * viewW;
                const uu = u - Math.floor(u);
                let ang = (uu - sunU) * 360;
                while (ang > 180) ang -= 360;
                while (ang < -180) ang += 360;
                const night = Math.max(0, Math.min(1, (Math.abs(ang) - 60) / 50));
                ng.addColorStop(t, `rgba(255,255,255,${night})`);
            }
            // can't easily destination-in with gradient on same canvas path — approximate full lights * lower alpha
            ctx.restore();
            ctx.save();
            ctx.globalAlpha = 0.35;
            ctx.globalCompositeOperation = 'screen';
            drawSeamless(tex.lights, sx, sy, sw, sh, 0, 0, W, H);
            ctx.restore();
        }

        // clouds scroll
        if (tex.clouds) {
            const cloudAlpha = Math.max(0.08, 0.55 - (view.zoom - 1) * 0.15);
            ctx.save();
            ctx.globalAlpha = cloudAlpha;
            const cOff = cloudOffset * img.width;
            drawSeamless(tex.clouds, sx + cOff, sy, sw, sh, 0, 0, W, H);
            ctx.restore();
        }

        // specular hint (day)
        if (tex.specular) {
            ctx.save();
            ctx.globalAlpha = 0.18;
            ctx.globalCompositeOperation = 'screen';
            drawSeamless(tex.specular, sx, sy, sw, sh, 0, 0, W, H);
            ctx.restore();
        }
    }

    // fog of war (можно отключить Ctrl+D+7 для тестов)
    if (!fogDisabled) {
        ensureFog();
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        const fu0 = ((u0 % 1) + 1) % 1;
        const fw = viewW;
        if (fu0 + fw <= 1) {
            ctx.drawImage(fogCanvas, fu0 * FOG_RES, v0 * FOG_RES, fw * FOG_RES, viewH * FOG_RES, 0, 0, W, H);
        } else {
            const w1 = 1 - fu0;
            const w2 = fw - w1;
            ctx.drawImage(fogCanvas, fu0 * FOG_RES, v0 * FOG_RES, w1 * FOG_RES, viewH * FOG_RES, 0, 0, W * (w1 / fw), H);
            ctx.drawImage(fogCanvas, 0, v0 * FOG_RES, w2 * FOG_RES, viewH * FOG_RES, W * (w1 / fw), 0, W * (w2 / fw), H);
        }
        ctx.restore();
    }

    // соты ПОВЕРХ тумана (как в ТЗ: туман скрывает всё кроме секторов)
    drawHexGrid(u0, v0, viewW, viewH, W, H);

    // постоянные маршруты добычи (зелёные)
    for (const mp of missionPaths) {
        if (!mp?.from || !mp?.to) continue;
        const a = lonLatToScreen(mp.from.lon, mp.from.lat, u0, v0, viewW, viewH, W, H);
        const b = lonLatToScreen(mp.to.lon, mp.to.lat, u0, v0, viewW, viewH, W, H);
        drawPathSegment(ctx, a, b, mp.style || 'mine', false);
    }

    // path выбора (поверх)
    if (pathLine) {
        const a = lonLatToScreen(pathLine.from.lon, pathLine.from.lat, u0, v0, viewW, viewH, W, H);
        const b = lonLatToScreen(pathLine.to.lon, pathLine.to.lat, u0, v0, viewW, viewH, W, H);
        drawPathSegment(ctx, a, b, pathLine.style || null, pathLine.pulse);
    }

    // маркеры: кластеризация близких + стек + hover-scale + target
    const layout = buildMarkerLayout(u0, v0, viewW, viewH, W, H);
    lastLayout = layout;
    // плавный scale к hover
    for (const it of layout) {
        const key = it.key;
        const want = (hoverMarkerKey === key) ? 1.38 : 1;
        const cur = hoverScaleMap.get(key) ?? 1;
        const next = cur + (want - cur) * 0.22;
        hoverScaleMap.set(key, Math.abs(next - want) < 0.005 ? want : next);
        it.scale = hoverScaleMap.get(key);
    }
    // prune scales
    if (hoverScaleMap.size > layout.length + 8) {
        const keep = new Set(layout.map(x => x.key));
        for (const k of [...hoverScaleMap.keys()]) {
            if (!keep.has(k) && (hoverScaleMap.get(k) || 1) <= 1.01) hoverScaleMap.delete(k);
        }
    }
    const labelJobs = [];
    for (const it of layout) {
        drawMarkerIcon(it.x, it.y, it.m, it.scale);
        if (hoverMarkerKey === it.key) drawHoverTarget(it.x, it.y, it.scale);
        if (it.m.label) labelJobs.push({ x: it.x, y: it.y, label: it.m.label, type: it.m.type, scale: it.scale });
    }
    drawMarkerLabels(labelJobs);
}

/**
 * Группирует маркеры почти в одной точке → вертикальный стек.
 * @returns {{key:string,m:object,x:number,y:number,scale:number}[]}
 */
function buildMarkerLayout(u0, v0, viewW, viewH, W, H) {
    const items = [];
    const seenKey = new Set();
    for (const m of markers) {
        const key = markerKey(m);
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        const scr = lonLatToScreen(m.lon, m.lat, u0, v0, viewW, viewH, W, H);
        if (!scr) continue;
        if (!isRevealed(m.lon, m.lat) && m.type !== 'structure' && m.type !== 'resource') continue;
        if (m.type === 'resource' && !isRevealed(m.lon, m.lat)) continue;
        items.push({
            key,
            m,
            x: scr.x,
            y: scr.y,
            baseX: scr.x,
            baseY: scr.y,
            scale: 1
        });
    }
    // кластеры по близости: транзитивное объединение
    const n = items.length;
    const parent = items.map((_, i) => i);
    const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
    const uni = (a, b) => {
        a = find(a); b = find(b);
        if (a !== b) parent[b] = a;
    };
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (Math.hypot(items[i].baseX - items[j].baseX, items[i].baseY - items[j].baseY) <= CLUSTER_PX) {
                uni(i, j);
            }
        }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(items[i]);
    }
    const rank = (t) => (t === 'structure' ? 0 : t === 'unit' ? 1 : 2);
    for (const cluster of groups.values()) {
        if (cluster.length <= 1) continue;
        cluster.sort((a, b) => rank(a.m.type) - rank(b.m.type) || String(a.key).localeCompare(String(b.key)));
        const cx = cluster.reduce((s, c) => s + c.baseX, 0) / cluster.length;
        const cy = cluster.reduce((s, c) => s + c.baseY, 0) / cluster.length;
        const total = (cluster.length - 1) * STACK_GAP;
        cluster.forEach((it, idx) => {
            it.x = cx;
            it.y = cy - total / 2 + idx * STACK_GAP;
        });
    }
    return items;
}

function drawHoverTarget(x, y, scale = 1) {
    const r = 14 * scale;
    const t = performance.now() * 0.004;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = `rgba(0, 220, 230, ${0.55 + 0.25 * Math.sin(t)})`;
    ctx.lineWidth = 1.5;
    // скошенный квадрат-таргет
    const s = r;
    ctx.beginPath();
    ctx.moveTo(-s + 4, -s);
    ctx.lineTo(s, -s);
    ctx.lineTo(s, s - 4);
    ctx.lineTo(s - 4, s);
    ctx.lineTo(-s, s);
    ctx.lineTo(-s, -s + 4);
    ctx.closePath();
    ctx.stroke();
    // углы
    ctx.beginPath();
    ctx.moveTo(-s, -s + 6); ctx.lineTo(-s, -s); ctx.lineTo(-s + 6, -s);
    ctx.moveTo(s - 6, -s); ctx.lineTo(s, -s); ctx.lineTo(s, -s + 6);
    ctx.moveTo(s, s - 6); ctx.lineTo(s, s); ctx.lineTo(s - 6, s);
    ctx.moveTo(-s + 6, s); ctx.lineTo(-s, s); ctx.lineTo(-s, s - 6);
    ctx.stroke();
    ctx.restore();
}

function isRevealed(lon, lat) {
    if (fogDisabled) return true;
    ensureFog();
    const { u, v } = lonLatToUv(lon, lat);
    const x = Math.floor((((u % 1) + 1) % 1) * FOG_RES);
    const y = Math.floor(Math.max(0, Math.min(0.999, v)) * FOG_RES);
    const pix = fogCtx.getImageData(x, y, 1, 1).data;
    return pix[3] < 120; // fog drawn black opaque; destination-out lowers alpha
}

function lonLatToScreen(lon, lat, u0, v0, viewW, viewH, W, H) {
    let { u, v } = lonLatToUv(lon, lat);
    // choose nearest seam relative to view centre
    let uu = u;
    const mid = u0 + viewW / 2;
    while (uu < mid - 0.5) uu += 1;
    while (uu > mid + 0.5) uu -= 1;
    if (uu < u0 || uu > u0 + viewW || v < v0 || v > v0 + viewH) return null;
    return {
        x: ((uu - u0) / viewW) * W,
        y: ((v - v0) / viewH) * H
    };
}

function getMarkerIcon(src) {
    if (!src) return null;
    if (iconCache.has(src)) return iconCache.get(src);
    const img = new Image();
    img.src = src;
    iconCache.set(src, img);
    return img;
}

function drawMarkerIcon(x, y, m, scale = 1) {
    const s = 18 * (scale || 1);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    if (m.type === 'structure') {
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.55);
        ctx.lineTo(s * 0.5, 0);
        ctx.lineTo(0, s * 0.55);
        ctx.lineTo(-s * 0.5, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    } else if (m.type === 'unit') {
        const img = m.icon ? getMarkerIcon(m.icon) : null;
        if (img && img.complete && img.naturalWidth) {
            const sz = s * 1.2;
            ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz);
        } else {
            ctx.beginPath();
            ctx.arc(0, 0, s * 0.38, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    } else if (m.type === 'resource') {
        const img = m.icon ? getMarkerIcon(m.icon) : null;
        if (img && img.complete && img.naturalWidth) {
            const sz = s * 1.15;
            ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz);
        } else {
            ctx.fillStyle = 'rgba(168, 212, 240, 0.95)';
            ctx.strokeStyle = 'rgba(40, 100, 140, 0.85)';
            ctx.beginPath();
            ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    } else {
        ctx.fillRect(-s * 0.35, -s * 0.35, s * 0.7, s * 0.7);
        ctx.strokeRect(-s * 0.35, -s * 0.35, s * 0.7, s * 0.7);
    }
    ctx.restore();
}

/**
 * Подписи маркеров: разводим по вертикали, если на одной линии / перекрываются.
 */
function drawMarkerLabels(jobs) {
    if (!jobs.length) return;
    // слева направо, сверху вниз — стабильный порядок
    jobs.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const placed = []; // {x, y, w, h}
    const padX = 11;
    const lineH = 13;
    ctx.save();
    ctx.font = '10px Play, sans-serif';
    for (const j of jobs) {
        const text = String(j.label);
        const tw = Math.ceil(ctx.measureText(text).width);
        let lx = j.x + padX;
        let ly = j.y + 4;
        // поднять/опустить, пока не пересечётся с уже занятыми
        let guard = 0;
        while (guard++ < 24) {
            let hit = false;
            for (const p of placed) {
                if (lx < p.x + p.w + 4 && lx + tw + 4 > p.x
                    && ly < p.y + p.h && ly + lineH > p.y) {
                    hit = true;
                    break;
                }
            }
            if (!hit) break;
            // чередуем: вверх, вниз, дальше вверх…
            const step = (guard % 2 === 1) ? -lineH : lineH * Math.ceil(guard / 2);
            ly = j.y + 4 + step;
        }
        placed.push({ x: lx, y: ly - lineH + 3, w: tw + 6, h: lineH });
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = 'rgba(220,240,255,0.95)';
        ctx.textBaseline = 'middle';
        ctx.strokeText(text, lx, ly);
        ctx.fillText(text, lx, ly);
    }
    ctx.restore();
}

/** @deprecated use drawMarkerIcon + drawMarkerLabels */
function drawMarker(x, y, m) {
    drawMarkerIcon(x, y, m);
    if (m.label) drawMarkerLabels([{ x, y, label: m.label, type: m.type }]);
}

/**
 * Квадратная сетка в UV карты: 11×10 (А–К × 1–10), без зазоров.
 * Размер клеток растёт с зумом. Имена уникальны: А1…К10.
 */
function drawHexGrid(u0, v0, viewW, viewH, W, H) {
    const COLS = HEX_LETTERS.length; // 11: А…К без Ё
    const ROWS = 10;
    const cellU = 1 / COLS;
    const cellV = 1 / ROWS;

    ctx.save();
    ctx.lineWidth = 1;
    const labeled = new Set();

    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const u1 = col * cellU;
            const u2 = (col + 1) * cellU;
            const v1 = row * cellV;
            const v2 = (row + 1) * cellV;

            // seamless: рисуем копии по ±1 по долготе
            for (const ou of [-1, 0, 1]) {
                let left = u1 + ou;
                let right = u2 + ou;
                // сдвиг к окну
                const mid = u0 + viewW / 2;
                while (right < mid - 0.5) { left += 1; right += 1; }
                while (left > mid + 0.5) { left -= 1; right -= 1; }

                if (right < u0 || left > u0 + viewW) continue;
                if (v2 < v0 || v1 > v0 + viewH) continue;

                const x1 = ((left - u0) / viewW) * W;
                const x2 = ((right - u0) / viewW) * W;
                const y1 = ((v1 - v0) / viewH) * H;
                const y2 = ((v2 - v0) / viewH) * H;
                const rw = x2 - x1;
                const rh = y2 - y1;
                if (rw < 0.5 || rh < 0.5) continue;

                // только тонкая обводка (без заливки), прозрачность бордера ÷4
                ctx.strokeStyle = 'rgba(140, 200, 220, 0.055)';
                ctx.strokeRect(x1 + 0.5, y1 + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));

                // подпись: в 2 раза прозрачнее
                const key = `${col}:${row}`;
                if (!labeled.has(key) && x1 < W && x2 > 0 && y1 < H && y2 > 0) {
                    labeled.add(key);
                    const name = `${HEX_LETTERS[col]}${row + 1}`;
                    ctx.font = '10px Play, sans-serif';
                    const tw = ctx.measureText(name).width + 8;
                    const bx = Math.max(2, x1 + 3);
                    const by = Math.max(2, y1 + 3);
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
                    ctx.fillRect(bx, by, tw, 13);
                    ctx.strokeStyle = 'rgba(30, 40, 45, 0.35)';
                    ctx.strokeRect(bx, by, tw, 13);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.48)';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(name, bx + 4, by + 7);
                    ctx.textBaseline = 'alphabetic';
                }
            }
        }
    }
    ctx.restore();
}



function tickClouds(dt) {
    let ts = 1;
    try { ts = Number(uiTimeSpeed); } catch (_) { ts = 1; }
    if (!Number.isFinite(ts) || ts <= 0) return; // 0x — облака стоят
    // медленный дрейф: при 1x ~1 оборот за ~10 мин реального времени
    const speed = ts * 0.0000025;
    cloudOffset = (cloudOffset + speed * Math.max(0, dt || 16)) % 1;
}

export function startMapLoop() {
    stopMapLoop();
    let last = performance.now();
    const loop = (now) => {
        animId = requestAnimationFrame(loop);
        const dt = now - last;
        last = now;
        // плавный догон targetZoom
        if (Math.abs(view.zoom - targetZoom) > 0.001) {
            const k = Math.min(1, (dt || 16) * 0.012);
            view.zoom = view.zoom + (targetZoom - view.zoom) * k;
        } else {
            view.zoom = targetZoom;
        }
        tickClouds(dt);
        drawMap();
    };
    animId = requestAnimationFrame(loop);
}

export function stopMapLoop() {
    if (animId) cancelAnimationFrame(animId);
    animId = 0;
}

export function attachMap(canvasEl, hostEl) {
    canvas = canvasEl;
    host = hostEl;
    ctx = canvas.getContext('2d');
    resize();
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('click', onClick);
}

export function detachMap() {
    stopMapLoop();
    if (!canvas) return;
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    canvas.removeEventListener('click', onClick);
}

export function resize() {
    if (!canvas || !host) return;
    const r = host.getBoundingClientRect();
    const w = Math.max(320, Math.floor(r.width));
    const h = Math.max(200, Math.floor(r.height));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
}

function onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    // зум к курсору: фиксируем UV под указателем
    const before = canvasToMapUv(e.clientX, e.clientY);
    const factor = e.deltaY > 0 ? (1 / 1.18) : 1.18; // плавнее, шаг чуть сильнее
    targetZoom = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, targetZoom * factor));
    // мгновенно подтягиваем чуть-чуть, остальное — в loop
    const prev = view.zoom;
    view.zoom = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, view.zoom * Math.pow(factor, 0.35)));
    // компенсируем pan, чтобы before UV остался под курсором
    const afterWin = viewWindow();
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    // UV под курсором после зума при том же pan:
    const uAt = view.panX - afterWin.viewW / 2 + nx * afterWin.viewW;
    const vAt = view.panY - afterWin.viewH / 2 + ny * afterWin.viewH;
    view.panX += before.u - uAt;
    view.panY += before.v - vAt;
    view.panX = ((view.panX % 1) + 1) % 1;
    const vh = afterWin.viewH;
    view.panY = Math.max(vh / 2, Math.min(1 - vh / 2, view.panY));
}

function onDown(e) {
    if (e.button !== 0) return;
    if (pickMode) return;
    dragging = true;
    lastMx = e.clientX;
    lastMy = e.clientY;
    canvas.style.cursor = 'grabbing';
}

function onMove(e) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right
        && e.clientY >= rect.top && e.clientY <= rect.bottom;
    cursorInsideMap = inside;
    // координаты обновляем только пока курсор над картой — иначе оставляем последние
    if (inside) {
        const uv = canvasToMapUv(e.clientX, e.clientY);
        const ll = uvToLonLat(uv.u, uv.v);
        cursorLon = ll.lon;
        cursorLat = ll.lat;
        if (pickMode && pickFrom) {
            setPathLine(pickFrom, { lon: ll.lon, lat: ll.lat }, true);
        }
        // hover по layout (учитывает стек)
        if (!dragging && !pickMode) {
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            let best = null;
            let bestD = 18;
            for (const it of lastLayout) {
                const d = Math.hypot(mx - it.x, my - it.y);
                const hitR = 14 * (it.scale || 1);
                if (d < hitR && d < bestD) {
                    bestD = d;
                    best = it.key;
                }
            }
            hoverMarkerKey = best;
            canvas.style.cursor = best ? 'pointer' : 'grab';
        }
    } else {
        hoverMarkerKey = null;
    }
    if (dragging) {
        hoverMarkerKey = null;
        const { viewW, viewH } = viewWindow();
        const dx = (e.clientX - lastMx) / rect.width;
        const dy = (e.clientY - lastMy) / rect.height;
        view.panX -= dx * viewW;
        view.panY = Math.max(viewH / 2, Math.min(1 - viewH / 2, view.panY - dy * viewH));
        // seamless panX
        view.panX = ((view.panX % 1) + 1) % 1;
        lastMx = e.clientX;
        lastMy = e.clientY;
    }
}

function onUp() {
    dragging = false;
    if (canvas) canvas.style.cursor = pickMode ? 'crosshair' : 'grab';
}

function onClick(e) {
    const uv = canvasToMapUv(e.clientX, e.clientY);
    const ll = uvToLonLat(uv.u, uv.v);
    if (pickMode && onPickCoord) {
        onPickCoord(ll.lon, ll.lat);
        return;
    }
    // hit по layout (стек / hover scale)
    if (onMarkerClick && lastLayout.length) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        let best = null;
        let bestD = 1e9;
        for (const it of lastLayout) {
            const d = Math.hypot(mx - it.x, my - it.y);
            const hitR = 16 * (it.scale || 1);
            if (d < hitR && d < bestD) {
                bestD = d;
                best = it.m;
            }
        }
        if (best) {
            onMarkerClick(best);
            return;
        }
    }
    if (onBackgroundClick) onBackgroundClick();
}

/** Haversine distance km on body */
export function distanceKm(body, lon1, lat1, lon2, lat2) {
    const R = diameterKmOf(body) / 2;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR;
    const dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
