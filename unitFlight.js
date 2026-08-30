/**
 * Полёт юнитов на карте: маркеры, маршрут, зоны, анимации взлёта/посадки.
 * Вынесено из technoport.js.
 */
import { state } from './state.js';
import { t } from './settings.js';
import {
    getUnitDef,
    unitDisplayName,
    findOrbitUnit,
    getAllOrbitUnits,
    isWithinLandingZone,
    isInYellowZone,
    bodyHasTechnoportBuilding,
    getUnitWorldPos,
    getGravityWellCellWorldSize,
    getWellFlightLimits,
    clampLocalToFlightRing,
    setFlightDestination,
    setSystemFlightDestination,
    stopUnitMotion,
    startLanding,
    getFlightPathLocal,
    getSystemArrivalLocal
} from './units.js';

let selectedUnitInstanceId = null;
let flightModeActive = false;
let systemFlightModeActive = false;
let systemHoverBodyId = null; // превью цели
let flightCursorLocal = null;
let markersRoot = null;
let flightOverlay = null;
let zonesRoot = null; // legacy HTML (скрыт)
let deselectAtMs = 0;
/** @type {Map<number, { land: THREE.Mesh, edge: THREE.Mesh }>} */
const flightZoneByBody = new Map();


export function getSelectedOrbitUnitId() {
    return selectedUnitInstanceId;
}

export function isFlightModeActive() {
    return flightModeActive;
}

export function initUnitFlightUI() {
    ensureMarkersRoot();
    ensureFlightOverlay();
    ensureZonesRoot();
    window.addEventListener('mousemove', onFlightMouseMove);
    window.addEventListener('mousedown', onFlightMouseDown, true);
    console.log('Unit flight UI ready');
}

export function selectOrbitUnit(instanceId) {
    if (instanceId) {
        const found = findOrbitUnit(instanceId);
        // нельзя выделить во время взлёта/посадки
        if (found && (found.unit.status === 'launching' || found.unit.status === 'landing')) {
            return;
        }
    }
    selectedUnitInstanceId = instanceId || null;
    deselectAtMs = 0;
    if (!instanceId) {
        flightModeActive = false;
        systemFlightModeActive = false;
        systemHoverBodyId = null;
        flightCursorLocal = null;
    }
    refreshSpacePanelFlight();
    updateMarkerSelection();
    updateFlightOverlay();
    updateFlightZones();
}

export function clearOrbitSelection() {
    selectedUnitInstanceId = null;
    flightModeActive = false;
    systemFlightModeActive = false;
    systemHoverBodyId = null;
    flightCursorLocal = null;
    deselectAtMs = 0;
    refreshSpacePanelFlight();
    updateMarkerSelection();
    updateFlightOverlay();
    updateFlightZones();
}

export function onMapEmptyDoubleClick() {
    clearOrbitSelection();
}

export function toggleFlightMode() {
    if (!selectedUnitInstanceId) return;
    const found = findOrbitUnit(selectedUnitInstanceId);
    if (!found) return;
    const st = found.unit.status;
    // во время systemFlying кнопки заблокированы
    if (st === 'systemFlying' || st === 'launching' || st === 'landing') return;
    if (st !== 'orbit' && st !== 'flying') return;

    // если включаем грав. полёт — выключаем системный режим
    if (!flightModeActive) {
        systemFlightModeActive = false;
        systemHoverBodyId = null;
    }
    flightModeActive = !flightModeActive;
    if (!flightModeActive) flightCursorLocal = null;
    refreshSpacePanelFlight();
    updateFlightOverlay();
    updateFlightZones();
}

/** Полёт внутри звёздной системы (цель — другое небесное тело). */
export function toggleSystemFlightMode() {
    if (!selectedUnitInstanceId) return;
    const found = findOrbitUnit(selectedUnitInstanceId);
    if (!found) return;
    const st = found.unit.status;
    if (st === 'systemFlying' || st === 'launching' || st === 'landing') return;

    if (!systemFlightModeActive) {
        // нужна жёлтая зона (или уже systemFlying — не сюда)
        if (st !== 'orbit' && st !== 'flying') return;
        if (!isInYellowZone(found.unit)) return;
        // деактивируем полёт в грав. колодце и останавливаем корабль
        flightModeActive = false;
        flightCursorLocal = null;
        if (st === 'flying') stopUnitMotion(selectedUnitInstanceId);
        systemFlightModeActive = true;
        systemHoverBodyId = null;
    } else {
        systemFlightModeActive = false;
        systemHoverBodyId = null;
    }
    refreshSpacePanelFlight();
    updateFlightOverlay();
    updateFlightZones();
}

export function requestLanding() {
    if (!selectedUnitInstanceId) return;
    const res = startLanding(selectedUnitInstanceId);
    if (!res.ok) {
        console.warn('landing failed', res.reason);
        return;
    }
    flightModeActive = false;
    systemFlightModeActive = false;
    systemHoverBodyId = null;
    flightCursorLocal = null;
    // плавный сброс выделения через 1.5с
    deselectAtMs = performance.now() + 1500;
    refreshSpacePanelFlight();
    updateFlightOverlay();
    updateFlightZones();
}

function ensureMarkersRoot() {
    if (markersRoot) return markersRoot;
    markersRoot = document.createElement('div');
    markersRoot.id = 'unit-map-markers';
    document.body.appendChild(markersRoot);
    return markersRoot;
}

function ensureFlightOverlay() {
    if (flightOverlay) return flightOverlay;
    flightOverlay = document.createElement('div');
    flightOverlay.id = 'unit-flight-overlay';
    flightOverlay.innerHTML = `
        <svg id="unit-flight-svg" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="unit-flight-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
                    <stop offset="0%" stop-color="rgba(0,200,255,0.95)"/>
                    <stop offset="100%" stop-color="rgba(0,200,255,0.05)"/>
                </linearGradient>
            </defs>
            <path id="unit-flight-path" class="unit-flight-path" d=""/>
            <path id="unit-flight-path-ghost" class="unit-flight-path ghost" d=""/>
        </svg>
        <div id="unit-flight-dest" class="unit-flight-dest"></div>
        <div id="unit-flight-dest-ghost" class="unit-flight-dest ghost"></div>
    `;
    document.body.appendChild(flightOverlay);
    return flightOverlay;
}

function ensureZonesRoot() {
    // HTML-зоны больше не используем (3D-кольца совпадают с грав. колодцем)
    if (zonesRoot) {
        zonesRoot.style.display = 'none';
        return zonesRoot;
    }
    zonesRoot = document.createElement('div');
    zonesRoot.id = 'unit-flight-zones';
    zonesRoot.style.display = 'none';
    document.body.appendChild(zonesRoot);
    return zonesRoot;
}

function getSceneFromBody(body) {
    return body?.mesh?.parent
        || body?.gravityWellGrid?.parent
        || body?.gravityWellLine?.parent
        || null;
}

/**
 * Unlit-шейдер зон: полярные координаты из position (RingGeometry UV — декартовы,
 * из‑за них градиент «ехал» сверху/снизу экрана).
 * land: непрозрачнее у тела → прозрачнее к границе посадки
 * edge: непрозрачнее у пунктира (космос) → прозрачнее внутрь к 80%
 */
function makeStripeRingMaterial(colorRgb, mode) {
    const isLand = mode === 'land';
    return new THREE.ShaderMaterial({
        uniforms: {
            ringColor: { value: new THREE.Color(colorRgb) },
            innerR: { value: 1.0 },
            outerR: { value: 1.1 },
            opacity: { value: isLand ? 0.75 : 0.7 },
            modeLand: { value: isLand ? 1.0 : 0.0 }
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        lights: false,
        fog: false,
        blending: THREE.NormalBlending,
        vertexShader: `
            varying vec3 vPos;
            void main() {
                vPos = position; // локальные XY кольца до rotation
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 ringColor;
            uniform float innerR;
            uniform float outerR;
            uniform float opacity;
            uniform float modeLand;
            varying vec3 vPos;
            void main() {
                float R = length(vPos.xy);
                float span = max(outerR - innerR, 1e-5);
                float t = clamp((R - innerR) / span, 0.0, 1.0); // 0 = inner, 1 = outer

                // Параллельные диагональные полосы «опасности» в плоскости кольца.
                // Без atan — нет шва; без ang+t — нет спирали.
                float diag = (vPos.x + vPos.y) * 5.5;
                float stripe = abs(fract(diag) - 0.5);
                stripe = 1.0 - smoothstep(0.07, 0.15, stripe);

                float radial;
                float border;
                if (modeLand > 0.5) {
                    // зелёная: у тела плотнее, дальше — прозрачнее
                    radial = pow(1.0 - t, 0.65);
                    border = 1.0 - smoothstep(0.0, 0.04, 1.0 - t);
                } else {
                    // жёлтая: у пунктира (космос) плотнее, внутрь — прозрачнее
                    radial = pow(t, 0.75);
                    border = 1.0 - smoothstep(0.0, 0.04, 1.0 - t);
                }

                float alpha = max(stripe * 0.55 * radial, border * 0.95) * opacity;
                if (alpha < 0.03) discard;
                gl_FragColor = vec4(ringColor, alpha);
            }
        `
    });
}

function ensureFlightZoneMeshes(bodyId) {
    bodyId = Number(bodyId);
    if (flightZoneByBody.has(bodyId)) return flightZoneByBody.get(bodyId);
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    const scene = getSceneFromBody(body);
    if (!scene || !body?.mesh) return null;

    // placeholder radii — пересчитаем в update
    const land = new THREE.Mesh(
        new THREE.RingGeometry(1, 1.1, 96, 1),
        makeStripeRingMaterial(0x28dc5a, 'land')
    );
    land.rotation.x = -Math.PI / 2;
    land.position.y = 0.012;
    land.visible = false;
    land.renderOrder = 6;
    land.frustumCulled = false;
    scene.add(land);

    const edge = new THREE.Mesh(
        new THREE.RingGeometry(0.8, 0.99, 96, 1),
        makeStripeRingMaterial(0xffc828, 'edge')
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.013;
    edge.visible = false;
    edge.renderOrder = 6;
    edge.frustumCulled = false;
    scene.add(edge);

    const entry = { land, edge };
    flightZoneByBody.set(bodyId, entry);
    return entry;
}

function setRingRadii(mesh, innerR, outerR) {
    if (!mesh) return;
    if (innerR >= outerR) outerR = innerR * 1.02;
    const prev = mesh.userData.ringRadii;
    if (!(prev && Math.abs(prev[0] - innerR) < 1e-6 && Math.abs(prev[1] - outerR) < 1e-6)) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.RingGeometry(innerR, outerR, 128, 1);
        mesh.userData.ringRadii = [innerR, outerR];
    }
    // радиусы в шейдер — полярный градиент
    if (mesh.material && mesh.material.uniforms) {
        mesh.material.uniforms.innerR.value = innerR;
        mesh.material.uniforms.outerR.value = outerR;
    }
}

function screenToWorldXZ(clientX, clientY) {
    if (!state.camera) return null;
    const ndc = new THREE.Vector2(
        (clientX / window.innerWidth) * 2 - 1,
        -(clientY / window.innerHeight) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, state.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return hit;
}

function worldToLocalOnBody(bodyId, wx, wz) {
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    if (!body?.mesh) return null;
    return {
        lx: wx - body.mesh.position.x,
        lz: wz - body.mesh.position.z
    };
}

function localToWorldOnBody(bodyId, lx, lz) {
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    if (!body?.mesh) return null;
    return {
        x: body.mesh.position.x + lx,
        z: body.mesh.position.z + lz,
        y: 0.05
    };
}

function projectWorldToScreen(wx, wy, wz) {
    const cam = state.camera;
    if (!cam) return null;
    const v = new THREE.Vector3(wx, wy, wz);
    v.project(cam);
    if (v.z > 1) return null;
    return {
        x: (v.x * 0.5 + 0.5) * window.innerWidth,
        y: (-v.y * 0.5 + 0.5) * window.innerHeight
    };
}

/**
 * Экранный радиус окружности в локальных единицах тела.
 * Проецируем несколько точек на окружности — так совпадает с 3D сеткой/пунктиром
 * при наклонённой камере (формула FOV давала заниженный радиус ≈ в 1.5–2 раза).
 */
function projectLocalRadiusPx(bodyId, localR) {
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    const cam = state.camera;
    if (!body?.mesh || !cam) return null;
    const c = body.mesh.position;
    const R = Math.abs(Number(localR) || 0);
    if (R < 1e-8) return null;
    const p0 = projectWorldToScreen(c.x, 0.05, c.z);
    if (!p0) return null;

    const samples = 8;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < samples; i++) {
        const a = (i / samples) * Math.PI * 2;
        const wx = c.x + Math.cos(a) * R;
        const wz = c.z + Math.sin(a) * R;
        const p = projectWorldToScreen(wx, 0.05, wz);
        if (!p) continue;
        sum += Math.hypot(p.x - p0.x, p.y - p0.y);
        n++;
    }
    if (n < 2) return null;
    return { cx: p0.x, cy: p0.y, r: Math.max(2, sum / n) };
}

function pickBodyAtScreen(clientX, clientY, excludeBodyId) {
    const hit = screenToWorldXZ(clientX, clientY);
    if (!hit) return null;
    let best = null;
    let bestDist = Infinity;
    for (const [id, body] of Object.entries(state.celestialBodies || {})) {
        if (!body?.mesh || !body.data) continue;
        const typ = body.data.type;
        if (typ === 'star' || typ === 'starSystem' || typ === 'interstellarNebula') continue;
        if (Number(id) === Number(excludeBodyId)) continue;
        const size = Number(body.data.size) || 1;
        const lim = getWellFlightLimits(id);
        // клик по диску грав. колодца тела
        const dx = hit.x - body.mesh.position.x;
        const dz = hit.z - body.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d <= lim.maxR * 1.02 && d < bestDist) {
            bestDist = d;
            best = Number(id);
        }
    }
    return best;
}

function onFlightMouseMove(ev) {
    if (systemFlightModeActive && selectedUnitInstanceId) {
        const found = findOrbitUnit(selectedUnitInstanceId);
        if (!found) { systemHoverBodyId = null; return; }
        systemHoverBodyId = pickBodyAtScreen(ev.clientX, ev.clientY, found.unit.bodyId);
        flightCursorLocal = null;
        updateFlightOverlay();
        return;
    }
    if (!flightModeActive || !selectedUnitInstanceId) {
        flightCursorLocal = null;
        return;
    }
    const found = findOrbitUnit(selectedUnitInstanceId);
    if (!found) { flightCursorLocal = null; return; }
    const hit = screenToWorldXZ(ev.clientX, ev.clientY);
    if (!hit) { flightCursorLocal = null; return; }
    const local = worldToLocalOnBody(found.unit.bodyId, hit.x, hit.z);
    if (!local) { flightCursorLocal = null; return; }
    const ok = clampLocalToFlightRing(found.unit.bodyId, local.lx, local.lz);
    flightCursorLocal = ok ? { lx: ok.lx, lz: ok.lz } : null;
    updateFlightOverlay();
}

function onFlightMouseDown(ev) {
    if (ev.button !== 0) return;
    const target = ev.target;
    if (target && target.closest && (
        target.closest('[data-ui="true"]') ||
        target.closest('#unit-space-panel') ||
        target.closest('#unit-tech-modal')
    )) return;

    if (systemFlightModeActive && selectedUnitInstanceId) {
        const found = findOrbitUnit(selectedUnitInstanceId);
        if (!found) return;
        const bid = systemHoverBodyId || pickBodyAtScreen(ev.clientX, ev.clientY, found.unit.bodyId);
        if (!bid) return;
        ev.preventDefault();
        ev.stopPropagation();
        const res = setSystemFlightDestination(selectedUnitInstanceId, bid);
        if (!res.ok) {
            console.warn('setSystemFlight', res.reason);
            return;
        }
        systemFlightModeActive = false;
        systemHoverBodyId = null;
        updateFlightOverlay();
        refreshSpacePanelFlight();
        return;
    }

    if (!flightModeActive || !selectedUnitInstanceId) return;
    if (!flightCursorLocal) return;
    ev.preventDefault();
    ev.stopPropagation();
    const res = setFlightDestination(
        selectedUnitInstanceId,
        flightCursorLocal.lx,
        flightCursorLocal.lz
    );
    if (!res.ok) console.warn('setFlight', res.reason);
    updateFlightOverlay();
    refreshSpacePanelFlight();
}

function updateMarkerSelection() {
    if (!markersRoot) return;
    markersRoot.querySelectorAll('.unit-map-marker').forEach(el => {
        el.classList.toggle('selected', el.dataset.instanceId === selectedUnitInstanceId);
    });
}

export function updateUnitMapMarkers() {
    const root = ensureMarkersRoot();
    const cam = state.camera;
    if (!cam) return;

    const units = getAllOrbitUnits().filter(u =>
        u.status === 'orbit' || u.status === 'landing' ||
        u.status === 'flying' || u.status === 'launching' ||
        u.status === 'systemFlying'
    );
    const seen = new Set();

    for (const u of units) {
        seen.add(u.instanceId);
        let el = root.querySelector(`[data-instance-id="${CSS.escape(u.instanceId)}"]`);
        if (!el) {
            el = document.createElement('div');
            el.className = 'unit-map-marker';
            el.dataset.instanceId = u.instanceId;
            const img = document.createElement('img');
            const def = getUnitDef(u.unitTypeId);
            img.src = def?.tacticalAvatar || def?.avatar || '';
            img.alt = '';
            el.appendChild(img);
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                selectOrbitUnit(u.instanceId);
            });
            root.appendChild(el);
        }

        const busy = u.status === 'launching' || u.status === 'landing';
        // systemFlying — можно выбрать, но не «busy» для pointer
        el.classList.toggle('selected', u.instanceId === selectedUnitInstanceId && !busy);
        el.classList.toggle('unit-busy', busy);
        el.style.pointerEvents = busy ? 'none' : 'auto';

        const wp = getUnitWorldPos(u);
        const vector = new THREE.Vector3(wp.x, wp.y, wp.z);
        vector.project(cam);
        const sx = (vector.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (-vector.y * 0.5 + 0.5) * window.innerHeight;
        const behind = vector.z > 1;
        el.style.display = behind ? 'none' : 'block';
        el.style.left = `${sx}px`;
        el.style.top = `${sy}px`;

        const cellWorld = getGravityWellCellWorldSize(u.bodyId);
        const dist = cam.position.distanceTo(new THREE.Vector3(wp.x, 0, wp.z));
        const vFOV = (cam.fov * Math.PI) / 180;
        const worldPerPx = (2 * Math.max(dist, 0.01) * Math.tan(vFOV / 2)) / Math.max(window.innerHeight, 1);
        let px = (cellWorld / Math.max(worldPerPx, 1e-6)) * 0.72;
        if (!Number.isFinite(px) || px < 5) px = 5;
        // с высоты «звездная система» и выше — минимум 30px
        const camY = state.camera?.position?.y || 0;
        if (camY >= 30) px = Math.max(px, 30);
        if (px > 72) px = 72;

        const scale = u.animScale != null ? Number(u.animScale) : 1;
        const opacity = u.animOpacity != null ? Number(u.animOpacity) : 1;
        el.style.width = `${px * scale}px`;
        el.style.height = `${px * scale}px`;
        el.style.opacity = String(Math.max(0, Math.min(1, opacity)));

        let fx = Number(u.facingX);
        let fz = Number(u.facingZ);
        if (!Number.isFinite(fx) || !Number.isFinite(fz) || (fx === 0 && fz === 0)) {
            fx = 0; fz = -1;
        }
        const nose = new THREE.Vector3(wp.x + fx, wp.y, wp.z + fz);
        nose.project(cam);
        const nx = (nose.x * 0.5 + 0.5) * window.innerWidth;
        const ny = (-nose.y * 0.5 + 0.5) * window.innerHeight;
        const ang = Math.atan2(nx - sx, -(ny - sy)) * (180 / Math.PI);
        el.style.transform = 'translate(-50%, -50%)';
        const img = el.querySelector('img');
        if (img) img.style.transform = `rotate(${ang}deg)`;
    }

    root.querySelectorAll('.unit-map-marker').forEach(el => {
        if (!seen.has(el.dataset.instanceId)) el.remove();
    });
}

function pathLocalToScreen(bodyId, localPts) {
    const out = [];
    for (const p of localPts) {
        const w = localToWorldOnBody(bodyId, p.lx, p.lz);
        if (!w) continue;
        const s = projectWorldToScreen(w.x, w.y, w.z);
        if (s) out.push(s);
    }
    return out;
}

function screenPtsToPathD(pts) {
    if (!pts.length) return '';
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    if (pts.length === 2) {
        d += ` L ${pts[1].x} ${pts[1].y}`;
        return d;
    }
    for (let i = 1; i < pts.length - 1; i++) {
        const midX = (pts[i].x + pts[i + 1].x) / 2;
        const midY = (pts[i].y + pts[i + 1].y) / 2;
        d += ` Q ${pts[i].x} ${pts[i].y} ${midX} ${midY}`;
    }
    const last = pts[pts.length - 1];
    d += ` T ${last.x} ${last.y}`;
    return d;
}

function sizeDestMarker(el, bodyId, wx, wz) {
    if (!el || !state.camera) return;
    const cellWorld = getGravityWellCellWorldSize(bodyId);
    const dist = state.camera.position.distanceTo(new THREE.Vector3(wx, 0, wz));
    const vFOV = (state.camera.fov * Math.PI) / 180;
    const worldPerPx = (2 * Math.max(dist, 0.01) * Math.tan(vFOV / 2)) / Math.max(window.innerHeight, 1);
    let px = (cellWorld / Math.max(worldPerPx, 1e-6)) * 0.36;
    if (!Number.isFinite(px) || px < 4) px = 4;
    if (px > 40) px = 40;
    el.style.width = `${px}px`;
    el.style.height = `${px}px`;
}


function getBodyCenterWorld(bodyId) {
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    if (!body?.mesh) return null;
    return { x: body.mesh.position.x, z: body.mesh.position.z };
}

/** Кривая «гравитационного манёвра» в мировых координатах → экранный path d */
function systemFlightPathD(wx0, wz0, wx1, wz1) {
    const dx = wx1 - wx0, dz = wz1 - wz0;
    const len = Math.hypot(dx, dz) || 1;
    // перпендикулярный offset ~15% длины — визуальный манёвр
    const ox = -dz / len * len * 0.15;
    const oz = dx / len * len * 0.15;
    const mx = (wx0 + wx1) / 2 + ox;
    const mz = (wz0 + wz1) / 2 + oz;
    const samples = 16;
    const pts = [];
    for (let i = 0; i <= samples; i++) {
        const u = i / samples;
        const omu = 1 - u;
        // quadratic bezier
        const x = omu * omu * wx0 + 2 * omu * u * mx + u * u * wx1;
        const z = omu * omu * wz0 + 2 * omu * u * mz + u * u * wz1;
        const s = projectWorldToScreen(x, 0.05, z);
        if (s) pts.push(s);
    }
    return screenPtsToPathD(pts);
}

function updateFlightOverlay() {
    ensureFlightOverlay();
    const pathEl = document.getElementById('unit-flight-path');
    const pathGhost = document.getElementById('unit-flight-path-ghost');
    const destEl = document.getElementById('unit-flight-dest');
    const destGhost = document.getElementById('unit-flight-dest-ghost');
    const grad = document.getElementById('unit-flight-grad');
    if (!pathEl || !destEl) return;

    const hideAll = () => {
        pathEl.setAttribute('d', '');
        pathEl.style.display = 'none';
        if (pathGhost) { pathGhost.setAttribute('d', ''); pathGhost.style.display = 'none'; }
        destEl.style.display = 'none';
        destEl.classList.remove('pulse');
        if (destGhost) { destGhost.style.display = 'none'; destGhost.classList.remove('pulse'); }
    };

    if (!selectedUnitInstanceId) { hideAll(); return; }
    const found = findOrbitUnit(selectedUnitInstanceId);
    if (!found) { hideAll(); return; }
    const unit = found.unit;

    // во время посадки/взлёта маршруты не рисуем
    if (unit.status === 'landing' || unit.status === 'launching') {
        hideAll();
        return;
    }

    // --- полёт внутри звёздной системы ---
    // Визуал: вектор и таргет до ЦЕНТРА тела; факт. точка прибытия — 99% кольца
    if (unit.status === 'systemFlying' && unit.systemTargetBodyId != null) {
        const wp = getUnitWorldPos(unit);
        const center = getBodyCenterWorld(unit.systemTargetBodyId);
        if (center) {
            const d = systemFlightPathD(wp.x, wp.z, center.x, center.z);
            pathEl.setAttribute('d', d);
            pathEl.style.display = 'block';
            if (grad) {
                const s0 = projectWorldToScreen(wp.x, 0.05, wp.z);
                const s1 = projectWorldToScreen(center.x, 0.05, center.z);
                if (s0 && s1) {
                    grad.setAttribute('x1', s0.x); grad.setAttribute('y1', s0.y);
                    grad.setAttribute('x2', s1.x); grad.setAttribute('y2', s1.y);
                }
                pathEl.setAttribute('stroke', 'url(#unit-flight-grad)');
            }
            const sEnd = projectWorldToScreen(center.x, 0.05, center.z);
            if (sEnd) {
                destEl.style.display = 'block';
                destEl.style.left = `${sEnd.x}px`;
                destEl.style.top = `${sEnd.y}px`;
                sizeDestMarker(destEl, unit.systemTargetBodyId, center.x, center.z);
                destEl.classList.remove('pulse');
            }
        }
        if (pathGhost) { pathGhost.style.display = 'none'; pathGhost.setAttribute('d', ''); }
        if (destGhost) { destGhost.style.display = 'none'; }
        return;
    }

    // режим выбора цели (системный) — пульс на центре наведённого тела
    if (systemFlightModeActive && systemHoverBodyId != null) {
        const wp = getUnitWorldPos(unit);
        const center = getBodyCenterWorld(systemHoverBodyId);
        if (center) {
            const d = systemFlightPathD(wp.x, wp.z, center.x, center.z);
            pathEl.setAttribute('d', d);
            pathEl.style.display = 'block';
            if (grad) {
                const s0 = projectWorldToScreen(wp.x, 0.05, wp.z);
                const s1 = projectWorldToScreen(center.x, 0.05, center.z);
                if (s0 && s1) {
                    grad.setAttribute('x1', s0.x); grad.setAttribute('y1', s0.y);
                    grad.setAttribute('x2', s1.x); grad.setAttribute('y2', s1.y);
                }
                pathEl.setAttribute('stroke', 'url(#unit-flight-grad)');
            }
            const sEnd = projectWorldToScreen(center.x, 0.05, center.z);
            if (sEnd) {
                destEl.style.display = 'block';
                destEl.style.left = `${sEnd.x}px`;
                destEl.style.top = `${sEnd.y}px`;
                sizeDestMarker(destEl, systemHoverBodyId, center.x, center.z);
                destEl.classList.add('pulse');
            }
        }
        if (pathGhost) { pathGhost.style.display = 'none'; pathGhost.setAttribute('d', ''); }
        if (destGhost) { destGhost.style.display = 'none'; }
        return;
    }

    const showPath = (pathNode, destNode, localPath, { gradient, pulse, ghost }) => {
        if (!localPath || localPath.length < 2) {
            if (pathNode) { pathNode.style.display = 'none'; pathNode.setAttribute('d', ''); }
            if (destNode) { destNode.style.display = 'none'; destNode.classList.remove('pulse'); }
            return;
        }
        const screenPts = pathLocalToScreen(unit.bodyId, localPath);
        if (screenPts.length < 2) {
            if (pathNode) pathNode.style.display = 'none';
            if (destNode) destNode.style.display = 'none';
            return;
        }
        const d = screenPtsToPathD(screenPts);
        pathNode.setAttribute('d', d);
        pathNode.style.display = 'block';
        if (gradient && grad) {
            const a = screenPts[0];
            const b = screenPts[screenPts.length - 1];
            grad.setAttribute('x1', a.x);
            grad.setAttribute('y1', a.y);
            grad.setAttribute('x2', b.x);
            grad.setAttribute('y2', b.y);
            pathNode.setAttribute('stroke', 'url(#unit-flight-grad)');
        } else {
            pathNode.setAttribute('stroke', ghost ? 'rgba(0,200,255,0.28)' : 'rgba(0,200,255,0.9)');
        }
        const last = screenPts[screenPts.length - 1];
        const lastLocal = localPath[localPath.length - 1];
        const w = localToWorldOnBody(unit.bodyId, lastLocal.lx, lastLocal.lz);
        destNode.style.display = 'block';
        destNode.style.left = `${last.x}px`;
        destNode.style.top = `${last.y}px`;
        if (w) sizeDestMarker(destNode, unit.bodyId, w.x, w.z);
        destNode.classList.toggle('pulse', !!pulse);
    };

    const flying = unit.status === 'flying' && (unit.waypoints?.length || (unit.destLx != null));
    if (flying) {
        const localPath = getFlightPathLocal(unit, null);
        showPath(pathEl, destEl, localPath, { gradient: true, pulse: false, ghost: false });
    } else {
        pathEl.style.display = 'none';
        pathEl.setAttribute('d', '');
        destEl.style.display = 'none';
        destEl.classList.remove('pulse');
    }

    if (flightModeActive && flightCursorLocal) {
        const preview = getFlightPathLocal(unit, flightCursorLocal);
        if (flying) {
            if (pathGhost && destGhost) {
                showPath(pathGhost, destGhost, preview, { gradient: false, pulse: true, ghost: true });
                pathGhost.classList.add('ghost');
            }
        } else {
            showPath(pathEl, destEl, preview, { gradient: true, pulse: true, ghost: false });
            if (pathGhost) { pathGhost.style.display = 'none'; pathGhost.setAttribute('d', ''); }
            if (destGhost) { destGhost.style.display = 'none'; destGhost.classList.remove('pulse'); }
        }
    } else {
        if (pathGhost) { pathGhost.style.display = 'none'; pathGhost.setAttribute('d', ''); }
        if (destGhost) { destGhost.style.display = 'none'; destGhost.classList.remove('pulse'); }
    }
}

/** 3D-зоны: зелёная на landMaxR, жёлтая 80–99% от пунктира (maxR) */
function updateFlightZones() {
    ensureZonesRoot();

    // спрятать все
    for (const entry of flightZoneByBody.values()) {
        if (entry.land) entry.land.visible = false;
        if (entry.edge) entry.edge.visible = false;
    }

    const show = flightModeActive && selectedUnitInstanceId;
    if (!show) return;

    const found = findOrbitUnit(selectedUnitInstanceId);
    if (!found) return;
    const bodyId = found.unit.bodyId;
    const body = state.celestialBodies[bodyId] || state.celestialBodies[String(bodyId)];
    if (!body?.mesh) return;

    const lim = getWellFlightLimits(bodyId);
    // 100% = maxR = lineRadius пунктира (wellR * 1.05)
    const landR = lim.landMaxR != null ? lim.landMaxR : (lim.size + lim.ring * 0.2);
    const maxR = lim.maxR;
    const bodySize = lim.size;
    // зелёная: от поверхности тела → до границы зоны посадки (landMaxR)
    const landInner = bodySize * 1.01;
    const landOuter = Math.max(landR, landInner * 1.05);
    // жёлтая: 80% … 99% пунктира
    const edgeInner = maxR * 0.80;
    const edgeOuter = maxR * 0.99;

    const entry = ensureFlightZoneMeshes(bodyId);
    if (!entry) return;

    setRingRadii(entry.land, landInner, landOuter);
    setRingRadii(entry.edge, edgeInner, edgeOuter);

    // следуем за телом, как gravityWellGrid
    const yLand = (body.mesh.position.y || 0) + 0.012;
    const yEdge = (body.mesh.position.y || 0) + 0.013;
    entry.land.position.set(body.mesh.position.x, yLand, body.mesh.position.z);
    entry.edge.position.set(body.mesh.position.x, yEdge, body.mesh.position.z);
    entry.land.visible = true;
    entry.edge.visible = true;
}

/** Обновление кнопок мини-панели (полёт/посадка) */
export function refreshSpacePanelFlight() {
    const panel = document.getElementById('unit-space-panel');
    if (!panel) return;
    if (!selectedUnitInstanceId) {
        panel.style.display = 'none';
        return;
    }
    const found = findOrbitUnit(selectedUnitInstanceId);
    if (!found) {
        panel.style.display = 'none';
        selectedUnitInstanceId = null;
        return;
    }
    // во время посадки панель можно оставить кратко, но кнопки disabled
    const def = getUnitDef(found.unit.unitTypeId);
    panel.style.display = 'flex';
    const av = document.getElementById('unit-space-avatar');
    if (av) av.src = def?.avatar || '';
    const nm = document.getElementById('unit-space-name');
    if (nm) nm.textContent = unitDisplayName(def);

    const st = found.unit.status;
    const systemFlying = st === 'systemFlying';
    const landing = st === 'landing';
    const launching = st === 'launching';
    const lockedAll = systemFlying || launching; // при systemFlying все кнопки lock

    const landBtn = document.getElementById('unit-space-land-btn');
    if (landBtn) {
        const inGreen = isWithinLandingZone(found.unit);
        const hasPort = bodyHasTechnoportBuilding(found.unit.bodyId);
        const ok = (st === 'orbit' || st === 'flying') && inGreen && hasPort;
        landBtn.disabled = lockedAll || (!ok && !landing);
        landBtn.classList.toggle('disabled', landBtn.disabled && !landing);
        landBtn.classList.toggle('landing-active', landing);
        if (landing) {
            landBtn.title = t('tech.landing') || 'Идёт посадка…';
        } else if (launching) {
            landBtn.title = t('tech.launching') || 'Идёт взлёт…';
        } else if (systemFlying) {
            landBtn.title = t('tech.systemFlying') || 'Идёт перелёт…';
        } else if (!hasPort) {
            landBtn.title = t('tech.landNoPort') || 'Нет технопорта — некуда приземляться';
        } else if (!inGreen) {
            landBtn.title = t('tech.landFar') || 'Слишком далеко от небесного тела';
        } else {
            landBtn.title = t('tech.land') || 'Посадка';
        }
    }
    const flightBtn = document.getElementById('unit-space-flight-btn');
    if (flightBtn) {
        const canFly = (st === 'orbit' || st === 'flying') && !lockedAll;
        flightBtn.disabled = !canFly;
        flightBtn.classList.toggle('disabled', !canFly);
        flightBtn.classList.toggle('active', flightModeActive);
        flightBtn.title = flightModeActive
            ? (t('tech.flightWellActive') || 'Полёт внутри грав. колодца (выйти)')
            : (t('tech.flightWell') || 'Полёт внутри грав. колодца');
    }
    const sysBtn = document.getElementById('unit-space-sysflight-btn');
    if (sysBtn) {
        const inYellow = isInYellowZone(found.unit);
        const canSys = (st === 'orbit' || st === 'flying') && inYellow && !lockedAll;
        sysBtn.disabled = !canSys && !systemFlightModeActive;
        // если режим уже включён — можно выключить
        if (systemFlightModeActive && !systemFlying) sysBtn.disabled = false;
        if (systemFlying) sysBtn.disabled = true;
        sysBtn.classList.toggle('disabled', sysBtn.disabled);
        sysBtn.classList.toggle('active', systemFlightModeActive);
        if (systemFlying) {
            sysBtn.title = t('tech.systemFlying') || 'Идёт перелёт внутри системы…';
        } else if (systemFlightModeActive) {
            sysBtn.title = t('tech.flightSystemActive') || 'Выбор цели (нажмите, чтобы отменить)';
        } else if (!inYellow) {
            sysBtn.title = t('tech.flightSystemFar') || 'Нужна жёлтая зона у края грав. колодца';
        } else {
            sysBtn.title = t('tech.flightSystem') || 'Полёт внутри системы';
        }
    }
}

export function tickUnitFlightUI() {
    if (deselectAtMs && performance.now() >= deselectAtMs) {
        clearOrbitSelection();
    }
    // если выделенный юнит ушёл в landing/launching — таймер сброса
    if (selectedUnitInstanceId) {
        const found = findOrbitUnit(selectedUnitInstanceId);
        if (found && (found.unit.status === 'landing' || found.unit.status === 'launching')) {
            if (!deselectAtMs) deselectAtMs = performance.now() + 1500;
        } else if (found && found.unit.status === 'orbit' && found.unit.animScale === 1) {
            // ok
        } else if (!found) {
            clearOrbitSelection();
        }
    }
    updateUnitMapMarkers();
    updateFlightOverlay();
    updateFlightZones();
    refreshSpacePanelFlight();
}
