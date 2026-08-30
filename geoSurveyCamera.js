/**
 * Камера режима подробного просмотра небесного тела (Гео-разведка).
 * Обходит обычную высоту камеры; WASD: AD — разворот, WS — вперёд/назад по сфере.
 */
import { camera, keys, targetCameraY, setTargetCameraY, setCurrentLocation } from './camera.js';
import { setFloatingOriginFrozen } from './bodies.js';
import { state } from './state.js';

let active = false;
let targetBody = null;
let prevState = null;
let transition = null;

let yaw = 0;
let pitch = 0.45;
let heading = 0;

const MOVE_SPEED = 0.65;
const TURN_SPEED = 1.25;
const TRANSITION_MS = 1100;

export function isGeoSurveyActive() {
    return active || !!(transition && transition.entering);
}

export function isGeoSurveyBlocking() {
    // блокировать обычную камеру пока активны режим или любой переход
    return active || !!transition;
}

export function getGeoSurveyBody() {
    return targetBody;
}

export function getGeoSurveyAngles() {
    return { yaw, pitch, heading };
}

let _stillTimer = 0;
let _lastYaw = 0;
let _lastPitch = 0;

/** Камера неподвижна (нет WASD и углы стабильны) */
export function isGeoSurveyCameraStill() {
    return _stillTimer > 0.18;
}


function bodyRadius(body) {
    return Math.max(0.2, Number(body?.data?.size) || 1);
}

function cameraDistance(body) {
    const r = bodyRadius(body);
    return r * 1.42 + 0.15;
}

/** Позиция камеры в ЛОКАЛЬНОЙ СК тела → мир (якорь к поверхности при вращении) */
function spherePos(body, y, p) {
    const mesh = body.mesh;
    const c = mesh.position;
    const d = cameraDistance(body);
    const cp = Math.cos(p);
    const sp = Math.sin(p);
    const local = new THREE.Vector3(
        d * cp * Math.sin(y),
        d * sp,
        d * cp * Math.cos(y)
    );
    local.applyQuaternion(mesh.quaternion);
    return {
        x: c.x + local.x,
        y: c.y + local.y,
        z: c.z + local.z
    };
}

function lookTarget(body, y, p) {
    const mesh = body.mesh;
    const c = mesh.position;
    const r = bodyRadius(body);
    const local = new THREE.Vector3(
        r * 0.2 * Math.sin(y),
        r * 0.08,
        r * 0.2 * Math.cos(y)
    );
    local.applyQuaternion(mesh.quaternion);
    return {
        x: c.x + local.x,
        y: c.y + local.y,
        z: c.z + local.z
    };
}

function cameraUpForBody(body) {
    const up = new THREE.Vector3(0, 1, 0);
    try { up.applyQuaternion(body.mesh.quaternion); } catch (_) {}
    return up;
}

export function setMapDecorationsVisible(visible) {
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const b = bodies[id];
        if (!b) continue;
        if (b.orbitLine) b.orbitLine.visible = visible;
        if (b.gravityWellLine) b.gravityWellLine.visible = visible;
        if (b.gravityWellGrid) b.gravityWellGrid.visible = visible;
        if (b.gravityWellGradient) b.gravityWellGradient.visible = visible;
    }
    // табло имён небесных тел
    const labels = state.labels || {};
    for (const id of Object.keys(labels)) {
        const lab = labels[id];
        if (!lab) continue;
        if (!visible) {
            lab.style.display = 'none';
            lab.dataset.geoSurveyHidden = '1';
        } else if (lab.dataset.geoSurveyHidden === '1') {
            delete lab.dataset.geoSurveyHidden;
            // видимость вернёт updateBodies / updateLabel
        }
    }
    const markers = document.getElementById('unit-map-markers');
    if (markers) markers.style.display = visible ? '' : 'none';
    const overlay = document.getElementById('unit-flight-overlay');
    if (overlay) overlay.style.display = visible ? '' : 'none';
    const zones = document.getElementById('unit-flight-zones');
    if (zones) zones.style.display = visible ? '' : 'none';

    // пыль / партиклы других систем
    try {
        const ps = state.particleSystems || {};
        for (const key of Object.keys(ps)) {
            const entry = ps[key];
            if (!entry) continue;
            if (entry.system) entry.system.visible = visible;
            if (entry.visible != null) entry.visible = visible;
            if (Array.isArray(entry)) entry.forEach(o => { if (o?.visible != null) o.visible = visible; });
        }
        if (state.nebulaParticleSystems) {
            const nps = state.nebulaParticleSystems;
            const list = Array.isArray(nps) ? nps : Object.values(nps || {});
            list.forEach(obj => {
                if (!obj) return;
                if (obj.visible != null) obj.visible = visible;
                if (obj.system) obj.system.visible = visible;
                if (obj.points) obj.points.visible = visible;
                if (obj.mesh) obj.mesh.visible = visible;
            });
        }
        if (!visible) {
            state._geoSurveyPrevParticleOpacity = state.particleOpacity;
            state.particleOpacity = 0;
            state.targetParticleOpacity = 0;
        } else if (state._geoSurveyPrevParticleOpacity != null) {
            state.particleOpacity = state._geoSurveyPrevParticleOpacity;
            state.targetParticleOpacity = state._geoSurveyPrevParticleOpacity;
            delete state._geoSurveyPrevParticleOpacity;
        }
    } catch (_) {}
}

function capturePrev() {
    if (!camera) return null;
    // Высота: targetCameraY приоритетнее (position.y в survey уже «прилип» к сфере)
    let ty = Number(targetCameraY);
    if (!Number.isFinite(ty) || ty < 3) ty = Math.max(3, Number(camera.position.y) || 3);
    return {
        x: camera.position.x,
        y: ty,
        z: camera.position.z,
        targetY: ty,
        upX: camera.up.x,
        upY: camera.up.y,
        upZ: camera.up.z
    };
}

export function enterGeoSurvey(body) {
    if (!camera || !body?.mesh) return false;
    // если уже на этом теле — только убедиться, что декорации скрыты
    if (active && targetBody === body && !transition) {
        setMapDecorationsVisible(false);
        return true;
    }

    // Смена тела внутри гео-разведки (Земля→Марс): снять dim с прошлого, не ломая FO
    if (active && targetBody && targetBody !== body) {
        try { dimBodyMaterials(targetBody, false); } catch (_) {}
        prevState = prevState || capturePrev();
        targetBody = body;
        try { setCurrentLocation(body); } catch (_) {}
        setMapDecorationsVisible(false);
        try { dimBodyMaterials(body, true); } catch (_) {}
        // пересчитать дневную сторону + tight depth (ниже общий код)
    } else {
        prevState = capturePrev();
        targetBody = body;
        active = true;
        state.geoSurveyBlocking = true;
        try { setCurrentLocation(body); } catch (_) {}
        setMapDecorationsVisible(false);
        try { dimBodyMaterials(body, true); } catch (_) {}
    }
    active = true;
    state.geoSurveyBlocking = true;
    try { setFloatingOriginFrozen(true); } catch (_) {}

    const c = body.mesh.position;
    // Дневная сторона: камера со стороны звезды-источника света
    let sunPos = null;
    try {
        let parentId = body.data?.parent;
        let guard = 0;
        while (parentId != null && guard++ < 6) {
            const p = state.celestialBodies[parentId] || state.celestialBodies[String(parentId)];
            if (!p) break;
            if (p.data?.type === 'star') { sunPos = p.mesh?.position; break; }
            parentId = p.data?.parent;
        }
        if (!sunPos) {
            // ближайшая звезда
            let best = null, bestD = Infinity;
            for (const id of Object.keys(state.celestialBodies || {})) {
                const b = state.celestialBodies[id];
                if (b?.data?.type !== 'star' || !b.mesh) continue;
                const d = b.mesh.position.distanceTo(c);
                if (d < bestD) { bestD = d; best = b.mesh.position; }
            }
            sunPos = best;
        }
    } catch (_) {}
    if (sunPos) {
        // направление от тела к солнцу → камера на этом луче (смотрим на дневную сторону)
        const sx = sunPos.x - c.x;
        const sz = sunPos.z - c.z;
        yaw = Math.atan2(sx, sz);
        if (!Number.isFinite(yaw)) yaw = 0;
    } else {
        const dx = camera.position.x - c.x;
        const dz = camera.position.z - c.z;
        yaw = Math.atan2(dx, dz);
        if (!Number.isFinite(yaw)) yaw = 0;
    }
    pitch = 0.38;
    heading = yaw;

    const to = spherePos(body, yaw, pitch);
    transition = {
        start: performance.now(),
        duration: TRANSITION_MS,
        fromPos: camera.position.clone(),
        toPos: new THREE.Vector3(to.x, to.y, to.z),
        entering: true
    };

    // Tight depth range: far=30000 при near=0.02 убивал атмосферу/огни (дрожание)
    const r = Math.max(0.2, Number(body?.data?.size) || 1);
    camera.near = Math.max(0.005, r * 0.008);
    camera.far = Math.max(40, r * 35);
    camera.updateProjectionMatrix();
    try { setFloatingOriginFrozen(true); } catch (_) {}
    state.geoSurveyBlocking = true;
    console.log('Geo-survey camera enter', body.data?.id, 'near/far', camera.near, camera.far);
    return true;
}

export function exitGeoSurvey() {
    if (!active && !(transition && transition.entering)) {
        if (transition && !transition.entering) return;
        if (!active) return;
    }
    const prev = prevState;
    const leaving = targetBody;
    active = false;
    state.geoSurveyBlocking = true; // пока идёт выходной transition — декорации ещё скрыты
    targetBody = null;
    try { if (leaving) dimBodyMaterials(leaving, false); } catch (_) {}
    // setMapDecorationsVisible(true) — только после завершения transition

    if (!camera) return;
    // Восстановить высоту ДО survey (не оставлять y≈1 с артефактами сетки/тел)
    let restoreY = 3;
    if (prev && Number.isFinite(prev.targetY) && prev.targetY >= 3) restoreY = prev.targetY;
    else if (prev && Number.isFinite(prev.y) && prev.y >= 3) restoreY = prev.y;
    try { setTargetCameraY(restoreY); } catch (_) {}

    const toX = prev && Number.isFinite(prev.x) ? prev.x : camera.position.x;
    const toZ = prev && Number.isFinite(prev.z) ? prev.z : camera.position.z;
    // Если prev позиция была у поверхности — ставим над телом на restoreY
    const to = new THREE.Vector3(toX, restoreY, toZ);
    if (leaving?.mesh) {
        to.x = leaving.mesh.position.x;
        to.z = leaving.mesh.position.z;
        to.y = restoreY;
    }

    transition = {
        start: performance.now(),
        duration: TRANSITION_MS,
        fromPos: camera.position.clone(),
        toPos: to,
        entering: false,
        restoreUp: prev,
        restoreY
    };
    // depth range под восстановленную высоту
    if (restoreY < 8) { camera.near = 0.02; camera.far = 800; }
    else if (restoreY < 15) { camera.near = 0.05; camera.far = 2500; }
    else if (restoreY < 90) { camera.near = 0.2; camera.far = 12000; }
    else { camera.near = 1; camera.far = 40000; }
    camera.updateProjectionMatrix();
    console.log('Geo-survey camera exit → y', restoreY);
}

export function updateGeoSurveyCamera(deltaTime) {
    if (!camera) return false;

    if (transition) {
        const t = Math.min(1, (performance.now() - transition.start) / transition.duration);
        const ease = t * t * (3 - 2 * t);
        camera.position.lerpVectors(transition.fromPos, transition.toPos, ease);
        if (transition.entering) {
            setMapDecorationsVisible(false);
            if (targetBody?.mesh) {
                const lt = lookTarget(targetBody, yaw, pitch);
                const up = cameraUpForBody(targetBody);
                camera.up.copy(up);
                camera.lookAt(lt.x, lt.y, lt.z);
            }
        } else if (!transition.entering) {
            camera.up.set(0, 0, -1);
            camera.lookAt(camera.position.x, 0, camera.position.z);
            if (transition.restoreUp && t >= 1) {
                const u = transition.restoreUp;
                camera.up.set(u.upX ?? 0, u.upY ?? 0, u.upZ ?? -1);
            }
        }
        if (t >= 1) {
            const wasEntering = transition.entering;
            const ry = transition.restoreY;
            transition = null;
            if (!wasEntering) {
                setMapDecorationsVisible(true);
                state.geoSurveyBlocking = false;
                try { setFloatingOriginFrozen(false); } catch (_) {}
                if (Number.isFinite(ry) && ry >= 3) {
                    camera.position.y = ry;
                    try { setTargetCameraY(ry); } catch (_) {}
                }
                camera.up.set(0, 0, -1);
                camera.lookAt(camera.position.x, 0, camera.position.z);
            }
        }
        return true;
    }

    if (!active || !targetBody?.mesh) return false;

    const dt = Math.max(0, Number(deltaTime) || 0);

    // A/D — разворот вокруг тела (влево/вправо по горизонту)
    if (keys.a) yaw -= TURN_SPEED * dt;
    if (keys.d) yaw += TURN_SPEED * dt;
    heading = yaw;

    // W/S — вдоль меридиана (сверху вниз / снизу вверх), не по азимуту
    if (keys.w) pitch += MOVE_SPEED * dt;
    if (keys.s) pitch -= MOVE_SPEED * dt;

    const moving = !!(keys.w || keys.s || keys.a || keys.d);
    const angDelta = Math.abs(yaw - _lastYaw) + Math.abs(pitch - _lastPitch);
    if (moving || angDelta > 0.0008) _stillTimer = 0;
    else _stillTimer += dt;
    _lastYaw = yaw;
    _lastPitch = pitch;

    // доступ к обоим полюсам (небольшой отступ, чтобы не «провалиться» взглядом)
    const maxP = Math.PI / 2 - 0.06;
    const minP = -Math.PI / 2 + 0.06;
    if (pitch > maxP) pitch = maxP;
    if (pitch < minP) pitch = minP;

    // нормализуем yaw
    if (yaw > Math.PI * 2 || yaw < -Math.PI * 2) yaw = yaw % (Math.PI * 2);

    const pos = spherePos(targetBody, yaw, pitch);
    camera.position.set(pos.x, pos.y, pos.z);
    camera.up.copy(cameraUpForBody(targetBody));
    const lt = lookTarget(targetBody, yaw, pitch);
    camera.lookAt(lt.x, lt.y, lt.z);
    // удерживаем tight near/far (обычный updateCamera не вызывается)
    const r = Math.max(0.2, Number(targetBody?.data?.size) || 1);
    const wantNear = Math.max(0.005, r * 0.008);
    const wantFar = Math.max(40, r * 35);
    if (Math.abs(camera.near - wantNear) > 1e-6 || Math.abs(camera.far - wantFar) > 1e-3) {
        camera.near = wantNear;
        camera.far = wantFar;
        camera.updateProjectionMatrix();
    }

    // удерживаем скрытие декораций (updateBodies иначе вернёт орбиты)
    setMapDecorationsVisible(false);

    return true;
}


const _matBackup = new WeakMap();

function collectMeshes(root) {
    const list = [];
    if (!root) return list;
    root.traverse?.(obj => {
        if (obj.isMesh && obj.material) list.push(obj);
    });
    if (!list.length && root.isMesh) list.push(root);
    return list;
}

export function dimBodyMaterials(body, dim) {
    const mesh = body?.mesh;
    if (!mesh) return;
    const meshes = collectMeshes(mesh);
    // атмосфера / облака / огни — тоже гасим
    if (body.atmosphere) meshes.push(body.atmosphere);
    if (body.clouds) meshes.push(body.clouds);
    if (body.cityLights) meshes.push(body.cityLights);

    const seen = new Set();
    for (const obj of meshes) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
            if (!m || seen.has(m)) continue;
            seen.add(m);
            if (dim) {
                if (!_matBackup.has(m)) {
                    _matBackup.set(m, {
                        color: m.color ? m.color.clone() : null,
                        emissive: m.emissive ? m.emissive.clone() : null,
                        specular: m.specular ? m.specular.clone() : null,
                        shininess: m.shininess,
                        opacity: m.opacity
                    });
                }
                if (m.color) m.color.multiplyScalar(0.48);
                if (m.emissive) m.emissive.multiplyScalar(0.28);
                if (m.specular) m.specular.multiplyScalar(0.18);
                if (m.shininess != null) m.shininess = Math.max(2, (m.shininess || 30) * 0.22);
                if (m.reflectivity != null) m.reflectivity *= 0.3;
                // чуть приглушаем прозрачные слои (атмосфера)
                if (m.transparent && m.opacity != null) {
                    m.opacity = Math.min(m.opacity, (m.opacity || 1) * 0.65);
                }
                m.needsUpdate = true;
            } else {
                const b = _matBackup.get(m);
                if (!b) continue;
                if (m.color && b.color) m.color.copy(b.color);
                if (m.emissive && b.emissive) m.emissive.copy(b.emissive);
                if (m.specular && b.specular) m.specular.copy(b.specular);
                if (b.shininess != null) m.shininess = b.shininess;
                if (b.opacity != null) m.opacity = b.opacity;
                m.needsUpdate = true;
                _matBackup.delete(m);
            }
        }
    }
}
