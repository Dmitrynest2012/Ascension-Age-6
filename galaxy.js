/**
 * Уровень высоты «Галактика» (5ZC).
 * Плоскость Млечного Пути + пыль рукавов.
 * Параметры рукавов (ARM_*) едины для текстуры и particles — визуальная синхронизация.
 */

import {
    particleVertexShader,
    particleFragmentShader
} from './shaders.js';
import { state } from './state.js';
import { a2ReachesBeyondHomeGalaxy, isOpticalFogEnabled } from './opticalScan.js';

export const GALAXY_LAYER = 0;
export const GALAXY_HEIGHT_MIN = 6500;
export const GALAXY_HEIGHT_MAX = 25000;

const FADE_START = 5600;
const FADE_END = 7200;

/** Единые параметры спирали (текстура + пыль + позиции туманностей). */
export const ARM_A0 = [0.18, 0.18 + Math.PI, 0.18 + Math.PI * 0.5, 0.18 + Math.PI * 1.5];
export const ARM_TWIST = 2.55;
/** Доля полурадиуса плоскости: от ядра к периферии (~30% короче) */
export const ARM_R0 = 0.12;
export const ARM_R1 = 0.68;
/** Ширина рукава (доля half) — ×1.5 */
export const ARM_WIDTH = 0.15;

/** Мировая позиция точки на рукаве (armIndex 0..3, t 0..1). half = planeSize/2. */
export function armWorldPos(armIndex, t, half) {
    const a0 = ARM_A0[armIndex % 4];
    const r = (ARM_R0 + Math.max(0, Math.min(1, t)) * (ARM_R1 - ARM_R0)) * half;
    const ang = a0 + Math.max(0, Math.min(1, t)) * ARM_TWIST;
    return { x: Math.cos(ang) * r, z: Math.sin(ang) * r, r, ang };
}

/**
 * Текстура спиральной галактики (общая для 5ZC и 6ZC).
 * armColors: массив из 4 [r,g,b]; coreColors опционально.
 */
export function buildGalaxyTexture(armColors = null, seedShift = 0) {

    const W = 2048;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = W;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, W);

    const cx = W / 2;
    const cy = W / 2;
    const half = W / 2;

    // Мягкий диск
    const bg = ctx.createRadialGradient(cx, cy, half * 0.04, cx, cy, half);
    bg.addColorStop(0.00, 'rgba(36, 32, 48, 0.18)');
    bg.addColorStop(0.35, 'rgba(24, 22, 36, 0.12)');
    bg.addColorStop(0.65, 'rgba(14, 14, 24, 0.06)');
    bg.addColorStop(0.88, 'rgba(8, 8, 14, 0.02)');
    bg.addColorStop(1.00, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, W);

    const defaultArms = [
        [110, 130, 190],
        [95, 115, 170],
        [140, 120, 170],
        [85, 105, 155]
    ];
    const cols = armColors && armColors.length >= 4 ? armColors : defaultArms;
    const arms = [
        { a0: ARM_A0[0] + seedShift, color: cols[0] },
        { a0: ARM_A0[1] + seedShift, color: cols[1] },
        { a0: ARM_A0[2] + seedShift, color: cols[2] },
        { a0: ARM_A0[3] + seedShift, color: cols[3] }
    ];

    for (const arm of arms) {
        for (let i = 0; i < 320; i++) {
            const t = i / 320;
            const r = (ARM_R0 + t * (ARM_R1 - ARM_R0)) * half;
            const ang = arm.a0 + t * ARM_TWIST;
            const x = cx + Math.cos(ang) * r;
            const y = cy + Math.sin(ang) * r;
            // Широкое мягкое пятно — края почти невидимы
            const rad = ARM_WIDTH * half * (1.2 - t * 0.35);
            const [r0, g0, b0] = arm.color;
            const a = (0.045 + (1 - t) * 0.05) * 0.85;
            const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
            g.addColorStop(0.00, `rgba(${r0},${g0},${b0},${Math.min(0.14, a)})`);
            g.addColorStop(0.30, `rgba(${r0},${g0},${b0},${Math.min(0.07, a * 0.5)})`);
            g.addColorStop(0.60, `rgba(${r0},${g0},${b0},${Math.min(0.03, a * 0.2)})`);
            g.addColorStop(1.00, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, rad, 0, Math.PI * 2);
            ctx.fill();
        }
    }

        // Ядро + газ: несколько мягких слоёв, без жёстких колец (бесшовный стык с рукавами)
    const coreLayers = [
        [0.22, 'rgba(255, 236, 210, 0.26)', 'rgba(220, 180, 140, 0.12)', 'rgba(140, 110, 100, 0.04)'],
        [0.16, 'rgba(255, 245, 220, 0.22)', 'rgba(230, 190, 150, 0.10)', 'rgba(0,0,0,0)'],
        [0.10, 'rgba(255, 250, 235, 0.28)', 'rgba(240, 200, 160, 0.12)', 'rgba(0,0,0,0)']
    ];
    for (const [cr, c0, c1, c2] of coreLayers) {
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, half * cr);
        core.addColorStop(0.00, c0);
        core.addColorStop(0.45, c1);
        core.addColorStop(1.00, c2);
        ctx.fillStyle = core;
        ctx.fillRect(0, 0, W, W);
    }
    // Корни рукавов: длинный мягкий стык ядро↔рукав (не «оторванный жгут»)
    for (let arm = 0; arm < 4; arm++) {
        const a0 = ARM_A0[arm];
        for (let i = 0; i < 70; i++) {
            const tt = (i / 70) * 0.32; // глубже в рукав
            const rr = (ARM_R0 * 0.35 + tt * (ARM_R1 - ARM_R0 * 0.35)) * half;
            const ang = a0 + tt * ARM_TWIST;
            const x = cx + Math.cos(ang) * rr;
            const y = cy + Math.sin(ang) * rr;
            const rad = ARM_WIDTH * half * (1.55 - tt * 0.9);
            const fade = 1 - tt * 0.7;
            const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
            g.addColorStop(0.00, `rgba(210, 180, 150, ${0.11 * fade})`);
            g.addColorStop(0.40, `rgba(160, 140, 155, ${0.055 * fade})`);
            g.addColorStop(0.75, `rgba(120, 110, 150, ${0.02 * fade})`);
            g.addColorStop(1.00, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, rad, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    try {
        const img = ctx.getImageData(0, 0, W, W);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const n = (Math.random() - 0.5) * 5;
            d[i] = Math.max(0, Math.min(255, d[i] + n));
            d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
            d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
        }
        ctx.putImageData(img, 0, 0);
    } catch (_) {}

    // SOFT EDGE MASK — убираем «квадрат»: альфа плавно → 0 к краям круга
    try {
        const img = ctx.getImageData(0, 0, W, W);
        const d = img.data;
        const cxF = W * 0.5, cyF = W * 0.5, halfF = W * 0.5;
        for (let y = 0; y < W; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const dx = (x - cxF) / halfF;
                const dy = (y - cyF) / halfF;
                const rr = Math.sqrt(dx * dx + dy * dy);
                // 0..0.70 — полная сила; 0.70..0.98 — плавный спад; >0.98 — ноль
                let m = 1;
                if (rr > 0.98) m = 0;
                else if (rr > 0.70) {
                    const t = (rr - 0.70) / 0.28;
                    m = 1 - t * t * (3 - 2 * t);
                }
                d[i + 3] = Math.round(d[i + 3] * m);
            }
        }
        ctx.putImageData(img, 0, 0);
    } catch (_) {}

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
}


/** Невидимый якорь галактики в сцене (для локации / сейва). */
export function createGalaxyAnchor(body) {
    const anchor = new THREE.Object3D();
    anchor.name = 'galaxyAnchor';
    anchor.position.set(Number(body?.centerX) || 0, 0, Number(body?.centerZ) || 0);
    anchor.userData = anchor.userData || {};
    anchor.userData.isGalaxy = true;
    anchor.userData.bodyId = body?.id;
    return anchor;
}

export function createGalaxyVisuals(data, scene) {
    if (!scene) return;
    state.galaxyVisual = state.galaxyVisual || null;
    if (state.galaxyVisual) return;

    const galaxies = (data || []).filter(b => b && b.type === 'galaxy');
    if (!galaxies.length) {
        state.galaxyVisual = { entries: [] };
        return;
    }

    const entries = [];
    for (const galaxy of galaxies) {
        const id = Number(galaxy.id);
        const size = Number(galaxy.size) || 60000;
        const planeSize = Math.max(size * 1.15, 40000);
        const half = planeSize / 2;
        const lx = Number(galaxy.centerX) || 0;
        const lz = Number(galaxy.centerZ) || 0;

        // Цвета: Млечный путь по умолчанию; Андромеда — розовее
        let armColors = null;
        let seedShift = 0;
        if (id === 3001) {
            armColors = [
                [160, 110, 140],
                [140, 95, 125],
                [180, 120, 150],
                [130, 90, 120]
            ];
            seedShift = 0.35;
        } else if (id === 3002) {
            // Халикс — бирюзово-зелёные рукава
            armColors = [
                [70, 160, 170],
                [55, 140, 155],
                [90, 175, 165],
                [60, 130, 150]
            ];
            seedShift = 0.62;
        }
        const tex = buildGalaxyTexture(armColors, seedShift);
        const planeMat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 0.01,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.NormalBlending
        });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(planeSize, planeSize), planeMat);
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(lx, -40, lz);
        plane.frustumCulled = false;
        plane.renderOrder = -900;
        plane.name = 'galaxyPlane_' + id;
        plane.layers.set(0);
        scene.add(plane);

        // Пыль рукавов + ядра (как у Млечного пути — одинаково для каждой галактики)
        const positions = [];
        const randomSeeds = [];
        // Рукава — плотная пыль
        for (let arm = 0; arm < 4; arm++) {
            for (let i = 0; i < 1400; i++) {
                const t = Math.random();
                const a0 = ARM_A0[arm] + seedShift;
                const r = (ARM_R0 + t * (ARM_R1 - ARM_R0)) * half;
                const ang = a0 + t * ARM_TWIST;
                const spread = (Math.random() - 0.5) * ARM_WIDTH * half * (0.7 + t * 0.4);
                positions.push(
                    Math.cos(ang) * r + Math.cos(ang + Math.PI / 2) * spread,
                    (Math.random() - 0.5) * 22,
                    Math.sin(ang) * r + Math.sin(ang + Math.PI / 2) * spread
                );
                randomSeeds.push(Math.random());
            }
        }
        // Ядро — концентрация пыли к центру
        for (let i = 0; i < 2200; i++) {
            const theta = Math.random() * Math.PI * 2;
            // экспоненциальное распределение: гуще в центре
            const r = half * 0.22 * Math.pow(Math.random(), 1.7);
            positions.push(
                Math.cos(theta) * r,
                (Math.random() - 0.5) * 14,
                Math.sin(theta) * r
            );
            randomSeeds.push(Math.random());
        }
        // Редкий фон диска
        for (let i = 0; i < 1800; i++) {
            const theta = Math.random() * Math.PI * 2;
            const r = (0.12 + Math.sqrt(Math.random()) * 0.78) * half;
            positions.push(Math.cos(theta) * r, (Math.random() - 0.5) * 18, Math.sin(theta) * r);
            randomSeeds.push(Math.random());
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('randomSeed', new THREE.Float32BufferAttribute(randomSeeds, 1));
        // Цвет пыли: Андромеда чуть теплее
        const dustCol = id === 3001
            ? new THREE.Vector3(0.88, 0.72, 0.82)
            : (id === 3002
                ? new THREE.Vector3(0.55, 0.9, 0.95)
                : new THREE.Vector3(0.85, 0.88, 1.0));
        const dustMat = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0.0 },
                opacity: { value: 0.0 },
                color: { value: dustCol },
                pointSize: { value: 0.55 },
                cameraDistance: { value: 100.0 }
            },
            vertexShader: particleVertexShader,
            fragmentShader: particleFragmentShader,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        const system = new THREE.Points(geo, dustMat);
        system.frustumCulled = false;
        system.renderOrder = -890;
        system.name = 'galaxyDust_' + id;
        system.position.set(lx, 0, lz);
        system.layers.set(0);
        scene.add(system);

        entries.push({
            bodyId: id,
            logicalX: lx,
            logicalZ: lz,
            plane,
            planeMat,
            system,
            planeSize,
            half
        });
    }

    state.galaxyVisual = {
        entries,
        // совместимость со старым кодом (первая = Млечный путь)
        plane: entries[0]?.plane || null,
        planeMat: entries[0]?.planeMat || null,
        system: entries[0]?.system || null,
        planeSize: entries[0]?.planeSize || 0,
        half: entries[0]?.half || 0,
        baseOpacityPlane: 0.01,
        baseOpacityDust: 0.01
    };
}

export function updateGalaxyVisuals(currentLevelId) {
    const gv = state.galaxyVisual;
    if (!gv) return;
    const h = state.camera?.position?.y ?? 0;
    const inMenu = !!(state.ui && state.ui.mainMenuVisible);

    let t = 0;
    if (h <= FADE_START) t = 0;
    else if (h >= FADE_END) t = 1;
    else t = (h - FADE_START) / (FADE_END - FADE_START);
    t = t * t * (3 - 2 * t);

    if (currentLevelId === '5ZC') t = Math.max(t, 0.85);
    // На 6ZC детальные плоскости гаснут (остаются диски universe.js)
    if (currentLevelId === '6ZC') t = Math.min(t, 0.06);
    if (inMenu) t = 0;

    const maxPlane = 0.40;
    const maxDust = 0.34;
    const targetPlane = maxPlane * t;
    const targetDust = maxDust * t;
    const lerpK = 0.08 + 0.15 * t;

    let fx = 0, fz = 0;
    try {
        fx = Number(state.foX) || 0;
        fz = Number(state.foZ) || 0;
    } catch (_) {}

    const entries = gv.entries || [];
    if (entries.length) {
        for (const e of entries) {
            if (!e) continue;
            if (e.planeMat) {
                e.planeMat.opacity += (targetPlane - e.planeMat.opacity) * lerpK;
                e.plane.visible = !inMenu && e.planeMat.opacity > 0.004;
                try {
                    if (isOpticalFogEnabled() && !a2ReachesBeyondHomeGalaxy() && Number(e.bodyId || e.id) !== 3000) {
                        e.plane.visible = false;
                        if (e.dust) e.dust.visible = false;
                    }
                } catch (_) {}
            }
            if (e.system?.material?.uniforms) {
                const u = e.system.material.uniforms;
                const dustTarget = currentLevelId === '6ZC' ? 0 : targetDust;
                u.opacity.value += (dustTarget - u.opacity.value) * lerpK;
                u.time.value = performance.now() * 0.001;
                const dist = state.camera
                    ? state.camera.position.distanceTo(e.system.position)
                    : 100;
                u.cameraDistance.value = Number.isFinite(dist) ? Math.max(dist, 1) : 100;
                e.system.visible = !inMenu && u.opacity.value > 0.004 && currentLevelId !== '6ZC';
            }
            // FO: logical → display
            if (e.plane) {
                e.plane.position.x = (e.logicalX || 0) - fx;
                e.plane.position.z = (e.logicalZ || 0) - fz;
            }
            if (e.system) {
                e.system.position.x = (e.logicalX || 0) - fx;
                e.system.position.z = (e.logicalZ || 0) - fz;
            }
        }
        // sync legacy refs
        if (entries[0]) {
            gv.plane = entries[0].plane;
            gv.planeMat = entries[0].planeMat;
            gv.system = entries[0].system;
        }
    } else {
        // legacy single-plane path
        if (gv.planeMat) {
            gv.planeMat.opacity += (targetPlane - gv.planeMat.opacity) * lerpK;
            gv.plane.visible = !inMenu && gv.planeMat.opacity > 0.004;
        }
        if (gv.system?.material?.uniforms) {
            const u = gv.system.material.uniforms;
            const dustTarget = currentLevelId === '6ZC' ? 0 : targetDust;
            u.opacity.value += (dustTarget - u.opacity.value) * lerpK;
            u.time.value = performance.now() * 0.001;
            gv.system.visible = !inMenu && u.opacity.value > 0.004 && currentLevelId !== '6ZC';
        }
        try {
            if (gv.plane) { gv.plane.position.x = -fx; gv.plane.position.z = -fz; }
            if (gv.system) { gv.system.position.x = -fx; gv.system.position.z = -fz; }
        } catch (_) {}
    }
}
