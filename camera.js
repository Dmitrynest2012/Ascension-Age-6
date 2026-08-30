import { heightLevels, CAMERA_Y_MAX } from './utils.js';
import { recenterFloatingOriginToBody } from './bodies.js';
import { state } from './state.js';
import { updateBodyMenu } from './ui.js';
import {
    cancelBodyRenameIfEditing,
    refreshLocationNameDisplay,
    notifyLocationForRename
} from './bodyRename.js';
import { locName } from './settings.js';
import { GALAXY_HEIGHT_MIN } from './galaxy.js';
import { UNIVERSE_HEIGHT_MIN, UNIVERSE_BUBBLE_RADIUS, findNearestGalaxy, isCameraOutsideUniverseBubble, getUniverseBubbleCenterDisplay } from './universe.js';
import { MULTIVERSE_HEIGHT_MIN, findUniverseBody } from './multiverse.js';
import { isMultiverseCameraUnlocked } from './opticalScan.js';


export let camera = null;
export let keys = { w: false, a: false, s: false, d: false, shift: false, space: false };
export let targetCameraY;
export let trackedBody = null;
export let trackedOffset = new THREE.Vector3(0, 0, 0);
export let currentLocation = null;
function syncWindowCurrentLocation() {
    try { window.__currentLocation = currentLocation; } catch (_) {}
}

try { window.__currentLocation = null; } catch (_) {}

/** Сеттеры — из других модулей нельзя писать в import { currentLocation } */
export function setCurrentLocation(body) {
    currentLocation = body || null;
    syncWindowCurrentLocation();
}
export function setTargetCameraY(y) {
    const n = Number(y);
    targetCameraY = Number.isFinite(n) ? n : targetCameraY;
}
export function setTrackedBody(body) {
    trackedBody = body || null;
    if (!body) trackedOffset.set(0, 0, 0);
}


/** Ближайшая межзвёздная туманность под камерой (по XZ). */
function findNearestNebulaUnderCamera(cam) {
    if (!cam || !state.celestialBodies) return null;
    let best = null;
    let bestD = Infinity;
    for (const body of Object.values(state.celestialBodies)) {
        if (body.data?.type !== 'interstellarNebula' || !body.mesh) continue;
        const dx = cam.position.x - body.mesh.position.x;
        const dz = cam.position.z - body.mesh.position.z;
        const d = Math.hypot(dx, dz);
        const size = Number(body.data.size) || 1200;
        // «Под камерой» = в пределах радиуса туманности
        if (d < size * 0.85 && d < bestD) {
            bestD = d;
            best = body;
        }
    }
    if (best) return best;
    // Фоллбек: любая ближайшая (для перелёта)
    for (const body of Object.values(state.celestialBodies)) {
        if (body.data?.type !== 'interstellarNebula' || !body.mesh) continue;
        const dx = cam.position.x - body.mesh.position.x;
        const dz = cam.position.z - body.mesh.position.z;
        const d = Math.hypot(dx, dz);
        if (d < bestD) { bestD = d; best = body; }
    }
    return best;
}

/** Найти объект type=starSystem, к которому относится звезда/тело */
function findStarSystemForBody(body) {
    if (!body?.data) return null;
    if (body.data.type === 'starSystem') return body;
    const sid = body.data.starSystemId;
    if (sid != null && state.celestialBodies[sid]) return state.celestialBodies[sid];
    // звезда: искать starSystem, у которого children содержит star.id
    let starId = body.data.id;
    if (body.data.type === 'planet') starId = body.data.parent;
    else if (body.data.type === 'moon') {
        const planet = state.celestialBodies[body.data.parent];
        starId = planet?.data?.parent;
    }
    for (const id in state.celestialBodies) {
        const b = state.celestialBodies[id];
        if (b.data?.type === 'starSystem') {
            const ch = b.data.children || [];
            if (ch.includes(starId) || ch.includes(Number(starId))) return b;
        }
    }
    return null;
}

/** Камера в «звёздной системе» (3ZC), а не в межзвёздной туманности (4ZC) */
export function isCameraInsideStarSystem(currentLevelId) {
    return currentLevelId === '1ZC' || currentLevelId === '2ZC' || currentLevelId === '3ZC';
}

export let transition = null;

/**
 * Поставить камеру над телом на заданной высоте (Y).
 * bodyId — id из hev.body.json (3 = Святая Русь).
 */

/** near/far по высоте: тонкие оболочки (атмосфера/огни) не дрожат при малом near + огромном far */
function applyCameraDepthRange(y) {
    if (!camera) return;
    // Важно: при близкой камере far не должен быть огромным —
    // иначе depth buffer убивает тонкую атмосферу/city lights (дрожание лимба).
    let near = 0.1;
    let far = 30000;
    if (y < 8) {
        near = 0.02;
        far = 800;
    } else if (y < 15) {
        near = 0.05;
        far = 2500;
    } else if (y < 90) {
        near = 0.2;
        far = 12000;
    } else if (y < 400) {
        near = 1;
        far = 40000;
    } else if (y < 6500) {
        near = 8;
        far = 90000;
    } else if (y < 25000) {
        near = 40;
        far = 200000;
    } else if (y < 160000) {
        // 6ZC Вселенная
        near = 200;
        far = Math.max(700000, y * 10);
    } else {
        // 7ZC Мультивселенная — видим весь хрустальный шар
        near = 500;
        far = Math.max(2000000, y * 12);
    }
    if (camera.near !== near || camera.far !== far) {
        camera.near = near;
        camera.far = far;
        camera.updateProjectionMatrix();
    }
}

export function focusBodyAtHeight(bodyId, heightY = 3) {
    if (!camera || !state.celestialBodies) return false;
    const body = state.celestialBodies[bodyId]
        || state.celestialBodies[String(bodyId)]
        || state.celestialBodies[Number(bodyId)];
    if (!body?.mesh) {
        console.warn('focusBodyAtHeight: body not found', bodyId);
        return false;
    }
    // Для starSystem / nebulа берём centre из mesh; y камеры — высота уровня
    let y = Number(heightY);
    if (!Number.isFinite(y)) y = 3;
    y = Math.max(3, Math.min(CAMERA_Y_MAX, y));

    // FO к цели до чтения display-позиции
    let px = 0, pz = 0;
    try {
        const fo = recenterFloatingOriginToBody(body);
        if (fo) { px = fo.x; pz = fo.z; }
        else {
            px = Number(body.mesh.position.x) || 0;
            pz = Number(body.mesh.position.z) || 0;
        }
    } catch (_) {
        px = Number(body.mesh.position.x) || 0;
        pz = Number(body.mesh.position.z) || 0;
    }

    applyCameraDepthRange(y);
    camera.layers.enable(0);
    camera.layers.enable(1);
    camera.layers.enable(2);

    camera.position.set(px, y, pz);
    targetCameraY = y;
    camera.up.set(0, 0, -1);
    camera.lookAt(px, 0, pz);

    currentLocation = body;
    syncWindowCurrentLocation();
    // starSystem / nebula: не трекаем (size≈0 → wellRadius≈0 ломает камеру)
    const t = body.data?.type;
    if (t === 'starSystem' || t === 'interstellarNebula' || t === 'galaxy') {
        trackedBody = null;
        trackedOffset.set(0, 0, 0);
    } else {
        trackedBody = body;
        trackedOffset.set(0, 0, 0);
    }
    try { applyLocationToUI(body); } catch (_) {}
    console.log('Camera focused on body', bodyId, 'type', t, 'at height', y, 'pos', px, pz);
    return true;
}

export function initCamera(scene) {
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 30000);
    // Временная позиция до загрузки тел; после loadBodies вызывается focusBodyAtHeight(3, 3)
    camera.position.set(0, 3, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    targetCameraY = camera.position.y;
    state.camera = camera;

    function isTextInputTarget(el) {
        if (!el) return false;
        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        // блокнот / любые поля с data-text-input
        if (el.closest?.('#notepad-textarea, #location-name-input, [data-text-input], textarea, input')) return true;
        return false;
    }

    /** Физическая клавиша WASD: layout-независимый e.code + RU/Mac fallbacks */
    function mapWasdKey(e) {
        // e.code стабилен на Win/Mac при любой раскладке
        switch (e.code) {
            case 'KeyW': return 'w';
            case 'KeyA': return 'a';
            case 'KeyS': return 's';
            case 'KeyD': return 'd';
            default: break;
        }
        const k = String(e.key || '').toLowerCase();
        if (k === 'w' || k === 'a' || k === 's' || k === 'd') return k;
        // Русская раскладка (символ на тех же физических клавишах)
        if (k === 'ц') return 'w';
        if (k === 'ф') return 'a';
        if (k === 'ы') return 's';
        if (k === 'в') return 'd';
        return null;
    }

    window.addEventListener('keydown', e => {
        // не перехватывать клавиши при наборе текста (блокнот, инпуты)
        if (isTextInputTarget(e.target)) return;
        const move = mapWasdKey(e);
        if (move) {
            keys[move] = true;
            return;
        }
        const key = String(e.key || '').toLowerCase();
        if (e.code === 'Space' || key === ' ') {
            keys.space = true;
            e.preventDefault();
        } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift') {
            keys.shift = true;
        }
    });
    window.addEventListener('keyup', e => {
        if (isTextInputTarget(e.target)) return;
        const move = mapWasdKey(e);
        if (move) {
            keys[move] = false;
            return;
        }
        const key = String(e.key || '').toLowerCase();
        if (e.code === 'Space' || key === ' ') {
            keys.space = false;
        } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift') {
            keys.shift = false;
        }
    });

    window.addEventListener('wheel', e => {
        if (state.geoSurveyBlocking) {
            e.preventDefault();
            return;
        }
        // Попап ресурсной полоски / явный UI
        if (e.target?.closest?.('#resource-popup') || e.target?.closest?.('[data-ui="true"]')) {
            // если элемент (или предок) прокручиваемый — не трогаем камеру
            let el = e.target;
            while (el && el !== document.body) {
                const style = window.getComputedStyle(el);
                const oy = style.overflowY;
                const canScrollY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay')
                    && el.scrollHeight > el.clientHeight + 1;
                if (canScrollY || el.id === 'resource-popup') {
                    return;
                }
                if (el.hasAttribute?.('data-ui')) break;
                el = el.parentElement;
            }
        }
        // Не зумим камеру, если колесо над UI (модалка здания, меню, попапы и т.д.)
        let target = e.target;
        let isUIElement = target?.hasAttribute?.('data-ui');
        while (target && !isUIElement) {
            target = target.parentElement;
            if (target) {
                isUIElement = target.hasAttribute('data-ui');
            }
        }
        if (isUIElement) {
            // Если курсор над прокручиваемой областью UI — не трогаем событие,
            // чтобы работал native scroll (схемы, попапы и т.д.)
            let el = e.target;
            while (el && el !== document.body && el !== document.documentElement) {
                const style = window.getComputedStyle(el);
                const oy = style.overflowY;
                const canScrollY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay')
                    && el.scrollHeight > el.clientHeight + 1;
                if (canScrollY) {
                    // Разрешаем прокрутку контейнера; камеру не двигаем
                    return;
                }
                el = el.parentElement;
            }
            // UI без прокрутки — только блокируем зум карты
            e.preventDefault();
            return;
        }

        const height = camera.position.y;
        let zoomInSpeed = 0.02;
        let zoomOutSpeed = 0.02;
        for (let id in heightLevels) {
            if (height >= heightLevels[id].min && height <= heightLevels[id].max) {
                zoomInSpeed = heightLevels[id].zoomInSpeed;
                zoomOutSpeed = heightLevels[id].zoomOutSpeed;
                break;
            }
        }
        const zoomSpeed = e.deltaY < 0 ? zoomInSpeed : zoomOutSpeed;
        targetCameraY += e.deltaY * zoomSpeed;
        if (!isMultiverseCameraUnlocked() && targetCameraY > UNIVERSE_HEIGHT_MIN - 1) {
            targetCameraY = Math.min(targetCameraY, UNIVERSE_HEIGHT_MIN - 8);
        }
        // С 6ZC нельзя опуститься в 5ZC без галактики в кадре
        if (height >= UNIVERSE_HEIGHT_MIN && targetCameraY < UNIVERSE_HEIGHT_MIN) {
            const ng = findNearestGalaxy(camera);
            const gSize = Number(ng?.body?.data?.size) || 60000;
            if (ng?.body?.mesh && ng.dist < gSize * 1.8) {
                try { recenterFloatingOriginToBody(ng.body); } catch (_) {}
                const px = ng.body.mesh.position.x, pz = ng.body.mesh.position.z;
                // Любая галактика (Млечный путь и Андромеда) — спуск на уровень «Галактика»
                transition = {
                    startTime: performance.now(),
                    duration: 2600,
                    startPosition: camera.position.clone(),
                    targetPosition: new THREE.Vector3(px, 14000, pz),
                    startY: camera.position.y,
                    targetY: 14000
                };
                trackedBody = null;
                trackedOffset.set(0, 0, 0);
                currentLocation = ng.body;
                syncWindowCurrentLocation();
                applyLocationToUI(ng.body);
                targetCameraY = camera.position.y;
            } else {
                targetCameraY = Math.max(UNIVERSE_HEIGHT_MIN, targetCameraY);
            }
        }
        // С 5ZC нельзя опуститься в 4ZC, если под камерой нет туманности
        else if (height >= GALAXY_HEIGHT_MIN && targetCameraY < GALAXY_HEIGHT_MIN) {
            const nearest = findNearestNebulaUnderCamera(camera);
            if (nearest?.mesh) {
                const p = nearest.mesh.position;
                transition = {
                    startTime: performance.now(),
                    duration: 2800,
                    startPosition: camera.position.clone(),
                    targetPosition: new THREE.Vector3(p.x, 1200, p.z),
                    startY: camera.position.y,
                    targetY: 1200
                };
                trackedBody = null;
                trackedOffset.set(0, 0, 0);
                currentLocation = nearest;
                syncWindowCurrentLocation();
                applyLocationToUI(nearest);
                targetCameraY = camera.position.y;
            } else {
                targetCameraY = Math.max(GALAXY_HEIGHT_MIN, targetCameraY);
            }
        }
        if (!isMultiverseCameraUnlocked() && targetCameraY >= UNIVERSE_HEIGHT_MIN) {
            targetCameraY = UNIVERSE_HEIGHT_MIN - 8;
        }
        targetCameraY = Math.max(3, Math.min(CAMERA_Y_MAX, targetCameraY));
    }, { passive: false });

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    window.addEventListener('dblclick', e => {
        let target = e.target;
        let isUIElement = target.hasAttribute('data-ui');
        while (target && !isUIElement) {
            target = target.parentElement;
            if (target) {
                isUIElement = target.hasAttribute('data-ui');
            }
        }
        if (isUIElement) {
            return;
        }

        const height = camera.position.y;
        let currentLevelId = '';
        for (let id in heightLevels) {
            if (height >= heightLevels[id].min && height <= heightLevels[id].max) {
                currentLevelId = id;
                break;
            }
        }

        let selectedBodyId = null;
        // Клик по DOM-лейблу пузыря вселенной (заякорен над сферой)
        {
            let el = e.target;
            while (el && el !== document.body) {
                if (el.classList && el.classList.contains('universe-bubble-label')) {
                    const uid = el.dataset.universeId;
                    if (uid && state.celestialBodies[uid]) selectedBodyId = String(uid);
                    else if (uid && state.celestialBodies[Number(uid)]) selectedBodyId = String(uid);
                    break;
                }
                if (el.id === 'universe-level-label') {
                    const ub = findUniverseBody();
                    if (ub) selectedBodyId = String(ub.data.id);
                    break;
                }
                el = el.parentElement;
            }
        }
        // Клик по лейблу (или его дочернему элементу)
        if (!selectedBodyId) {
            let el = e.target;
            while (el && el !== document.body) {
                for (let id in state.labels) {
                    if (state.labels[id] === el && state.labels[id].style.display === 'block') {
                        selectedBodyId = id;
                        break;
                    }
                }
                if (selectedBodyId) break;
                el = el.parentElement;
            }
        }

        if (!selectedBodyId) {
            mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObjects(
                Object.values(state.celestialBodies)
                    .filter(body => body.mesh && body.mesh.visible)
                    .map(body => body.mesh)
            );
            if (intersects.length > 0) {
                const intersectedMesh = intersects[0].object;
                selectedBodyId = Object.keys(state.celestialBodies).find(id => state.celestialBodies[id].mesh === intersectedMesh);
            }
        }

        if (selectedBodyId) {
            const selectedBody = state.celestialBodies[selectedBodyId];
            // 7ZC / снаружи пузыря: двойной клик по Вселенной → внутрь шара
            if ((currentLevelId === '7ZC' || currentLevelId === '6ZC') && selectedBody.data.type === 'universe') {
                try { recenterFloatingOriginToBody(selectedBody); } catch (e) { console.warn('universe FO', e); }
                const c = getUniverseBubbleCenterDisplay(selectedBody.data.id);
                const ty = 45000; // внутри выбранной Вселенной
                transition = {
                    startTime: performance.now(),
                    duration: 2800,
                    startPosition: camera.position.clone(),
                    targetPosition: new THREE.Vector3(c.x, ty, c.z),
                    startY: camera.position.y,
                    targetY: ty
                };
                trackedBody = null;
                trackedOffset.set(0, 0, 0);
                currentLocation = selectedBody;
                syncWindowCurrentLocation();
                applyLocationToUI(selectedBody);
                console.log('Double-click Universe → inside bubble y=' + ty);
            }
            // Уровень 6ZC (Вселенная): двойной клик по галактике → перелёт к ней
            else if (currentLevelId === '6ZC' && selectedBody.data.type === 'galaxy') {
                let px = selectedBody.mesh.position.x, pz = selectedBody.mesh.position.z;
                try {
                    const fo = recenterFloatingOriginToBody(selectedBody);
                    if (fo) { px = fo.x; pz = fo.z; }
                } catch (e) { console.warn('6ZC FO', e); }
                // Спуск на уровень «Галактика» (5ZC) для любой галактики
                const ty = 14000; // уровень «Галактика» для любой галактики
                transition = {
                    startTime: performance.now(),
                    duration: 2400,
                    startPosition: camera.position.clone(),
                    targetPosition: new THREE.Vector3(px, ty, pz),
                    startY: camera.position.y,
                    targetY: ty
                };
                trackedBody = null;
                trackedOffset.set(0, 0, 0);
                currentLocation = selectedBody;
                syncWindowCurrentLocation();
                applyLocationToUI(selectedBody);
                console.log(`Double-click selected (6ZC, galaxy): ${locName(selectedBody.data.name)} y=${ty}`);
            }
            // Уровень 5ZC (Галактика): двойной клик по туманности → перелёт + спуск на 4ZC
            else if (currentLevelId === '5ZC' && selectedBody.data.type === 'interstellarNebula') {
                let px = selectedBody.mesh.position.x, pz = selectedBody.mesh.position.z;
                try {
                    const fo = recenterFloatingOriginToBody(selectedBody);
                    if (fo) { px = fo.x; pz = fo.z; }
                } catch (e) { console.warn('5ZC FO', e); }
                transition = {
                    startTime: performance.now(),
                    duration: 3200,
                    startPosition: camera.position.clone(),
                    targetPosition: new THREE.Vector3(px, 1200, pz),
                    startY: camera.position.y,
                    targetY: 1200
                };
                trackedBody = null;
                trackedOffset.set(0, 0, 0);
                currentLocation = selectedBody;
                syncWindowCurrentLocation();
                applyLocationToUI(selectedBody);
                console.log(`Double-click selected (5ZC, nebula): ${locName(selectedBody.data.name)}`);
            }
            // Уровень 4ZC: только звезды, переход на высоту 3ZC (17)
            else if (currentLevelId === '4ZC' && selectedBody.data.type === 'star') {
                let px = selectedBody.mesh.position.x, pz = selectedBody.mesh.position.z;
                try {
                    const fo = recenterFloatingOriginToBody(selectedBody);
                    if (fo) { px = fo.x; pz = fo.z; }
                } catch (e) { console.warn('4ZC FO', e); }
                transition = {
                    startTime: performance.now(),
                    duration: 3000,
                    startPosition: camera.position.clone(),
                    targetPosition: new THREE.Vector3(px, heightLevels['3ZC'].min, pz),
                    startY: camera.position.y,
                    targetY: heightLevels['3ZC'].min
                };
                trackedBody = selectedBody;
                trackedOffset.set(0, 0, 0);
                currentLocation = selectedBody;
                syncWindowCurrentLocation();
                applyLocationToUI(selectedBody);
                console.log(`Double-click selected (4ZC, star): ${locName(selectedBody.data.name)}, colonized: ${selectedBody.data.colonized}, has_technoport: ${selectedBody.data.has_technoport}`);
            }
            // Уровень 3ZC, высота > 90, звезда, планета или луна: переход на высоту 90
            else if (currentLevelId === '3ZC' && height > 90) {
                let _px = selectedBody.mesh.position.x, _pz = selectedBody.mesh.position.z;
                try {
                    const fo = recenterFloatingOriginToBody(selectedBody);
                    if (fo) { _px = fo.x; _pz = fo.z; }
                } catch (_) {}
                transition = {
                    startTime: performance.now(),
                    duration: 3000,
                    startPosition: camera.position.clone(),
                    targetPosition: new THREE.Vector3(
                        _px,
                        90,
                        _pz
                    ),
                    startY: camera.position.y,
                    targetY: 90
                };
                trackedBody = selectedBody;
                trackedOffset.set(0, 0, 0);
                currentLocation = selectedBody;
                syncWindowCurrentLocation();
                applyLocationToUI(selectedBody);
                console.log(`Double-click selected (3ZC, height > 90, ${selectedBody.data.type}): ${locName(selectedBody.data.name)}, colonized: ${selectedBody.data.colonized}, has_technoport: ${selectedBody.data.has_technoport}`);
            }
            // Другие случаи: перемещение к телу без изменения высоты
            else {
                if (currentLevelId === '3ZC' && selectedBody.data.type === 'moon') {
                    // Игнорируем луны на 3ZC, если высота > 90 (уже обработано выше)
                    if (height > 90) {
                        console.log(`Double-click ignored: moon selected on 3ZC with height > 90`);
                        return;
                    }
                }
                if (currentLevelId === '4ZC' && (selectedBody.data.type === 'planet' || selectedBody.data.type === 'moon')) {
                    console.log(`Double-click ignored: planet/moon selected on 4ZC`);
                    return;
                }
                trackedBody = selectedBody;
                let px = selectedBody.mesh.position.x, pz = selectedBody.mesh.position.z;
                try {
                    const fo = recenterFloatingOriginToBody(selectedBody);
                    if (fo) { px = fo.x; pz = fo.z; }
                } catch (_) {}
                camera.position.set(px, camera.position.y, pz);
                trackedOffset.set(0, 0, 0);
                currentLocation = selectedBody;
                syncWindowCurrentLocation();
                applyCameraDepthRange(camera.position.y);
                applyLocationToUI(selectedBody);
                console.log(`Double-click selected: ${locName(selectedBody.data.name)}, colonized: ${selectedBody.data.colonized}, has_technoport: ${selectedBody.data.has_technoport}`);
            }
        } else {
            trackedBody = null;
            trackedOffset.set(0, 0, 0);
            currentLocation = null;
            syncWindowCurrentLocation();
            applyLocationToUI(null);
            try {
                import('./technoport.js').then(m => m.onMapEmptyDoubleClick?.()).catch(() => {});
            } catch (_) {}
            console.log('Double-click: No body selected, currentLocation set to null');
        }
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        state.renderer.setSize(window.innerWidth, window.innerHeight);
        state.composer.setSize(window.innerWidth, window.innerHeight);
    });
}

export function updateCamera(deltaTime, currentLevelId) {
    if (state.geoSurveyBlocking) {
        // режим гео-разведки / переход — обычная камера не двигается
        return;
    }
    const height = camera.position.y;
    applyCameraDepthRange(height);
    let cameraSpeed = 0.1;
    for (let id in heightLevels) {
        if (height >= heightLevels[id].min && height <= heightLevels[id].max) {
            cameraSpeed = heightLevels[id].cameraSpeed;
            break;
        }
    }

    if (trackedBody && (
        (trackedBody.data.type === 'moon' && (currentLevelId === '3ZC' || currentLevelId === '4ZC')) ||
        currentLevelId === '4ZC'
    )) {
        trackedBody = null;
        trackedOffset.set(0, 0, 0);
        currentLocation = null;
        syncWindowCurrentLocation();
        document.getElementById('location-name').textContent = '';
        console.log('Tracked body reset due to level or type restriction');
    }

    if (transition) {
        const elapsed = performance.now() - transition.startTime;
        const t = Math.min(elapsed / transition.duration, 1);
        const easeT = t * t * (3 - 2 * t);
        camera.position.lerpVectors(transition.startPosition, transition.targetPosition, easeT);
        targetCameraY = transition.startY + (transition.targetY - transition.startY) * easeT;
        if (t >= 1) {
            transition = null;
            console.log('Transition completed');
        }
    } else {
        if (keys.shift) {
            cameraSpeed *= 2;
        }

        if (trackedBody && trackedBody.mesh &&
            trackedBody.data?.type !== 'starSystem' &&
            trackedBody.data?.type !== 'interstellarNebula' &&
            trackedBody.data?.type !== 'galaxy') {
            const wellCenter = trackedBody.mesh.position.clone();
            const wellRadius = Math.max(
                1,
                (Number(trackedBody.data.size) || 1) * (Number(trackedBody.data.gravityWellMultiplier) || 1)
            );

            if (keys.w) trackedOffset.z -= cameraSpeed * deltaTime;
            if (keys.s) trackedOffset.z += cameraSpeed * deltaTime;
            if (keys.a) trackedOffset.x -= cameraSpeed * deltaTime;
            if (keys.d) trackedOffset.x += cameraSpeed * deltaTime;

            const distanceXZ = Math.sqrt(trackedOffset.x * trackedOffset.x + trackedOffset.z * trackedOffset.z);
            if (distanceXZ > wellRadius && wellRadius > 0) {
                const scale = wellRadius / distanceXZ;
                trackedOffset.x *= scale;
                trackedOffset.z *= scale;
            }

            const nx = wellCenter.x + trackedOffset.x;
            const nz = wellCenter.z + trackedOffset.z;
            if (Number.isFinite(nx) && Number.isFinite(nz)) {
                camera.position.x = nx;
                camera.position.z = nz;
            }

            if (Number.isFinite(targetCameraY)) {
                camera.position.y += (targetCameraY - camera.position.y) * 0.05;
            }
        } else {
            // free fly (в т.ч. starSystem / nebula)
            if (trackedBody && (trackedBody.data?.type === 'starSystem' || trackedBody.data?.type === 'interstellarNebula' || trackedBody.data?.type === 'galaxy' || trackedBody.data?.type === 'universe')) {
                trackedBody = null;
                trackedOffset.set(0, 0, 0);
            }
            camera.position.y += (targetCameraY - camera.position.y) * 0.05;
            if (keys.w) camera.position.z -= cameraSpeed * deltaTime;
            if (keys.s) camera.position.z += cameraSpeed * deltaTime;
            if (keys.a) camera.position.x -= cameraSpeed * deltaTime;
            if (keys.d) camera.position.x += cameraSpeed * deltaTime;
        }
    }

    camera.lookAt(camera.position.x, 0, camera.position.z);
}


/** Обновляет верхний бар и меню при смене локации (клик / стрелки / авто) */
function applyLocationToUI(body) {
    const bodyInfo = document.getElementById('body-info');
    try { notifyLocationForRename(body); } catch (_) {}
    if (body) {
        try { refreshLocationNameDisplay(body); } catch (_) {
            const locationNameElement = document.getElementById('location-name');
            if (locationNameElement) locationNameElement.textContent = locName(body.data.name);
        }
        if (bodyInfo) bodyInfo.style.display = 'block';
        updateBodyMenu(body);
    } else {
        const locationNameElement = document.getElementById('location-name');
        if (locationNameElement) locationNameElement.textContent = '';
        if (bodyInfo) bodyInfo.style.display = 'none';
        updateBodyMenu(null);
    }
}

export function updateCurrentLocation() {
    // В режиме гео-разведки локацию не пересчитываем — бар и меню не сбрасываются
    if (state.geoSurveyBlocking) return;
    console.log('updateCurrentLocation called, state.celestialBodies:', Object.keys(state.celestialBodies).length);
    const height = camera.position.y;
    let currentLevelId = '';
    for (let id in heightLevels) {
        if (height >= heightLevels[id].min && height <= heightLevels[id].max) {
            currentLevelId = id;
            break;
        }
    }
    console.log(`Camera height: ${height}, currentLevelId: ${currentLevelId}`);

    let closestBody = null;
    let minDistance = Infinity;
    const locationNameElement = document.getElementById('location-name');

    const fov = camera.fov * Math.PI / 180;
    const viewDistance = 100;

    // Проверка небесных тел
    for (let id in state.celestialBodies) {
        const body = state.celestialBodies[id];
        const mesh = body.mesh;
        if (!mesh || !mesh.visible) {
            console.log(`Body ${locName(body.data.name)} skipped: mesh=${!!mesh}, visible=${mesh ? mesh.visible : false}`);
            continue;
        }

        const distance = camera.position.distanceTo(mesh.position);
        if (distance > viewDistance) {
            console.log(`Body ${locName(body.data.name)} skipped: distance=${distance} > viewDistance=${viewDistance}`);
            continue;
        }

        const vectorToBody = mesh.position.clone().sub(camera.position).normalize();
        const cameraForward = new THREE.Vector3(0, -1, 0);
        const angle = vectorToBody.angleTo(cameraForward);

        if (angle < fov / 2) {
            const wellRadius = body.data.size * (body.data.gravityWellMultiplier || 1);
            const wellDistance = distance - wellRadius;
            const isWellVisible = currentLevelId === '1ZC' || currentLevelId === '2ZC';

            console.log(`Body ${locName(body.data.name)}: distance=${distance}, wellDistance=${wellDistance}, angle=${angle}, isWellVisible=${isWellVisible}`);

            if (distance < minDistance) {
    minDistance = distance;
    closestBody = body;
}
        } else {
            console.log(`Body ${locName(body.data.name)} skipped: angle=${angle} >= fov/2=${fov / 2}`);
        }
    }

   // Проверка лейблов
    if (!closestBody) {
        const mouse = new THREE.Vector2(0, 0); // Центр экрана
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);

        for (let id in state.labels) {
            const label = state.labels[id];
            if (label.style.display === 'none') {
                console.log(`Label for body ${state.celestialBodies[id].data.name /*loc*/} skipped: not visible`);
                continue;
            }

            const body = state.celestialBodies[id];
            const mesh = body.mesh;
            if (!mesh || !mesh.visible) {
                console.log(`Label for body ${locName(body.data.name)} skipped: mesh=${!!mesh}, visible=${mesh ? mesh.visible : false}`);
                continue;
            }

            // Проверяем, пересекает ли луч камеры область лейбла
            const labelRect = label.getBoundingClientRect();
            const screenCenterX = window.innerWidth / 2;
            const screenCenterY = window.innerHeight / 2;
            const isLabelHit = (
                screenCenterX >= labelRect.left &&
                screenCenterX <= labelRect.right &&
                screenCenterY >= labelRect.top &&
                screenCenterY <= labelRect.bottom
            );

            if (isLabelHit) {
                const distance = camera.position.distanceTo(mesh.position);
                if (distance < viewDistance && distance < minDistance) {
                    minDistance = distance;
                    closestBody = body;
                    console.log(`Label hit for body ${locName(body.data.name)}: distance=${distance}, position=(${labelRect.left}, ${labelRect.top}, ${labelRect.right}, ${labelRect.bottom})`);
                } else {
                    console.log(`Label for body ${locName(body.data.name)} skipped: distance=${distance} > viewDistance=${viewDistance} or not closer`);
                }
            } else {
                console.log(`Label for body ${locName(body.data.name)} skipped: not hit by screen center`);
            }
        }
    }

    // 7ZC Мультивселенная: локация — Вселенная-512 (пузырь) или Мультивселенная
    if (currentLevelId === '7ZC') {
        const universe = findUniverseBody()
            || Object.values(state.celestialBodies || {}).find(b => b.data?.type === 'universe');
        const outside = isCameraOutsideUniverseBubble(camera);
        if (outside && universe) {
            // далеко от шара → Мультивселенная; близко к шару → Вселенная-512
            const c = getUniverseBubbleCenterDisplay();
            const dist = Math.hypot(
                camera.position.x - c.x,
                camera.position.y - c.y,
                camera.position.z - c.z
            );
            if (dist < UNIVERSE_BUBBLE_RADIUS * 2.2) {
                closestBody = universe;
            } else {
                closestBody = {
                    data: {
                        id: -512,
                        type: 'multiverse',
                        name: { ru: 'Мультивселенная', en: 'Multiverse', de: 'Multiversum' }
                    },
                    mesh: universe.mesh
                };
            }
        } else {
            closestBody = universe || null;
        }
    }
    // 6ZC: ближайшая галактика; иначе Вселенная
    else if (currentLevelId === '6ZC') {
        const ng = findNearestGalaxy(camera);
        const universe = findUniverseBody()
            || Object.values(state.celestialBodies || {}).find(b => b.data?.type === 'universe');
        const gSize = Number(ng?.body?.data?.size) || 60000;
        if (ng && ng.dist < gSize * 2.5) {
            closestBody = ng.body;
        } else {
            closestBody = universe || ng?.body || null;
        }
    }
    // 5ZC: ближайшая туманность (если близко), иначе ближайшая галактика
    else if (currentLevelId === '5ZC') {
        let nearestNeb = null;
        let minN = Infinity;
        for (const id in state.celestialBodies) {
            const body = state.celestialBodies[id];
            if (body.data?.type !== 'interstellarNebula' || !body.mesh) continue;
            const dx = camera.position.x - body.mesh.position.x;
            const dz = camera.position.z - body.mesh.position.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < minN) { minN = d; nearestNeb = body; }
        }
        let nearestGal = null, minG = Infinity;
        for (const id in state.celestialBodies) {
            const body = state.celestialBodies[id];
            if (body.data?.type !== 'galaxy' || !body.mesh) continue;
            const dx = camera.position.x - body.mesh.position.x;
            const dz = camera.position.z - body.mesh.position.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < minG) { minG = d; nearestGal = body; }
        }
        const size = Number(nearestNeb?.data?.size) || 1200;
        closestBody = (nearestNeb && minN < size * 2.2) ? nearestNeb : (nearestGal || nearestNeb);
    }
    // 4ZC: локация = ближайшая межзвёздная туманность (задел на несколько)
    else if (currentLevelId === '4ZC') {
        let nearestNeb = null;
        let minN = Infinity;
        for (const id in state.celestialBodies) {
            const body = state.celestialBodies[id];
            if (body.data?.type !== 'interstellarNebula' || !body.mesh) continue;
            const dx = camera.position.x - body.mesh.position.x;
            const dz = camera.position.z - body.mesh.position.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < minN) { minN = d; nearestNeb = body; }
        }
        closestBody = nearestNeb;
    } else if (!closestBody && (currentLevelId === '3ZC' || currentLevelId === '2ZC' || currentLevelId === '1ZC')) {
        // внутри звёздной системы, но не на конкретном теле → локация = звездная система
        // ищем ближайшую звезду по XZ, затем её starSystem
        let nearestStar = null;
        let minD = Infinity;
        for (const id in state.celestialBodies) {
            const body = state.celestialBodies[id];
            if (body.data?.type !== 'star' || !body.mesh) continue;
            const dx = camera.position.x - body.mesh.position.x;
            const dz = camera.position.z - body.mesh.position.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < minD) { minD = d; nearestStar = body; }
        }
        if (nearestStar) {
            closestBody = findStarSystemForBody(nearestStar) || nearestStar;
        }
    }

    if (currentLocation !== closestBody) {
        currentLocation = closestBody;
        syncWindowCurrentLocation();
        applyLocationToUI(currentLocation);
        if (currentLocation) {
            console.log('Current location set to:', `${locName(currentLocation.data.name)} (type: ${currentLocation.data.type})`);
        } else {
            console.log('Current location set to: null');
        }
    }
}

export function switchBody(direction) {
    const allBodies = Object.values(state.celestialBodies || {})
        .filter(body => body?.mesh && body?.data)
        .sort((a, b) => (a.data.id || 0) - (b.data.id || 0));

    if (allBodies.length === 0) {
        console.log('switchBody: No bodies available');
        return;
    }

    // Если локации нет — берём ближайшее тело
    if (!currentLocation?.data) {
        let best = null, bestD = Infinity;
        for (const body of allBodies) {
            const d = camera.position.distanceTo(body.mesh.position);
            if (d < bestD) { bestD = d; best = body; }
        }
        if (!best) return;
        currentLocation = best;
        syncWindowCurrentLocation();
    }

    const t = currentLocation.data.type;
    let candidates = [];

    if (t === 'multiverse' || t === 'universe') {
        // Стрелки на вселенной — переключение между галактиками
        candidates = allBodies.filter(b => b.data.type === 'galaxy');
    } else if (t === 'galaxy') {
        // Галактики внутри одной вселенной
        const uid = currentLocation.data.universeId != null
            ? Number(currentLocation.data.universeId) : null;
        candidates = allBodies.filter(b => {
            if (b.data.type !== 'galaxy') return false;
            if (uid == null) return true;
            return Number(b.data.universeId) === uid || b.data.parent === uid;
        });
    } else if (t === 'interstellarNebula') {
        candidates = allBodies.filter(b => b.data.type === 'interstellarNebula');
    } else if (t === 'starSystem') {
        // Только системы той же туманности
        const nebId = currentLocation.data.nebulaId != null
            ? Number(currentLocation.data.nebulaId) : null;
        candidates = allBodies.filter(b => {
            if (b.data.type !== 'starSystem') return false;
            if (nebId == null) return true;
            return Number(b.data.nebulaId) === nebId;
        });
    } else if (t === 'star') {
        // Только звёзды той же туманности
        const nebId = currentLocation.data.nebulaId != null
            ? Number(currentLocation.data.nebulaId) : null;
        candidates = allBodies.filter(b => {
            if (b.data.type !== 'star') return false;
            if (nebId == null) return true;
            return Number(b.data.nebulaId) === nebId;
        });
    } else if (t === 'planet') {
        const parentStarId = currentLocation.data.parent;
        candidates = allBodies.filter(b =>
            b.data.type === 'planet' && b.data.parent === parentStarId
        );
    } else if (t === 'moon') {
        const parentPlanet = state.celestialBodies[currentLocation.data.parent]
            || state.celestialBodies[String(currentLocation.data.parent)];
        const parentStarId = parentPlanet?.data?.parent;
        candidates = allBodies.filter(b => {
            if (b.data.type !== 'moon') return false;
            const pp = state.celestialBodies[b.data.parent] || state.celestialBodies[String(b.data.parent)];
            return pp?.data?.parent === parentStarId;
        });
    }

    // Одна кандидат — переключать некуда
    if (!candidates.length || candidates.length < 2) {
        console.log('switchBody: no siblings to switch (candidates=' + candidates.length + ')');
        return;
    }

    let currentIndex = candidates.findIndex(b => b.data.id === currentLocation.data.id);
    if (currentIndex < 0) currentIndex = 0;

    const newIndex = direction === 'next'
        ? (currentIndex + 1) % candidates.length
        : (currentIndex - 1 + candidates.length) % candidates.length;

    const newBody = candidates[newIndex];
    if (!newBody?.mesh) return;

    const keepY = camera.position.y;
    trackedBody = (newBody.data.type === 'starSystem' || newBody.data.type === 'interstellarNebula' || newBody.data.type === 'galaxy' || newBody.data.type === 'universe' || newBody.data.type === 'multiverse')
        ? null : newBody;
    currentLocation = newBody;
    syncWindowCurrentLocation();

    let px = newBody.mesh.position.x;
    let pz = newBody.mesh.position.z;
    try {
        const fo = recenterFloatingOriginToBody(newBody);
        if (fo) { px = fo.x; pz = fo.z; }
    } catch (e) { console.warn('switchBody FO', e); }

    camera.position.set(px, keepY, pz);
    targetCameraY = keepY;
    trackedOffset.set(0, 0, 0);
    applyCameraDepthRange(keepY);
    applyLocationToUI(currentLocation);
    console.log(`switchBody: Switched to ${locName(newBody.data.name)} (type=${newBody.data.type}), y=${keepY}, siblings=${candidates.length}`);
}