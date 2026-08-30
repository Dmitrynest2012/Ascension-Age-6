/**
 * Мини-игра гео-разведки: залежи, сигнал, зонд, прогресс, сохранения.
 */
import { state } from './state.js';
import { t } from './settings.js';

/** @type {Record<string, { deposits: Array, completed: boolean, total: number }>} */
export function getGeoSurveyMap() {
    if (!state.locationGeoSurvey) state.locationGeoSurvey = {};
    return state.locationGeoSurvey;
}

function mulberry32(a) {
    return function () {
        let t = (a += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function bodyKey(body) {
    return String(body?.data?.id ?? body?.id ?? '');
}

export function getSurveySiteCount(body) {
    const n = Number(body?.data?.geoSurveySites);
    if (Number.isFinite(n) && n > 0) return Math.min(12, Math.floor(n));
    // по умолчанию: луна 5, планета 4, прочее 3
    const type = body?.data?.type;
    if (type === 'moon') return 5;
    if (type === 'planet') return 4;
    return 3;
}

/**
 * Стабильная генерация залежей (один раз на тело / на игру).
 * Углы в той же системе, что камера гео-разведки: yaw, pitch.
 */
export function ensureBodyDeposits(body) {
    const id = bodyKey(body);
    if (!id) return null;
    const map = getGeoSurveyMap();
    if (map[id]?.deposits?.length) return map[id];

    const total = getSurveySiteCount(body);
    // чем больше точек — тем меньше зона
    const outer = Math.max(0.08, 0.38 / Math.sqrt(total));
    const inner = outer * 0.42;
    const seed = (Number(body?.data?.id) || 1) * 2654435761 + total * 97;
    const rnd = mulberry32(seed >>> 0);
    const deposits = [];
    for (let i = 0; i < total; i++) {
        // залежи по всей сфере, включая полюса
        let yaw = 0, pitch = 0, tries = 0;
        do {
            yaw = rnd() * Math.PI * 2 - Math.PI;
            // равномернее по сфере: pitch = arcsin(2u-1)
            const u = rnd();
            pitch = Math.asin(2 * u - 1);
            tries++;
        } while (
            tries < 60 &&
            deposits.some(d => angDist(d.yaw, d.pitch, yaw, pitch) < outer * 1.45)
        );
        deposits.push({
            id: `dep_${id}_${i}`,
            yaw,
            pitch,
            outer,
            inner,
            scanned: false,
            colorIndex: i % 10
        });
    }

    const completed = !!body?.data?.geoExploration;
    if (completed) deposits.forEach(d => { d.scanned = true; });

    map[id] = {
        deposits,
        total,
        completed,
        scannedCount: deposits.filter(d => d.scanned).length
    };
    return map[id];
}

function angDist(y1, p1, y2, p2) {
    // приближение на сфере направлений
    const dy = Math.atan2(Math.sin(y1 - y2), Math.cos(y1 - y2));
    const dp = p1 - p2;
    return Math.sqrt(dy * dy + dp * dp);
}

/**
 * Сила сигнала 0..1 относительно камеры (yaw,pitch).
 * 0 — тишина, ~0.35 — внешняя зона, 1 — ядро.
 */
/**
 * Углы камеры в ЛОКАЛЬНОЙ системе тела (с учётом mesh.quaternion).
 * Залежи хранятся в тех же локальных yaw/pitch → сигнал не «уедет» при вращении.
 */
export function cameraAnglesInBodyLocal(body, camYaw, camPitch) {
    const mesh = body?.mesh;
    if (!mesh) return { yaw: camYaw, pitch: camPitch };
    // направление камеры от центра тела в мире
    const cp = Math.cos(camPitch);
    const dir = new THREE.Vector3(
        cp * Math.sin(camYaw),
        Math.sin(camPitch),
        cp * Math.cos(camYaw)
    );
    const inv = mesh.quaternion.clone().invert();
    dir.applyQuaternion(inv);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const yaw = Math.atan2(dir.x, dir.z);
    return { yaw, pitch };
}

export function signalAt(body, camYaw, camPitch) {
    const entry = ensureBodyDeposits(body);
    if (!entry || entry.completed) return { strength: 0, zone: 'none', deposit: null };
    // Камера гео-разведки заякорена к телу: yaw/pitch уже локальные
    const local = { yaw: camYaw, pitch: camPitch };
    let best = null;
    let bestD = Infinity;
    for (const d of entry.deposits) {
        if (d.scanned) continue;
        const dist = angDist(local.yaw, local.pitch, d.yaw, d.pitch);
        if (dist < bestD) {
            bestD = dist;
            best = d;
        }
    }
    if (!best) return { strength: 0, zone: 'none', deposit: null };
    if (bestD <= best.inner) {
        return { strength: 1, zone: 'inner', deposit: best, dist: bestD };
    }
    if (bestD <= best.outer) {
        const t = 1 - (bestD - best.inner) / Math.max(1e-6, best.outer - best.inner);
        return { strength: 0.25 + t * 0.45, zone: 'outer', deposit: best, dist: bestD };
    }
    // слабый фон если относительно недалеко
    if (bestD < best.outer * 2.2) {
        const t = 1 - (bestD - best.outer) / (best.outer * 1.2);
        return { strength: Math.max(0.02, t * 0.18), zone: 'far', deposit: best, dist: bestD };
    }
    return { strength: 0.02 + Math.random() * 0.03, zone: 'noise', deposit: null, dist: bestD };
}

export function markDepositScanned(body, depositId) {
    const entry = ensureBodyDeposits(body);
    if (!entry) return entry;
    const d = entry.deposits.find(x => x.id === depositId);
    if (d) d.scanned = true;
    entry.scannedCount = entry.deposits.filter(x => x.scanned).length;
    if (entry.scannedCount >= entry.total) {
        entry.completed = true;
        if (body?.data) body.data.geoExploration = true;
    }
    return entry;
}

export function isBodySurveyComplete(body) {
    const entry = ensureBodyDeposits(body);
    return !!(entry?.completed || body?.data?.geoExploration);
}

/** Снимок для сейва */
export function captureGeoSurveySnapshot() {
    return JSON.parse(JSON.stringify(getGeoSurveyMap()));
}

export function applyGeoSurveySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    state.locationGeoSurvey = JSON.parse(JSON.stringify(snap));
    // синхронизация geoExploration на телах
    for (const id of Object.keys(state.locationGeoSurvey)) {
        const e = state.locationGeoSurvey[id];
        const body = state.celestialBodies?.[id] || state.celestialBodies?.[Number(id)];
        if (body?.data && e?.completed) body.data.geoExploration = true;
    }
}

/** WebAudio: фон (ВЧ) / близость (СЧ) / ядро — взбесившийся ВЧ-сонар */
let audioCtx = null;
let noiseSrc = null;
let noiseGain = null;
let noiseFilter = null;
let midOsc = null;
let midGain = null;
let midFilter = null;
let pingOsc = null;
let pingGain = null;
let pingOsc2 = null;
let pingGain2 = null;
let sonarTimer = null;
let lastSonarStrength = 0;
let lastZone = 'noise';
let sonarRunning = false;

function ensureSonarGraph() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (pingOsc) return;

    // --- фоновый высокочастотный шум ---
    const bufLen = Math.floor(audioCtx.sampleRate * 1.5);
    const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
    noiseSrc = audioCtx.createBufferSource();
    noiseSrc.buffer = buf;
    noiseSrc.loop = true;
    noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 4200;
    noiseFilter.Q.value = 0.9;
    noiseGain = audioCtx.createGain();
    noiseGain.gain.value = 0.0001;
    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(audioCtx.destination);
    noiseSrc.start();

    // --- средний слой (близость) ---
    midOsc = audioCtx.createOscillator();
    midOsc.type = 'triangle';
    midOsc.frequency.value = 380;
    midFilter = audioCtx.createBiquadFilter();
    midFilter.type = 'bandpass';
    midFilter.frequency.value = 520;
    midFilter.Q.value = 3;
    midGain = audioCtx.createGain();
    midGain.gain.value = 0.0001;
    midOsc.connect(midFilter);
    midFilter.connect(midGain);
    midGain.connect(audioCtx.destination);
    midOsc.start();

    // --- пинги сонара ---
    pingOsc = audioCtx.createOscillator();
    pingGain = audioCtx.createGain();
    pingOsc.type = 'sine';
    pingOsc.frequency.value = 900;
    pingGain.gain.value = 0.0001;
    pingOsc.connect(pingGain);
    pingGain.connect(audioCtx.destination);
    pingOsc.start();

    pingOsc2 = audioCtx.createOscillator();
    pingGain2 = audioCtx.createGain();
    pingOsc2.type = 'square';
    pingOsc2.frequency.value = 1400;
    pingGain2.gain.value = 0.0001;
    pingOsc2.connect(pingGain2);
    pingGain2.connect(audioCtx.destination);
    pingOsc2.start();
}

function setLayerGains(strength, zone) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const s = Math.max(0, Math.min(1, strength));
    // фон ВЧ всегда при скане
    const nVol = 0.018 + s * 0.025;
    if (noiseGain) {
        noiseGain.gain.cancelScheduledValues(now);
        noiseGain.gain.linearRampToValueAtTime(nVol, now + 0.08);
    }
    if (noiseFilter) {
        noiseFilter.frequency.value = 3800 + s * 1800;
    }
    // средние — outer/far
    let mVol = 0.0001;
    if (zone === 'far') mVol = 0.02 + s * 0.03;
    if (zone === 'outer') mVol = 0.045 + s * 0.06;
    if (zone === 'inner') mVol = 0.01; // почти гасим — доминирует взбесившийся сонар
    if (midGain) {
        midGain.gain.cancelScheduledValues(now);
        midGain.gain.linearRampToValueAtTime(mVol, now + 0.1);
    }
    if (midOsc) {
        midOsc.frequency.linearRampToValueAtTime(320 + s * 280, now + 0.1);
    }
}

function sonarPing(strength, zone) {
    if (!audioCtx || !pingOsc) return;
    try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (_) {}
    const s = Math.max(0, Math.min(1, strength));
    const now = audioCtx.currentTime;
    let base, vol, vol2, dur;
    if (zone === 'inner') {
        // взбесившийся высокочастотный сонар (тише в ~3 раза)
        base = 1100 + s * 900 + Math.random() * 200;
        vol = (0.16 + s * 0.22) / 3;
        vol2 = vol * 0.4;
        dur = 0.22;
    } else if (zone === 'outer') {
        base = 520 + s * 280;
        vol = 0.1 + s * 0.12;
        vol2 = vol * 0.25;
        dur = 0.4;
    } else {
        // far / noise — редкий тихий ВЧ писк
        base = 2400 + Math.random() * 400;
        vol = 0.035 + s * 0.04;
        vol2 = 0.01;
        dur = 0.18;
    }
    try {
        pingOsc.type = zone === 'inner' ? 'sawtooth' : 'sine';
        pingOsc.frequency.cancelScheduledValues(now);
        pingOsc.frequency.setValueAtTime(base, now);
        pingOsc.frequency.linearRampToValueAtTime(base * (zone === 'inner' ? 1.35 : 0.7), now + dur);
        pingGain.gain.cancelScheduledValues(now);
        pingGain.gain.setValueAtTime(0.0001, now);
        pingGain.gain.linearRampToValueAtTime(vol, now + 0.012);
        pingGain.gain.linearRampToValueAtTime(0.0001, now + dur);

        pingOsc2.frequency.cancelScheduledValues(now);
        pingOsc2.frequency.setValueAtTime(base * 1.7, now);
        pingGain2.gain.cancelScheduledValues(now);
        pingGain2.gain.setValueAtTime(0.0001, now);
        pingGain2.gain.linearRampToValueAtTime(vol2, now + 0.01);
        pingGain2.gain.linearRampToValueAtTime(0.0001, now + dur * 0.85);
    } catch (_) {}
}

export function startScannerAudio(strength, zone = 'noise') {
    try {
        ensureSonarGraph();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        lastSonarStrength = Math.max(0.05, strength);
        lastZone = zone || 'noise';
        setLayerGains(lastSonarStrength, lastZone);
        if (sonarRunning) return;
        sonarRunning = true;
        const beat = () => {
            if (!sonarRunning) return;
            sonarPing(lastSonarStrength, lastZone);
            setLayerGains(lastSonarStrength, lastZone);
            let ms;
            if (lastZone === 'inner') ms = Math.max(90, 220 - lastSonarStrength * 100); // частый бешеный
            else if (lastZone === 'outer') ms = Math.max(280, 700 - lastSonarStrength * 350);
            else ms = Math.max(500, 1100 - lastSonarStrength * 400);
            sonarTimer = setTimeout(beat, ms);
        };
        beat();
    } catch (e) {
        console.warn('scanner audio', e);
    }
}

export function updateScannerAudio(strength, zone = 'noise') {
    lastSonarStrength = Math.max(0.05, Math.min(1, strength));
    lastZone = zone || lastZone;
    setLayerGains(lastSonarStrength, lastZone);
}

export function stopScannerAudio() {
    sonarRunning = false;
    if (sonarTimer) {
        clearTimeout(sonarTimer);
        sonarTimer = null;
    }
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    try {
        [noiseGain, midGain, pingGain, pingGain2].forEach(gn => {
            if (!gn) return;
            gn.gain.cancelScheduledValues(now);
            gn.gain.linearRampToValueAtTime(0.0001, now + 0.08);
        });
    } catch (_) {}
}

export function statusMessageFor(zone, scanning, completed, scanned, total) {
    if (completed) return t('geoSurvey.status.complete') || 'Георазведка завершена';
    if (!scanning) return t('geoSurvey.status.idle') || 'Удерживайте Пробел для сканирования (камера неподвижна)';
    if (zone === 'inner') return t('geoSurvey.status.inner') || 'Фиксирую аномальную активность — ядро залежи!';
    if (zone === 'outer') return t('geoSurvey.status.outer') || 'Регистрирую возмущения, возможно здесь что-то есть';
    if (zone === 'far') return t('geoSurvey.status.far') || 'Слабый отклик на периферии сектора';
    return t('geoSurvey.status.noise') || 'Фоновый шум. Продолжайте поиск';
}

export { angDist };
