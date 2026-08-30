/**
 * opticalScan.js — космический туман войны + области А1/А2 обсерваторий.
 */
import { state } from './state.js';
import { getLocationBuildingData } from './buildingHelpers.js';
import { getRecipesForBuilding, getRecipeEffectiveness } from './recipes.js';
import { t } from './settings.js';

export const OPTICAL_RECIPE_ID = 'RCP_OPTICAL_SCANNING';
export const OPTICAL_EFFECT_ID = 'EFF_OPTICAL_SCAN';

const AU_KM = 149597870.7;
const EARTH_WORLD_DIST = 30;
const KM_PER_WORLD_SYSTEM = AU_KM / EARTH_WORLD_DIST;
const LY_KM = 9.46073e12;
const MW_RADIUS_LY = 52850;
const MW_SIZE_WORLD = 60000;

const MAX_SOURCES = 24;

const _scan = {
    overlayOn: false,
    fogEnabled: true,
    multiverseUnlocked: false,
    sources: [],
    smooth: {},
    group: null,
    fogMesh: null,
    discs: [],
    labels: [],
    inited: false
};

export function isOpticalFogEnabled() {
    return _scan.fogEnabled !== false;
}

export function isOpticalOverlayOn() {
    return !!_scan.overlayOn;
}

export function isMultiverseCameraUnlocked() {
    return !!_scan.multiverseUnlocked;
}

/** Консоль: вкл/выкл оптическую видимость (не пишется в сейв). */
export function setOpticalFogEnabled(on) {
    _scan.fogEnabled = !!on;
    // Выкл. оптики = отладка «виден весь космос» + разблок вылета из вселенной
    _scan.multiverseUnlocked = !_scan.fogEnabled;
    if (!_scan.fogEnabled) setOpticalOverlay(false);
    return _scan.fogEnabled;
}

export function toggleOpticalFogEnabled() {
    return setOpticalFogEnabled(!_scan.fogEnabled);
}

export function setOpticalOverlay(on) {
    _scan.overlayOn = !!on;
    syncOverlayButton();
}

export function toggleOpticalOverlay() {
    setOpticalOverlay(!_scan.overlayOn);
    return _scan.overlayOn;
}

function kmPerWorldNebula(neb) {
    const data = neb?.data || neb;
    const sizeW = Math.max(1, Number(data?.size) || 1200);
    const radiusLy = Math.max(0.001, Number(data?.radius) || 15);
    return (radiusLy * LY_KM) / sizeW;
}

function kmPerWorldGalaxy(gal) {
    const data = gal?.data || gal;
    const sizeW = Math.max(1, Number(data?.size) || MW_SIZE_WORLD);
    const radiusLy = Math.max(1, Number(data?.radius) || MW_RADIUS_LY);
    return (radiusLy * LY_KM) / sizeW;
}

function walkBody(id) {
    return bodyMesh(id);
}

/** Туманность, в которой лежит тело (parent-цепочка / starSystem). */
function getHomeNebula(entry) {
    let cur = entry;
    const seen = new Set();
    for (let i = 0; i < 8 && cur?.data; i++) {
        const id = cur.data.id;
        if (id != null) {
            if (seen.has(String(id))) break;
            seen.add(String(id));
        }
        if (cur.data.type === 'interstellarNebula') return cur;
        if (cur.data.type === 'starSystem' && cur.data.parent != null) {
            cur = walkBody(cur.data.parent);
            continue;
        }
        if (cur.data.starSystemId != null) {
            const sys = walkBody(cur.data.starSystemId);
            if (sys?.data?.parent != null) {
                cur = walkBody(sys.data.parent);
                continue;
            }
        }
        if (cur.data.parent != null) {
            cur = walkBody(cur.data.parent);
            continue;
        }
        break;
    }
    const bodies = state.celestialBodies || {};
    for (const e of Object.values(bodies)) {
        if (e?.data?.type === 'interstellarNebula') return e;
    }
    return null;
}

function getHomeGalaxy(entry) {
    let cur = entry;
    for (let i = 0; i < 8 && cur?.data; i++) {
        if (cur.data.type === 'galaxy') return cur;
        if (cur.data.galaxyId != null) {
            const g = walkBody(cur.data.galaxyId);
            if (g) return g;
        }
        if (cur.data.parent != null) {
            cur = walkBody(cur.data.parent);
            continue;
        }
        break;
    }
    return walkBody(3000);
}

function kmToWorld(km, levelId, homeNebula, homeGalaxy) {
    const k = Number(km) || 0;
    if (k <= 0) return 0;
    if (levelId === '5ZC' || levelId === '6ZC' || levelId === '7ZC') {
        return k / kmPerWorldGalaxy(homeGalaxy);
    }
    if (levelId === '4ZC') {
        return k / kmPerWorldNebula(homeNebula);
    }
    return k / KM_PER_WORLD_SYSTEM;
}

function worldToKm(world, levelId, homeNebula, homeGalaxy) {
    const w = Number(world) || 0;
    if (w <= 0) return 0;
    if (levelId === '5ZC' || levelId === '6ZC' || levelId === '7ZC') {
        return w * kmPerWorldGalaxy(homeGalaxy);
    }
    if (levelId === '4ZC') {
        return w * kmPerWorldNebula(homeNebula);
    }
    return w * KM_PER_WORLD_SYSTEM;
}

function starSystemIdOf(entry) {
    let cur = entry;
    const seen = new Set();
    for (let i = 0; i < 8 && cur?.data; i++) {
        const d = cur.data;
        const id = d.id;
        if (id != null) {
            if (seen.has(String(id))) break;
            seen.add(String(id));
        }
        if (d.type === 'starSystem') return Number(d.id);
        if (d.starSystemId != null) return Number(d.starSystemId);
        if (d.type === 'star') {
            for (const e of Object.values(state.celestialBodies || {})) {
                if (e?.data?.type === 'starSystem' && Array.isArray(e.data.children)
                    && e.data.children.some(c => Number(c) === Number(d.id))) {
                    return Number(e.data.id);
                }
            }
        }
        if (d.parent != null) {
            cur = bodyMesh(d.parent);
            continue;
        }
        break;
    }
    return null;
}

function homeStarEntry(locId) {
    const home = bodyMesh(locId);
    const sysId = starSystemIdOf(home);
    if (sysId != null) {
        const sys = bodyMesh(sysId);
        const ch = sys?.data?.children || [];
        for (const c of ch) {
            const e = bodyMesh(c);
            if (e?.data?.type === 'star') return e;
        }
    }
    let cur = home;
    for (let i = 0; i < 6 && cur?.data; i++) {
        if (cur.data.type === 'star') return cur;
        if (cur.data.parent == null) break;
        cur = bodyMesh(cur.data.parent);
    }
    return home;
}

/** Расстояние до ближайшей чужой звезды/системы (мировые единицы текущей сцены). */
function nearestForeignStarDist(srcMesh, homeSysId) {
    if (!srcMesh) return Infinity;
    let best = Infinity;
    const bodies = state.celestialBodies || {};
    for (const e of Object.values(bodies)) {
        const t = e?.data?.type;
        if (t !== 'star' && t !== 'starSystem') continue;
        if (!e.mesh || e.mesh === srcMesh) continue;
        const sid = starSystemIdOf(e);
        if (homeSysId != null && sid != null && Number(sid) === Number(homeSysId)) continue;
        const d = Math.hypot(e.mesh.position.x - srcMesh.position.x, e.mesh.position.z - srcMesh.position.z);
        if (d > 1 && d < best) best = d;
    }
    return best;
}

function bodyMesh(id) {
    const bodies = state.celestialBodies || {};
    return (bodies[id] || bodies[String(id)] || bodies[Number(id)] || null);
}

function collectObservatories() {
    const out = [];
    const locMap = state.locationBuildings || {};
    for (const locKey of Object.keys(locMap)) {
        const locId = Number(locKey);
        const bag = locMap[locKey] || {};
        for (const bid of Object.keys(bag)) {
            const data = bag[bid];
            if (!data || !(data.built_count > 0)) continue;
            const tpl = (state.buildings || []).find(b => b.id === bid);
            if (!tpl?.IsObservatory && bid !== 'CONSTRC011') continue;
            const recipes = getRecipesForBuilding(bid) || [];
            const rec = recipes.find(r => r.id === OPTICAL_RECIPE_ID)
                || recipes.find(r => (r.outputs || []).some(o => o.effectId === OPTICAL_EFFECT_ID));
            if (!rec) continue;
            const eff = getRecipeEffectiveness(locId, bid, rec);
            if (!(eff > 0.001)) continue;
            const outp = (rec.outputs || []).find(o => o.effectId === OPTICAL_EFFECT_ID) || rec.outputs?.[0];
            const level = Number(data.currentLevel) || 0;
            const a1mArr = tpl.OpticalScanA1Mult || [];
            const a2mArr = tpl.OpticalScanA2Mult || [];
            const a1m = Number(a1mArr[Math.min(level, Math.max(0, a1mArr.length - 1))] ?? (1 + level * 0.18)) || 1;
            const a2m = Number(a2mArr[Math.min(level, Math.max(0, a2mArr.length - 1))] ?? (1 + level * 0.16)) || 1;
            const count = Number(data.built_count) || 0;
            const baseA1 = Number(outp?.a1RadiusKm) || 7479893535;
            const baseA2 = Number(outp?.a2RadiusKm) || 1.25008e17;
            const entry = bodyMesh(locId);
            if (!entry?.mesh) continue;
            out.push({
                locId,
                buildingId: bid,
                mesh: entry.mesh,
                targetA1km: baseA1 * a1m * count * eff,
                targetA2km: baseA2 * a2m * count * eff
            });
        }
    }
    return out;
}

function smoothKm(key, target, dt) {
    const prev = _scan.smooth[key];
    if (prev == null || !Number.isFinite(prev)) {
        _scan.smooth[key] = target;
        return target;
    }
    const k = 1 - Math.exp(-Math.max(0.15, dt || 0.016) * 1.8);
    const next = prev + (target - prev) * k;
    _scan.smooth[key] = next;
    return next;
}

export function getOpticalSources(levelId = '3ZC', dt = 0.016) {
    const raw = collectObservatories();
    const sources = [];
    const cur = (typeof window !== 'undefined') ? window.__currentLocation : null;
    const curSys = starSystemIdOf(cur);
    for (const o of raw) {
        const a1km = smoothKm(o.locId + ':a1', o.targetA1km, dt);
        const a2km = smoothKm(o.locId + ':a2', o.targetA2km, dt);
        const home = bodyMesh(o.locId);
        const neb = getHomeNebula(home);
        const gal = getHomeGalaxy(home);
        const homeSys = starSystemIdOf(home);
        const star = homeStarEntry(o.locId);
        const sys = homeSys != null ? bodyMesh(homeSys) : null;
        const a1sys = a1km / KM_PER_WORLD_SYSTEM;
        const a2sys = a2km / KM_PER_WORLD_SYSTEM;
        const a1neb = neb ? a1km / kmPerWorldNebula(neb) : kmToWorld(a1km, '4ZC');
        const a2neb = neb ? a2km / kmPerWorldNebula(neb) : kmToWorld(a2km, '4ZC');
        const a1gal = a1km / kmPerWorldGalaxy(gal);
        const a2gal = a2km / kmPerWorldGalaxy(gal);

        let x = o.mesh.position.x, z = o.mesh.position.z;
        let a1w, a2w;
        if (levelId === '5ZC' || levelId === '6ZC' || levelId === '7ZC') {
            const anchor = neb?.mesh || sys?.mesh || star?.mesh || o.mesh;
            x = anchor.position.x; z = anchor.position.z;
            a1w = a1gal;
            a2w = a2gal;
        } else if (levelId === '4ZC') {
            const anchor = star?.mesh || sys?.mesh || neb?.mesh || o.mesh;
            x = anchor.position.x; z = anchor.position.z;
            const starSize = Math.max(Number(star?.data?.size) || 0, 1.2);
            // истинный радиус в мире туманности; крошечный А1 — только нимб у звезды
            a1w = a1neb > starSize * 0.6 ? a1neb : Math.max(a1neb, starSize * 1.7);
            a2w = Math.max(a2neb, a1w * 1.15);
        } else {
            // 1–3ZC
            const sameSys = curSys != null && homeSys != null && Number(curSys) === Number(homeSys);
            if (sameSys || curSys == null) {
                x = o.mesh.position.x; z = o.mesh.position.z;
                a1w = a1sys;
                a2w = a2sys;
            } else {
                // мы в другой системе: покрыта ли она А1/А2 в км по шкале туманности
                const curStar = homeStarEntry(cur?.data?.id);
                const dW = (star?.mesh && curStar?.mesh)
                    ? Math.hypot(star.mesh.position.x - curStar.mesh.position.x, star.mesh.position.z - curStar.mesh.position.z)
                    : Infinity;
                const dKm = (neb && Number.isFinite(dW)) ? dW * kmPerWorldNebula(neb) : Infinity;
                const curAnchor = curStar?.mesh || cur?.mesh || o.mesh;
                x = curAnchor.position.x; z = curAnchor.position.z;
                if (dKm <= a1km) {
                    a1w = Math.max(a1sys, 400);
                    a2w = Math.max(a2sys, a1w * 1.2);
                } else if (dKm <= a2km) {
                    a1w = 0;
                    a2w = Math.max(a2sys, 400);
                } else {
                    a1w = 0; a2w = 0;
                }
            }
        }

        sources.push({
            locId: o.locId,
            homeSys,
            x, z,
            a1km, a2km,
            a1w, a2w,
            a1sys, a2sys,
            a1neb, a2neb,
            a1gal, a2gal,
            levelId
        });
    }
    _scan.sources = sources;
    _scan.levelId = levelId;
    return sources;
}

function coverageAt(x, z, sources, targetEntry) {
    let a1 = false, a2 = false;
    const tpe = targetEntry?.data?.type;
    const tSys = starSystemIdOf(targetEntry);
    const lvl = sources[0]?.levelId || _scan.levelId || '3ZC';
    for (const s of sources) {
        const sameSys = tSys != null && s.homeSys != null && Number(tSys) === Number(s.homeSys);
        let r1 = s.a1w, r2 = s.a2w;
        if (tpe === 'interstellarNebula' || tpe === 'galaxy') {
            // на карте галактики якорь источника — туманность, радиусы в галактических единицах
            r1 = s.a1gal;
            r2 = s.a2gal;
        } else if (tpe === 'star' || tpe === 'starSystem') {
            r1 = sameSys ? s.a1sys : s.a1neb;
            r2 = sameSys ? Math.max(s.a2sys, s.a2neb) : s.a2neb;
        } else if (tpe === 'planet' || tpe === 'moon') {
            r1 = sameSys ? s.a1sys : s.a1neb;
            r2 = sameSys ? Math.max(s.a2sys, s.a2neb) : s.a2neb;
        }
        // на 5ZC+ сравниваем якоря в галактических координатах
        let tx = x, tz = z;
        if (tpe === 'interstellarNebula' || tpe === 'galaxy') {
            tx = x; tz = z;
        }
        const d = Math.hypot(tx - s.x, tz - s.z);
        if (r1 > 0 && d <= r1) { a1 = true; a2 = true; }
        else if (r2 > 0 && d <= r2) a2 = true;
    }
    return { a1, a2 };
}

export function getOpticalBodyState(body, levelId) {
    if (!_scan.fogEnabled) return 'full';
    let entry = body;
    const data = body?.data || body;
    if (!data) return 'full';
    if (!body?.mesh && data.id != null) entry = bodyMesh(data.id) || body;
    const tpe = data.type;
    if (tpe === 'universe' || tpe === 'multiverse') return 'full';
    // Колонизированные / освоенные тела всегда видны (база игрока)
    if (data.colonized || data.developed) return 'full';
    // Своя звезда и своя система — видны без обсерватории.
    // Луны/чужие планеты без А1/А2 — отсутствуют, не «неизвестны».
    if (tpe === 'star' || tpe === 'starSystem') {
        const sysId = tpe === 'starSystem' ? Number(data.id) : starSystemIdOf(entry);
        if (sysId != null) {
            for (const e of Object.values(state.celestialBodies || {})) {
                const d = e?.data;
                if (!d) continue;
                if (!(d.colonized || d.developed || Number(d.id) === 3)) continue;
                if (Number(starSystemIdOf(e)) === Number(sysId)) return 'full';
            }
        }
    }
    const mesh = entry?.mesh;
    if (!mesh) return 'hidden';
    const lvl = levelId || _scan.levelId || '3ZC';
    const sources = _scan.sources.length ? _scan.sources : getOpticalSources(lvl, 0);
    if (!sources.length) return 'hidden';
    const { a1, a2 } = coverageAt(mesh.position.x, mesh.position.z, sources, entry);
    if (tpe === 'planet' || tpe === 'moon') {
        if (a1) return 'full';
        if (a2) return 'detect';
        return 'hidden';
    }
    // звезда / система / туманность / галактика — А2 достаточно для полной сводки
    if (a2 || a1) return 'full';
    return 'hidden';
}

export function a2ReachesBeyondHomeGalaxy() {
    if (!_scan.fogEnabled) return true;
    const sources = _scan.sources;
    if (!sources.length) return false;
    const mw = bodyMesh(3000);
    const mwR = (Number(mw?.data?.size) || MW_SIZE_WORLD) * 0.5;
    const cx = mw?.mesh?.position?.x ?? 0;
    const cz = mw?.mesh?.position?.z ?? 0;
    for (const s of sources) {
        const d = Math.hypot(s.x - cx, s.z - cz);
        if (d + s.a2w > mwR * 0.98) return true;
    }
    return false;
}

export function applyOpticalMaterial(entry, vis) {
    const mesh = entry?.mesh;
    if (!mesh || !mesh.isMesh) return;
    if (vis === 'detect') {
        if (!mesh.userData._optOrigMat) mesh.userData._optOrigMat = mesh.material;
        if (!mesh.userData._optBlackMat) {
            mesh.userData._optBlackMat = new THREE.MeshBasicMaterial({
                color: 0x050508,
                transparent: false
            });
        }
        if (mesh.material !== mesh.userData._optBlackMat) mesh.material = mesh.userData._optBlackMat;
    } else if (mesh.userData._optOrigMat && mesh.material === mesh.userData._optBlackMat) {
        mesh.material = mesh.userData._optOrigMat;
    }
}

function ensureGroup() {
    if (_scan.group) return _scan.group;
    const scene = state.scene || state.camera?.parent;
    // scene may be renderer-owned; look on camera
    const sc = globalThis.__gameScene || state.scene;
    if (!sc) return null;
    const g = new THREE.Group();
    g.name = 'opticalScanGroup';
    sc.add(g);
    _scan.group = g;
    return g;
}

function makeDiscMat(color, maxAlpha) {
    return new THREE.ShaderMaterial({
        uniforms: {
            color: { value: new THREE.Color(color) },
            opacity: { value: maxAlpha }
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 color;
            uniform float opacity;
            varying vec2 vUv;
            void main() {
                float d = length(vUv - vec2(0.5)) * 2.0;
                if (d > 1.0) discard;
                // заливка от центра + яркое кольцо по краю (как грав. колодец)
                float fill = 0.22 + 0.55 * smoothstep(0.0, 0.85, d);
                float rim = smoothstep(0.82, 0.93, d) * (1.0 - smoothstep(0.93, 1.0, d));
                float a = (fill * 0.45 + rim * 1.35) * opacity;
                gl_FragColor = vec4(color, clamp(a, 0.0, 0.95));
            }
        `
    });
}

function makeRimMat(color) {
    return new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide
    });
}

function makeFogMat() {
    return new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            nSrc: { value: 0 },
            centers: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector2()) },
            radii: { value: new Float32Array(MAX_SOURCES) }
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: `
            varying vec3 vWorld;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorld = wp.xyz;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `,
        fragmentShader: `
            uniform float time;
            uniform int nSrc;
            uniform vec2 centers[${MAX_SOURCES}];
            uniform float radii[${MAX_SOURCES}];
            varying vec3 vWorld;
            float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
            float noise(vec2 p){
                vec2 i = floor(p), f = fract(p);
                float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
                vec2 u = f*f*(3.0-2.0*f);
                return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
            }
            void main() {
                float cover = 0.0;
                for (int i = 0; i < ${MAX_SOURCES}; i++) {
                    if (i >= nSrc) break;
                    float r = max(radii[i], 1.0);
                    float d = length(vWorld.xz - centers[i]);
                    cover = max(cover, 1.0 - smoothstep(r * 0.88, r, d));
                }
                if (cover > 0.92) discard;
                vec2 uv = vWorld.xz * 0.00008;
                float n = noise(uv + time * 0.015);
                float n2 = noise(uv * 2.4 - time * 0.02);
                float wave = 0.55 + 0.45 * sin(uv.x * 6.0 + time * 0.4 + n * 4.0);
                vec3 col = mix(vec3(0.0, 0.0, 0.02), vec3(0.02, 0.04, 0.07), n2 * wave);
                float a = (1.0 - cover) * (0.72 + n * 0.18);
                gl_FragColor = vec4(col, clamp(a, 0.0, 0.88));
            }
        `
    });
}

function projectLabel(x, y, z, camera) {
    if (!camera) return null;
    const v = new THREE.Vector3(x, y, z);
    v.project(camera);
    if (v.z > 1) return null;
    return {
        x: (v.x * 0.5 + 0.5) * window.innerWidth,
        y: (-v.y * 0.5 + 0.5) * window.innerHeight
    };
}

function ensureLabels(n) {
    while (_scan.labels.length < n) {
        const el = document.createElement('div');
        el.className = 'optical-disc-label';
        el.style.opacity = '0';
        document.body.appendChild(el);
        _scan.labels.push(el);
    }
}

export function initOpticalScan(scene) {
    if (_scan.inited) return;
    if (scene) {
        try { state.scene = scene; } catch (_) {}
        globalThis.__gameScene = scene;
    }
    const sc = scene || globalThis.__gameScene;
    if (sc && !_scan.group) {
        const g = new THREE.Group();
        g.name = 'opticalScanGroup';
        sc.add(g);
        _scan.group = g;
        const fogGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
        const fog = new THREE.Mesh(fogGeo, makeFogMat());
        fog.rotation.x = -Math.PI / 2;
        fog.frustumCulled = false;
        fog.renderOrder = -50;
        fog.name = 'opticalFogPlane';
        g.add(fog);
        _scan.fogMesh = fog;
    }
    bindOverlayButton();
    _scan.inited = true;
}

function bindOverlayButton() {
    const btn = document.getElementById('optical-scan-toggle');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleOpticalOverlay();
    });
    syncOverlayButton();
}

function syncOverlayButton() {
    const btn = document.getElementById('optical-scan-toggle');
    if (!btn) return;
    btn.classList.toggle('active', !!_scan.overlayOn);
    btn.title = t(_scan.overlayOn ? 'optical.overlayOn' : 'optical.overlayOff');
    btn.setAttribute('data-tip', btn.title);
}


/** Видимые радиусы: A1/A2 в одних мировых единицах, A2 снаружи A1.
 *  cap только если кольцо уезжает за camera.far — пропорция km сохраняется,
 *  пока оба кольца влезают в кадр. */
function visualDiscRadii(s, capA1, capA2) {
    let a1 = Math.max(0, Number(s.a1w) || 0);
    let a2 = Math.max(0, Number(s.a2w) || 0);
    if (a2 > 0 && a1 > a2) a1 = a2 * 0.62;
    if (a2 > capA2) a2 = capA2;
    if (a1 > capA1) a1 = capA1;
    // если после капа кольца слиплись — развести, не ломая «A1 внутри A2»
    if (a1 > 0 && a2 > 0 && a1 > a2 * 0.84) a1 = a2 * 0.62;
    return { a1, a2 };
}

export function tickOpticalScan(dt, levelId) {
    if (!_scan.inited) initOpticalScan(globalThis.__gameScene);
    bindOverlayButton();
    const sources = getOpticalSources(levelId || '3ZC', dt);
    _scan._nameTick = (_scan._nameTick || 0) + dt;
    if (_scan._nameTick > 0.35) {
        _scan._nameTick = 0;
        try {
            import('./bodyRename.js').then(m => m.refreshAllBodyNameDisplays?.()).catch(() => {});
        } catch (_) {}
    }
    const cam = state.camera;
    const inGame = !document.body.classList.contains('main-menu-active');
    const showFog = _scan.fogEnabled && inGame;
    const showDisc = !!_scan.overlayOn && inGame;

    // fog plane
    if (_scan.fogMesh && cam) {
        const span = Math.max(cam.position.y * 18, 400);
        _scan.fogMesh.scale.set(span, span, 1);
        _scan.fogMesh.position.set(cam.position.x, -2, cam.position.z);
        const mat = _scan.fogMesh.material;
        const n = Math.min(sources.length, MAX_SOURCES);
        mat.uniforms.nSrc.value = showFog ? n : 0;
        mat.uniforms.time.value = performance.now() * 0.001;
        for (let i = 0; i < MAX_SOURCES; i++) {
            const s = sources[i];
            if (s) {
                mat.uniforms.centers.value[i].set(s.x, s.z);
                mat.uniforms.radii.value[i] = s.a2w;
            } else {
                mat.uniforms.radii.value[i] = 0;
            }
        }
        mat.uniforms.radii.value = mat.uniforms.radii.value;
        _scan.fogMesh.visible = showFog && n >= 0;
        if (!showFog) _scan.fogMesh.visible = false;
        // if no observatories, entire map is fog
        if (showFog && n === 0) {
            mat.uniforms.nSrc.value = 0;
            _scan.fogMesh.visible = true;
        }
    }

    // overlay discs — A2 затем A1 (заливка + обод + линия границы)
    let group = _scan.group;
    const sc = globalThis.__gameScene || state.scene;
    if (!group && sc) {
        group = new THREE.Group();
        group.name = 'opticalScanGroup';
        sc.add(group);
        _scan.group = group;
    }
    if (group && sc && group.parent !== sc) {
        try { group.parent && group.parent.remove(group); } catch (_) {}
        sc.add(group);
    }
    if (group) {
        if (!_scan._discKindV2) {
            for (const m of _scan.discs) {
                try { m.parent && m.parent.remove(m); } catch (_) {}
            }
            _scan.discs = [];
            _scan._discKindV2 = true;
        }
        const need = sources.length * 4;
        while (_scan.discs.length < need) {
            // пары: [0]=A2 fill+rim, [1]=A1 fill+rim
            const pair = Math.floor(_scan.discs.length / 2);
            const kind = (pair % 2 === 0) ? 'a2' : 'a1';
            const fill = new THREE.Mesh(
                new THREE.CircleGeometry(1, 96),
                kind === 'a2' ? makeDiscMat(0x6a8aa0, 0.18) : makeDiscMat(0x5ec4ff, 0.42)
            );
            fill.rotation.x = Math.PI / 2;
            fill.frustumCulled = false;
            fill.renderOrder = kind === 'a2' ? 8 : 9;
            fill.userData.kind = kind;
            fill.userData.role = 'fill';
            const rimInner = kind === 'a1' ? 0.972 : 0.988;
            const rim = new THREE.Mesh(
                new THREE.RingGeometry(rimInner, 1.0, 160),
                makeRimMat(kind === 'a2' ? 0xb7c9d6 : 0xb4f0ff)
            );
            rim.rotation.x = Math.PI / 2;
            rim.frustumCulled = false;
            rim.renderOrder = kind === 'a2' ? 10 : 12;
            rim.userData.kind = kind;
            rim.userData.role = 'rim';
            group.add(fill);
            group.add(rim);
            _scan.discs.push(fill, rim);
        }
        const far = Math.max(20, Number(cam?.far) || 2500);
        const capA2 = far * 0.88;
        const capA1 = far * 0.52;
        for (let i = 0; i < _scan.discs.length; i++) {
            const mesh = _scan.discs[i];
            const si = Math.floor(i / 4);
            const s = sources[si];
            if (!showDisc || !s) {
                mesh.visible = false;
                continue;
            }
            const vis = visualDiscRadii(s, capA1, capA2);
            const r = mesh.userData.kind === 'a1' ? vis.a1 : vis.a2;
            if (!(r > 0.02)) { mesh.visible = false; continue; }
            mesh.visible = true;
            const lift = mesh.userData.kind === 'a1' ? 0.12 : 0.05;
            mesh.position.set(s.x, lift, s.z);
            mesh.scale.set(r, r, 1);
            s._visA1 = vis.a1;
            s._visA2 = vis.a2;
        }
    }

    // подписи на видимом ободе (не на «сыром» радиусе за far)
    const needL = showDisc ? sources.length * 2 : 0;
    ensureLabels(needL);
    for (let i = 0; i < _scan.labels.length; i++) {
        const el = _scan.labels[i];
        const si = Math.floor(i / 2);
        const s = sources[si];
        if (!showDisc || !s || !cam) {
            el.style.opacity = '0';
            continue;
        }
        const isA1 = (i % 2) === 1;
        const r = isA1 ? (s._visA1 || s.a1w) : (s._visA2 || s.a2w);
        if (!(r > 0.02)) { el.style.opacity = '0'; continue; }
        const lx = s.x + r * 0.98;
        const lz = s.z;
        const scr = projectLabel(lx, 1.4, lz, cam);
        if (!scr) { el.style.opacity = '0'; continue; }
        el.textContent = isA1 ? 'A1' : 'A2';
        el.style.left = scr.x + 'px';
        el.style.top = scr.y + 'px';
        el.style.opacity = '1';
    }
}

export function getOpticalUnknownName() {
    return t('optical.unknownBody');
}

/** Планета/луна в зоне только А2 — маскируем имя. */
export function isOpticallyUnknownBody(body) {
    try {
        if (!isOpticalFogEnabled() || !body) return false;
        const tpe = body?.data?.type || body?.type;
        if (tpe !== 'planet' && tpe !== 'moon') return false;
        return getOpticalBodyState(body) === 'detect';
    } catch (_) {
        return false;
    }
}
