/**
 * Уровень высоты «Вселенная» (6ZC) + визуал пузырей для Мультивселенной (7ZC).
 * Несколько вселенных-сфер, лейблы проецируются из 3D, энергопотоки между пузырями.
 */
import { state } from './state.js';
import { a2ReachesBeyondHomeGalaxy, isOpticalFogEnabled } from './opticalScan.js';
import { buildGalaxyTexture, ARM_A0, ARM_TWIST, ARM_R0, ARM_R1, ARM_WIDTH } from './galaxy.js';

export const UNIVERSE_HEIGHT_MIN = 25000;
export const UNIVERSE_HEIGHT_MAX = 160000;
export const UNIVERSE_LENS_START = 48000;
/** @deprecated — лейбл по isCameraOutsideUniverseBubble */
export const UNIVERSE_BUBBLE_LABEL_Y = 160000;
/** Радиус хрустального шара одной вселенной */
export const UNIVERSE_BUBBLE_RADIUS = 140000;

const FADE_IN_START = 18000;
const FADE_IN_END = 24000;

const GALAXY_ARM_COLORS = {
    3000: [
        [110, 130, 190],
        [95, 115, 170],
        [140, 120, 170],
        [85, 105, 155]
    ],
    3001: [
        [160, 110, 140],
        [140, 95, 125],
        [180, 120, 150],
        [130, 90, 120]
    ],
    3002: [
        [70, 160, 170],
        [55, 140, 155],
        [90, 175, 165],
        [60, 130, 150]
    ]
};

function locUniverseName(body) {
    const n = body?.name;
    if (!n) return 'Universe';
    if (typeof n === 'string') return n;
    const lang = (state.settings && state.settings.language) || 'ru';
    return n[lang] || n.ru || n.en || 'Universe';
}

/**
 * Сфера-пузырь: центр полностью прозрачный, к краю — белёсый градиент (как колодец, но «наружу»).
 * Логика fresnel: чем ближе луч к касательной, тем выше alpha и белизна.
 */
/**
 * Пузырь вселенной — два слоя:
 * 1) fill: градиент от полностью прозрачного центра к белёсой оболочке у границы (во внутрь)
 * 2) contour: чёткий белый контур силуэта сферы
 */
function createUniverseBubbleMesh(radius, logicalX, logicalZ, bodyId) {
    const group = new THREE.Group();
    group.name = 'universeBubble_' + bodyId;
    group.userData.logicalX = logicalX;
    group.userData.logicalZ = logicalZ;
    group.userData.universeId = bodyId;
    group.userData.radius = radius;

    const sharedVS = `
        varying vec3 vWorldPos;
        varying vec3 vN;
        void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vN = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * wp;
        }
    `;

    // --- FILL: объёмная оболочка сферы (не диск).
    // Луч камеры пересекает внешнюю сферу R и внутреннюю R*innerRatio.
    // Градиент начинается с отступом от контура во внутрь; к центру — прозрачнее.
    // Оптическая толщина длиннее у лимба → читается именно сфера.
    const fillMat = new THREE.ShaderMaterial({
        uniforms: {
            opacity: { value: 0 },
            colorShell: { value: new THREE.Color(0xffffff) },
            colorRim: { value: new THREE.Color(0xffffff) },
            camOutside: { value: 0 },
            sphereCenter: { value: new THREE.Vector3(logicalX, 0, logicalZ) },
            sphereRadius: { value: radius },
            innerRatio: { value: 0.88 }
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        vertexShader: sharedVS,
        fragmentShader: `
            uniform float opacity;
            uniform vec3 colorShell;
            uniform vec3 colorRim;
            uniform float camOutside;
            uniform vec3 cameraPosition;
            uniform vec3 sphereCenter;
            uniform float sphereRadius;
            uniform float innerRatio;
            varying vec3 vWorldPos;
            varying vec3 vN;

            bool hitSphere(vec3 ro, vec3 rd, vec3 c, float r, out float t0, out float t1) {
                vec3 oc = ro - c;
                float b = dot(oc, rd);
                float det = b * b - dot(oc, oc) + r * r;
                if (det < 0.0) { t0 = 0.0; t1 = 0.0; return false; }
                float s = sqrt(det);
                t0 = -b - s;
                t1 = -b + s;
                return t1 > 0.0;
            }

            void main() {
                vec3 ro = cameraPosition;
                vec3 rd = normalize(vWorldPos - cameraPosition);
                float R = max(sphereRadius, 1.0);
                float Rin = R * clamp(innerRatio, 0.5, 0.97);

                float o0, o1, i0, i1;
                if (!hitSphere(ro, rd, sphereCenter, R, o0, o1)) discard;

                float enter = max(o0, 0.0);
                float exit  = max(o1, 0.0);
                float pathOuter = max(exit - enter, 0.0);

                float pathInner = 0.0;
                if (hitSphere(ro, rd, sphereCenter, Rin, i0, i1)) {
                    float ie = max(i0, 0.0);
                    float ix = max(i1, 0.0);
                    pathInner = max(ix - ie, 0.0);
                }

                // Длина пути только в оболочке [Rin..R] — у лимба длиннее (сфера, не диск)
                float shellPath = max(pathOuter - pathInner, 0.0);
                float thickness = max(R - Rin, 1.0);
                float od = clamp(shellPath / (thickness * 2.35), 0.0, 1.0);
                od = pow(od, 0.72);

                // Доп. fresnel только чтобы подчеркнуть кривизну, не заменяя объём
                float ndv = abs(dot(normalize(vN), normalize(cameraPosition - vWorldPos)));
                float curve = pow(1.0 - ndv, 1.6);

                float a = opacity * (od * mix(0.42, 0.78, camOutside) + curve * 0.10);
                if (a < 0.008) discard;
                vec3 col = mix(colorShell, colorRim, clamp(od * 0.55 + curve * 0.45, 0.0, 1.0));
                gl_FragColor = vec4(col, clamp(a, 0.0, 0.82));
            }
        `
    });
    const fill = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), fillMat);
    fill.frustumCulled = false;
    fill.renderOrder = -931;
    fill.name = 'universeBubbleFill';
    group.add(fill);

    // --- CONTOUR: узкая яркая полоса ровно на силуэте сферы ---
    const contMat = new THREE.ShaderMaterial({
        uniforms: {
            opacity: { value: 0 },
            colorRim: { value: new THREE.Color(0xffffff) },
            camOutside: { value: 0 }
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: sharedVS,
        fragmentShader: `
            uniform float opacity;
            uniform vec3 colorRim;
            uniform float camOutside;
            uniform vec3 cameraPosition;
            varying vec3 vWorldPos;
            varying vec3 vN;
            void main() {
                vec3 V = normalize(cameraPosition - vWorldPos);
                float ndv = abs(dot(normalize(vN), V));
                float edge = 1.0 - ndv;

                // Узкий «обод» на границе силуэта (чёткий контур сферы)
                float band = smoothstep(0.62, 0.78, edge) * (1.0 - smoothstep(0.86, 0.98, edge));
                // ещё более тонкая яркая линия поверх
                float line = exp(-pow((edge - 0.82) / 0.045, 2.0));

                float a = (band * 0.55 + line * 0.95) * opacity * mix(0.7, 1.15, camOutside);
                if (a < 0.01) discard;
                gl_FragColor = vec4(colorRim, clamp(a, 0.0, 1.0));
            }
        `
    });
    const contour = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.002, 96, 64), contMat);
    contour.frustumCulled = false;
    contour.renderOrder = -929;
    contour.name = 'universeBubbleContour';
    group.add(contour);

    // --- экваториальное кольцо (помогает читать сферу в плане) ---
    const ringGeo = new THREE.TorusGeometry(radius * 0.998, radius * 0.0045, 8, 128);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.frustumCulled = false;
    ring.renderOrder = -928;
    ring.name = 'universeBubbleRing';
    group.add(ring);

    group.userData.fillMat = fillMat;
    group.userData.contMat = contMat;
    group.userData.ringMat = ringMat;
    // совместимость: mat → fill (opacity drive)
    group.userData.mat = fillMat;
    return group;
}

/** DOM-лейбл, позиция обновляется проекцией 3D-точки над сферой. */
function createBubbleLabel(text, bodyId) {
    const el = document.createElement('div');
    el.className = 'universe-bubble-label';
    el.dataset.universeId = String(bodyId);
    el.textContent = text;
    el.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'transform:translate(-50%,-100%)',
        'pointer-events:auto', 'cursor:pointer', 'z-index:45', 'opacity:0',
        'color:#dce9ff', 'font-family:Play,sans-serif', 'font-size:18px',
        'letter-spacing:0.1em', 'text-shadow:0 0 12px rgba(120,160,255,0.55)',
        'padding:6px 14px', 'background:rgba(0,0,0,0.45)',
        'clip-path:polygon(8px 0,100% 0,100% 100%,0 100%,0 8px)',
        'transition:opacity 0.5s ease', 'white-space:nowrap'
    ].join(';');
    document.body.appendChild(el);
    return el;
}

/**
 * Энергопоток между двумя вселенными — анимированная «лента» частиц + шейдерная труба.
 */
function createEnergyStream(ax, az, bx, bz, scene) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const midX = (ax + bx) * 0.5;
    const midZ = (az + bz) * 0.5;

    // Тонкая светящаяся «труба» (цилиндр вдоль X, потом ориентация)
    const tubeGeo = new THREE.CylinderGeometry(180, 180, len, 12, 32, true);
    tubeGeo.rotateZ(Math.PI / 2);
    const tubeMat = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            opacity: { value: 0 },
            colorA: { value: new THREE.Color(0x6ec8ff) },
            colorB: { value: new THREE.Color(0xb48cff) }
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: `
            varying float vAlong;
            varying vec3 vN;
            void main() {
                vAlong = position.x; // после rotateZ ось вдоль X
                vN = normalize(normalMatrix * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform float time;
            uniform float opacity;
            uniform vec3 colorA;
            uniform vec3 colorB;
            varying float vAlong;
            varying vec3 vN;
            void main() {
                float flow = fract(vAlong * 0.00012 - time * 0.35);
                float pulse = smoothstep(0.0, 0.15, flow) * smoothstep(0.55, 0.2, flow);
                float rim = pow(1.0 - abs(dot(normalize(vN), vec3(0.0, 0.0, 1.0))), 1.5);
                vec3 col = mix(colorA, colorB, flow);
                float a = opacity * (0.15 + pulse * 0.7 + rim * 0.25);
                if (a < 0.01) discard;
                gl_FragColor = vec4(col, a);
            }
        `
    });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.frustumCulled = false;
    tube.renderOrder = -940;
    tube.name = 'universeEnergyTube';

    // Ориентация трубы в XZ
    const ang = Math.atan2(dz, dx);
    tube.rotation.y = -ang;
    tube.position.set(midX, 0, midZ);

    // Частицы потока
    const N = 600;
    const positions = [];
    const seeds = [];
    for (let i = 0; i < N; i++) {
        const t = i / N;
        const x = ax + dx * t;
        const z = az + dz * t;
        const y = (Math.random() - 0.5) * 400;
        const side = (Math.random() - 0.5) * 500;
        const px = x + Math.cos(ang + Math.PI / 2) * side;
        const pz = z + Math.sin(ang + Math.PI / 2) * side;
        positions.push(px, y, pz);
        seeds.push(Math.random());
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    pGeo.setAttribute('randomSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const pMat = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            opacity: { value: 0 },
            color: { value: new THREE.Color(0xa0d8ff) },
            pointSize: { value: 3.2 }
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
            attribute float randomSeed;
            uniform float time;
            uniform float pointSize;
            varying float vB;
            void main() {
                vec3 p = position;
                // лёгкое «течение» вдоль заранее заложенного направления через фазу
                float phase = fract(randomSeed + time * 0.25);
                vB = 0.5 + 0.5 * sin(phase * 6.28318);
                vec4 mv = modelViewMatrix * vec4(p, 1.0);
                float dist = max(length(mv.xyz), 1.0);
                gl_PointSize = pointSize * (0.6 + randomSeed) * clamp(2200.0 / dist, 0.4, 3.0);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: `
            uniform float opacity;
            uniform vec3 color;
            varying float vB;
            void main() {
                vec2 uv = gl_PointCoord - vec2(0.5);
                float d = length(uv);
                if (d > 0.5) discard;
                float core = 1.0 - smoothstep(0.0, 0.25, d);
                float a = opacity * (core * 0.9 + 0.15) * vB;
                gl_FragColor = vec4(color, a);
            }
        `
    });
    const pts = new THREE.Points(pGeo, pMat);
    pts.frustumCulled = false;
    pts.renderOrder = -939;
    pts.name = 'universeEnergyParticles';

    scene.add(tube);
    scene.add(pts);
    return {
        tube, tubeMat, pts, pMat,
        logicalAX: ax, logicalAZ: az,
        logicalBX: bx, logicalBZ: bz,
        midX, midZ
    };
}

/**
 * Декоративные задние галактики — обязательный элемент КАЖДОЙ вселенной.
 * Кластер центрирован на своей вселенной, внутри пузыря, вдали от реальных галактик.
 */
function createUniverseDecorGalaxies(universe, realGalaxies, scene) {
    const ux = Number(universe.centerX) || 0;
    const uz = Number(universe.centerZ) || 0;
    const R = Math.max(Number(universe.size) || UNIVERSE_BUBBLE_RADIUS, 80000);
    const uid = Number(universe.id);

    const exclude = [];
    for (const g of realGalaxies || []) {
        const parent = g.parent != null ? Number(g.parent) : null;
        if (parent !== uid && Number(g.universeId) !== uid) continue;
        exclude.push({
            x: Number(g.centerX) || 0,
            z: Number(g.centerZ) || 0,
            r: Math.max((Number(g.size) || 40000) * 0.55, 18000)
        });
    }

    const N = 720;
    const positions = [];
    const seeds = [];
    const sizes = [];
    let attempts = 0;
    while (positions.length / 3 < N && attempts < N * 40) {
        attempts++;
        const u = Math.random();
        // объём сферы вселенной: ближе к оболочке чуть плотнее, центр не пустой
        const r = R * (0.12 + Math.pow(u, 0.65) * 0.78);
        const th = Math.random() * Math.PI * 2;
        const ph = (Math.random() - 0.5) * Math.PI * 0.85;
        const y = Math.sin(ph) * r * 0.42;
        const rr = Math.cos(ph) * r;
        const x = ux + Math.cos(th) * rr;
        const z = uz + Math.sin(th) * rr;
        let ok = true;
        for (const e of exclude) {
            const dx = x - e.x, dz = z - e.z;
            if (dx * dx + dz * dz < e.r * e.r) { ok = false; break; }
        }
        if (!ok) continue;
        positions.push(x - ux, y, z - uz); // локально от центра вселенной
        seeds.push(Math.random());
        sizes.push(0.5 + Math.random() * 1.35);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('randomSeed', new THREE.Float32BufferAttribute(seeds, 1));
    geo.setAttribute('microSize', new THREE.Float32BufferAttribute(sizes, 1));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            opacity: { value: 0 },
            colorNear: { value: new THREE.Color(0xb0bcc8) },
            colorFar: { value: new THREE.Color(0x8a4030) },
            pointSize: { value: 150.0 }
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        vertexShader: `
            attribute float randomSeed;
            attribute float microSize;
            uniform float time;
            uniform float pointSize;
            varying float vBright;
            varying float vDist;
            varying float vSeed;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                float dist = max(length(mv.xyz), 1.0);
                vDist = dist;
                vSeed = randomSeed;
                vBright = 0.72 + 0.28 * sin(time * 0.12 + randomSeed * 6.0);
                gl_PointSize = pointSize * microSize * clamp(380.0 / dist, 0.35, 3.0);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: `
            uniform float opacity;
            uniform vec3 colorNear;
            uniform vec3 colorFar;
            varying float vBright;
            varying float vDist;
            varying float vSeed;
            void main() {
                vec2 uv = gl_PointCoord - vec2(0.5);
                float ang = vSeed * 6.28318;
                float c = cos(ang), s = sin(ang);
                vec2 p = vec2(c * uv.x + s * uv.y, -s * uv.x + c * uv.y);
                p.x *= 1.55;
                float d = length(p);
                if (d > 0.5) discard;
                float core = 1.0 - smoothstep(0.0, 0.18, d);
                float halo = 1.0 - smoothstep(0.12, 0.5, d);
                float shape = core * 0.85 + halo * 0.32;
                float farK = clamp((vDist - 22000.0) / 140000.0, 0.0, 1.0);
                vec3 col = mix(colorNear, colorFar, farK);
                float a = opacity * shape * vBright * (1.0 - farK * 0.5);
                if (a < 0.01) discard;
                gl_FragColor = vec4(col, a);
            }
        `
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -926;
    pts.name = 'universeDecorGalaxies_' + uid;
    scene.add(pts);
    return { pts, mat, logicalX: ux, logicalZ: uz, universeId: uid };
}

function createUniverseGalaxyStarfield(discR, seedShift, starTint, scene, bodyId) {
    const half = discR;
    const positions = [];
    const seeds = [];
    for (let arm = 0; arm < 4; arm++) {
        for (let i = 0; i < 4200; i++) {
            const t = Math.random();
            const a0 = ARM_A0[arm % 4] + seedShift;
            const r = (ARM_R0 + t * (ARM_R1 - ARM_R0)) * half;
            const ang = a0 + t * ARM_TWIST;
            const u1 = Math.max(1e-6, Math.random());
            const u2 = Math.random();
            const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const sigma = ARM_WIDTH * half * (1.1 + t * 0.9);
            const spread = gauss * sigma * 0.55;
            positions.push(
                Math.cos(ang) * r + Math.cos(ang + Math.PI / 2) * spread,
                (Math.random() - 0.5) * 14,
                Math.sin(ang) * r + Math.sin(ang + Math.PI / 2) * spread
            );
            seeds.push(Math.random());
        }
        for (let i = 0; i < 1600; i++) {
            const t = Math.random();
            const a0 = ARM_A0[arm % 4] + seedShift;
            const r = (ARM_R0 + t * (ARM_R1 - ARM_R0)) * half * (0.92 + Math.random() * 0.16);
            const ang = a0 + t * ARM_TWIST + (Math.random() - 0.5) * 0.12;
            const u1 = Math.max(1e-6, Math.random());
            const u2 = Math.random();
            const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const sigma = ARM_WIDTH * half * (2.2 + t * 1.4);
            const spread = gauss * sigma * 0.5;
            positions.push(
                Math.cos(ang) * r + Math.cos(ang + Math.PI / 2) * spread,
                (Math.random() - 0.5) * 16,
                Math.sin(ang) * r + Math.sin(ang + Math.PI / 2) * spread
            );
            seeds.push(Math.random());
        }
    }
    for (let i = 0; i < 3000; i++) {
        const th = Math.random() * Math.PI * 2;
        const r = half * 0.22 * Math.pow(Math.random(), 1.55);
        positions.push(Math.cos(th) * r, (Math.random() - 0.5) * 10, Math.sin(th) * r);
        seeds.push(Math.random());
    }
    for (let i = 0; i < 3200; i++) {
        const th = Math.random() * Math.PI * 2;
        const r = (0.08 + Math.pow(Math.random(), 0.7) * 0.88) * half;
        positions.push(Math.cos(th) * r, (Math.random() - 0.5) * 12, Math.sin(th) * r);
        seeds.push(Math.random());
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('randomSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            opacity: { value: 0 },
            color: { value: new THREE.Color(starTint[0], starTint[1], starTint[2]) },
            pointSize: { value: 2.4 }
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
            attribute float randomSeed;
            uniform float time;
            uniform float pointSize;
            varying float vB;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                float dist = max(length(mv.xyz), 1.0);
                float sz = pointSize * (0.7 + randomSeed * 0.9) * clamp(1800.0 / dist, 0.55, 2.8);
                gl_PointSize = sz;
                vB = 0.75 + 0.25 * sin(time * 0.4 + randomSeed * 14.0);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: `
            uniform float opacity;
            uniform vec3 color;
            varying float vB;
            void main() {
                vec2 uv = gl_PointCoord - vec2(0.5);
                float d = length(uv);
                if (d > 0.5) discard;
                float core = 1.0 - smoothstep(0.0, 0.22, d);
                float halo = (1.0 - smoothstep(0.15, 0.5, d)) * 0.25;
                float a = (core + halo) * opacity * vB;
                if (a < 0.02) discard;
                gl_FragColor = vec4(color * (0.85 + core * 0.4), a);
            }
        `
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -905;
    pts.name = 'universeGalaxyStars_' + bodyId;
    pts.visible = false;
    scene.add(pts);
    return pts;
}

function createUniverseGalaxyDisc(body, scene) {
    const size = Math.max(Number(body.size) || 60000, 10000);
    const discR = Math.max(size * 0.28, 14000);
    const id = Number(body.id);
    const arms = GALAXY_ARM_COLORS[id] || null;
    const seedShift = id === 3001 ? 0.35 : (id === 3002 ? 0.62 : 0);
    const tex = buildGalaxyTexture(arms, seedShift);
    const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(discR * 2, discR * 2), mat);
    plane.rotation.x = -Math.PI / 2;
    const lx = Number(body.centerX) || 0;
    const lz = Number(body.centerZ) || 0;
    plane.position.set(lx, -40, lz);
    plane.frustumCulled = false;
    plane.renderOrder = -910;
    plane.name = `universeGalaxyDisc_${body.id}`;
    plane.userData.galaxyId = body.id;
    plane.userData.logicalX = lx;
    plane.userData.logicalZ = lz;
    scene.add(plane);

    const starTint = id === 3001 ? [1.0, 0.82, 0.88] : (id === 3002 ? [0.75, 0.95, 1.0] : [0.92, 0.95, 1.0]);
    const stars = createUniverseGalaxyStarfield(discR, seedShift, starTint, scene, id);
    stars.position.set(lx, -20, lz);

    return {
        plane, mat, discR,
        logicalX: lx, logicalZ: lz, bodyId: id,
        stars, starsMat: stars.material,
        parentUniverseId: body.parent != null ? Number(body.parent) : 4000
    };
}

function projectToScreen(worldX, worldY, worldZ, camera) {
    if (!camera) return null;
    const v = new THREE.Vector3(worldX, worldY, worldZ);
    v.project(camera);
    if (v.z > 1) return null; // behind camera
    const x = (v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, ndcZ: v.z };
}

export function createUniverseVisuals(data, scene) {
    if (!scene) return;
    if (state.universeVisual) return;

    const universes = (data || []).filter(b => b.type === 'universe');
    const galaxies = (data || []).filter(b => b.type === 'galaxy');
    const discs = galaxies.map(g => createUniverseGalaxyDisc(g, scene));

    const bubbles = [];
    for (const u of universes) {
        const lx = Number(u.centerX) || 0;
        const lz = Number(u.centerZ) || 0;
        const R = Math.max(Number(u.size) || UNIVERSE_BUBBLE_RADIUS, 80000);
        const mesh = createUniverseBubbleMesh(R, lx, lz, u.id);
        mesh.position.set(lx, 0, lz);
        scene.add(mesh);
        const label = createBubbleLabel(locUniverseName(u), u.id);
        bubbles.push({
            bodyId: Number(u.id),
            logicalX: lx,
            logicalZ: lz,
            radius: R,
            mesh,
            mat: mesh.userData.fillMat,
            label,
            name: u.name
        });
    }

    // Энергопотоки между всеми парами вселенных
    const streams = [];
    for (let i = 0; i < universes.length; i++) {
        for (let j = i + 1; j < universes.length; j++) {
            const a = universes[i], b = universes[j];
            const ax = Number(a.centerX) || 0, az = Number(a.centerZ) || 0;
            const bx = Number(b.centerX) || 0, bz = Number(b.centerZ) || 0;
            const ra = Math.max(Number(a.size) || UNIVERSE_BUBBLE_RADIUS, 80000);
            const rb = Math.max(Number(b.size) || UNIVERSE_BUBBLE_RADIUS, 80000);
            const dx = bx - ax, dz = bz - az;
            const dist = Math.hypot(dx, dz) || 1;
            // поток только ВНЕ пузырей: от поверхности A до поверхности B
            const ux = dx / dist, uz = dz / dist;
            const gap = dist - ra - rb;
            if (gap < ra * 0.05) continue;
            const sax = ax + ux * ra;
            const saz = az + uz * ra;
            const sbx = bx - ux * rb;
            const sbz = bz - uz * rb;
            streams.push(createEnergyStream(sax, saz, sbx, sbz, scene));
        }
    }

    const decor = universes.map(u => createUniverseDecorGalaxies(u, galaxies, scene));

    const oldFixed = document.getElementById('universe-level-label');
    if (oldFixed) oldFixed.remove();

    state.universeVisual = {
        discs,
        bubbles,
        streams,
        decor,
        baseBubbleOpacity: 1.0,
        baseDecorOpacity: 0.34,
        baseStreamOpacity: 0.62
    };
}

export function updateUniverseVisuals(currentLevelId, height) {
    const uv = state.universeVisual;
    if (!uv) return;
    const h = Number(height) || (state.camera?.position?.y ?? 0);
    const inMenu = !!(state.ui && state.ui.mainMenuVisible);
    const cam = state.camera;

    let t = 0;
    if (h <= FADE_IN_START) t = 0;
    else if (h >= FADE_IN_END) t = 1;
    else t = (h - FADE_IN_START) / (FADE_IN_END - FADE_IN_START);
    t = t * t * (3 - 2 * t);
    if (currentLevelId === '6ZC' || currentLevelId === '7ZC') t = Math.max(t, 0.95);
    if (inMenu) t = 0;

    let bubbleT = 0;
    if (h >= UNIVERSE_LENS_START) {
        bubbleT = Math.min(1, (h - UNIVERSE_LENS_START) / 120000);
        bubbleT = bubbleT * bubbleT * (3 - 2 * bubbleT);
    }
    if (currentLevelId === '6ZC' || currentLevelId === '7ZC') bubbleT = Math.max(bubbleT, 0.4);
    if (currentLevelId === '7ZC') bubbleT = Math.max(bubbleT, 0.95);
    if (inMenu) bubbleT = 0;

    const expand = 1 + Math.min(1, Math.max(0, (h - 80000) / 200000)) * 0.25;

    let foX = 0, foZ = 0;
    try {
        foX = Number(state.foX) || 0;
        foZ = Number(state.foZ) || 0;
    } catch (_) {}

    // Диски галактик
    const starT = ((currentLevelId === '6ZC' || currentLevelId === '7ZC') && !inMenu) ? t : 0;
    for (const d of (uv.discs || [])) {
        if (!d?.plane || !d.mat) continue;
        const dx = (d.logicalX || 0) - foX;
        const dz = (d.logicalZ || 0) - foZ;
        d.plane.position.x = dx;
        d.plane.position.z = dz;
        d.plane.position.y = -40;
        const target = t * 0.88;
        d.mat.opacity += (target - d.mat.opacity) * 0.12;
        d.plane.visible = !inMenu && d.mat.opacity > 0.01;
        try {
            if (isOpticalFogEnabled() && !a2ReachesBeyondHomeGalaxy() && Number(d.bodyId) !== 3000) {
                d.plane.visible = false;
                if (d.stars) d.stars.visible = false;
            }
        } catch (_) {}
        d.plane.scale.set(expand, expand, expand);
        d.plane.rotation.z += 0.0000012;

        if (d.stars && d.starsMat?.uniforms) {
            d.stars.position.x = dx;
            d.stars.position.z = dz;
            d.stars.position.y = -20;
            d.stars.scale.set(expand, expand, expand);
            d.stars.rotation.y += 0.0000008;
            const st = starT * 0.72;
            d.starsMat.uniforms.opacity.value += (st - d.starsMat.uniforms.opacity.value) * 0.12;
            d.starsMat.uniforms.time.value = performance.now() * 0.001;
            d.stars.visible = !inMenu && d.starsMat.uniforms.opacity.value > 0.02
                && (currentLevelId === '6ZC' || currentLevelId === '7ZC');
        }
    }

    // Пузыри + лейблы
    for (const b of (uv.bubbles || [])) {
        if (!b?.mesh) continue;
        const dx = (b.logicalX || 0) - foX;
        const dz = (b.logicalZ || 0) - foZ;
        b.mesh.position.set(dx, 0, dz);

        const targetB = bubbleT * (uv.baseBubbleOpacity || 1);
        const fillMat = b.mesh.userData.fillMat || b.mat;
        const contMat = b.mesh.userData.contMat;
        const ringMat = b.mesh.userData.ringMat;

        let outside = 0;
        if (cam) {
            const dist = Math.hypot(
                cam.position.x - dx,
                cam.position.y - 0,
                cam.position.z - dz
            );
            const edge = (dist - b.radius * 0.72) / (b.radius * 0.4);
            outside = Math.max(0, Math.min(1, edge));
        }

        if (fillMat?.uniforms) {
            fillMat.uniforms.opacity.value += (targetB - fillMat.uniforms.opacity.value) * 0.12;
            if (fillMat.uniforms.camOutside)
                fillMat.uniforms.camOutside.value += (outside - fillMat.uniforms.camOutside.value) * 0.12;
            if (fillMat.uniforms.sphereCenter)
                fillMat.uniforms.sphereCenter.value.set(dx, 0, dz);
            if (fillMat.uniforms.sphereRadius)
                fillMat.uniforms.sphereRadius.value = b.radius;
        }
        if (contMat?.uniforms) {
            // контур ярче снаружи и на 7ZC
            const contT = targetB * (0.85 + outside * 0.35);
            contMat.uniforms.opacity.value += (contT - contMat.uniforms.opacity.value) * 0.12;
            if (contMat.uniforms.camOutside)
                contMat.uniforms.camOutside.value += (outside - contMat.uniforms.camOutside.value) * 0.12;
        }
        if (ringMat) {
            const ringT = targetB * (0.15 + outside * 0.40);
            ringMat.opacity += (ringT - ringMat.opacity) * 0.12;
        }

        const op = fillMat?.uniforms?.opacity?.value || 0;
        b.mesh.visible = !inMenu && op > 0.01;

        // Лейбл: проекция над вершиной сферы (только снаружи)
        if (b.label && cam) {
            const show = !inMenu && outside > 0.45;
            b.label.style.opacity = show ? '1' : '0';
            b.label.style.pointerEvents = show ? 'auto' : 'none';
            if (show) {
                const topY = b.radius * 1.02;
                const scr = projectToScreen(dx, topY, dz, cam);
                if (scr && scr.ndcZ < 1) {
                    b.label.style.left = scr.x + 'px';
                    b.label.style.top = scr.y + 'px';
                    b.label.style.display = 'block';
                } else {
                    b.label.style.opacity = '0';
                }
                try {
                    const body = state.celestialBodies?.[b.bodyId]?.data
                        || state.celestialBodies?.[String(b.bodyId)]?.data;
                    if (body) b.label.textContent = locUniverseName(body);
                } catch (_) {}
            }
        }
    }

    // Энергопотоки: только 7ZC и только если камера СНАРУЖИ всех пузырей
    let camInsideBubble = false;
    if (cam) {
        for (const b of (uv.bubbles || [])) {
            const cx = (b.logicalX || 0) - foX;
            const cz = (b.logicalZ || 0) - foZ;
            const dist = Math.hypot(cam.position.x - cx, cam.position.y, cam.position.z - cz);
            if (dist < (b.radius || UNIVERSE_BUBBLE_RADIUS) * 0.98) {
                camInsideBubble = true;
                break;
            }
        }
    }
    const streamT = (!inMenu && currentLevelId === '7ZC' && !camInsideBubble)
        ? Math.max(bubbleT, 0.85)
        : 0;
    for (const s of (uv.streams || [])) {
        if (!s) continue;
        const mx = ((s.logicalAX + s.logicalBX) * 0.5) - foX;
        const mz = ((s.logicalAZ + s.logicalBZ) * 0.5) - foZ;
        if (s.tube) {
            s.tube.position.x = mx;
            s.tube.position.z = mz;
        }
        // particles are in absolute logical coords — shift whole Points
        if (s.pts) {
            s.pts.position.set(-foX, 0, -foZ);
        }
        const op = streamT * (uv.baseStreamOpacity || 0.55);
        if (s.tubeMat?.uniforms) {
            s.tubeMat.uniforms.opacity.value += (op - s.tubeMat.uniforms.opacity.value) * 0.1;
            s.tubeMat.uniforms.time.value = performance.now() * 0.001;
            s.tube.visible = !inMenu && s.tubeMat.uniforms.opacity.value > 0.02;
        }
        if (s.pMat?.uniforms) {
            s.pMat.uniforms.opacity.value += (op * 0.85 - s.pMat.uniforms.opacity.value) * 0.1;
            s.pMat.uniforms.time.value = performance.now() * 0.001;
            s.pts.visible = !inMenu && s.pMat.uniforms.opacity.value > 0.02;
        }
    }

    // Декор-галактики каждой вселенной — центрированы на своём пузыре
    const decorT = inMenu ? 0 : t * (uv.baseDecorOpacity || 0.34);
    for (const d of (uv.decor || [])) {
        if (!d?.pts || !d.mat?.uniforms) continue;
        d.pts.position.set((d.logicalX || 0) - foX, 0, (d.logicalZ || 0) - foZ);
        d.mat.uniforms.opacity.value += (decorT - d.mat.uniforms.opacity.value) * 0.1;
        d.mat.uniforms.time.value = performance.now() * 0.001;
        d.pts.visible = !inMenu && d.mat.uniforms.opacity.value > 0.01
            && (currentLevelId === '6ZC' || currentLevelId === '7ZC');
        try {
            if (isOpticalFogEnabled() && !a2ReachesBeyondHomeGalaxy()) d.pts.visible = false;
        } catch (_) {}
    }
}

/** Ближайшая галактика к камере (display-space). */
export function findNearestGalaxy(camera) {
    if (!camera) return null;
    let best = null, bestD = Infinity;
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        if (!e?.mesh || e.data?.type !== 'galaxy') continue;
        const dx = camera.position.x - e.mesh.position.x;
        const dz = camera.position.z - e.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d < bestD) { bestD = d; best = e; }
    }
    return best ? { body: best, dist: bestD } : null;
}

export function galaxyHasInterior(galaxyBody) {
    if (!galaxyBody?.data) return false;
    const gid = Number(galaxyBody.data.id);
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        const t = e?.data?.type;
        if (t !== 'interstellarNebula' && t !== 'star' && t !== 'starSystem') continue;
        if (Number(e.data.galaxyId) === gid) return true;
        if (Number(e.data.parent) === gid) return true;
    }
    return false;
}

/**
 * Камера снаружи ближайшего / текущего пузыря вселенной?
 */
export function isCameraOutsideUniverseBubble(camera) {
    if (!camera) return false;
    const uv = state.universeVisual;
    let foX = 0, foZ = 0;
    try {
        foX = Number(state.foX) || 0;
        foZ = Number(state.foZ) || 0;
    } catch (_) {}

    const bubbles = uv?.bubbles;
    if (bubbles && bubbles.length) {
        let best = Infinity;
        for (const b of bubbles) {
            const dx = camera.position.x - ((b.logicalX || 0) - foX);
            const dy = camera.position.y;
            const dz = camera.position.z - ((b.logicalZ || 0) - foZ);
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const margin = (b.radius || UNIVERSE_BUBBLE_RADIUS) * 1.02;
            if (dist < best) best = dist;
            if (dist <= margin) return false; // still inside at least one
        }
        return best > UNIVERSE_BUBBLE_RADIUS * 1.02;
    }
    // fallback single origin
    const dist = Math.hypot(camera.position.x + foX, camera.position.y, camera.position.z + foZ);
    return dist > UNIVERSE_BUBBLE_RADIUS * 1.02;
}

export function getUniverseBubbleCenterDisplay(universeId) {
    let foX = 0, foZ = 0;
    try {
        foX = Number(state.foX) || 0;
        foZ = Number(state.foZ) || 0;
    } catch (_) {}
    const uv = state.universeVisual;
    if (universeId != null && uv?.bubbles) {
        const b = uv.bubbles.find(x => Number(x.bodyId) === Number(universeId));
        if (b) {
            return {
                x: (b.logicalX || 0) - foX,
                y: 0,
                z: (b.logicalZ || 0) - foZ,
                radius: b.radius || UNIVERSE_BUBBLE_RADIUS
            };
        }
    }
    // default: Universe-512 at logical 0
    return { x: -foX, y: 0, z: -foZ, radius: UNIVERSE_BUBBLE_RADIUS };
}
