import { captureGeoSurveySnapshot, applyGeoSurveySnapshot } from './geoSurveyGame.js';
import { captureCartographySnapshot, applyCartographySnapshot } from './cartography.js';
/**
 * Система сохранений v2 — игровые сессии (localStorage).
 * Ключ: ascension_era6_sessions
 */
import { state } from './state.js';
import { camera, currentLocation, focusBodyAtHeight, targetCameraY, setCurrentLocation, setTargetCameraY, setTrackedBody } from './camera.js';
import { startTime, formatTime , captureTimeSpeedSnapshot, applyTimeSpeedFromSave } from './ui.js';
import { getPlayerGender, resetQuestsForNewGame } from './quests.js';
import { applyDevConsoleFromSave } from './developerConsole.js';
import { t, locName } from './settings.js';
import { collectUnitsSnapshot, applyUnitsSnapshot } from './units.js';
import { captureTechProgressSnapshot, applyTechProgressSnapshot } from './technologies.js';
import { captureBodyCustomNamesSnapshot, applyBodyCustomNamesSnapshot } from './bodyRename.js';
import { captureNotepadSnapshot, applyNotepadSnapshot } from './notepad.js';
import { captureCalculatorSnapshot, applyCalculatorSnapshot } from './calculator.js';
import { captureTrendHistorySnapshot, applyTrendHistorySnapshot } from './trendCharts.js';

const LS_SESSIONS_KEY = 'ascension_era6_sessions';

function currentLangSafe() {
    try {
        const raw = localStorage.getItem('ascension_era6_system');
        if (raw) {
            const L = JSON.parse(raw).lang;
            if (L) return L;
        }
    } catch (_) {}
    return 'ru';
}


/** Текущая сессия в памяти (после новой игры / загрузки) */
let currentSessionId = null;
/** Реальное время старта текущего прохождения (Погружение / корень сейва) — только для «Дата начала» */
let playthroughStartMs = null;
/**
 * Наигранное время = сумма закрытых игровых отрезков (вагонов).
 * НЕ считается от первого старта до «сейчас».
 */
let accumulatedPlayMs = 0;
/** Список закрытых отрезков { startMs, endMs, ms } — история заходов */
let playSegments = [];
/** Начало текущего активного отрезка; null = часы на паузе (меню / вкладка скрыта / выход) */
let sessionOpenedAtMs = null;
let sessionNameMemory = '';

/**
 * Закрыть текущий игровой отрезок (вагон) и поставить часы на паузу.
 * Не начинает новый отрезок.
 */
export function pausePlayClock() {
    const now = Date.now();
    if (sessionOpenedAtMs) {
        const ms = Math.max(0, now - sessionOpenedAtMs);
        if (ms > 0) {
            playSegments.push({ startMs: sessionOpenedAtMs, endMs: now, ms });
            accumulatedPlayMs += ms;
        }
        sessionOpenedAtMs = null;
    }
    return accumulatedPlayMs;
}

/**
 * Продолжить учёт: начать новый отрезок, если часы были на паузе.
 */
export function resumePlayClock() {
    if (!sessionOpenedAtMs) {
        sessionOpenedAtMs = Date.now();
    }
    return sessionOpenedAtMs;
}

/**
 * Для сохранения: закрыть текущий вагон в accumulated, сразу открыть новый
 * (игра продолжается, но сейв видит актуальное playMs).
 */
function commitPlayClock() {
    const now = Date.now();
    if (sessionOpenedAtMs) {
        const ms = Math.max(0, now - sessionOpenedAtMs);
        if (ms > 0) {
            playSegments.push({ startMs: sessionOpenedAtMs, endMs: now, ms });
            accumulatedPlayMs += ms;
        }
    }
    sessionOpenedAtMs = now;
    return accumulatedPlayMs;
}

/** Живое наигранное: сумма вагонов + текущий открытый отрезок (если часы идут) */
function getLivePlayMs() {
    let ms = Math.max(0, Number(accumulatedPlayMs) || 0);
    if (sessionOpenedAtMs) {
        ms += Math.max(0, Date.now() - sessionOpenedAtMs);
    }
    return ms;
}

function getPlaythroughStartMs() {
    return playthroughStartMs || Date.now();
}


/**
 * Локация для сейва:
 *  - высота 4ZC (≥400) → межзвёздная туманность (или текущая, если уже она)
 *  - высота 3ZC (≥17)  → звёздная система, в которой мы находимся
 *  - ниже → текущее тело (планета/луна/звезда)
 * При загрузке focusBodyAtHeight ставит камеру в центр этой локации.
 */
function resolveSaveLocationBody() {
    const h = (typeof targetCameraY === 'number')
        ? targetCameraY
        : (camera ? camera.position.y : 3);
    const bodies = state.celestialBodies || {};

    if (h >= 400) {
        // Межзвёздная туманность
        if (currentLocation?.data?.type === 'interstellarNebula') return currentLocation;
        let best = null, bestD = Infinity;
        const cx = camera?.position.x || 0, cz = camera?.position.z || 0;
        for (const id of Object.keys(bodies)) {
            const b = bodies[id];
            if (b?.data?.type !== 'interstellarNebula' || !b.mesh) continue;
            const dx = cx - b.mesh.position.x, dz = cz - b.mesh.position.z;
            const d = dx * dx + dz * dz;
            if (d < bestD) { bestD = d; best = b; }
        }
        return best || currentLocation;
    }

    if (h >= 17) {
        // Звёздная система
        if (currentLocation?.data?.type === 'starSystem') return currentLocation;
        // от текущего тела → его система
        if (currentLocation) {
            const sid = currentLocation.data.starSystemId;
            if (sid != null && bodies[sid]) return bodies[sid];
            // parent chain / children lookup
            for (const id of Object.keys(bodies)) {
                const b = bodies[id];
                if (b?.data?.type !== 'starSystem') continue;
                const ch = b.data.children || [];
                let starId = currentLocation.data.id;
                if (currentLocation.data.type === 'planet') starId = currentLocation.data.parent;
                else if (currentLocation.data.type === 'moon') {
                    const pl = bodies[currentLocation.data.parent];
                    starId = pl?.data?.parent;
                }
                if (ch.includes(starId) || ch.includes(Number(starId))) return b;
            }
        }
        // ближайшая система по XZ
        let best = null, bestD = Infinity;
        const cx = camera?.position.x || 0, cz = camera?.position.z || 0;
        for (const id of Object.keys(bodies)) {
            const b = bodies[id];
            if (b?.data?.type !== 'starSystem' || !b.mesh) continue;
            const dx = cx - b.mesh.position.x, dz = cz - b.mesh.position.z;
            const d = dx * dx + dz * dz;
            if (d < bestD) { bestD = d; best = b; }
        }
        return best || currentLocation;
    }

    return currentLocation;
}

function snapshotPlaySegments() {
    // копия закрытых + текущий незакрытый для сейва
    const list = playSegments.map(s => ({ ...s }));
    if (sessionOpenedAtMs) {
        const now = Date.now();
        const ms = Math.max(0, now - sessionOpenedAtMs);
        if (ms > 0) list.push({ startMs: sessionOpenedAtMs, endMs: now, ms, open: true });
    }
    return list;
}


export function getCurrentSessionId() {
    return currentSessionId;
}

export function setSessionNameMemory(name) {
    sessionNameMemory = String(name || '').trim();
    window.__sessionName = sessionNameMemory;
}

export function getSessionNameMemory() {
    return sessionNameMemory || window.__sessionName || '';
}

function uid() {
    return 'ses_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function readAll() {
    try {
        const raw = localStorage.getItem(LS_SESSIONS_KEY);
        if (!raw) return { version: 2, sessions: {} };
        const data = JSON.parse(raw);
        if (!data.sessions || typeof data.sessions !== 'object') return { version: 2, sessions: {} };
        return data;
    } catch (_) {
        return { version: 2, sessions: {} };
    }
}

function writeAll(data) {
    try {
        localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(data));
        return true;
    } catch (e) {
        console.warn('sessions write failed', e);
        return false;
    }
}

export function listSessions({ includeAutosaves = false } = {}) {
    const all = readAll();
    let list = Object.values(all.sessions);
    if (!includeAutosaves) {
        list = list.filter(s => !s.isAutosave);
    }
    return list.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
}

/** Братская сессия автосохранения для родителя */
export function getAutosaveSibling(parentId) {
    if (!parentId) return null;
    const all = readAll();
    const parent = all.sessions[parentId];
    if (parent?.autosaveId && all.sessions[parent.autosaveId]) {
        return all.sessions[parent.autosaveId];
    }
    // fallback: поиск по parentSessionId
    for (const s of Object.values(all.sessions)) {
        if (s.isAutosave && s.parentSessionId === parentId) return s;
    }
    return null;
}


export function getSession(id) {
    return readAll().sessions[id] || null;
}

export function deleteSession(id) {
    const all = readAll();
    if (!all.sessions[id]) return false;
    const ses = all.sessions[id];
    // удалить братское автосохранение
    if (ses.autosaveId && all.sessions[ses.autosaveId]) {
        delete all.sessions[ses.autosaveId];
    }
    // если удаляем автосейв — отвязать от родителя
    if (ses.isAutosave && ses.parentSessionId && all.sessions[ses.parentSessionId]) {
        delete all.sessions[ses.parentSessionId].autosaveId;
    }
    delete all.sessions[id];
    writeAll(all);
    if (currentSessionId === id) currentSessionId = null;
    return true;
}

/** Формат наигранного времени для UI */
export function formatPlayDuration(ms) {
    const totalMin = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
    if (totalMin < 60) {
        return `${totalMin} ${t('save.minutes') || 'мин.'}`;
    }
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (m === 0) return `${h} ${t('save.hours') || 'ч.'}`;
    return `${h} ${t('save.hours') || 'ч.'} ${m} ${t('save.minutes') || 'мин.'}`;
}

function formatRealDate(ms) {
    try {
        const d = new Date(ms);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    } catch (_) {
        return '—';
    }
}

function ensureQuestStateSafe() {
    try {
        // quests.js may not export ensureQuestState — use state.quests
        if (!state.quests) {
            state.quests = {
                active: [], completed: [], failed: [], progress: {},
                flags: {}, playerGender: null, removedCards: []
            };
        }
        return state.quests;
    } catch (_) {
        return {};
    }
}

/** Снимок текущего игрового состояния */
export function collectSessionSnapshot(nameOverride) {
    const qs = ensureQuestStateSafe();
    const now = Date.now();
    // не сбрасываем часы здесь — только читаем live-значение
    const playMs = getLivePlayMs();
    const existing = currentSessionId ? getSession(currentSessionId) : null;
    const rootStart = getPlaythroughStartMs();
    const rootLabel = formatRealDate(rootStart);

        const locBody = resolveSaveLocationBody();
    const cam = camera
        ? { x: camera.position.x, y: camera.position.y, z: camera.position.z }
        : { x: 0, y: 3, z: 0 };
    const bodyId = locBody?.data?.id ?? currentLocation?.data?.id ?? null;
    const height = typeof targetCameraY === 'number' ? targetCameraY : cam.y;

    const gameMs = startTime instanceof Date ? startTime.getTime() : Date.now();
    let gameLabel = '—';
    try { gameLabel = formatTime(startTime); } catch (_) {}

    // квесты: компактный срез для сейва
    const quests = {
        active: [...(qs.active || [])],
        completed: [...(qs.completed || [])],
        failed: [...(qs.failed || [])],
        removedCards: [...(qs.removedCards || [])],
        playerGender: qs.playerGender || null,
        flags: { ...(qs.flags || {}) },
        progress: JSON.parse(JSON.stringify(qs.progress || {}))
    };

    // ===== v2.2: мир =====
    const bodyOrbits = {};
    const bodyResources = {};
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const b = bodies[id];
        const mesh = b?.mesh;
        if (mesh) {
            bodyOrbits[id] = {
                orbitAngle: mesh.userData?.orbitAngle != null
                    ? Number(mesh.userData.orbitAngle)
                    : (b.data?.orbitalStartAngle ?? 0),
                rotationY: mesh.rotation ? Number(mesh.rotation.y) : (b.data?.rotationStartAngle ?? 0)
            };
        } else if (b?.data) {
            bodyOrbits[id] = {
                orbitAngle: b.data.orbitalStartAngle ?? 0,
                rotationY: b.data.rotationStartAngle ?? 0
            };
        }
        // население + склады ресурсов
        const data = b?.data;
        if (data) {
            const stock = (data.resources && data.resources.stock)
                ? { ...data.resources.stock }
                : {};
            bodyResources[id] = {
                population: Number(data.resources?.population) || 0,
                stock
            };
        }
    }

    const locationBuildings = JSON.parse(JSON.stringify(state.locationBuildings || {}));
    let locationGeoSurvey = {};
    try { locationGeoSurvey = captureGeoSurveySnapshot(); } catch (_) { locationGeoSurvey = JSON.parse(JSON.stringify(state.locationGeoSurvey || {})); }
    let locationCartography = {};
    try { locationCartography = captureCartographySnapshot(); } catch (_) { locationCartography = JSON.parse(JSON.stringify(state.locationCartography || {})); }

    const locationSpecialists = JSON.parse(JSON.stringify(state.locationSpecialists || {}));
    const locationBuildingRecipes = JSON.parse(JSON.stringify(state.locationBuildingRecipes || {}));
    const populationAccum = JSON.parse(JSON.stringify(state.populationAccum || {}));

    return {
        id: currentSessionId || uid(),
        name: (nameOverride || getSessionNameMemory() || existing?.name || t('save.unnamed') || 'Сессия').slice(0, 42),
        // корень прохождения — единая дата начала для всех слотов этой ветки
        playthroughStartMs: rootStart,
        createdAtMs: rootStart,
        updatedAtMs: now,
        realStartLabel: rootLabel,
        playMs,
        playSegments: snapshotPlaySegments(),
        gender: qs.playerGender || getPlayerGender?.() || null,
        camera: { ...cam, bodyId, height },
        gameTimeMs: gameMs,
        gameTimeLabel: gameLabel,
        mainQuestId: (qs.active && qs.active[0]) || null,
        mainQuestTitle: (function() {
            const id = (qs.active && qs.active[0]) || null;
            if (!id) return null;
            try {
                const titleObj = _questLocCache?.quests?.[id]?.title;
                if (titleObj) {
                    const L = currentLangSafe();
                    if (typeof titleObj === 'string') return titleObj;
                    return titleObj[L] || titleObj.ru || titleObj.en || null;
                }
            } catch (_) {}
            return null;
        })(),
        quests,
        // v2.2 world
        bodyOrbits,
        bodyResources,
        locationBuildings,
        locationGeoSurvey,
        locationCartography,
        locationUnits: collectUnitsSnapshot(),
        locationSpecialists,
        locationBuildingRecipes,
        populationAccum,
        techProgress: (function(){ try { return captureTechProgressSnapshot(); } catch(_) { return {}; } })(),
        devConsoleUnlocked: !!(state.devConsoleUnlocked),
        bodyCustomNames: (function(){ try { return captureBodyCustomNamesSnapshot(); } catch(_) { return {}; } })(),
        trendHistory: (() => { try { return captureTrendHistorySnapshot(); } catch (_) { return null; } })(),
        notepadText: (function(){ try { return captureNotepadSnapshot(); } catch(_) { return ''; } })(),
        calculatorHistory: (function(){ try { return captureCalculatorSnapshot(); } catch(_) { return []; } })(),
        timeSpeedState: (function(){ try { return captureTimeSpeedSnapshot(); } catch(_) { return { timeSpeed: 1, speedBeforePause: 1, paused: false }; } })(),
        version: 2.3
    };
}

const DEFAULT_GAME_START_MS = new Date(2108, 2, 30, 11, 0, 0).getTime();

/**
 * Сбросить живое состояние к шаблонам JSON (как холодный старт).
 * Нужно, когда «Новая игра» запускается после уже загруженной сессии:
 * init() больше не вызывается, иначе остаётся мир прошлого сейва.
 */
export async function resetLiveGameToDefaults() {
    try { applyTimeSpeedFromSave(1, 1); } catch (_) {}
    try { if (startTime instanceof Date) startTime.setTime(DEFAULT_GAME_START_MS); } catch (_) {}

    try { resetQuestsForNewGame(); } catch (e) { console.warn('reset quests', e); }

    state.locationBuildings = {};
    state.locationSpecialists = {};
    state.locationBuildingRecipes = {};
    state.populationAccum = {};
    state.locationUnits = {};
    state.locationCartography = {};
    state.locationGeoSurvey = {};
    state.geoSurveyBlocking = false;
    try { applyTechProgressSnapshot({}); } catch (_) {}
    try { applyBodyCustomNamesSnapshot({}); } catch (_) {}
    try { applyNotepadSnapshot(''); } catch (_) {}
    try { applyCalculatorSnapshot([]); } catch (_) {}
    try { applyTrendHistorySnapshot(null); } catch (_) {}
    try { applyDevConsoleFromSave({ devConsoleUnlocked: false }); } catch (_) {}
    try { applyUnitsSnapshot({}); } catch (_) {}
    try { applyCartographySnapshot({}); } catch (_) {}
    try { applyGeoSurveySnapshot({}); } catch (_) {}

    // Тела: ресурсы, геология, стартовые углы — из hev.body.json
    try {
        const res = await fetch('hev.body.json');
        const catalog = await res.json();
        const list = Array.isArray(catalog) ? catalog : (catalog?.bodies || []);
        const defaultOrbits = {};
        for (const src of list) {
            if (src?.id == null) continue;
            const live = state.celestialBodies?.[src.id]
                || state.celestialBodies?.[String(src.id)]
                || state.celestialBodies?.[Number(src.id)];
            if (!live?.data) continue;
            if (src.resources) live.data.resources = JSON.parse(JSON.stringify(src.resources));
            else if (live.data.resources) {
                live.data.resources.population = Number(src.resources?.population) || 0;
                live.data.resources.stock = {};
            }
            if (src.geoDeposits) live.data.geoDeposits = JSON.parse(JSON.stringify(src.geoDeposits));
            if ('geoExploration' in src) live.data.geoExploration = src.geoExploration;
            if (src.groundResourceNodes) {
                live.data.groundResourceNodes = JSON.parse(JSON.stringify(src.groundResourceNodes));
            }
            if (src.units) live.data.units = JSON.parse(JSON.stringify(src.units));
            const orbitA = src.orbitalStartAngle ?? 0;
            const rotY = src.rotationStartAngle ?? 0;
            live.data.orbitalStartAngle = orbitA;
            live.data.rotationStartAngle = rotY;
            if (live.mesh?.userData) live.mesh.userData.orbitAngle = orbitA;
            defaultOrbits[src.id] = { orbitAngle: orbitA, rotationY: rotY };
        }
        try { applyBodyOrbits(defaultOrbits); } catch (_) {}
        try { restoreSystemAnchors(); } catch (_) {}
    } catch (e) {
        console.warn('reset bodies from JSON', e);
    }

    // Здания заново из шаблонов buildings.json
    try {
        const ids = Object.keys(state.celestialBodies || {});
        for (const id of ids) state.initializeLocationBuildings(id);
    } catch (e) { console.warn('reset buildings', e); }

    // Стартовая камера новой игры
    try {
        setTrackedBody(null);
        focusBodyAtHeight(3, 3);
    } catch (e) { console.warn('reset camera', e); }

    try {
        const { closeQuestModal, renderQuestList } = await import('./questsUI.js');
        closeQuestModal?.();
        renderQuestList?.();
    } catch (_) {}
    try {
        const { closeNpcDialogue } = await import('./npcDialogue.js');
        closeNpcDialogue?.();
    } catch (_) {}
    try {
        const { closeCartography } = await import('./cartography.js');
        closeCartography?.();
    } catch (_) {}
    try {
        const { updateResourceBar } = await import('./resourceUI.js');
        const { currentLocation } = await import('./camera.js');
        updateResourceBar?.(currentLocation);
        const { updateBodyMenu, resetActiveButtons } = await import('./ui.js');
        resetActiveButtons?.();
        if (currentLocation) updateBodyMenu?.(currentLocation);
    } catch (_) {}
    try {
        const { applyGenderToHeader } = await import('./quests.js');
        applyGenderToHeader?.();
    } catch (_) {}
    try {
        const { evaluateNpcTriggers } = await import('./npcDialogue.js');
        evaluateNpcTriggers?.();
    } catch (_) {}

    return true;
}

/** Создать сессию в момент «Погружение» (после сброса мира). */
export function beginNewSession(name) {
    const now = Date.now();
    setSessionNameMemory(name);
    currentSessionId = uid();
    playthroughStartMs = now;
    accumulatedPlayMs = 0;
    playSegments = [];
    sessionOpenedAtMs = now;
    const snap = collectSessionSnapshot(name);
    snap.id = currentSessionId;
    snap.playthroughStartMs = now;
    snap.createdAtMs = now;
    snap.updatedAtMs = now;
    snap.realStartLabel = formatRealDate(now);
    snap.playMs = 0;
    snap.isAutosave = false;
    snap.parentSessionId = null;
    snap.autosaveId = null;
    const all = readAll();
    all.sessions[currentSessionId] = snap;
    writeAll(all);
    try { startAutosaveTimer(); } catch (_) {}
    return snap;
}

/** Сохранить текущую игру в существующий или новый слот */
export function saveCurrentGame(opts = {}) {
    const { sessionId = currentSessionId, name = null, asNew = false } = opts;
    // зафиксировать наигранное до смены слота
    commitPlayClock();

    // родительские метаданные прохождения (до смены currentSessionId)
    const parentId = currentSessionId;
    const parent = parentId ? getSession(parentId) : null;
    const rootStart = playthroughStartMs
        || parent?.playthroughStartMs
        || parent?.createdAtMs
        || Date.now();
    playthroughStartMs = rootStart;

    if (asNew || !sessionId) {
        currentSessionId = uid();
        // НЕ сбрасываем sessionOpenedAtMs / accumulated — это то же прохождение
    } else {
        currentSessionId = sessionId;
        if (!sessionOpenedAtMs) sessionOpenedAtMs = Date.now();
    }
    if (name) setSessionNameMemory(name);

    const snap = collectSessionSnapshot(name);
    snap.id = currentSessionId;
    snap.playthroughStartMs = rootStart;
    snap.createdAtMs = rootStart;
    snap.realStartLabel = formatRealDate(rootStart);
    snap.playMs = getLivePlayMs();

    // наследуем автосейв-связь только при перезаписи того же id
    const prev = getSession(currentSessionId);
    if (prev && !asNew) {
        snap.isAutosave = !!prev.isAutosave;
        snap.parentSessionId = prev.parentSessionId || null;
        snap.autosaveId = prev.autosaveId || null;
        if (prev.isAutosave) snap.name = prev.name;
    } else {
        snap.isAutosave = false;
        snap.parentSessionId = null;
        // новый слот — без чужого autosaveId
        snap.autosaveId = null;
    }

    const all = readAll();
    all.sessions[currentSessionId] = snap;
    writeAll(all);
    // open-сегмент продолжается; commit уже сделан
    if (!sessionOpenedAtMs) sessionOpenedAtMs = Date.now();
    return snap;
}

/** Перезаписать указанный слот текущим состоянием */
export function overwriteSession(sessionId, name) {
    const existing = getSession(sessionId);
    const forceName = existing?.isAutosave ? existing.name : name;

    commitPlayClock();

    // дата начала: от текущего прохождения (не «сейчас»)
    const rootStart = playthroughStartMs
        || existing?.playthroughStartMs
        || existing?.createdAtMs
        || getPlaythroughStartMs();
    playthroughStartMs = rootStart;

    const snap = collectSessionSnapshot(forceName || existing?.name);
    snap.id = sessionId;
    snap.playthroughStartMs = rootStart;
    snap.createdAtMs = rootStart;
    snap.realStartLabel = formatRealDate(rootStart);
    snap.playMs = getLivePlayMs();

    if (existing) {
        snap.isAutosave = !!existing.isAutosave;
        snap.parentSessionId = existing.parentSessionId || null;
        snap.autosaveId = existing.autosaveId || null;
        if (existing.isAutosave) snap.name = existing.name;
    }
    const all = readAll();
    all.sessions[sessionId] = snap;
    writeAll(all);
    if (!sessionOpenedAtMs) sessionOpenedAtMs = Date.now();
    return snap;
}

/**
 * Применить снимок сессии к рантайму (после loadMainGame / init).
 */
export function applySessionSnapshot(snap) {
    if (!snap) return false;
    currentSessionId = snap.id;
    // восстановить часы: только сумма прошлых заходов, новый вагон с загрузки
    playthroughStartMs = snap.playthroughStartMs || snap.createdAtMs || Date.now();
    playSegments = Array.isArray(snap.playSegments)
        ? snap.playSegments.filter(s => !s.open).map(s => ({
            startMs: s.startMs, endMs: s.endMs, ms: s.ms
        }))
        : [];
    // если в сейве есть playMs — доверяем ему как сумме (на случай старых сейвов без segments)
    const segSum = playSegments.reduce((a, s) => a + (Number(s.ms) || 0), 0);
    accumulatedPlayMs = Math.max(segSum, Math.max(0, Number(snap.playMs) || 0));
    // если segments пусты, но playMs есть — оставляем accumulated = playMs
    if (!playSegments.length && accumulatedPlayMs > 0) {
        // один синтетический вагон для истории
        playSegments = [{
            startMs: playthroughStartMs,
            endMs: playthroughStartMs + accumulatedPlayMs,
            ms: accumulatedPlayMs
        }];
    }
    sessionOpenedAtMs = Date.now(); // новый заход
    setSessionNameMemory(snap.name);

    // игровое время
    if (snap.gameTimeMs && startTime instanceof Date) {
        startTime.setTime(snap.gameTimeMs);
    }

    // квесты
    if (snap.quests && state.quests) {
        state.quests.active = [...(snap.quests.active || [])];
        state.quests.completed = [...(snap.quests.completed || [])];
        state.quests.failed = [...(snap.quests.failed || [])];
        state.quests.removedCards = [...(snap.quests.removedCards || [])];
        state.quests.playerGender = snap.quests.playerGender || null;
        state.quests.flags = { ...(snap.quests.flags || {}) };
        state.quests.progress = JSON.parse(JSON.stringify(snap.quests.progress || {}));
        try {
            import('./quests.js').then(m => {
                if (m.applyGenderToHeader) m.applyGenderToHeader();
            }).catch(() => {});
        } catch (_) {}
    }

    // здания / специалисты / рецепты
    if (snap.locationBuildings) {
        state.locationBuildings = JSON.parse(JSON.stringify(snap.locationBuildings));
    }
    if (snap.locationGeoSurvey) {
        try { applyGeoSurveySnapshot(snap.locationGeoSurvey); } catch (e) { console.warn(e); }
    }
    if (snap.locationCartography) {
        try { applyCartographySnapshot(snap.locationCartography); } catch (e) { console.warn(e); }
    }
    if (snap.locationUnits) {
        try { applyUnitsSnapshot(snap.locationUnits); } catch (e) { console.warn(e); }
    }
    if (snap.locationSpecialists) {
        state.locationSpecialists = JSON.parse(JSON.stringify(snap.locationSpecialists));
    }
    if (snap.locationBuildingRecipes) {
        state.locationBuildingRecipes = JSON.parse(JSON.stringify(snap.locationBuildingRecipes));
    }
    if (snap.populationAccum) {
        state.populationAccum = JSON.parse(JSON.stringify(snap.populationAccum));
    }
    try {
        applyTechProgressSnapshot(snap.techProgress || {});
    try { import('./developerConsole.js').then(m => m.applyDevConsoleFromSave?.(snap)); } catch (_) {}
    } catch (e) { console.warn('techProgress apply', e); }

    try {
        applyBodyCustomNamesSnapshot(snap.bodyCustomNames || {});
    } catch (e) { console.warn('bodyCustomNames apply', e); }

    try {
        applyNotepadSnapshot(snap.notepadText || '');
    } catch (e) { console.warn('notepad apply', e); }

    try {
        applyCalculatorSnapshot(snap.calculatorHistory || []);
    } catch (e) { console.warn('calculator apply', e); }

    try {
        if (snap.trendHistory) applyTrendHistorySnapshot(snap.trendHistory);
    } catch (e) { console.warn('trendHistory apply', e); }

    try {
        const ts = snap.timeSpeedState || snap;
        const spd = ts.timeSpeed != null ? ts.timeSpeed : (snap.timeSpeed != null ? snap.timeSpeed : 1);
        const before = ts.speedBeforePause != null ? ts.speedBeforePause : 1;
        applyTimeSpeedFromSave(spd, before);
    } catch (e) { console.warn('timeSpeed apply', e); }

    // ресурсы и население на телах
    if (snap.bodyResources) {
        for (const id of Object.keys(snap.bodyResources)) {
            const body = state.celestialBodies?.[id] || state.celestialBodies?.[Number(id)];
            if (!body?.data) continue;
            if (!body.data.resources) body.data.resources = {};
            const br = snap.bodyResources[id];
            body.data.resources.population = Number(br.population) || 0;
            body.data.resources.stock = { ...(br.stock || {}) };
        }
    }

    // орбиты и вращение
    if (snap.bodyOrbits) {
        applyBodyOrbits(snap.bodyOrbits);
    }
    // Жёстко восстановить позиции систем/звёзд по centerX/Z (орбиты их не трогают)
    try { restoreSystemAnchors(); } catch (e) { console.warn(e); }

    // ---- камера + локация ----
    const cam = snap.camera || {};
    let height = cam.height != null ? cam.height : (cam.y != null ? cam.y : 3);
    height = Math.max(3, Math.min(25000, Number(height) || 3));

    const bodiesMap = state.celestialBodies || {};
    let loc = null;
    if (cam.bodyId != null) {
        loc = bodiesMap[cam.bodyId] || bodiesMap[String(cam.bodyId)] || bodiesMap[Number(cam.bodyId)] || null;
    }

    // Сброс звёзд после 4ZC
    for (const id of Object.keys(bodiesMap)) {
        const e = bodiesMap[id];
        if (!e?.mesh) continue;
        if (e.data?.type === 'star') {
            e.mesh.scale.set(1, 1, 1);
            e.mesh.visible = true;
            e.mesh.layers.enable(0);
            if (e.mesh.material?.uniforms?.interstellarMode) {
                e.mesh.material.uniforms.interstellarMode.value = 0;
            }
            if (e.mesh.material?.uniforms?.cameraDistance) {
                e.mesh.material.uniforms.cameraDistance.value = height;
            }
        }
        if (e.data?.type === 'planet' || e.data?.type === 'moon') {
            e.mesh.layers.enable(0);
        }
    }

    if (camera) {
        camera.far = (height >= 6500) ? 120000 : 30000;
        camera.near = 0.1;
        camera.updateProjectionMatrix();
        try { camera.layers.mask = 0xffffffff; } catch (_) {
            camera.layers.enable(0); camera.layers.enable(1); camera.layers.enable(2);
        }
        camera.up.set(0, 0, -1);

        let px = Number(cam.x), pz = Number(cam.z);
        if (!Number.isFinite(px) || !Number.isFinite(pz)) {
            if (loc?.mesh) { px = loc.mesh.position.x || 0; pz = loc.mesh.position.z || 0; }
            else { px = 0; pz = 0; }
        }
        camera.position.set(px, height, pz);
        setTargetCameraY(height);
        camera.lookAt(px, 0, pz);
    }

    // UI-локация; trackedBody НЕ ставим на system/nebula (ломает well-track → чёрный экран)
    if (loc) {
        setCurrentLocation(loc);
        setTrackedBody(null); // system/nebula не трекаем
        try {
            const el = document.getElementById('location-name');
            if (el && loc.data?.name) {
                const n = loc.data.name;
                el.textContent = (typeof n === 'object') ? (n.ru || n.en || '') : String(n);
            }
        } catch (_) {}
        try {
            // динамический import без top-level await
            import('./ui.js').then(m => { try { m.updateBodyMenu(loc); } catch (_) {} }).catch(() => {});
        } catch (_) {}

        const t = loc.data?.type;
        if (t === 'planet' || t === 'moon' || t === 'star') {
            try {
                focusBodyAtHeight(loc.data.id, height);
                if (camera && Number.isFinite(Number(cam.x)) && Number.isFinite(Number(cam.z))) {
                    camera.position.set(Number(cam.x), height, Number(cam.z));
                    setTargetCameraY(height);
                    camera.lookAt(camera.position.x, 0, camera.position.z);
                }
            } catch (_) {}
        }
    }

    try { startAutosaveTimer(); } catch (_) {}
    return true;

}

/** Восстановить углы орбит/вращения и позиции на карте */

/** Позиции starSystem / star / nebula из centerX/Z (и parent-туманности). */
function restoreSystemAnchors() {
    const bodies = state.celestialBodies || {};
    // Сначала туманности
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        if (e?.data?.type !== 'interstellarNebula' || !e.mesh) continue;
        e.mesh.position.set(Number(e.data.centerX) || 0, e.mesh.position.y || 0, Number(e.data.centerZ) || 0);
    }
    // Системы относительно туманности
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        if (e?.data?.type !== 'starSystem' || !e.mesh) continue;
        let ox = Number(e.data.centerX) || 0;
        let oz = Number(e.data.centerZ) || 0;
        const p = e.data.parent != null ? bodies[e.data.parent] : null;
        if (p?.mesh) {
            ox += p.mesh.position.x;
            oz += p.mesh.position.z;
        }
        e.mesh.position.set(ox, 0, oz);
    }
    // Звёзды с centerX/Z (без parent-орбиты)
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        if (e?.data?.type !== 'star' || !e.mesh) continue;
        if (e.data.parent != null) continue;
        const cx = Number(e.data.centerX) || 0;
        const cz = Number(e.data.centerZ) || 0;
        e.mesh.position.set(cx, 0, cz);
        e.mesh.scale.set(1, 1, 1);
        if (e.mesh.material?.uniforms?.interstellarMode) {
            e.mesh.material.uniforms.interstellarMode.value = 0;
        }
        e.mesh.visible = true;
    }
}

export function applyBodyOrbits(bodyOrbits) {
    if (!bodyOrbits) return;
    const bodies = state.celestialBodies || {};
    // несколько проходов: сначала родители (звёзды/системы), потом дети
    const ids = Object.keys(bodyOrbits);
    const order = ids.slice().sort((a, b) => {
        const da = bodies[a]?.data || bodies[Number(a)]?.data;
        const db = bodies[b]?.data || bodies[Number(b)]?.data;
        const pa = da?.parent == null ? 0 : 1;
        const pb = db?.parent == null ? 0 : 1;
        return pa - pb;
    });
    for (const id of order) {
        const ang = bodyOrbits[id];
        if (!ang) continue;
        const body = bodies[id] || bodies[Number(id)];
        if (!body?.mesh) continue;
        const mesh = body.mesh;
        if (ang.rotationY != null && mesh.rotation) {
            mesh.rotation.y = Number(ang.rotationY) || 0;
        }
        if (ang.orbitAngle != null) {
            mesh.userData.orbitAngle = Number(ang.orbitAngle) || 0;
        }
        // позиция по орбите (НЕ для starSystem / interstellarNebula — у них centerX/Z)
        const data = body.data;
        if (data && data.type !== 'starSystem' && data.type !== 'interstellarNebula' && data.type !== 'galaxy'
            && data.parent != null && data.distance != null) {
            const parent = bodies[data.parent] || bodies[Number(data.parent)];
            const parentMesh = parent?.mesh;
            if (parentMesh) {
                const a = mesh.userData.orbitAngle ?? 0;
                mesh.position.x = parentMesh.position.x + data.distance * Math.cos(a);
                mesh.position.z = parentMesh.position.z + data.distance * Math.sin(a);
                if (body.orbitLine) body.orbitLine.position.copy(parentMesh.position);
                if (body.gravityWellLine) body.gravityWellLine.position.copy(mesh.position);
                if (body.gravityWellGradient) body.gravityWellGradient.position.copy(mesh.position);
                if (body.gravityWellGrid) body.gravityWellGrid.position.copy(mesh.position);
            }
        }
    }
}

export function getMainQuestTitle(snap) {
    const id = snap?.mainQuestId;
    if (!id) return t('save.noQuest') || '—';
    try {
        // title from localization via quests module async not available — use progress/catalog
        const cat = globalThis.__questCatalog;
        // fallback id
        return id;
    } catch (_) {
        return id;
    }
}

/** Подпись текущего квеста для карточки (с локализацией через quests) */
/** Кэш локализации квестов для карточек сейвов (холодный старт) */
let _questLocCache = null;
async function ensureQuestLocCache() {
    if (_questLocCache) return _questLocCache;
    try {
        const mod = await import('./quests.js');
        const loc = mod.getLocalization?.();
        if (loc?.quests) {
            _questLocCache = loc;
            return _questLocCache;
        }
    } catch (_) {}
    try {
        const res = await fetch('questsLocalization.json');
        if (res.ok) {
            _questLocCache = await res.json();
            return _questLocCache;
        }
    } catch (_) {}
    _questLocCache = { quests: {}, npc: {} };
    return _questLocCache;
}

function pickLocTitle(titleObj) {
    if (!titleObj) return null;
    if (typeof titleObj === 'string') return titleObj;
    const lang = (typeof t === 'function' ? null : null);
    let L = 'ru';
    try {
        // settings getLang via t side-channel — use import sync not available; try window
        const { getLang } = requireLang();
        L = getLang?.() || 'ru';
    } catch (_) {
        L = 'ru';
    }
    if (typeof titleObj === 'object') {
        return titleObj[L] || titleObj.ru || titleObj.en || titleObj.de || null;
    }
    return null;
}

function requireLang() {
    // getLang already imported from settings as part of t module — re-import pattern
    return { getLang: () => {
        try {
            // settings.js exports getLang — already imported t from settings; use dynamic
            return (window.__uiLang) || localStorage.getItem('ascension_era6_system') && JSON.parse(localStorage.getItem('ascension_era6_system')||'{}').lang || 'ru';
        } catch (_) { return 'ru'; }
    }};
}

export async function resolveMainQuestTitle(snap) {
    // сохранённый заголовок (если писали при сейве)
    if (snap?.mainQuestTitle) return snap.mainQuestTitle;

    const id = snap?.mainQuestId || snap?.quests?.active?.[0];
    if (!id) return t('save.noQuest') || '—';

    // 1) через уже загруженный каталог квестов
    try {
        const mod = await import('./quests.js');
        if (mod.getQuestById && mod.resolveQuestTitle) {
            const q = mod.getQuestById(id);
            if (q) {
                const title = mod.resolveQuestTitle(q);
                if (title && title !== id) return title;
            }
        }
        if (mod.getQuestViewModel) {
            const vm = mod.getQuestViewModel(id);
            if (vm?.title && vm.title !== id) return vm.title;
        }
    } catch (_) {}

    // 2) напрямую из questsLocalization.json (холодный старт меню)
    try {
        const loc = await ensureQuestLocCache();
        const titleObj = loc?.quests?.[id]?.title;
        let L = 'ru';
        try {
            const raw = localStorage.getItem('ascension_era6_system');
            if (raw) L = JSON.parse(raw).lang || 'ru';
        } catch (_) {}
        if (titleObj) {
            if (typeof titleObj === 'string') return titleObj;
            return titleObj[L] || titleObj.ru || titleObj.en || titleObj.de || id;
        }
    } catch (_) {}

    return id;
}

export function avatarSrcForGender(gender) {
    if (gender === 'male') return 'assets/textures/icons/manhero.png';
    if (gender === 'female') return 'assets/textures/icons/womanhero.png';
    return 'assets/textures/icons/gender_unknown.png';
}


// ===== Автосохранение =====
let lastAutosaveAtMs = 0;
let autosaveTimerId = null;

function autosaveDisplayName(parentName) {
    const suffix = t('save.autosaveSuffix') || '[Автосохранение]';
    const base = (parentName || t('save.unnamed') || 'Сессия').replace(/\s*\[.*?\]\s*$/, '').trim();
    return `${base} ${suffix}`;
}

/**
 * Создаёт или обновляет единственную братскую сессию автосохранения
 * для текущей (родительской) сессии. Имя автосейва не меняется после создания.
 */
export function performAutosave() {
    if (!currentSessionId) return null;
    const parent = getSession(currentSessionId);
    // если сейчас «текущая» — автосейв, ищем родителя
    let parentId = currentSessionId;
    if (parent?.isAutosave) {
        parentId = parent.parentSessionId || currentSessionId;
    }
    const parentSes = getSession(parentId);
    if (!parentSes || parentSes.isAutosave) {
        // нет нормального родителя — некуда вешать автосейв
        return null;
    }

    const all = readAll();
    let autoId = parentSes.autosaveId;
    let existing = autoId ? all.sessions[autoId] : null;
    if (!existing) {
        // поиск
        for (const s of Object.values(all.sessions)) {
            if (s.isAutosave && s.parentSessionId === parentId) {
                existing = s;
                autoId = s.id;
                break;
            }
        }
    }

    commitPlayClock();
    const snap = collectSessionSnapshot(parentSes.name);
    const now = Date.now();
    const rootStart = playthroughStartMs
        || parentSes.playthroughStartMs
        || parentSes.createdAtMs
        || now;
    snap.playthroughStartMs = rootStart;
    snap.createdAtMs = rootStart;
    snap.realStartLabel = formatRealDate(rootStart);
    snap.playMs = getLivePlayMs();

    if (existing) {
        snap.id = existing.id;
        snap.name = existing.name;
        snap.isAutosave = true;
        snap.parentSessionId = parentId;
        all.sessions[existing.id] = snap;
        all.sessions[parentId].autosaveId = existing.id;
    } else {
        autoId = uid();
        snap.id = autoId;
        snap.name = autosaveDisplayName(parentSes.name);
        snap.isAutosave = true;
        snap.parentSessionId = parentId;
        all.sessions[autoId] = snap;
        all.sessions[parentId].autosaveId = autoId;
    }
    writeAll(all);
    lastAutosaveAtMs = now;
    console.log('[autosave] saved', autoId, 'parent', parentId);
    return all.sessions[autoId];
}

export function resyncAutosaveTimer() {
    stopAutosaveTimer();
    startAutosaveTimer();
}

export function startAutosaveTimer() {
    stopAutosaveTimer();
    let mins = 0;
    try {
        // dynamic import avoid cycle — use localStorage system key
        const raw = localStorage.getItem('ascension_era6_system');
        if (raw) mins = Math.max(0, Math.min(60, Number(JSON.parse(raw).autosaveMinutes) || 0));
    } catch (_) {}
    try {
        // if settings already loaded
        import('./settings.js').then(m => {
            if (typeof m.getAutosaveMinutes === 'function') {
                mins = m.getAutosaveMinutes();
                schedule(mins);
            }
        }).catch(() => schedule(mins));
    } catch (_) {
        schedule(mins);
    }
    function schedule(m) {
        stopAutosaveTimer();
        if (!m || m <= 0) return;
        const intervalMs = m * 60 * 1000;
        lastAutosaveAtMs = Date.now();
        autosaveTimerId = setInterval(() => {
            if (typeof window !== 'undefined' && window.__gameStarted) {
                try { performAutosave(); } catch (e) { console.warn('autosave', e); }
            }
        }, intervalMs);
    }
}

export function stopAutosaveTimer() {
    if (autosaveTimerId) {
        clearInterval(autosaveTimerId);
        autosaveTimerId = null;
    }
}

/** Тик из игрового цикла (доп. страховка к setInterval) */
export function tickAutosave() {
    let mins = 0;
    try {
        const raw = localStorage.getItem('ascension_era6_system');
        if (raw) mins = Number(JSON.parse(raw).autosaveMinutes) || 0;
    } catch (_) {}
    if (!mins || mins <= 0) return;
    if (!currentSessionId) return;
    if (typeof window !== 'undefined' && !window.__gameStarted) return;
    const intervalMs = mins * 60 * 1000;
    const now = Date.now();
    if (!lastAutosaveAtMs) lastAutosaveAtMs = now;
    if (now - lastAutosaveAtMs >= intervalMs) {
        performAutosave();
    }
}


/** Слушатели: пауза часов при скрытии вкладки / уходе со страницы */
export function initPlayClockListeners() {
    if (typeof document === 'undefined') return;
    if (document.body?.dataset?.playClockBound) return;
    if (document.body) document.body.dataset.playClockBound = '1';

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            pausePlayClock();
        } else if (document.visibilityState === 'visible') {
            // возобновлять только если игра запущена и меню не поверх
            if (window.__gameStarted && !document.body.classList.contains('main-menu-active')) {
                resumePlayClock();
            }
        }
    });
    window.addEventListener('pagehide', () => { pausePlayClock(); });
}
