/**
 * 3D/2D визуалы гео-разведки: матрица, сетка секторов на теле, туман после скана, зонд.
 */
import { state } from './state.js';
import { camera } from './camera.js';
import { ensureBodyDeposits, isBodySurveyComplete } from './geoSurveyGame.js';
import { t } from './settings.js';

const DEPOSIT_COLORS = [
    '#e85d4c', '#f0a030', '#e8d44a', '#6bcb5f', '#3ec6ff',
    '#5b8def', '#9b6bff', '#ff6bcb', '#c5c8cc', '#2ec4b6'
];

/** Равномерная сетка по всей сфере: 8 долгот × 6 широт = 48 секторов */
const SECTOR_COLS = 8;
const SECTOR_ROWS = 6;
const SECTOR_COUNT = SECTOR_COLS * SECTOR_ROWS;


let overlaysRoot = null;
let matrixEl = null;
let targetEls = new Map();
let sectorEls = new Map();
let probeEl = null;
let fogGroup = null;
let sectorGridGroup = null; // THREE grid on body
let attachedBodyMesh = null;
let scanRippleMesh = null;
let probeWaveMesh = null;
let probeWaveActive = false;
let probeWaveStart = 0;
let probeWaveDuration = 5200;
let surfaceReticle = null; // 3D мишень на поверхности


function ensureOverlays() {
    if (overlaysRoot) return overlaysRoot;
    overlaysRoot = document.createElement('div');
    overlaysRoot.id = 'geo-survey-overlays';
    overlaysRoot.innerHTML = `
        <div class="gs-matrix" id="gs-matrix">
            <div class="gs-matrix-cross"></div>
            <div class="gs-matrix-ring r1"></div>
            <div class="gs-matrix-ring r2"></div>
            <div class="gs-matrix-ring r3"></div>
            <div class="gs-matrix-scanline"></div>
            <div class="gs-dir" id="gs-dir">
                <div class="gs-dir-arc a1"></div>
                <div class="gs-dir-arc a2"></div>
                <div class="gs-dir-arc a3"></div>
            </div>
        </div>
        <div id="gs-sectors"></div>
        <div id="gs-targets"></div>
        <div id="gs-probe" class="gs-probe" style="display:none"></div>
    `;
    document.body.appendChild(overlaysRoot);
    matrixEl = overlaysRoot.querySelector('#gs-matrix');
    probeEl = overlaysRoot.querySelector('#gs-probe');
    return overlaysRoot;
}

function bodyRadius(body) {
    return Math.max(0.05, Number(body?.data?.size) || 1);
}

/** Реальный радиус поверхности mesh (как у SphereGeometry), иначе data.size */
function meshSurfaceRadius(body) {
    const mesh = body?.mesh;
    const g = mesh?.geometry;
    if (g?.parameters?.radius != null && Number.isFinite(g.parameters.radius)) {
        return Math.max(0.05, g.parameters.radius);
    }
    if (g) {
        try {
            if (!g.boundingSphere) g.computeBoundingSphere();
            if (g.boundingSphere?.radius) return Math.max(0.05, g.boundingSphere.radius);
        } catch (_) {}
    }
    return bodyRadius(body);
}

function sph(r, yaw, pitch) {
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    return new THREE.Vector3(
        r * cp * Math.sin(yaw),
        r * sp,
        r * cp * Math.cos(yaw)
    );
}

/**
 * Залежи хранятся в локальных углах тела (yaw/pitch).
 * Мировая позиция = local * quaternion(mesh) + position —
 * синхронно с вращением при ускорении времени.
 */
function depositWorldPos(body, dep) {
    const mesh = body.mesh;
    const R = meshSurfaceRadius(body);
    const local = sph(R * 1.012, dep.yaw, dep.pitch);
    local.applyQuaternion(mesh.quaternion);
    return local.add(mesh.position);
}

/** Локальный вектор на поверхности (для секторов / тумана) с учётом scale mesh */
function depositLocalPos(dep, r = 1.02) {
    return sph(r, dep.yaw, dep.pitch);
}

function projectToScreen(v3) {
    if (!camera) return null;
    const v = v3.clone().project(camera);
    if (v.z > 1) return null;
    return {
        x: (v.x * 0.5 + 0.5) * window.innerWidth,
        y: (-v.y * 0.5 + 0.5) * window.innerHeight,
        z: v.z
    };
}

/**
 * Сетка 3×3 на поверхности сферы (локальные координаты mesh).
 * Диапазон yaw / pitch покрывает большую часть тела.
 */
function gridAxes() {
    // Полная сфера: долгота −π…π, широта −π/2…π/2 (без крошечного отступа у полюсов)
    const yawMin = -Math.PI;
    const yawMax = Math.PI;
    const pitchMin = -Math.PI / 2 + 0.02;
    const pitchMax = Math.PI / 2 - 0.02;
    const yaws = [];
    const pitches = [];
    for (let i = 0; i <= SECTOR_COLS; i++) {
        yaws.push(yawMin + (yawMax - yawMin) * (i / SECTOR_COLS));
    }
    for (let i = 0; i <= SECTOR_ROWS; i++) {
        pitches.push(pitchMin + (pitchMax - pitchMin) * (i / SECTOR_ROWS));
    }
    return { yaws, pitches, yawMin, yawMax, pitchMin, pitchMax };
}

function buildSectorGridMesh() {
    const group = new THREE.Group();
    group.name = 'geoSurveySectorGrid';
    const r = 1.012;
    const { yaws, pitches } = gridAxes();
    const positions = [];
    const segs = 64; // плотная сетка по дугам

    for (const yaw of yaws) {
        for (let i = 0; i < segs; i++) {
            const t0 = i / segs;
            const t1 = (i + 1) / segs;
            const p0 = pitches[0] + (pitches[pitches.length - 1] - pitches[0]) * t0;
            const p1 = pitches[0] + (pitches[pitches.length - 1] - pitches[0]) * t1;
            const a = sph(r, yaw, p0);
            const b = sph(r, yaw, p1);
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
    }
    for (const pitch of pitches) {
        for (let i = 0; i < segs; i++) {
            const t0 = i / segs;
            const t1 = (i + 1) / segs;
            const y0 = yaws[0] + (yaws[yaws.length - 1] - yaws[0]) * t0;
            const y1 = yaws[0] + (yaws[yaws.length - 1] - yaws[0]) * t1;
            const a = sph(r, y0, pitch);
            const b = sph(r, y1, pitch);
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
        color: 0x9aa8b4,
        transparent: true,
        opacity: 0.32,
        depthWrite: false
    });
    group.add(new THREE.LineSegments(geo, mat));
    return group;
}

function sectorCellCenters() {
    const { yawMin, yawMax, pitchMin, pitchMax } = gridAxes();
    const out = [];
    let n = 1;
    for (let row = 0; row < SECTOR_ROWS; row++) {
        for (let col = 0; col < SECTOR_COLS; col++) {
            const yaw = yawMin + (yawMax - yawMin) * ((col + 0.5) / SECTOR_COLS);
            const pitch = pitchMax - (pitchMax - pitchMin) * ((row + 0.5) / SECTOR_ROWS);
            const prefix = t('geoSurvey.sector') || 'Сектор';
            out.push({ yaw, pitch, label: `${prefix} ${n}`, key: `s${n}` });
            n++;
        }
    }
    return out;
}

export function ensureSurveyVisuals(body) {
    ensureOverlays();
    overlaysRoot.style.display = 'block';
    if (matrixEl) matrixEl.style.display = 'block';
    ensureBodyDeposits(body);
    attachSectorGrid(body);
    rebuildFog(body);
}

function attachSectorGrid(body) {
    const mesh = body?.mesh;
    if (!mesh) return;
    if (sectorGridGroup && attachedBodyMesh === mesh) return;
    detachSectorGrid();
    sectorGridGroup = buildSectorGridMesh();
    // масштаб = реальный радиус геометрии (как у цветных пятен)
    const s = meshSurfaceRadius(body);
    sectorGridGroup.scale.set(s, s, s);
    mesh.add(sectorGridGroup);
    attachedBodyMesh = mesh;
}

function detachSectorGrid() {
    if (sectorGridGroup) {
        try { sectorGridGroup.parent?.remove(sectorGridGroup); } catch (_) {}
        sectorGridGroup = null;
    }
    attachedBodyMesh = null;
}

export function depositDiscMaterial(color) {
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uColor: { value: new THREE.Color(color) },
            uTime: { value: 0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            uniform float uTime;
            varying vec2 vUv;
            void main() {
                vec2 p = vUv - 0.5;
                float r = length(p) * 2.0;
                if (r > 1.0) discard;
                // «нарезка ножом»: прорези сетки сквозь заливку
                float cells = 9.0;
                float gx = abs(fract(p.x * cells) - 0.5);
                float gy = abs(fract(p.y * cells) - 0.5);
                float cutW = 0.07;
                float cut = step(cutW, min(gx, gy)); // 0 = прорезь
                // заливка диска с градиентом к краю
                float fill = smoothstep(1.0, 0.18, r) * 0.52 * cut;
                // тонкие яркие линии реза
                float line = (1.0 - smoothstep(0.0, 0.028, min(gx, gy))) * smoothstep(1.0, 0.22, r);
                float alpha = max(fill, line * 0.75);
                alpha *= 0.88 + 0.12 * sin(uTime * 1.2 + r * 5.0);
                gl_FragColor = vec4(uColor, alpha);
            }
        `
    });
}

/**
 * Стабильная ориентация на поверхности: +Z = нормаль,
 * «вверх» берётся из проекции мирового up в касательную плоскость —
 * без кручения «как барабан» при движении камеры.
 */
function orientOnSurface(obj, localPos, mesh) {
    obj.position.copy(localPos);
    const n = localPos.clone().normalize();
    // world-up → локаль mesh
    const upWorld = new THREE.Vector3(0, 1, 0);
    let upLocal = upWorld.clone();
    if (mesh?.quaternion) {
        upLocal.applyQuaternion(mesh.quaternion.clone().invert());
    }
    let tangent = new THREE.Vector3().crossVectors(upLocal, n);
    if (tangent.lengthSq() < 1e-8) {
        tangent.crossVectors(new THREE.Vector3(1, 0, 0), n);
    }
    tangent.normalize();
    const bitangent = new THREE.Vector3().crossVectors(n, tangent).normalize();
    // базис: X=tangent, Y=bitangent, Z=normal (Circle/Line в XY)
    const m = new THREE.Matrix4().makeBasis(tangent, bitangent, n);
    obj.quaternion.setFromRotationMatrix(m);
}

export function rebuildFog(body) {
    const mesh = body?.mesh;
    if (!mesh) return;
    if (fogGroup) {
        try { fogGroup.parent?.remove(fogGroup); } catch (_) {}
        fogGroup = null;
    }
    const entry = ensureBodyDeposits(body);
    if (!entry) return;
    if (!isBodySurveyComplete(body) && !entry.completed) return;

    const GRID_R = 1.012;
    fogGroup = new THREE.Group();
    fogGroup.name = 'geoSurveyDeposits';
    const R = meshSurfaceRadius(body);
    fogGroup.scale.set(R, R, R);
    mesh.add(fogGroup);

    entry.deposits.forEach((dep) => {
        if (!dep.scanned && !entry.completed && !isBodySurveyComplete(body)) return;
        // show all deposits when survey complete
        const local = sph(GRID_R, dep.yaw, dep.pitch);
        const col = DEPOSIT_COLORS[dep.colorIndex % DEPOSIT_COLORS.length];
        const blobR = 0.045 + (dep.outer || 0.1) * 0.12;

        // 2–3 слоя плоских дисков
        for (let layer = 0; layer < 3; layer++) {
            const scale = 1 + layer * 0.35;
            const geo = new THREE.CircleGeometry(blobR * scale, 48);
            const mat = depositDiscMaterial(col);
            mat.uniforms.uColor.value.multiplyScalar(1 - layer * 0.12);
            mat.opacity = 1; // shader controls alpha
            const disc = new THREE.Mesh(geo, mat);
            disc.userData.isDepositDisc = true;
            const pos = local.clone().multiplyScalar(1 + layer * 0.0015);
            orientOnSurface(disc, pos, mesh);
            fogGroup.add(disc);
        }
    });
}


/** Вогнутая мишень на поверхности (на уровне сетки секторов) */
function makeCurvedDisc(radius, segments, bend) {
    const geo = new THREE.CircleGeometry(radius, segments);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const rr = Math.sqrt(x * x + y * y) / Math.max(1e-6, radius);
        // лёгкая вогнутость «в тело»
        pos.setZ(i, -bend * rr * rr);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
}

function ensureSurfaceReticle(body) {
    const mesh = body?.mesh;
    if (!mesh) return null;
    if (surfaceReticle && surfaceReticle.parent === mesh) return surfaceReticle;
    disposeSurfaceReticle();

    const group = new THREE.Group();
    group.name = 'geoSurveyReticle';
    const col = new THREE.Color('#00ffc8');
    const matLine = new THREE.LineBasicMaterial({
        color: col, transparent: true, opacity: 0.75, depthWrite: false
    });
    const matRing = new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: 0.35, depthWrite: false,
        side: THREE.DoubleSide, wireframe: false
    });

    // вогнутая «тарелка»-основа
    const baseGeo = makeCurvedDisc(0.085, 48, 0.018);
    const baseMat = new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: 0.08, depthWrite: false,
        side: THREE.DoubleSide
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    group.add(base);

    // кольца (плоские на вогнутой базе — чуть разного радиуса)
    [0.028, 0.052, 0.078].forEach((rad, idx) => {
        const pts = [];
        const n = 64;
        for (let i = 0; i <= n; i++) {
            const a = (i / n) * Math.PI * 2;
            const x = Math.cos(a) * rad;
            const y = Math.sin(a) * rad;
            const rr = rad / 0.085;
            const z = -0.018 * rr * rr + 0.0005 * idx;
            pts.push(new THREE.Vector3(x, y, z));
        }
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(g, matLine.clone());
        line.material.opacity = 0.55 - idx * 0.1;
        group.add(line);
    });

    // крест
    const crossPts = [
        new THREE.Vector3(-0.07, 0, -0.012), new THREE.Vector3(0.07, 0, -0.012),
        new THREE.Vector3(0, -0.07, -0.012), new THREE.Vector3(0, 0.07, -0.012)
    ];
    // два сегмента
    const cx = new THREE.BufferGeometry().setFromPoints([crossPts[0], crossPts[1]]);
    const cy = new THREE.BufferGeometry().setFromPoints([crossPts[2], crossPts[3]]);
    group.add(new THREE.Line(cx, matLine.clone()));
    group.add(new THREE.Line(cy, matLine.clone()));

    // 4 уголка на ОКРУЖНОСТИ мишени (как таргет на круге, не скруглённый квадрат)
    // каждый = дуга по ободу ±span + две короткие радиальные засечки
    const cornerOnCircle = (baseAng) => {
        const R = 0.072;          // радиус круга мишени
        const span = 0.28;        // полуширина дуги в радианах (~16°)
        const tick = 0.012;       // длина радиальной засечки
        const steps = 12;
        const pts = [];
        // внешняя засечка у начала дуги
        const a0 = baseAng - span;
        const a1 = baseAng + span;
        pts.push(new THREE.Vector3(
            Math.cos(a0) * (R + tick),
            Math.sin(a0) * (R + tick),
            -0.01
        ));
        // дуга по окружности
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const a = a0 + (a1 - a0) * t;
            pts.push(new THREE.Vector3(
                Math.cos(a) * R,
                Math.sin(a) * R,
                -0.01
            ));
        }
        // внешняя засечка у конца дуги
        pts.push(new THREE.Vector3(
            Math.cos(a1) * (R + tick),
            Math.sin(a1) * (R + tick),
            -0.01
        ));
        return new THREE.BufferGeometry().setFromPoints(pts);
    };
    // 4 позиции по кругу: 45°, 135°, 225°, 315°
    [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4].forEach((ang) => {
        const m = matLine.clone();
        m.opacity = 0.8;
        group.add(new THREE.Line(cornerOnCircle(ang), m));
    });

    // радарная «палка»
    const armPts = [new THREE.Vector3(0, 0, -0.008), new THREE.Vector3(0.072, 0, -0.014)];
    const arm = new THREE.Line(new THREE.BufferGeometry().setFromPoints(armPts), matLine.clone());
    arm.material.opacity = 0.85;
    arm.userData.isRadarArm = true;
    group.add(arm);

    mesh.add(group);
    surfaceReticle = group;
    return surfaceReticle;
}

function disposeSurfaceReticle() {
    if (!surfaceReticle) return;
    try { surfaceReticle.parent?.remove(surfaceReticle); } catch (_) {}
    surfaceReticle.traverse((o) => {
        try { o.geometry?.dispose(); o.material?.dispose(); } catch (_) {}
    });
    surfaceReticle = null;
}


function ensureScanRipple(body) {
    const mesh = body?.mesh;
    if (!mesh) return null;
    if (scanRippleMesh && scanRippleMesh.parent === mesh) return scanRippleMesh;
    disposeScanRipple();
    const geo = new THREE.CircleGeometry(0.09, 64);
    const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uTime: { value: 0 },
            uActive: { value: 0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                // лёгкая «рябь» вершин при скане
                vec3 p = position;
                float r = length(uv - 0.5) * 2.0;
                float act = 0.0; // set in CPU via uniform not available in vertex easily
                gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uTime;
            uniform float uActive;
            varying vec2 vUv;
            void main() {
                vec2 p = vUv - 0.5;
                float r = length(p) * 2.0;
                if (r > 1.0) discard;
                float wave = sin((r * 14.0 - uTime * 6.0)) * 0.5 + 0.5;
                float ring = smoothstep(0.0, 0.08, wave) * smoothstep(1.0, 0.2, r);
                float haze = (1.0 - smoothstep(0.0, 0.7, r)) * 0.25;
                // бирюзовые расходящиеся кольца
                float rings = 0.0;
                for (int i = 0; i < 3; i++) {
                    float phase = uTime * (2.2 + float(i) * 0.35) - float(i) * 0.45;
                    float rr = fract(phase * 0.15 + r * 0.55);
                    rings += smoothstep(0.12, 0.0, abs(rr - 0.08)) * (1.0 - r);
                }
                float alpha = (haze + ring * 0.35 + rings * 0.55) * uActive;
                vec3 col = mix(vec3(0.1, 0.9, 0.85), vec3(0.4, 1.0, 0.95), ring);
                gl_FragColor = vec4(col, alpha);
            }
        `
    });
    scanRippleMesh = new THREE.Mesh(geo, mat);
    scanRippleMesh.renderOrder = 10;
    mesh.add(scanRippleMesh);
    return scanRippleMesh;
}

function disposeScanRipple() {
    if (!scanRippleMesh) return;
    try { scanRippleMesh.parent?.remove(scanRippleMesh); } catch (_) {}
    try {
        scanRippleMesh.geometry?.dispose();
        scanRippleMesh.material?.dispose();
    } catch (_) {}
    scanRippleMesh = null;
}

function ensureProbeWave(body) {
    const mesh = body?.mesh;
    if (!mesh) return null;
    if (probeWaveMesh && probeWaveMesh.parent === mesh) return probeWaveMesh;
    disposeProbeWave();
    const geo = new THREE.SphereGeometry(1.02, 64, 48);
    const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uProgress: { value: 0 },
            uActive: { value: 0 }
        },
        vertexShader: `
            varying vec3 vN;
            void main() {
                vN = normalize(position);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uProgress;
            uniform float uActive;
            varying vec3 vN;
            void main() {
                // фронт волны: latitude-like band expanding from impact
                // progress 0..1 → front from 1 (start dir) to -1
                float front = 1.0 - uProgress * 2.0;
                float band = 1.0 - smoothstep(0.0, 0.12, abs(vN.y - front));
                // вторичные хвосты
                float tail = exp(-abs(vN.y - front) * 8.0) * 0.35;
                float fade = smoothstep(0.0, 0.15, uProgress) * (1.0 - smoothstep(0.75, 1.0, uProgress));
                float alpha = (band * 0.55 + tail) * fade * uActive;
                vec3 col = vec3(0.15, 0.95, 0.9);
                gl_FragColor = vec4(col, alpha);
            }
        `
    });
    probeWaveMesh = new THREE.Mesh(geo, mat);
    probeWaveMesh.scale.setScalar(meshSurfaceRadius(body));
    probeWaveMesh.renderOrder = 9;
    mesh.add(probeWaveMesh);
    return probeWaveMesh;
}

function disposeProbeWave() {
    if (!probeWaveMesh) return;
    try { probeWaveMesh.parent?.remove(probeWaveMesh); } catch (_) {}
    try {
        probeWaveMesh.geometry?.dispose();
        probeWaveMesh.material?.dispose();
    } catch (_) {}
    probeWaveMesh = null;
    probeWaveActive = false;
}

/** Запуск бирюзовой волны зонда (вызывать при старте зонда) */
export function startProbeWave(body, durationMs = 5200) {
    if (!body?.mesh) return;
    ensureProbeWave(body);
    probeWaveActive = true;
    probeWaveStart = performance.now();
    probeWaveDuration = Math.max(800, durationMs);
    if (probeWaveMesh?.material?.uniforms) {
        probeWaveMesh.material.uniforms.uActive.value = 1;
        probeWaveMesh.material.uniforms.uProgress.value = 0;
    }
}

export function updateProbeWave() {
    if (!probeWaveMesh || !probeWaveActive) return;
    const t = (performance.now() - probeWaveStart) / probeWaveDuration;
    const u = Math.min(1, Math.max(0, t));
    probeWaveMesh.material.uniforms.uProgress.value = u;
    probeWaveMesh.material.uniforms.uActive.value = 1;
    if (u >= 1) {
        probeWaveMesh.material.uniforms.uActive.value = 0;
        probeWaveActive = false;
        disposeProbeWave();
    }
}

export function updateSurveyVisuals(body, angles, signal, scanning) {
    ensureOverlays();
    if (!body?.mesh) return;
    attachSectorGrid(body);
    const entry = ensureBodyDeposits(body);
    const complete = isBodySurveyComplete(body);

    if (matrixEl) {
        matrixEl.classList.toggle('scanning', !!scanning);
        matrixEl.style.setProperty('--gs-signal', String(signal?.strength || 0));
    }

    // Подписи секторов — центры клеток сетки на теле
    const sectorsRoot = overlaysRoot.querySelector('#gs-sectors');
    if (sectorsRoot) {
        const usedS = new Set();
        const c = body.mesh.position;
        const r = meshSurfaceRadius(body) * 1.012;
        for (const sec of sectorCellCenters()) {
            const local = sph(r, sec.yaw, sec.pitch);
            local.applyQuaternion(body.mesh.quaternion);
            const world = local.clone().add(c);
            const toCam = camera.position.clone().sub(world).normalize();
            const outward = world.clone().sub(c).normalize();
            if (toCam.dot(outward) < 0.08) continue;
            const scr = projectToScreen(world);
            if (!scr || scr.z > 0.98) continue;

            let el = sectorEls.get(sec.key);
            if (!el) {
                el = document.createElement('div');
                el.className = 'gs-sector';
                el.innerHTML = `<span class="gs-sector-label"></span>`;
                sectorsRoot.appendChild(el);
                sectorEls.set(sec.key, el);
            }
            const lab = el.querySelector('.gs-sector-label');
            if (lab) lab.textContent = sec.label;
            usedS.add(sec.key);
            el.style.display = 'block';
            el.style.left = `${scr.x}px`;
            el.style.top = `${scr.y}px`;
        }
        for (const [id, el] of sectorEls) {
            if (!usedS.has(id)) {
                el.remove();
                sectorEls.delete(id);
            }
        }
    }

    // Крутящиеся мишени над залежами больше не показываем
    const targetsRoot = overlaysRoot.querySelector('#gs-targets');
    if (targetsRoot) {
        for (const [, el] of targetEls) el.remove();
        targetEls.clear();
        targetsRoot.innerHTML = '';
    }

    // Анимация дисков залежей
    if (fogGroup) {
        const tNow = performance.now() * 0.001;
        fogGroup.traverse((o) => {
            if (o.userData?.isDepositDisc && o.material?.uniforms?.uTime) {
                o.material.uniforms.uTime.value = tNow;
            }
        });
    }

    // Рябь скана под прицелом (точка взгляда на поверхности)
    try {
        const ripple = ensureScanRipple(body);
        if (ripple) {
            const R = meshSurfaceRadius(body);
            const local = sph(1.014, angles.yaw, angles.pitch).multiplyScalar(R);
            orientOnSurface(ripple, local, body.mesh);
            const targetAct = scanning ? 1 : 0;
            const u = ripple.material.uniforms;
            const cur = Number(u.uActive.value) || 0;
            u.uActive.value = cur + (targetAct - cur) * Math.min(1, 0.12);
            u.uTime.value = performance.now() * 0.001;
            const shake = 1 + (u.uActive.value > 0.05 ? Math.sin(performance.now() * 0.02) * 0.04 * u.uActive.value : 0);
            // CircleGeometry(0.09) × R ≈ доля радиуса планеты
            ripple.scale.setScalar(R * shake);
        }
    } catch (_) {}

    // 3D мишень на поверхности (точка взгляда) — без кручения барабана
    let reticleScreen = null;
    try {
        const ret = ensureSurfaceReticle(body);
        if (ret) {
            const R = meshSurfaceRadius(body);
            const local = sph(1.012, angles.yaw, angles.pitch).multiplyScalar(R);
            orientOnSurface(ret, local, body.mesh);
            const tNow = performance.now() * 0.001;
            ret.traverse((o) => {
                // только радарная палка крутится в плоскости мишени
                if (o.userData?.isRadarArm) {
                    o.rotation.z = tNow * 2.2;
                    if (o.material && scanning) o.material.opacity = 0.95;
                }
            });
            // экранная проекция центра и края → якорь для эха
            const worldC = local.clone().applyQuaternion(body.mesh.quaternion).add(body.mesh.position);
            const scrC = projectToScreen(worldC);
            // точка на ободе (локальный +X мишени ≈ 0.078 * R в world через базис)
            const edgeLocal = new THREE.Vector3(0.078 * R, 0, 0);
            // edge in reticle local → world: reticle matrix
            ret.updateMatrixWorld(true);
            const edgeWorld = edgeLocal.clone().applyMatrix4(ret.matrixWorld);
            const scrE = projectToScreen(edgeWorld);
            if (scrC && scrE) {
                const radPx = Math.max(28, Math.hypot(scrE.x - scrC.x, scrE.y - scrC.y));
                reticleScreen = { x: scrC.x, y: scrC.y, r: radPx };
            } else if (scrC) {
                reticleScreen = { x: scrC.x, y: scrC.y, r: 70 };
            }
        }
    } catch (_) {}


    // Эхо: якорь = экранный круг мишени, волны с обода к центру
    if (matrixEl) {
        const dirEl = matrixEl.querySelector('#gs-dir') || document.getElementById('gs-dir');
        if (reticleScreen) {
            const d = reticleScreen.r * 2;
            matrixEl.style.left = `${reticleScreen.x}px`;
            matrixEl.style.top = `${reticleScreen.y}px`;
            matrixEl.style.width = `${d}px`;
            matrixEl.style.height = `${d}px`;
        }
        if (dirEl) {
            const showDir = scanning && signal && (signal.zone === 'far' || signal.zone === 'outer' || signal.zone === 'inner') && signal.deposit;
            dirEl.classList.toggle('visible', !!showDir);
            dirEl.classList.toggle('inner', signal?.zone === 'inner');
            if (showDir && signal.deposit) {
                const world = depositWorldPos(body, signal.deposit);
                const scr = projectToScreen(world);
                const cx = reticleScreen ? reticleScreen.x : window.innerWidth * 0.5;
                const cy = reticleScreen ? reticleScreen.y : window.innerHeight * 0.5;
                if (scr) {
                    const dx = scr.x - cx;
                    const dy = scr.y - cy;
                    const deg = Math.atan2(dx, -dy) * (180 / Math.PI) - 90;
                    dirEl.style.setProperty('--gs-dir', `${deg}deg`);
                }
            }
        }
    }

    // Волна зонда
    try { updateProbeWave(); } catch (_) {}

    if (complete && fogGroup && fogGroup.children.length === 0) {
        rebuildFog(body);
    }
}

export function pulseProbeToDeposit(body, deposit) {
    ensureOverlays();
    if (!probeEl || !deposit) return;
    const world = depositWorldPos(body, deposit);
    const scr = projectToScreen(world);
    const tx = scr ? scr.x : window.innerWidth * 0.5;
    const ty = scr ? scr.y : window.innerHeight * 0.5;
    probeEl.style.display = 'block';
    probeEl.style.left = `${window.innerWidth * 0.5}px`;
    probeEl.style.top = `-20px`;
    probeEl.style.opacity = '1';
    probeEl.style.transition = 'none';
    requestAnimationFrame(() => {
        probeEl.style.transition = 'left 1.1s cubic-bezier(.2,.8,.2,1), top 1.1s cubic-bezier(.4,0,.2,1), opacity 0.3s ease 0.9s';
        probeEl.style.left = `${tx}px`;
        probeEl.style.top = `${ty}px`;
        setTimeout(() => {
            probeEl.style.opacity = '0';
            setTimeout(() => { probeEl.style.display = 'none'; }, 320);
        }, 1100);
    });
}

export function clearSurveyVisuals() {
    if (overlaysRoot) overlaysRoot.style.display = 'none';
    for (const [, el] of targetEls) el.remove();
    targetEls.clear();
    for (const [, el] of sectorEls) el.remove();
    sectorEls.clear();
    if (probeEl) probeEl.style.display = 'none';
    if (fogGroup) {
        try { fogGroup.parent?.remove(fogGroup); } catch (_) {}
        fogGroup = null;
    }
    disposeScanRipple();
    disposeProbeWave();
    disposeSurfaceReticle();
    detachSectorGrid();
}
