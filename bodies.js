import { 
    sunVertexShader, 
    sunFragmentShader, 
    gravityWellLineVertexShader, 
    gravityWellLineFragmentShader, 
    gravityWellGradientVertexShader, 
    gravityWellGradientFragmentShader,
    particleVertexShader,
    particleFragmentShader,
    atmosphereVertexShader,
    atmosphereFragmentShader,
    cityLightsVertexShader,
    cityLightsFragmentShader,
    auroraVertexShader,
    auroraFragmentShader,
    nebulaVertexShader,
    nebulaFragmentShader,
    starIconVertexShader,
    starIconFragmentShader
} from './shaders.js';
import {
    createNebulaVisual,
    updateNebulaVisual,
    removeNebulaDomOverlay,
    createNebulaParticleSystems,
    updateNebulaParticleSystems
} from './nebula.js';
import {
    createGalaxyVisuals,
    createGalaxyAnchor,
    updateGalaxyVisuals
} from './galaxy.js';
import {
    createUniverseVisuals,
    updateUniverseVisuals
} from './universe.js';
import {
    createMultiverseVisuals,
    updateMultiverseVisuals
} from './multiverse.js';
import { getOpticalBodyState, applyOpticalMaterial, isOpticalFogEnabled, a2ReachesBeyondHomeGalaxy, getOpticalUnknownName } from './opticalScan.js';
import { state } from './state.js';
import { heightLevels, CAMERA_Y_MAX } from './utils.js';
import { locName } from './settings.js';
import { createStarHaloFx, addStarHaloToScene, updateStarHaloFx } from './starHalo.js';


function starIconColorFromBody(body, tex) {
    const hex = body?.atmosphereColor;
    if (typeof hex === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex.trim())) {
        return new THREE.Color(hex.trim());
    }
    try {
        const img = tex && tex.image;
        if (img && img.width) {
            const c = document.createElement('canvas');
            c.width = 8; c.height = 8;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, 8, 8);
            const d = ctx.getImageData(0, 0, 8, 8).data;
            let r = 0, g = 0, b = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) {
                r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
            }
            if (n > 0) return new THREE.Color(r / n / 255, g / n / 255, b / n / 255);
        }
    } catch (_) {}
    return new THREE.Color(1.0, 0.78, 0.38);
}

function createStarIconMesh(starColor) {
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            starColor: { value: starColor.clone ? starColor.clone() : new THREE.Color(starColor) },
            opacity: { value: 1 }
        },
        vertexShader: starIconVertexShader,
        fragmentShader: starIconFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const icon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    icon.name = 'starIcon8';
    icon.frustumCulled = false;
    icon.renderOrder = 120;
    icon.visible = false;
    return icon;
}

/** Парсинг цвета атмосферы: "#rrggbb" | "rgb(r,g,b)" | [r,g,b] (0–1 или 0–255) */
function parseAtmosphereColor(raw, fallback = 0x88b7ff) {
    const c = new THREE.Color(fallback);
    if (raw == null) return c;
    if (typeof raw === 'string') {
        try { c.set(raw); } catch (_) { /* keep fallback */ }
        return c;
    }
    if (Array.isArray(raw) && raw.length >= 3) {
        let r = Number(raw[0]), g = Number(raw[1]), b = Number(raw[2]);
        if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
        c.setRGB(
            Math.max(0, Math.min(1, r)),
            Math.max(0, Math.min(1, g)),
            Math.max(0, Math.min(1, b))
        );
        return c;
    }
    if (typeof raw === 'number') {
        c.set(raw);
        return c;
    }
    return c;
}

/**
 * Объёмная атмосфера: плотность max у поверхности, экспоненциально → 0 в космос.
 * JSON: hasAtmosphere, atmosphereColor; опц. atmosphereScale, atmosphereIntensity,
 *       atmosphereScaleHeight (доля толщины, меньше = резче падает к космосу).
 */

/**
 * Материал планеты/луны: узкий specular-блик + спокойный diffuse.
 * Без specularMap — равномерный маленький кружок (Phong, высокий shininess).
 * Со specularMap (JSON: specularMap) — блик сильнее на «мокрых» зонах карты.
 */
function createPlanetMaterial(diffuseTex, specularTex, body) {
    const hasSpecMap = !!specularTex;
    // Очень высокий shininess → крошечный блик только в зоне отражения (дневная сторона)
    const shininess = hasSpecMap ? 220 : 180;
    const specular = hasSpecMap
        ? new THREE.Color(0x3a3a48)
        : new THREE.Color(0x141418);

    const mat = new THREE.MeshPhongMaterial({
        map: diffuseTex || null,
        specular,
        shininess,
        specularMap: specularTex || null,
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 0,
        color: new THREE.Color(0xffffff)
    });
    return mat;
}

/** Слой света/меша по starSystemId: своя звезда не светит чужие планеты (иначе 2 блика). */

/**
 * Облачный слой: child-сфера чуть выше поверхности → вращается с телом.
 * JSON: hasClouds, cloudMap, cloudDensity (0..1), cloudScale (опц.).
 * День/ночь от PointLight; без specular-пересвета.
 */
function createCloudShell(body, size, cloudTex) {
    if (!body?.hasClouds || !cloudTex) return null;

    const density = Math.max(0, Math.min(1, Number(body.cloudDensity) || 0.5));
    const scale = Number(body.cloudScale) || 1.025;
    const geo = new THREE.SphereGeometry(size * scale, 128, 128);

    // alpha отдельно — зелёный канал = маска облаков
    const alphaTex = cloudTex.clone();
    alphaTex.needsUpdate = true;
    cloudTex.wrapS = cloudTex.wrapT = THREE.ClampToEdgeWrapping;
    alphaTex.wrapS = alphaTex.wrapT = THREE.ClampToEdgeWrapping;

    /*
     * Видимость: на дистанции PointLight сильно гасит Lambert.
     * — opacity почти до 1 при высокой density
     * — color > 1 слегка поднимает albedo
     * — emissiveMap по маске облаков: лёгкая «светимость» только в белых зонах,
     *   ночь не становится белым шаром (чёрные зоны маски = 0 emissive)
     */
    const opacity = 0.55 + density * 0.45; // density 0.99 → ~1.0
    // r128: у Lambert нет emissiveIntensity — сила зашита в цвет emissive
    const em = 0.18 + density * 0.28;
    const mat = new THREE.MeshLambertMaterial({
        map: cloudTex,
        alphaMap: alphaTex,
        color: new THREE.Color(1.4, 1.4, 1.45),
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
        emissive: new THREE.Color(em, em, em * 1.05),
        emissiveMap: alphaTex
    });

    const shell = new THREE.Mesh(geo, mat);
    shell.name = 'clouds';
    shell.renderOrder = 1;
    shell.frustumCulled = true;
    return shell;
}




/**
 * Ночные огни городов.
 * JSON: hasCityLights, cityLightsMap, cityLightsIntensity (опц.).
 * Условие: body.colonized === true. Видны только на ночной стороне (шейдер).
 */
function createCityLightsShell(body, size, lightsTex) {
    if (!body?.hasCityLights || !body?.colonized || !lightsTex) return null;

    const intensity = Math.max(0.15, Math.min(3, Number(body.cityLightsIntensity) || 1.2));
    const scale = Number(body.cityLightsScale) || 1.004;
    const geo = new THREE.SphereGeometry(size * scale, 128, 128);

    const mat = new THREE.ShaderMaterial({
        uniforms: {
            lightsMap: { value: lightsTex },
            sunDirection: { value: new THREE.Vector3(1, 0, 0) },
            intensity: { value: intensity }
        },
        vertexShader: cityLightsVertexShader,
        fragmentShader: cityLightsFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide
    });

    const shell = new THREE.Mesh(geo, mat);
    shell.name = 'cityLights';
    shell.renderOrder = 1;
    shell.frustumCulled = true;
    shell.userData.isCityLights = true;
    return shell;
}


/**
 * Полярное сияние (шейдер, без текстур).
 * JSON: hasMagneticField === true.
 * Видимость: только уровень камеры 1ZC («Планеты и луны»).
 * Анимация: time += dt * timeSpeed.
 */
function createAuroraShell(body, size) {
    if (!body?.hasMagneticField) return null;
    if (body.type === 'star' || body.type === 'starSystem') return null;

    const scale = Number(body.auroraScale) || 1.09;
    const intensity = Number(body.auroraIntensity) || 0.45;
    const geo = new THREE.SphereGeometry(size * scale, 96, 96);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: Math.random() * 10 },
            intensity: { value: intensity }
        },
        vertexShader: auroraVertexShader,
        fragmentShader: auroraFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const shell = new THREE.Mesh(geo, mat);
    shell.name = 'aurora';
    shell.renderOrder = 3;
    shell.frustumCulled = true;
    shell.visible = false; // покажет updateBodies на 1ZC
    return shell;
}







/**
 * Межзвёздная туманность — С НУЛЯ, другая технология:
 *  НЕ mesh/plane/shader/sprite в Three.js.
 *  Полноэкранный DOM-слой поверх canvas (CSS radial-gradient + mix-blend-mode:screen).
 *  Якорь в сцене — пустой Object3D только для локации/сейва.
 *  1–3ZC: opacity 0.01; 4ZC: opacity 1.
 */
/**
 * Туманность: делегируем в nebula.js (отдельный pass без bloom).
 */
function createNebulaMesh(body) {
    removeNebulaDomOverlay();
    return createNebulaVisual(body);
}



function getSystemLightLayer(starSystemId) {
    if (starSystemId === 1001) return 2; // Альфа Центавра
    return 1; // Солнечная система по умолчанию
}

/** Базовая яркость PointLight звезды (одна активна — один блик) */
const STAR_LIGHT_INTENSITY = 1.15;

/**
 * В сцене несколько звёзд с PointLight → несколько specular на одной планете.
 * Layers помогают не всегда; гарантированно: светит только ближайшая к камере звезда.
 */
function updateStarLightIsolation() {
    const bodies = state.celestialBodies || {};
    const cam = state.camera;
    if (!cam) return;

    let bestId = null;
    let bestDist = Infinity;
    const world = new THREE.Vector3();

    for (const key of Object.keys(bodies)) {
        const e = bodies[key];
        if (!e?.light || e.data?.type !== 'star' || !e.mesh) continue;
        e.mesh.getWorldPosition(world);
        const d = cam.position.distanceToSquared(world);
        if (d < bestDist) {
            bestDist = d;
            bestId = e.data.id;
        }
    }

    for (const key of Object.keys(bodies)) {
        const e = bodies[key];
        if (!e?.light || e.data?.type !== 'star') continue;
        e.light.intensity = (e.data.id === bestId) ? STAR_LIGHT_INTENSITY : 0;
    }
}


/* ============================================================================
 * FLOATING ORIGIN
 * После появления уровня Галактики звёзды живут на координатах ±15k.
 * Float32 GPU на таких смещениях дрожит на тонких оболочках (атмосфера, огни).
 * На 1ZC–3ZC сдвигаем мир так, чтобы активная звезда была у (0,0);
 * логические галактические координаты храним в mesh.userData.logicalX/Z.
 * На 4ZC/5ZC origin = (0,0) — нужны абсолютные позиции.
 * ============================================================================ */
let _foX = 0;
let _foZ = 0;

function resolveNearestStarEntry() {
    const cam = state.camera;
    if (!cam) return null;
    let best = null;
    let bestD = Infinity;
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        if (!e?.mesh || e.data?.type !== 'star') continue;
        // сравниваем по логическим координатам (если уже сдвинуты — восстанавливаем)
        const lx = (e.mesh.userData.logicalX != null)
            ? e.mesh.userData.logicalX
            : (e.mesh.position.x + _foX);
        const lz = (e.mesh.userData.logicalZ != null)
            ? e.mesh.userData.logicalZ
            : (e.mesh.position.z + _foZ);
        const dx = (cam.position.x + _foX) - lx;
        const dz = (cam.position.z + _foZ) - lz;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = e; }
    }
    return best;
}


function _applyFoPositionsOnly() {
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        const mesh = e?.mesh;
        if (!mesh || !e.data) continue;
        const t = e.data.type;
        const isFree = (t === 'star' && (e.data.parent == null || e.data.parent === undefined))
            || t === 'starSystem' || t === 'interstellarNebula' || t === 'galaxy' || t === 'universe';
        if (!isFree) continue;
        if (mesh.userData.logicalX == null || mesh.userData.logicalZ == null) {
            mesh.userData.logicalX = mesh.position.x + _foX;
            mesh.userData.logicalZ = mesh.position.z + _foZ;
        }
        mesh.position.x = mesh.userData.logicalX - _foX;
        mesh.position.z = mesh.userData.logicalZ - _foZ;
    }
    for (const id of Object.keys(bodies)) {
        const body = bodies[id];
        if (!body?.mesh || !body.data) continue;
        if (body.data.type !== 'planet' && body.data.type !== 'moon') continue;
        if (body.data.parent == null) continue;
        const parentEntry = bodies[body.data.parent] || bodies[String(body.data.parent)];
        const parentMesh = parentEntry?.mesh;
        if (!parentMesh) continue;
        const angle = body.mesh.userData.orbitAngle;
        if (!Number.isFinite(angle)) continue;
        const dist = Number(body.data.distance) || 0;
        body.mesh.position.x = parentMesh.position.x + dist * Math.cos(angle);
        body.mesh.position.z = parentMesh.position.z + dist * Math.sin(angle);
        if (body.orbitLine) body.orbitLine.position.copy(parentMesh.position);
        if (body.gravityWellLine) body.gravityWellLine.position.copy(body.mesh.position);
        if (body.gravityWellGradient) body.gravityWellGradient.position.copy(body.mesh.position);
        if (body.gravityWellGrid) body.gravityWellGrid.position.copy(body.mesh.position);
    }
    if (state.particleSystems) {
        for (const starId of Object.keys(state.particleSystems)) {
            const ps = state.particleSystems[starId];
            const starE = bodies[starId] || bodies[String(starId)];
            if (ps?.system && starE?.mesh) {
                ps.system.position.x = starE.mesh.position.x;
                ps.system.position.z = starE.mesh.position.z;
            }
        }
    }
    if (state.nebulaParticleSystems) {
        for (const id of Object.keys(state.nebulaParticleSystems)) {
            const entry = state.nebulaParticleSystems[id];
            const e = bodies[id] || bodies[String(id)];
            if (!entry || !e?.mesh) continue;
            entry.baseX = e.mesh.position.x;
            entry.baseZ = e.mesh.position.z;
        }
    }
    try { state.foX = _foX; state.foZ = _foZ; } catch (_) {}
}

/**
 * Привязать floating origin к звезде, связанной с body, и вернуть display-позицию body.
 * Вызывать перед switchBody/focusBody — иначе камера уходит в чёрный экран.
 */
export function getFloatingOrigin() {
    try { state.foX = _foX; state.foZ = _foZ; } catch (_) {}
    return { x: _foX, z: _foZ };
}

export function recenterFloatingOriginToBody(body) {
    if (!body?.mesh || !body.data) return null;
    const bodies = state.celestialBodies || {};
    let star = null;
    const t = body.data.type;
    if (t === 'star') {
        star = body;
    } else if (t === 'planet' || t === 'moon') {
        let p = body.data;
        let guard = 0;
        while (p && guard++ < 8) {
            const pe = bodies[p.parent] || bodies[String(p.parent)];
            if (!pe?.data) break;
            if (pe.data.type === 'star') { star = pe; break; }
            p = pe.data;
        }
    } else if (t === 'galaxy' || t === 'universe') {
        // FO = центр галактики / вселенной (НЕ чужая звезда Млечного пути)
        star = body;
    } else if (t === 'starSystem' || t === 'interstellarNebula') {
        // ближайшая звезда той же туманности / системы
        const nebId = body.data.nebulaId != null ? Number(body.data.nebulaId)
            : (t === 'interstellarNebula' ? Number(body.data.id) : null);
        const sysId = t === 'starSystem' ? Number(body.data.id) : null;
        let best = null, bestD = Infinity;
        const bx = body.mesh.userData.logicalX != null ? body.mesh.userData.logicalX : (body.mesh.position.x + _foX);
        const bz = body.mesh.userData.logicalZ != null ? body.mesh.userData.logicalZ : (body.mesh.position.z + _foZ);
        for (const id of Object.keys(bodies)) {
            const e = bodies[id];
            if (!e?.mesh || e.data?.type !== 'star') continue;
            if (nebId != null && e.data.nebulaId != null && Number(e.data.nebulaId) !== nebId) continue;
            if (sysId != null && e.data.starSystemId != null && Number(e.data.starSystemId) !== sysId) {
                // soft filter — still allow by distance
            }
            const lx = e.mesh.userData.logicalX != null ? e.mesh.userData.logicalX : (e.mesh.position.x + _foX);
            const lz = e.mesh.userData.logicalZ != null ? e.mesh.userData.logicalZ : (e.mesh.position.z + _foZ);
            const d = (lx - bx) * (lx - bx) + (lz - bz) * (lz - bz);
            if (d < bestD) { bestD = d; best = e; }
        }
        star = best;
    }
    if (!star?.mesh) star = body;
    const lx = star.mesh.userData.logicalX != null
        ? star.mesh.userData.logicalX
        : (Number(star.data?.centerX) || (star.mesh.position.x + _foX));
    const lz = star.mesh.userData.logicalZ != null
        ? star.mesh.userData.logicalZ
        : (Number(star.data?.centerZ) || (star.mesh.position.z + _foZ));
    if (Number.isFinite(lx)) _foX = lx;
    if (Number.isFinite(lz)) _foZ = lz;
    try { state.foX = _foX; state.foZ = _foZ; } catch (_) {}
    _applyFoPositionsOnly();
    return { x: body.mesh.position.x, z: body.mesh.position.z, foX: _foX, foZ: _foZ };
}

/** Применить floating origin. Вызывать в конце updateBodies после всех записей позиций. */
/** Во время гео-разведки FO не двигает камеру — иначе дрожит атмосфера/огни в упор. */
let _foFrozen = false;
export function setFloatingOriginFrozen(v) { _foFrozen = !!v; }
export function isFloatingOriginFrozen() { return _foFrozen; }

function applyFloatingOrigin(currentLevelId) {
    const cam = state.camera;
    if (!cam) return;

    // Гео-разведка / freeze: меши на месте, камеру не двигаем
    if (_foFrozen || state.geoSurveyBlocking) {
        _applyFoPositionsOnly();
        return;
    }

    // 4ZC/5ZC: НЕ сбрасываем FO в (0,0) — иначе transition/лейблы дают чёрный экран.
    // Origin меняем только на 1–3ZC (ближайшая звезда) или через recenterFloatingOriginToBody.
    if (currentLevelId === '1ZC' || currentLevelId === '2ZC' || currentLevelId === '3ZC') {
        const star = resolveNearestStarEntry();
        if (star?.mesh) {
            let targetX = (star.mesh.userData.logicalX != null)
                ? star.mesh.userData.logicalX
                : (star.mesh.position.x + _foX);
            let targetZ = (star.mesh.userData.logicalZ != null)
                ? star.mesh.userData.logicalZ
                : (star.mesh.position.z + _foZ);
            if (!Number.isFinite(targetX)) targetX = _foX;
            if (!Number.isFinite(targetZ)) targetZ = _foZ;
            const dx = targetX - _foX;
            const dz = targetZ - _foZ;
            if (Math.abs(dx) > 1e-4 || Math.abs(dz) > 1e-4) {
                cam.position.x -= dx;
                cam.position.z -= dz;
                _foX = targetX;
                _foZ = targetZ;
            }
        }
    }

    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        const mesh = e?.mesh;
        if (!mesh || !e.data) continue;
        const t = e.data.type;
        // Свободные якоря: звезда без parent, система, туманность, галактика
        const isFree = (t === 'star' && (e.data.parent == null || e.data.parent === undefined))
            || t === 'starSystem' || t === 'interstellarNebula' || t === 'galaxy' || t === 'universe';
        if (!isFree) continue;
        if (mesh.userData.logicalX == null || mesh.userData.logicalZ == null) {
            // восстановить из текущей позиции + старого origin
            mesh.userData.logicalX = mesh.position.x + _foX;
            mesh.userData.logicalZ = mesh.position.z + _foZ;
        }
        mesh.position.x = mesh.userData.logicalX - _foX;
        mesh.position.z = mesh.userData.logicalZ - _foZ;
    }

    // Пыль звёздных систем — к позиции звезды
    if (state.particleSystems) {
        for (const starId of Object.keys(state.particleSystems)) {
            const ps = state.particleSystems[starId];
            const starE = bodies[starId] || bodies[String(starId)];
            if (ps?.system && starE?.mesh) {
                ps.system.position.x = starE.mesh.position.x;
                ps.system.position.z = starE.mesh.position.z;
            }
        }
    }
    // Туманности: base для партиклов = display-позиция (после FO)
    if (state.nebulaParticleSystems) {
        for (const id of Object.keys(state.nebulaParticleSystems)) {
            const entry = state.nebulaParticleSystems[id];
            const e = bodies[id] || bodies[String(id)];
            if (!entry || !e?.mesh) continue;
            entry.baseX = e.mesh.position.x;
            entry.baseZ = e.mesh.position.z;
        }
    }
}

function createAtmosphereShell(body, size, type) {
    if (!body || !body.hasAtmosphere) return null;

    const isStar = type === 'star';
    // Внешняя граница: тонкая у планеты, заметнее у звезды (хромосфера/корона)
    const scale = Number(body.atmosphereScale) || (isStar ? 1.18 : 1.06);
    const intensity = Number(body.atmosphereIntensity) || (isStar ? 1.55 : 0.85);
    // H как доля толщины атмосферы (0.2–0.35 ≈ реалистичный мягкий спад)
    const heightFrac = Number(body.atmosphereScaleHeight) || (isStar ? 0.28 : 0.18);

    const outerR = size * scale;
    const innerR = size;
    const thickness = Math.max(outerR - innerR, size * 0.01);
    const scaleHeight = thickness * heightFrac;

    const color = parseAtmosphereColor(
        body.atmosphereColor,
        isStar ? 0xffb45a : 0x6ba3ff
    );

    const geo = new THREE.SphereGeometry(outerR, 64, 64);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            glowColor: { value: color },
            planetCenter: { value: new THREE.Vector3(0, 0, 0) },
            sunPosition: { value: new THREE.Vector3(0, 0, 0) },
            lightResponse: { value: isStar ? 0.0 : 1.0 },
            innerRadius: { value: innerR },
            outerRadius: { value: outerR },
            densityMul: { value: intensity },
            scaleHeight: { value: scaleHeight }
        },
        vertexShader: atmosphereVertexShader,
        fragmentShader: atmosphereFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        // против z-fighting дымки с поверхностью вблизи (гео-разведка)
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
    });

    const shell = new THREE.Mesh(geo, mat);
    shell.name = 'atmosphere';
    shell.renderOrder = 2;
    shell.frustumCulled = false; // вблизи frustumCulled давал мерцание края
    // центр в local space = 0 (child планеты); world center обновим в updateBodies
    shell.userData.isAtmosphere = true;
    return shell;
}

/** Обновить planetCenter + позицию СВОЕЙ звезды для день/ночи атмосферы */
export function syncAtmosphereCenters() {
    const bodies = state.celestialBodies || {};
    const starWorld = {};
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        if (e?.data?.type === 'star' && e.mesh) {
            const w = new THREE.Vector3();
            e.mesh.getWorldPosition(w);
            starWorld[id] = w;
        }
    }

    const tmp = new THREE.Vector3();
    for (const id of Object.keys(bodies)) {
        const entry = bodies[id];
        const mesh = entry?.mesh;
        if (!mesh) continue;

        const w = new THREE.Vector3();
        mesh.getWorldPosition(w);

        // Звезда своей системы
        let starId = null;
        let p = entry.data?.parent;
        let g = 0;
        while (p != null && g++ < 8) {
            const pe = bodies[p];
            if (!pe?.data) break;
            if (pe.data.type === 'star') { starId = pe.data.id; break; }
            p = pe.data.parent;
        }
        if (starId == null && entry.data?.type === 'star') starId = entry.data.id;
        const sw = (starId != null && starWorld[starId]) ? starWorld[starId] : (starWorld[0] || new THREE.Vector3(0, 0, 0));

        const atmo = entry.atmosphere;
        if (atmo?.material?.uniforms?.planetCenter) {
            atmo.material.uniforms.planetCenter.value.copy(w);
            if (atmo.material.uniforms.sunPosition) {
                atmo.material.uniforms.sunPosition.value.copy(sw);
            }
        }

        // Ночные огни: направление на звезду + видимость только если colonized
        const lights = entry.cityLights;
        if (lights?.material?.uniforms?.sunDirection) {
            tmp.copy(sw).sub(w).normalize();
            lights.material.uniforms.sunDirection.value.copy(tmp);
            const colonized = !!entry.data?.colonized;
            lights.visible = colonized;
        }
    }
}


export function createLabel(name, size) {
    const div = document.createElement('div');
    div.style.userSelect = 'none';   // 🔒 запрет выделения текста
    div.style.cursor = 'pointer';
    div.style.position = 'absolute';
    div.style.color = 'white';
    div.style.fontFamily = 'Play';
    div.style.fontSize = '14px';
    div.style.backgroundColor = 'rgba(0,0,0,0.5)';
    div.style.padding = '5px 10px';
    div.style.clipPath = 'polygon(10px 0, 100% 0, 100% 100%, 0 100%, 0 10px)';
    div.style.transform = 'translate(-50%, -100%)';
    div.style.transition = 'background-color 0.3s ease'; // плавный переход
    div.innerText = name;
    div.dataset.size = size;

    // ✨ эффект подсветки при наведении
    div.addEventListener('mouseenter', () => {
        div.style.backgroundColor = 'rgba(0, 143, 143, 0.77)'; // подсветка
    });

    div.addEventListener('mouseleave', () => {
        div.style.backgroundColor = 'rgba(0,0,0,0.5)'; // возвращаем обратно
    });


    document.body.appendChild(div);
    return div;
}

function labelDisplayName(entry) {
    if (!entry?.data) return '';
    try {
        const custom = state.bodyCustomNames?.[String(entry.data.id)];
        if (typeof custom === 'string' && custom.trim()) return custom.trim();
    } catch (_) {}
    return locName(entry.data.name, '');
}

export function updateLabel(label, obj, visible, levelId) {
    if (!label || !obj) return;
    const entry = state.celestialBodies[obj.userData.id]
        || state.celestialBodies[String(obj.userData.id)];
    const bodyType = entry?.data?.type;
    const camY = state.camera?.position?.y ?? 0;
    const is4zc = levelId === '4ZC' || (camY >= 400 && camY < 6500);
    const keep4zcStar = visible && is4zc && (bodyType === 'star' || bodyType === 'starSystem');
    if (!visible) {
        label.style.display = 'none';
        return;
    }

    const vector = new THREE.Vector3();
    obj.updateMatrixWorld();
    vector.setFromMatrixPosition(obj.matrixWorld);
    vector.y += parseFloat(label.dataset.size) + 0.5;
    vector.project(state.camera);

    const distance = state.camera.position.distanceTo(obj.position);
    const maxDistance = 100;
    const scale = Math.min(1, maxDistance / distance);

    const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-vector.y * 0.5 + 0.5) * window.innerHeight - (parseFloat(label.dataset.size) * 20 * scale);

    label.style.left = `${x}px`;
    label.style.top = `${y}px`;

    let opt = 'full';
    try {
        if (isOpticalFogEnabled() && entry) {
            opt = getOpticalBodyState(entry, levelId);
        }
    } catch (_) { opt = 'full'; }

    if (opt === 'hidden' && !keep4zcStar) {
        label.style.display = 'none';
        return;
    }

    try {
        if (opt === 'detect' || (opt === 'hidden' && keep4zcStar)) {
            label.textContent = getOpticalUnknownName();
            label.dataset.optUnknown = '1';
        } else {
            const nm = labelDisplayName(entry);
            if (nm) label.textContent = nm;
            delete label.dataset.optUnknown;
        }
    } catch (_) {}

    const dx = state.camera.position.x - obj.position.x;
    const dz = state.camera.position.z - obj.position.z;
    const horiz = Math.hypot(dx, dz);

    // Туманности — уровень Галактика (5ZC); галактики — Вселенная (6ZC)
    if (bodyType === 'interstellarNebula' || bodyType === 'galaxy' || bodyType === 'universe') {
        if (bodyType === 'interstellarNebula' && camY >= 6500 && camY < 25000) {
            let show = horiz <= 180000;
            try {
                if (show && isOpticalFogEnabled() && getOpticalBodyState(entry) === 'hidden') show = false;
            } catch (_) {}
            label.style.display = show ? 'block' : 'none';
        } else if (bodyType === 'galaxy' && camY >= 25000 && camY < 160000) {
            let show = horiz <= 220000;
            try {
                if (show && isOpticalFogEnabled() && getOpticalBodyState(entry) === 'hidden') show = false;
            } catch (_) {}
            label.style.display = show ? 'block' : 'none';
        } else {
            label.style.display = 'none';
        }
        return;
    }
    // «Система такая-то» только на 4ZC. На 1–3ZC этой таблички нет.
    if (bodyType === 'starSystem') {
        if (!is4zc || camY >= 6500) {
            label.style.display = 'none';
            return;
        }
        label.style.display = horiz > 90000 ? 'none' : 'block';
        return;
    }
    // Звезда: на 4ZC табличка системы уже есть — «Солнце» не дублируем.
    if (bodyType === 'star') {
        if (is4zc || camY >= 6500) {
            label.style.display = 'none';
        } else {
            const maxH = camY >= 260 ? 90000 : 800;
            label.style.display = horiz > maxH ? 'none' : 'block';
        }
        return;
    }
    const visibilityThreshold = 500;
    label.style.display = distance > visibilityThreshold ? 'none' : 'block';
}

export async function loadBodiesFromJSON(data, scene) {
    const loader = new THREE.TextureLoader();
    const textures = {};
    const specularTextures = {};
    const cloudTextures = {};
    const cityLightsTextures = {};

    // Найти все звёзды для создания систем частиц
    const stars = data.filter(body => body.type === 'star');
    state.particleSystems = {};
    state.ringSystems = {};

    // Звёздная пыль: для каждой звезды (с планетами — по орбитам; без — дефолтный радиус системы)
    for (const star of stars) {
        const children = data.filter(body => body.parent === star.id && (body.type === 'planet' || body.type === 'moon'));
        const maxDistance = children.length > 0
            ? Math.max(...children.map(body => Number(body.distance) || 0), 1)
            : Math.max(Number(star.size) || 2, 1) * 35; // Эты Киля / Трапеция и т.п.

        const particleGeometry = new THREE.BufferGeometry();
        const particleCount = 8000;
        const positions = [];
        const randomSeeds = [];
        const particles = [];
        for (let i = 0; i < particleCount; i++) {
            const radius = maxDistance * 1.5;
            const theta = Math.random() * 2 * Math.PI;
            const phi = Math.acos(2 * Math.random() - 1);
            const r = Math.cbrt(Math.random()) * radius;
            const x = r * Math.sin(phi) * Math.cos(theta);
            const y = r * Math.sin(phi) * Math.sin(theta);
            const z = r * Math.cos(phi);
            positions.push(x, y, z);
            randomSeeds.push(Math.random());
            particles.push(new THREE.Vector3(x, y, z));
        }
        particleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        particleGeometry.setAttribute('randomSeed', new THREE.Float32BufferAttribute(randomSeeds, 1));

        const particleMaterial = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0.0 },
                opacity: { value: 1.0 },
                color: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
                pointSize: { value: 0.5 },
                cameraDistance: { value: 5.0 }
            },
            vertexShader: particleVertexShader,
            fragmentShader: particleFragmentShader,
            transparent: true
        });

        const particleSystem = new THREE.Points(particleGeometry, particleMaterial);
        particleSystem.position.set(star.centerX || 0, 0, star.centerZ || 0);
        scene.add(particleSystem);
        state.particleSystems[star.id] = { system: particleSystem, particles };
    }

    // Туманность = тот же класс объектов, что звёздная пыль
    try {
        createNebulaParticleSystems(data, scene);
    } catch (e) {
        console.error('[nebula] createNebulaParticleSystems failed', e);
    }
    // Галактика (плоскость Млечного Пути + межгалактическая пыль)
    try {
        createGalaxyVisuals(data, scene);
    } catch (e) {
        console.error('[galaxy] createGalaxyVisuals failed', e);
    }
    try {
        createUniverseVisuals(data, scene);
    } catch (e) {
        console.error('[universe] createUniverseVisuals failed', e);
    }
    try {
        createMultiverseVisuals(scene);
    } catch (e) {
        console.error('[multiverse] createMultiverseVisuals failed', e);
    }

    const loadPromises = data.map(body => {
        // starSystem / galaxy / nebula без текстуры — не грузим через TextureLoader
        if ((!body.texture && !body.specularMap && !body.cloudMap && !body.cityLightsMap)
            || body.type === 'starSystem'
            || body.type === 'galaxy'
            || body.type === 'interstellarNebula') {
            return Promise.resolve();
        }
        const jobs = [];
        if (body.texture) {
            jobs.push(new Promise(resolve => {
                loader.load(
                    body.texture,
                    tex => { textures[body.id] = tex; resolve(); },
                    undefined,
                    err => {
                        console.warn('Texture load failed:', body.texture, err);
                        resolve();
                    }
                );
            }));
        }
        // Опциональная specular-карта (Земля и др., когда появится файл)
        if (body.specularMap) {
            jobs.push(new Promise(resolve => {
                loader.load(
                    body.specularMap,
                    tex => { specularTextures[body.id] = tex; resolve(); },
                    undefined,
                    err => {
                        console.warn('Specular map load failed:', body.specularMap, err);
                        resolve();
                    }
                );
            }));
        }
        if (body.cloudMap) {
            jobs.push(new Promise(resolve => {
                loader.load(
                    body.cloudMap,
                    tex => {
                        if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
                        tex.needsUpdate = true;
                        cloudTextures[body.id] = tex;
                        resolve();
                    },
                    undefined,
                    err => {
                        console.warn('Cloud map load failed:', body.cloudMap, err);
                        resolve();
                    }
                );
            }));
        }
        if (body.cityLightsMap) {
            jobs.push(new Promise(resolve => {
                loader.load(
                    body.cityLightsMap,
                    tex => {
                        if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
                        tex.needsUpdate = true;
                        cityLightsTextures[body.id] = tex;
                        resolve();
                    },
                    undefined,
                    err => {
                        console.warn('City lights map load failed:', body.cityLightsMap, err);
                        resolve();
                    }
                );
            }));
        }
        return Promise.all(jobs);
    });

    await Promise.all(loadPromises);

    for (let body of data) {
        const { id, name, type, parent, size, distance, gravityWellMultiplier, orbitalStartAngle, rotationStartAngle, centerX, centerZ, rings, ringCount, ringDensity, ringSpacing, ringThickness } = body;
        state.celestialBodies[id] = { data: body, mesh: null, orbitLine: null, gravityWellLine: null, gravityWellGradient: null, gravityWellGrid: null, ringSystems: [] };

        let tex = textures[id];
        let mesh;
        // Не создаём огромную сферу для якорей галактики/туманности/системы
        let geometry = null;
        if (type !== 'starSystem' && type !== 'interstellarNebula' && type !== 'galaxy' && type !== 'universe' && type !== 'multiverse') {
            geometry = new THREE.SphereGeometry(size, 512, 512);
        }

        if (type === 'starSystem' || type === 'interstellarNebula' || type === 'galaxy' || type === 'universe' || type === 'multiverse') {
            if (type === 'interstellarNebula') {
                mesh = createNebulaMesh(body) || new THREE.Object3D();
            } else if (type === 'galaxy') {
                mesh = createGalaxyAnchor(body) || new THREE.Object3D();
            } else if (type === 'universe') {
                mesh = new THREE.Object3D();
                mesh.name = 'universeAnchor';
                mesh.userData.isUniverse = true;
            } else if (type === 'multiverse') {
                mesh = new THREE.Object3D();
                mesh.name = 'multiverseAnchor';
                mesh.userData.isMultiverse = true;
            } else {
                mesh = new THREE.Object3D();
                mesh.visible = false;
            }
        } else if (type === 'star') {
            mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
                uniforms: {
                    sunTexture: { value: tex },
                    time: { value: 0 },
                    cameraDistance: { value: 5 },
                    interstellarMode: { value: 0 }
                },
                vertexShader: sunVertexShader,
                fragmentShader: sunFragmentShader
            }));

            // Мягкий свет: хватает для дня, не выжигает диск; decay=2 реалистичнее на дистанции
            const light = new THREE.PointLight(0xfff0d8, STAR_LIGHT_INTENSITY, 0, 1);
            mesh.add(light);
            state.celestialBodies[id].light = light;
            const iconCol = starIconColorFromBody(body, tex);
            const starIcon = createStarIconMesh(iconCol);
            state.celestialBodies[id].starIcon = starIcon;
            state.celestialBodies[id].starIconColor = iconCol;
            state.celestialBodies[id].starHaloFx = createStarHaloFx(iconCol);
        } else {
            // Планеты и луны: узкий блик, без пересвета дневной стороны
            mesh = new THREE.Mesh(
                geometry,
                createPlanetMaterial(tex, specularTextures[id], body)
            );
        }

        mesh.userData.orbitAngle = orbitalStartAngle;
        mesh.userData.id = id;
        if (mesh.rotation) mesh.rotation.y = rotationStartAngle;

        // Слои: каждая система освещается только своей звездой (иначе 2 блика с двух PointLight)
        let sysId = body.starSystemId;
        if (sysId == null && type === 'star') sysId = (id === 20) ? 1001 : 1000;
        if (sysId == null && parent != null) {
            const p = data.find(b => b.id === parent);
            sysId = p?.starSystemId ?? (p?.type === 'star' && p.id === 20 ? 1001 : 1000);
        }
        if (sysId == null) sysId = 1000;
        const sysLayer = getSystemLightLayer(sysId);
        if (type !== 'interstellarNebula') {
            // layer 0 всегда + слой системы (свет звезды). set() снимал layer 0 → после сейва легко «пропасть»
            mesh.layers.set(0);
            mesh.layers.enable(sysLayer);
        }
        if (state.celestialBodies[id].light) {
            state.celestialBodies[id].light.layers.set(sysLayer);
            state.celestialBodies[id].light.layers.enable(0);
        }

        // Облака + ночные огни (child → вращение с телом), затем атмосфера
        if (type !== 'star' && type !== 'starSystem' && type !== 'interstellarNebula') {
            const cTex = cloudTextures[id];
            if (body.hasClouds && !cTex) {
                console.warn('[clouds] hasClouds=true but texture missing for body', id, body.cloudMap || '(no cloudMap)');
            }
            const clouds = createCloudShell(body, size, cTex);
            if (clouds) {
                clouds.layers.set(sysLayer);
                mesh.add(clouds);
                state.celestialBodies[id].clouds = clouds;
            }

            const lTex = cityLightsTextures[id];
            if (body.hasCityLights && body.colonized && !lTex) {
                console.warn('[cityLights] texture missing for body', id, body.cityLightsMap || '');
            }
            const cityLights = createCityLightsShell(body, size, lTex);
            if (cityLights) {
                cityLights.layers.set(sysLayer);
                mesh.add(cityLights);
                state.celestialBodies[id].cityLights = cityLights;
            }

            const aurora = createAuroraShell(body, size);
            if (aurora) {
                aurora.layers.set(sysLayer);
                mesh.add(aurora);
                state.celestialBodies[id].aurora = aurora;
            }
        }

        // Атмосфера, если hasAtmosphere в JSON
        const atmosphere = createAtmosphereShell(body, size, type);
        if (atmosphere) {
            atmosphere.layers.set(sysLayer);
            mesh.add(atmosphere);
            state.celestialBodies[id].atmosphere = atmosphere;
        }

        if (type === 'interstellarNebula' || type === 'galaxy' || type === 'universe' || type === 'multiverse') {
            mesh.userData.logicalX = Number(centerX) || 0;
            mesh.userData.logicalZ = Number(centerZ) || 0;
            if (mesh.position) {
                mesh.position.x = mesh.userData.logicalX;
                mesh.position.z = mesh.userData.logicalZ;
            }
            scene.add(mesh);
            state.celestialBodies[id].mesh = mesh;
            // Вселенные: лейблы рисует universe.js (проекция на сферу). Мультивселенная — без таблички на 7ZC пока.
            if (type === 'galaxy' || type === 'interstellarNebula') {
                const labelSize = type === 'galaxy' ? 8 : 4;
                state.labels[id] = createLabel(locName(name), labelSize);
            }
            continue;
        }
        if (type === 'starSystem') {
            let ox = centerX || 0, oz = centerZ || 0;
            if (parent != null && state.celestialBodies[parent]?.mesh) {
                const pm = state.celestialBodies[parent].mesh;
                ox += pm.position.x;
                oz += pm.position.z;
            }
            mesh.position.set(ox, 0, oz);
            mesh.userData.logicalX = ox;
            mesh.userData.logicalZ = oz;
            scene.add(mesh);
            state.celestialBodies[id].mesh = mesh;
            state.labels[id] = createLabel(locName(name), Math.max(Number(size) || 0.01, 1.2));
            continue;
        }

        if (parent !== null && state.celestialBodies[parent] && state.celestialBodies[parent].mesh) {
            const parentMesh = state.celestialBodies[parent].mesh;
            mesh.position.x = parentMesh.position.x + distance * Math.cos(orbitalStartAngle);
            mesh.position.z = parentMesh.position.z + distance * Math.sin(orbitalStartAngle);

            const orbitCurve = new THREE.EllipseCurve(0, 0, distance, distance, 0, 2 * Math.PI);
            const points = orbitCurve.getPoints(512).map(p => new THREE.Vector3(p.x, 0, p.y));
            const orbitGeo = new THREE.BufferGeometry().setFromPoints(points);
            const orbitMat = new THREE.LineBasicMaterial({ 
                color: 0x40E0D0,
                transparent: true, 
                opacity: 0.2,
                linewidth: 2
            });
            const orbitLine = new THREE.LineLoop(orbitGeo, orbitMat);
            scene.add(orbitLine);
            state.celestialBodies[id].orbitLine = orbitLine;

            const wellRadius = size * (gravityWellMultiplier || 1);

            // --- 1. Оригинальный градиент ---
            const gradientGeometry = new THREE.CircleGeometry(wellRadius, 64);
            const gradientMaterial = new THREE.ShaderMaterial({
                vertexShader: gravityWellGradientVertexShader,
                fragmentShader: gravityWellGradientFragmentShader,
                transparent: true,
                side: THREE.DoubleSide
            });
            const gravityWellGradient = new THREE.Mesh(gradientGeometry, gradientMaterial);
            gravityWellGradient.rotation.x = Math.PI / 2;
            gravityWellGradient.position.copy(mesh.position);
            scene.add(gravityWellGradient);
            state.celestialBodies[id].gravityWellGradient = gravityWellGradient;

            // --- 2. Тактическая сетка: крестики + линии секторов ---
            const gridGeometry = new THREE.CircleGeometry(wellRadius, 64);
            const gridMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    gridColor:   { value: new THREE.Color(0xffffff) },
                    crossOpacity:{ value: 0.28 },   // яркость крестиков
                    lineOpacity: { value: 0.10 },   // яркость линий между ними
                    crossSize:   { value: 0.045 },  // длина лучей крестика
                    lineWidth:   { value: 0.012 },  // толщина линий сетки
                    gridDensity: { value: 10.0 }    // количество клеток по диаметру
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv * 2.0 - 1.0; // -1..1
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform vec3 gridColor;
                    uniform float crossOpacity;
                    uniform float lineOpacity;
                    uniform float crossSize;
                    uniform float lineWidth;
                    uniform float gridDensity;
                    varying vec2 vUv;

                    void main() {
                        float dist = length(vUv);
                        if (dist > 1.0) discard;

                        // координаты в пространстве сетки
                        vec2 g = vUv * gridDensity;
                        vec2 cell = fract(g) - 0.5;          // -0.5..0.5 внутри клетки
                        vec2 id   = floor(g);                // номер клетки

                        float alpha = 0.0;

                        // === 1. Линии сетки (более прозрачные) ===
                        // вертикальные линии
                        if (abs(cell.x) < lineWidth) {
                            alpha = max(alpha, lineOpacity);
                        }
                        // горизонтальные линии
                        if (abs(cell.y) < lineWidth) {
                            alpha = max(alpha, lineOpacity);
                        }

                        // === 2. Крестики на пересечениях (ярче) ===
                        // крестик рисуется только около центра клетки (т.е. на пересечении)
                        float nearCenter = step(abs(cell.x), crossSize * 0.6) * 
                                           step(abs(cell.y), crossSize * 0.6);

                        // горизонтальный луч крестика
                        if (abs(cell.y) < lineWidth * 1.4 && abs(cell.x) < crossSize) {
                            alpha = max(alpha, crossOpacity * nearCenter);
                        }
                        // вертикальный луч крестика
                        if (abs(cell.x) < lineWidth * 1.4 && abs(cell.y) < crossSize) {
                            alpha = max(alpha, crossOpacity * nearCenter);
                        }

                        // мягкое затухание к краю колодца
                        float edgeFade = 1.0 - smoothstep(0.78, 1.0, dist);
                        alpha *= edgeFade;

                        if (alpha < 0.008) discard;

                        gl_FragColor = vec4(gridColor, alpha);
                    }
                `,
                transparent: true,
                side: THREE.DoubleSide,
                depthWrite: false
            });

            const gravityWellGrid = new THREE.Mesh(gridGeometry, gridMaterial);
            gravityWellGrid.rotation.x = Math.PI / 2;
            gravityWellGrid.position.copy(mesh.position);
            gravityWellGrid.position.y += 0.002;
            scene.add(gravityWellGrid);
            state.celestialBodies[id].gravityWellGrid = gravityWellGrid;

            // --- 3. Пунктирная граница из коротких дуг ---
            const lineRadius = wellRadius * 1.05;
            const dashCount = 48;
            const gapRatio = 0.42;
            const pointsPerDash = 8;

            const positions = [];
            const fullAngle = Math.PI * 2;
            const step = fullAngle / dashCount;
            const dashAngle = step * (1.0 - gapRatio);

            for (let i = 0; i < dashCount; i++) {
                const startAngle = i * step;
                for (let j = 0; j < pointsPerDash; j++) {
                    const t = j / (pointsPerDash - 1);
                    const a = startAngle + t * dashAngle;
                    positions.push(
                        Math.cos(a) * lineRadius,
                        0,
                        Math.sin(a) * lineRadius
                    );
                }
            }

            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

            const indices = [];
            for (let i = 0; i < dashCount; i++) {
                const base = i * pointsPerDash;
                for (let j = 0; j < pointsPerDash - 1; j++) {
                    indices.push(base + j, base + j + 1);
                }
            }
            lineGeometry.setIndex(indices);

            const lineMaterial = new THREE.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.22,
                depthWrite: false
            });

            const gravityWellLine = new THREE.LineSegments(lineGeometry, lineMaterial);
            gravityWellLine.position.copy(mesh.position);
            scene.add(gravityWellLine);
            state.celestialBodies[id].gravityWellLine = gravityWellLine;

        } else {
            mesh.position.set(centerX || 0, 0, centerZ || 0);
            mesh.userData.logicalX = centerX || 0;
            mesh.userData.logicalZ = centerZ || 0;
        }

        if (rings && ringCount > 0 && ringCount <= 5 && ringDensity > 0 && ringSpacing > 0) {
            console.log(`Creating rings for body ${id} (${locName(name)}): ${ringCount} rings, density ${ringDensity}, spacing ${ringSpacing}, thickness ${ringThickness || 0.1}`);
            let currentRadius = size;
            for (let i = 0; i < ringCount; i++) {
                const multiplier = (i === 0) ? 1 : (i === 1) ? 3 : 5;
                currentRadius += ringSpacing * multiplier;
                const ringGeometry = new THREE.BufferGeometry();
                const ringPositions = [];
                const ringRandomSeeds = [];
                const thickness = ringThickness || 0.1;
                for (let j = 0; j < ringDensity; j++) {
                    const theta = Math.random() * 2 * Math.PI;
                    const radius = currentRadius + (Math.random() - 0.5) * thickness;
                    const x = radius * Math.cos(theta);
                    const z = radius * Math.sin(theta);
                    const y = (Math.random() - 0.5) * 0.1;
                    ringPositions.push(x, y, z);
                    ringRandomSeeds.push(Math.random());
                }
                ringGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ringPositions, 3));
                ringGeometry.setAttribute('randomSeed', new THREE.Float32BufferAttribute(ringRandomSeeds, 1));

                const ringMaterial = new THREE.ShaderMaterial({
                    uniforms: {
                        time: { value: 0.0 },
                        opacity: { value: 0.2 },
                        color: { value: new THREE.Vector3(0.8, 0.8, 0.8) },
                        pointSize: { value: 2.0 },
                        cameraDistance: { value: 5.0 }
                    },
                    vertexShader: particleVertexShader,
                    fragmentShader: particleFragmentShader,
                    transparent: true
                });

                const ringSystem = new THREE.Points(ringGeometry, ringMaterial);
                ringSystem.position.copy(mesh.position);
                scene.add(ringSystem);
                state.celestialBodies[id].ringSystems.push(ringSystem);
                console.log(`Ring ${i + 1} created for body ${id} at radius ${currentRadius}, thickness ${thickness}`);
            }
        }

        scene.add(mesh);
        state.celestialBodies[id].mesh = mesh;
        if (state.celestialBodies[id].starIcon) {
            const icon = state.celestialBodies[id].starIcon;
            icon.layers.set(0);
            scene.add(icon);
        }
        if (state.celestialBodies[id].starHaloFx) {
            addStarHaloToScene(scene, state.celestialBodies[id].starHaloFx);
        }
        state.labels[id] = createLabel(locName(name), size);
    }

    // Важно: включаем слои ПОСЛЕ initCamera. Меши на layer 1/2, иначе камера (только 0) их не рисует.
    if (state.camera) {
        state.camera.layers.enable(0);
        state.camera.layers.enable(1);
        state.camera.layers.enable(2);
    }
}



/** id ближайшей к камере межзвёздной туманности (по XZ). */
function getNearestNebulaIdToCamera() {
    if (!state.camera || !state.celestialBodies) return null;
    let best = null;
    let bestD = Infinity;
    for (const id of Object.keys(state.celestialBodies)) {
        const e = state.celestialBodies[id];
        if (e?.data?.type !== 'interstellarNebula' || !e.mesh) continue;
        const dx = state.camera.position.x - e.mesh.position.x;
        const dz = state.camera.position.z - e.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d < bestD) { bestD = d; best = Number(e.data.id); }
    }
    return best;
}

export function updateBodies(deltaTime, timeSpeed, currentLevelId) {
    updateStarLightIsolation();
    syncAtmosphereCenters();

    // Полярные сияния: только «Планеты и луны» (1ZC); скорость от timeSpeed
    const showAurora = currentLevelId === '1ZC';
    const auroraStep = deltaTime * Math.max(0, timeSpeed) * 0.12;
    for (const key of Object.keys(state.celestialBodies || {})) {
        const entry = state.celestialBodies[key];
        const aurora = entry?.aurora;
        if (!aurora?.material?.uniforms?.time) continue;
        aurora.visible = showAurora && !!entry.data?.hasMagneticField;
        if (aurora.visible) {
            aurora.material.uniforms.time.value += auroraStep;
        }
    }
    let targetOpacity;
    switch (currentLevelId) {
        case '1ZC':
            targetOpacity = 0.55;
            break;
        case '2ZC':
            targetOpacity = 0.95;
            break;
        case '3ZC':
            targetOpacity = 0.8;
            break;
        case '4ZC':
            targetOpacity = 0.05;
            break;
        case '5ZC':
            targetOpacity = 0.0;
            break;
        default:
            targetOpacity = 1.0;
    }

    if (state.targetParticleOpacity !== targetOpacity) {
        state.targetParticleOpacity = targetOpacity;
        state.opacityTransition = {
            startTime: performance.now(),
            startOpacity: state.particleOpacity,
            targetOpacity: targetOpacity,
            duration: 2000
        };
    }

    if (state.opacityTransition) {
        const elapsed = performance.now() - state.opacityTransition.startTime;
        const t = Math.min(elapsed / state.opacityTransition.duration, 1);
        const easeT = t * t * (3 - 2 * t);
        state.particleOpacity = state.opacityTransition.startOpacity + 
            (state.opacityTransition.targetOpacity - state.opacityTransition.startOpacity) * easeT;
        if (t >= 1) {
            state.opacityTransition = null;
        }
    }

    for (let id in state.celestialBodies) {
        const body = state.celestialBodies[id];
        const mesh = body.mesh;
        if (!mesh) continue;

        let isBodyVisible = true;
        let isWellVisible = currentLevelId === '1ZC' || currentLevelId === '2ZC';
        if (currentLevelId === '3ZC' && body.data.type === 'moon') {
            isBodyVisible = false;
        } else if (currentLevelId === '4ZC') {
            const t = body.data.type;
            if (t === 'moon' || t === 'planet') {
                isBodyVisible = false;
            } else if (t === 'star' || t === 'starSystem') {
                // Изоляция: на 4ZC видны только звёзды ближайшей туманности
                const nearestNebId = getNearestNebulaIdToCamera();
                const nebId = body.data.nebulaId != null ? Number(body.data.nebulaId) : null;
                if (nearestNebId != null && nebId != null && nebId !== nearestNebId) {
                    isBodyVisible = false;
                }
            }
        } else if (currentLevelId === '5ZC') {
            // Галактика: скрываем звёзды, системы, планеты, луны
            const t = body.data.type;
            if (t === 'star' || t === 'starSystem' || t === 'planet' || t === 'moon') {
                isBodyVisible = false;
            }
        } else if (currentLevelId === '6ZC') {
            // Вселенная: только галактики (+ якорь вселенной); туманности/звёзды/системы скрыты
            const t = body.data.type;
            if (t === 'star' || t === 'starSystem' || t === 'planet' || t === 'moon' || t === 'interstellarNebula') {
                isBodyVisible = false;
            }
        } else if (currentLevelId === '7ZC') {
            // Мультивселенная: якоря вселенных + мультивселенной; пузыри рисует universe.js
            const t = body.data.type;
            if (t !== 'universe' && t !== 'multiverse') {
                isBodyVisible = false;
            }
        }

        // Космический туман войны (оптика)
        let optVis = 'full';
        try {
            if (isOpticalFogEnabled() && isBodyVisible) {
                optVis = getOpticalBodyState(body, currentLevelId);
                if (optVis === 'hidden') isBodyVisible = false;
                if (body.data.type === 'galaxy' && !a2ReachesBeyondHomeGalaxy() && Number(body.data.id) !== 3000) {
                    isBodyVisible = false;
                    optVis = 'hidden';
                }
            }
        } catch (_) { optVis = 'full'; }
        try { applyOpticalMaterial(body, optVis); } catch (_) {}

        // Туманность / галактика сами управляют visible через opacity / anchor
        if (body.data.type !== 'interstellarNebula' && body.data.type !== 'galaxy' && body.data.type !== 'universe' && body.data.type !== 'multiverse') {
            mesh.visible = isBodyVisible;
        }
        // Гео-разведка: орбиты / колодец / сетка всегда скрыты
        const surveyHide = !!state.geoSurveyBlocking;
        if (body.orbitLine) {
            body.orbitLine.visible = isBodyVisible && !surveyHide;
        }
        if (body.gravityWellLine) {
            body.gravityWellLine.visible = isWellVisible && isBodyVisible && !surveyHide;
        }
        if (body.gravityWellGradient) {
            body.gravityWellGradient.visible = isWellVisible && isBodyVisible && !surveyHide;
        }
        if (body.gravityWellGrid) {
            body.gravityWellGrid.visible = isWellVisible && isBodyVisible && !surveyHide;
        }

        body.ringSystems?.forEach((ringSystem, index) => {
            const isRingVisible = isBodyVisible && currentLevelId !== '4ZC' && currentLevelId !== '5ZC' && currentLevelId !== '6ZC';
            ringSystem.visible = isRingVisible;
            if (isRingVisible) {
                ringSystem.position.copy(mesh.position);
                ringSystem.material.uniforms.time.value = performance.now() * 0.001;
                ringSystem.material.uniforms.cameraDistance.value = state.camera.position.distanceTo(mesh.position);
                console.log(`Ring ${index + 1} for body ${id} is visible at position:`, ringSystem.position);
            } else {
                console.log(`Ring ${index + 1} for body ${id} is hidden (isBodyVisible: ${isBodyVisible}, currentLevelId: ${currentLevelId})`);
            }
        });

        if (body.data.type !== 'interstellarNebula' && body.data.type !== 'starSystem') {
            const dayInSeconds = (body.data.day || 1) * 86400;
            const rotationSpeed = (2 * Math.PI) / dayInSeconds;
            if (mesh.rotation) mesh.rotation.y += rotationSpeed * deltaTime * timeSpeed;
        }

        // Орбита только у планет/лун (НЕ starSystem/nebula — иначе якоря систем уезжают)
        if (body.data.parent != null
            && (body.data.type === 'planet' || body.data.type === 'moon')) {
            const parentEntry = state.celestialBodies[body.data.parent]
                || state.celestialBodies[String(body.data.parent)];
            const parentMesh = parentEntry?.mesh;
            if (!parentMesh) {
                // нет родителя — не трогаем позицию
            } else {
            const yearInSeconds = (body.data.year || 1) * 31536000;
            const orbitSpeed = (2 * Math.PI) / yearInSeconds;
            const angle = mesh.userData.orbitAngle + orbitSpeed * deltaTime * timeSpeed;
            mesh.userData.orbitAngle = angle;
            mesh.position.x = parentMesh.position.x + body.data.distance * Math.cos(angle);
            mesh.position.z = parentMesh.position.z + body.data.distance * Math.sin(angle);

            if (body.orbitLine) {
                body.orbitLine.position.copy(parentMesh.position);
            }
            if (body.gravityWellLine) {
                body.gravityWellLine.position.copy(mesh.position);
            }
            if (body.gravityWellGradient) {
                body.gravityWellGradient.position.copy(mesh.position);
            }
            if (body.gravityWellGrid) {
                body.gravityWellGrid.position.copy(mesh.position);
                body.gravityWellGrid.position.y += 0.002;
            }
            } // end parentMesh ok
        }

        let labelVisible = isBodyVisible && !state.geoSurveyBlocking;
        if (currentLevelId === '4ZC' && !state.geoSurveyBlocking
            && (body.data.type === 'star' || body.data.type === 'starSystem')) {
            const nearestNebId = getNearestNebulaIdToCamera();
            const nebId = body.data.nebulaId != null ? Number(body.data.nebulaId) : null;
            const sameNeb = nearestNebId == null || nebId == null || nebId === Number(nearestNebId);
            if (sameNeb) labelVisible = true;
        }
        updateLabel(state.labels[id], mesh, labelVisible, currentLevelId);

        if (body.data.type === 'star' && mesh.material?.uniforms) {
            mesh.material.uniforms.time.value = performance.now() * 0.001 * timeSpeed;
            const cam = state.camera;
            let dist = 5;
            if (cam) dist = cam.position.distanceTo(mesh.position);
            if (!Number.isFinite(dist)) dist = 5;
            mesh.material.uniforms.cameraDistance.value = dist;

            const isInterstellar = currentLevelId === '4ZC';
            if (mesh.material.uniforms.interstellarMode) {
                mesh.material.uniforms.interstellarMode.value = 0.0;
            }
            if (isInterstellar && cam) {
                const vFOV = (cam.fov * Math.PI) / 180;
                const worldPerPx = (2 * Math.max(dist, 1) * Math.tan(vFOV / 2)) / Math.max(window.innerHeight, 1);
                const coreWorld = 10 * worldPerPx;
                const iconWorld = 86 * worldPerPx;
                const baseDiam = Math.max((body.data.size || 2) * 2, 0.01);
                let s = coreWorld / baseDiam;
                if (!Number.isFinite(s) || s <= 0) s = 1;
                mesh.scale.setScalar(s);

                const icon = body.starIcon;
                if (icon) {
                    icon.position.copy(mesh.position);
                    icon.quaternion.copy(cam.quaternion);
                    icon.scale.setScalar(Math.max(iconWorld, 0.001));
                    if (icon.material?.uniforms?.opacity) {
                        icon.material.uniforms.opacity.value = 1.0;
                    }
                }
            } else {
                mesh.scale.set(1, 1, 1);
            }
            mesh.layers.enable(0);
            // На 5ZC звёзды скрыты (isBodyVisible=false); иначе true
            if (currentLevelId !== '5ZC') mesh.visible = true;
            if (body.starIcon) {
                body.starIcon.visible = isInterstellar && !!mesh.visible && currentLevelId !== '5ZC';
            }
            if (body.starHaloFx) {
                updateStarHaloFx(body, currentLevelId);
            }
        }

        // Медленное вращение межзвёздных туманностей вокруг центра галактики (без отрисовки орбит)
        if (body.data.type === 'interstellarNebula' && mesh) {
            const orbR = Number(body.data.orbitalRadius) || 0;
            const yearDays = Number(body.data.year) || 0;
            if (orbR > 1 && yearDays > 0 && timeSpeed !== 0) {
                // year в земных сутках; один оборот = year суток игрового времени
                const angSpeed = (Math.PI * 2) / yearDays; // рад / игровые сутки
                // deltaTime — секунды реального времени кадра; timeSpeed — множитель игровых суток/сек приблизительно
                // Используем тот же масштаб, что и у планет: deltaTime * timeSpeed как доля суток
                const dtDays = deltaTime * Math.max(0, timeSpeed) * (1 / 86400);
                // Угол/радиус из centerX/Z — иначе туманность «прыгает» с JSON-позиции
                if (!Number.isFinite(mesh.userData.galaxyOrbitAngle)) {
                    const cx0 = Number(body.data.centerX) || 0;
                    const cz0 = Number(body.data.centerZ) || 0;
                    const r0 = Math.hypot(cx0, cz0);
                    mesh.userData.galaxyOrbitAngle = (r0 > 1e-3)
                        ? Math.atan2(cz0, cx0)
                        : (Number(body.data.orbitalStartAngle) || 0);
                    mesh.userData.galaxyOrbitR = (r0 > 1e-3) ? r0 : orbR;
                }
                mesh.userData.galaxyOrbitAngle += angSpeed * dtDays;
                const a = mesh.userData.galaxyOrbitAngle;
                const rUse = Number.isFinite(mesh.userData.galaxyOrbitR) ? mesh.userData.galaxyOrbitR : orbR;
                const nx = Math.cos(a) * rUse;
                const nz = Math.sin(a) * rUse;
                // Только logical — mesh.position выставит applyFloatingOrigin
                // (иначе планеты/атмосфера на кадр уезжают на ±13000 и дрожит шейдер)
                mesh.userData.logicalX = nx;
                mesh.userData.logicalZ = nz;
                // Звёзды/системы этой туманности — тоже только logical
                const nebId = Number(body.data.id);
                const baseCx = Number(body.data.centerX) || 0;
                const baseCz = Number(body.data.centerZ) || 0;
                const baseR = Math.hypot(baseCx, baseCz);
                for (const sid of Object.keys(state.celestialBodies || {})) {
                    const e = state.celestialBodies[sid];
                    if (!e?.mesh || !e.data) continue;
                    if (Number(e.data.nebulaId) !== nebId) continue;
                    if (e.data.type !== 'star' && e.data.type !== 'starSystem') continue;
                    const ox = Number(e.data.centerX) || 0;
                    const oz = Number(e.data.centerZ) || 0;
                    // relative (малые centerX внутри. 700) или absolute (как у Солнца = center туманности)
                    const oR = Math.hypot(ox, oz);
                    let offX, offZ;
                    if (baseR > 100 && oR < baseR * 0.2) {
                        offX = ox; offZ = oz; // relative to nebula
                    } else {
                        offX = ox - baseCx; offZ = oz - baseCz; // absolute
                    }
                    e.mesh.userData.logicalX = nx + offX;
                    e.mesh.userData.logicalZ = nz + offZ;
                }
            }
            updateNebulaVisual(body, currentLevelId);
        }
    } // end for celestialBodies

    try { applyFloatingOrigin(currentLevelId); } catch (e) { console.warn('[fo]', e); }

    // После FO: планеты/луны строго от display-позиции родителя (без large world coords)
    {
        const bodies = state.celestialBodies || {};
        for (const id of Object.keys(bodies)) {
            const body = bodies[id];
            if (!body?.mesh || !body.data) continue;
            if (body.data.type !== 'planet' && body.data.type !== 'moon') continue;
            if (body.data.parent == null) continue;
            const parentEntry = bodies[body.data.parent] || bodies[String(body.data.parent)];
            const parentMesh = parentEntry?.mesh;
            if (!parentMesh) continue;
            const angle = body.mesh.userData.orbitAngle;
            if (!Number.isFinite(angle)) continue;
            const dist = Number(body.data.distance) || 0;
            body.mesh.position.x = parentMesh.position.x + dist * Math.cos(angle);
            body.mesh.position.z = parentMesh.position.z + dist * Math.sin(angle);
            if (body.orbitLine) body.orbitLine.position.copy(parentMesh.position);
            if (body.gravityWellLine) body.gravityWellLine.position.copy(body.mesh.position);
            if (body.gravityWellGradient) body.gravityWellGradient.position.copy(body.mesh.position);
            if (body.gravityWellGrid) body.gravityWellGrid.position.copy(body.mesh.position);
        }
    }

    for (const starId in state.particleSystems) {
        const { system } = state.particleSystems[starId];
        const starEntry = state.celestialBodies[starId];
        // На 5ZC пыль звёздных систем не рисуем
        if (currentLevelId === '5ZC' || currentLevelId === '6ZC') {
            system.visible = false;
            continue;
        }
        // На 4ZC — пыль только «своей» туманности
        if (currentLevelId === '4ZC') {
            const nearestNebId = getNearestNebulaIdToCamera();
            const nebId = starEntry?.data?.nebulaId != null ? Number(starEntry.data.nebulaId) : null;
            if (nearestNebId != null && nebId != null && nebId !== nearestNebId) {
                system.visible = false;
                continue;
            }
        }
        system.visible = true;
        // Якорь на звезде + лёгкий параллакс ОТНОСИТЕЛЬНО звезды (не camera*0.02 + worldX —
        // иначе при offset 22000 пыль уезжает на сотни единиц от системы)
        const mx = starEntry?.mesh?.position?.x;
        const mz = starEntry?.mesh?.position?.z;
        const bx = Number.isFinite(mx) ? mx : (starEntry?.data?.centerX || 0);
        const bz = Number.isFinite(mz) ? mz : (starEntry?.data?.centerZ || 0);
        const cam = state.camera.position;
        system.position.x = bx + (cam.x - bx) * 0.02;
        system.position.z = bz + (cam.z - bz) * 0.02;
        system.material.uniforms.time.value = performance.now() * 0.001;
        system.material.uniforms.opacity.value = state.particleOpacity;
        system.material.uniforms.cameraDistance.value = state.camera.position.distanceTo(system.position);
    }
    try {
        updateNebulaParticleSystems(currentLevelId);
    } catch (e) {
        console.warn('[nebula] updateNebulaParticleSystems', e);
    }
    try {
        updateGalaxyVisuals(currentLevelId);
    try { updateUniverseVisuals(currentLevelId, state.camera?.position?.y); } catch (e) { console.warn('[universe]', e); }
    try { updateMultiverseVisuals(currentLevelId, state.camera?.position?.y); } catch (e) { console.warn('[multiverse]', e); }
    } catch (e) {
        console.warn('[galaxy] updateGalaxyVisuals', e);
    }

}