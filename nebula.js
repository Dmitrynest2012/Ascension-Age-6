/**
 * Межзвёздная туманность — 2D как в intro, через рабочий пайплайн пыли.
 *
 * Механизм (проверен):
 *  - создаётся в loadBodiesFromJSON рядом со звёздной пылью (не body-mesh цикл);
 *  - state.nebulaParticleSystems;
 *  - каждый кадр: opacity + лёгкий параллакс в хвосте updateBodies;
 *  - layer 0, основная сцена / composer.
 *
 * Визуал: Canvas radial-gradient → MeshBasicMaterial → Plane (как intro.createNebula),
 * плюс мягкое облако Points тем же шейдером пыли для объёма.
 */

import {
    particleVertexShader,
    particleFragmentShader
} from './shaders.js';
import { state } from './state.js';

export const NEBULA_LAYER = 0;

function hexToRgb(col, fallback = [106, 140, 175]) {
    if (typeof col === 'string' && col[0] === '#' && col.length >= 7) {
        return [
            parseInt(col.slice(1, 3), 16),
            parseInt(col.slice(3, 5), 16),
            parseInt(col.slice(5, 7), 16)
        ];
    }
    return fallback;
}

/** 2D-текстура: приглушённый центр, очень мягкий край → космос */
function buildNebulaTexture(colors) {
    // Высокое разрешение + mipmaps: вблизи нет «холста/бамбука»
    const W = 2048;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = W;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, W);

    // Базовый диск: центр НЕ яркий, край уходит в 0 очень плавно
    const g0 = ctx.createRadialGradient(W / 2, W / 2, 8, W / 2, W / 2, W * 0.5);
    g0.addColorStop(0.00, 'rgba(95, 125, 165, 0.24)');
    g0.addColorStop(0.25, 'rgba(75, 105, 150, 0.26)');
    g0.addColorStop(0.50, 'rgba(50, 75, 115, 0.14)');
    g0.addColorStop(0.72, 'rgba(30, 50, 80, 0.06)');
    g0.addColorStop(0.88, 'rgba(15, 25, 45, 0.02)');
    g0.addColorStop(1.00, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g0;
    ctx.fillRect(0, 0, W, W);

    const list = (colors && colors.length) ? colors : ['#6a8caf', '#3d5a7a', '#a890c0', '#2a4060'];
    for (let i = 0; i < Math.min(list.length, 5); i++) {
        const [r, g, b] = hexToRgb(list[i]);
        const ang = (i / Math.min(list.length, 5)) * Math.PI * 2 + 0.35;
        const cx = W / 2 + Math.cos(ang) * (W * 0.18);
        const cy = W / 2 + Math.sin(ang) * (W * 0.14);
        const rad = W * (0.32 + (i % 3) * 0.05);
        const gr = ctx.createRadialGradient(cx, cy, 4, cx, cy, rad);
        gr.addColorStop(0.00, `rgba(${r},${g},${b},0.20)`);
        gr.addColorStop(0.40, `rgba(${r},${g},${b},0.12)`);
        gr.addColorStop(0.75, `rgba(${r},${g},${b},0.04)`);
        gr.addColorStop(1.00, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, W, W);
    }

    // Внешнее перо
    const feather = ctx.createRadialGradient(W / 2, W / 2, W * 0.35, W / 2, W / 2, W * 0.5);
    feather.addColorStop(0.0, 'rgba(40, 60, 90, 0.00)');
    feather.addColorStop(0.5, 'rgba(30, 45, 70, 0.03)');
    feather.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = feather;
    ctx.fillRect(0, 0, W, W);

    // Лёгкий шум — ломает полосы градиента (banding) вблизи
    const img = ctx.getImageData(0, 0, W, W);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 2) continue;
        const n = (Math.random() - 0.5) * 6; // ±3
        d[i]     = Math.max(0, Math.min(255, d[i] + n));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
}


/**
 * Создать визуал туманности (intro-plane + лёгкие particles).
 * Вызывается из loadBodies рядом со звёздной пылью.
 */
export function createNebulaParticleSystems(data, scene) {
    state.nebulaParticleSystems = state.nebulaParticleSystems || {};

    try {
        const el = document.getElementById('interstellar-nebula-fx');
        if (el) el.remove();
    } catch (_) {}

    const nebulas = (data || []).filter(b => b && b.type === 'interstellarNebula');
    for (const body of nebulas) {
        const id = body.id;
        const prev = state.nebulaParticleSystems[id];
        if (prev) {
            try { if (prev.plane) scene.remove(prev.plane); } catch (_) {}
            try { if (prev.system) scene.remove(prev.system); } catch (_) {}
        }

        const size = Math.max(800, Number(body.size) || 1200);
        // Компактный размер — туманности не перекрываются на 4ZC
        const planeSize = Math.max(size * 2.2, 2800);
        const colors = body.nebulaColors || ['#6a8caf', '#3d5a7a', '#a890c0', '#2a4060'];
        const cx = Number(body.centerX) || 0;
        const cz = Number(body.centerZ) || 0;

        // —— 1. 2D-плоскость как intro ——
        const tex = buildNebulaTexture(colors);
        const planeMat = new THREE.MeshBasicMaterial({
            map: tex,
            color: 0xffffff,
            transparent: true,
            opacity: 0.01,
            depthWrite: false,
            depthTest: false,
            side: THREE.DoubleSide,
            blending: THREE.NormalBlending, // не Additive — иначе центр выжигает звёзды
            fog: false
        });
        const plane = new THREE.Mesh(
            new THREE.PlaneGeometry(planeSize, planeSize * 0.72), // чуть вытянута, как intro 500×300
            planeMat
        );
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(cx, -6, cz);
        plane.frustumCulled = false;
        plane.renderOrder = -800;
        plane.name = 'nebulaPlane_' + id;
        plane.layers.set(0);
        plane.userData.isNebula = true;
        plane.userData.baseX = cx;
        plane.userData.baseZ = cz;
        scene.add(plane);

        // —— 2. Мягкие particles (тот же шейдер пыли) для «глубины» ——
        const radius = planeSize * 0.42;
        const count = 11000;
        const positions = [];
        const seeds = [];
        for (let i = 0; i < count; i++) {
            const theta = Math.random() * Math.PI * 2;
            const r = Math.pow(Math.random(), 0.55) * radius;
            positions.push(
                Math.cos(theta) * r,
                (Math.random() - 0.5) * radius * 0.06,
                Math.sin(theta) * r
            );
            seeds.push(Math.random());
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('randomSeed', new THREE.Float32BufferAttribute(seeds, 1));

        const [r0, g0, b0] = hexToRgb(colors[0]);
        // Мелкие круглые точки (gl_PointSize в px; на 4ZC dist велик → множитель 0.5)
        // pointSize 2.2 → ~1.1 px на экране; fragment уже discard за кругом → round
        const pMat = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 },
                opacity: { value: 0.01 },
                color: { value: new THREE.Vector3(r0 / 255, g0 / 255, b0 / 255) },
                pointSize: { value: 3.8 },
                cameraDistance: { value: 5.0 }
            },
            vertexShader: particleVertexShader,
            fragmentShader: particleFragmentShader,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        const system = new THREE.Points(geo, pMat);
        system.position.set(cx, 0, cz);
        system.frustumCulled = false;
        system.renderOrder = -799;
        system.name = 'nebulaPoints_' + id;
        system.layers.set(0);
        system.userData.isNebula = true;
        system.userData.baseX = cx;
        system.userData.baseZ = cz;
        scene.add(system);

        state.nebulaParticleSystems[id] = {
            plane,
            planeMat,
            system,
            bodyId: id,
            baseX: cx,
            baseZ: cz,
            size: Number(body.size) || 1200
        };
        console.log('[nebula] intro-style plane + particles', id, 'planeSize', planeSize);
    }
}

/**
 * Opacity: 1–3ZC ≈ 0.01; 4ZC plane ~0.7, particles ~0.55.
 * Параллакс как у звёздной пыли.
 */
/**
 * Плавный переход 3ZC → 4ZC по высоте камеры (не жёсткий порог 400).
 * Туман начинается проявляться ещё в «Звёздной системе» и к ~520 полностью на месте.
 */
export function updateNebulaParticleSystems(currentLevelId) {
    const map = state.nebulaParticleSystems;
    if (!map || !state.camera) return;

    const inMenu = typeof document !== 'undefined'
        && document.body.classList.contains('main-menu-active');

    const h = state.camera.position.y;
    // Граница уровней 400: fade-зона вокруг неё (не «в один момент»)
    const FADE_START = 260;  // ещё 3ZC — едва начинает проявляться
    const FADE_END   = 560;  // уже 4ZC — полная сила
    let t = (h - FADE_START) / (FADE_END - FADE_START);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    // smoothstep
    t = t * t * (3 - 2 * t);
    // 5ZC: слабый туман-плоскость; частицы внутри туманности выкл.
    const atGalaxy = h >= 6500;
    if (atGalaxy) t = 1;

    // Плавное гашение пыли/яркости при подходе к границе 4ZC→5ZC (с ~4500)
    // и при отдалении по горизонтали от центра туманности
    let heightFade = 1;
    if (h > 1800 && !atGalaxy) {
        heightFade = Math.max(0, 1 - (h - 1800) / (6500 - 1800));
        heightFade = heightFade * heightFade * (3 - 2 * heightFade);
    } else if (atGalaxy) {
        heightFade = 1; // плоскость на 5ZC контролируется maxPlane ниже
    }

    const maxPlane = atGalaxy ? 0.18 : 0.42;
    // Пыль частиц: на высокой 4ZC гасим heightFade; на 5ZC = 0
    const maxPts = atGalaxy ? 0.0 : 0.36 * heightFade;
    const basePlane = inMenu ? 0 : (0.01 + (maxPlane - 0.01) * t * (atGalaxy ? 1 : (0.55 + 0.45 * heightFade)));
    const basePts = inMenu ? 0 : (maxPts > 0 ? (0.01 + (maxPts - 0.01) * Math.min(t, 1)) : 0);

    const lerpK = 0.12 + 0.2 * t;
    const parallaxK = atGalaxy ? 0.0 : 0.02;

    let nearestId = null;
    let nearestD = Infinity;
    if (!atGalaxy && t > 0.05) {
        for (const id of Object.keys(map)) {
            const entry = map[id];
            const bx = entry.baseX != null ? entry.baseX : 0;
            const bz = entry.baseZ != null ? entry.baseZ : 0;
            const d = Math.hypot(state.camera.position.x - bx, state.camera.position.z - bz);
            if (d < nearestD) { nearestD = d; nearestId = id; }
        }
    }

    for (const id of Object.keys(map)) {
        const entry = map[id];
        const baseX = entry.baseX != null ? entry.baseX : 0;
        const baseZ = entry.baseZ != null ? entry.baseZ : 0;
        const parallaxX = state.camera.position.x * parallaxK + baseX;
        const parallaxZ = state.camera.position.z * parallaxK + baseZ;

        let isol = 1;
        if (!atGalaxy && nearestId != null) {
            isol = (String(id) === String(nearestId)) ? 1 : 0.015;
        }

        // Горизонтальное гашение: чем дальше от центра туманности, тем слабее (не ярче!)
        const horiz = Math.hypot(state.camera.position.x - baseX, state.camera.position.z - baseZ);
        const fadeR = Math.max(Number(entry.size) || 1200, 800) * 3.5;
        let distFade = 1;
        if (horiz > fadeR * 0.35) {
            distFade = Math.max(0.05, 1 - (horiz - fadeR * 0.35) / (fadeR * 0.9));
            distFade = distFade * distFade;
        }

        const targetPlane = basePlane * isol * distFade;
        const targetPts = basePts * isol * distFade;

        if (entry.plane && entry.planeMat) {
            entry.planeMat.opacity += (targetPlane - entry.planeMat.opacity) * lerpK;
            entry.plane.position.x = parallaxX;
            entry.plane.position.z = parallaxZ;
            if (atGalaxy && entry.plane.scale) entry.plane.scale.setScalar(0.5);
            else if (entry.plane.scale) entry.plane.scale.setScalar(1);
            entry.plane.visible = !inMenu && entry.planeMat.opacity > 0.004;
        }

        const system = entry.system;
        if (system?.material?.uniforms) {
            const u = system.material.uniforms;
            u.opacity.value += (targetPts - u.opacity.value) * lerpK;
            u.time.value = performance.now() * 0.001;
            const dist = state.camera.position.distanceTo(system.position);
            u.cameraDistance.value = Number.isFinite(dist) ? Math.max(dist, 1) : 100;
            system.position.x = parallaxX;
            system.position.z = parallaxZ;
            system.visible = !inMenu && !atGalaxy && u.opacity.value > 0.004;
        }
    }
}

/** Якорь для локации / сейва (body-цикл). */
export function createNebulaVisual(body) {
    if (!body || body.type !== 'interstellarNebula') return null;
    const anchor = new THREE.Object3D();
    anchor.name = 'interstellarNebula';
    anchor.position.set(Number(body.centerX) || 0, 0, Number(body.centerZ) || 0);
    anchor.userData.isNebula = true;
    anchor.userData.nebulaAnchor = true;
    anchor.userData.nebulaMats = [];
    return anchor;
}

export function updateNebulaVisual() { /* через updateNebulaParticleSystems */ }
export function renderNebulaPass() { /* no-op */ }
export function removeNebulaDomOverlay() {
    try {
        const el = document.getElementById('interstellar-nebula-fx');
        if (el) el.remove();
    } catch (_) {}
}
