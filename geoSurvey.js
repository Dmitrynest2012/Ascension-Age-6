/**
 * UI гео-разведки: осциллограф, статусы, зонд, тик мини-игры.
 */
import { t, onLanguageChange } from './settings.js';
import {
    enterGeoSurvey, exitGeoSurvey, isGeoSurveyActive, getGeoSurveyBody,
    getGeoSurveyAngles, isGeoSurveyCameraStill
} from './geoSurveyCamera.js';
import { currentLocation } from './camera.js';
import { keys } from './camera.js';
import { camera } from './camera.js';
import { state } from './state.js';
import {
    ensureBodyDeposits, signalAt, markDepositScanned, isBodySurveyComplete,
    startScannerAudio, updateScannerAudio, stopScannerAudio, statusMessageFor
} from './geoSurveyGame.js';
import {
    ensureSurveyVisuals, updateSurveyVisuals, clearSurveyVisuals, pulseProbeToDeposit, rebuildFog, startProbeWave
} from './geoSurveyVisuals.js';

let panelVisible = false;
let rafId = 0;
let canvas = null;
let ctx = null;
let waveHistory = [];
let lastSignal = { strength: 0, zone: 'noise', deposit: null };
let probeBusy = false;
let probeProgress = 0; // 0..1
let probeDepositId = null;
let probeStartMs = 0;
const PROBE_MS = 5000;
const INNER_HOLD_MS = 5000;
let innerHoldMs = 0;
let innerHoldDepositId = null;
let probeUnlocked = false;
let innerHoldStartMs = 0;


function $(id) { return document.getElementById(id); }

function refreshI18n(root) {
    (root || document).querySelectorAll?.('[data-i18n]')?.forEach?.(node => {
        const key = node.getAttribute('data-i18n');
        if (key) node.textContent = t(key);
    });
}

export function showGeoSurveyPanel(visible) {
    const panel = $('geosurvey-panel');
    if (!panel) return;
    panelVisible = !!visible;
    panel.style.display = visible ? 'flex' : 'none';
    if (visible) {
        refreshI18n(panel);
        const body = currentLocation;
        if (body?.mesh && body.data?.type !== 'star' && body.data?.type !== 'starSystem' && body.data?.type !== 'interstellarNebula') {
            ensureBodyDeposits(body);
            enterGeoSurvey(body);
            ensureSurveyVisuals(body);
            startLoop();
            updatePanelMeta(body);
        }
    } else {
        stopLoop();
        stopScannerAudio();
        clearSurveyVisuals();
        exitGeoSurvey();
        probeBusy = false;
        probeProgress = 0;
        probeDepositId = null;
        innerHoldMs = 0;
        innerHoldDepositId = null;
        probeUnlocked = false;
    }
}

function updatePanelMeta(body) {
    const entry = ensureBodyDeposits(body);
    const scanning = !!(keys.space && isGeoSurveyCameraStill());

    const countStr = entry ? `${entry.scannedCount} / ${entry.total}` : '0 / 0';
    const countMeta = $('geosurvey-count-meta');
    if (countMeta) countMeta.textContent = countStr;
    const done = isBodySurveyComplete(body);
    const btn = $('geosurvey-probe-btn');
    if (btn) {
        const canProbe = !done && !probeBusy && probeUnlocked && lastSignal.zone === 'inner';
        btn.disabled = !canProbe;
        btn.classList.toggle('ready', canProbe);
        if (done) {
            btn.textContent = t('geoSurvey.probe.done') || 'Разведка завершена';
        } else if (probeBusy) {
            btn.textContent = `${t('geoSurvey.probe.progress') || 'Зонд'} ${Math.floor(probeProgress * 100)}%`;
        } else if (scanning && lastSignal.zone === 'inner' && !probeUnlocked) {
            const pct = Math.min(100, Math.floor((innerHoldMs / INNER_HOLD_MS) * 100));
            btn.textContent = `${t('geoSurvey.probe.lock') || 'Сканирование ядра'} ${pct}%`;
        } else {
            btn.textContent = t('geoSurvey.probe') || 'Спустить зонд';
        }
    }
    const bar = $('geosurvey-probe-bar');
    const track = bar?.parentElement;
    if (bar && track) {
        let pct = 0;
        let mode = '';
        if (probeBusy) {
            pct = Math.min(100, probeProgress * 100);
            mode = 'probe';
        } else if (scanning && lastSignal.zone === 'inner' && !probeUnlocked) {
            pct = Math.min(100, (innerHoldMs / INNER_HOLD_MS) * 100);
            mode = 'scan';
        } else if (probeUnlocked && lastSignal.zone === 'inner') {
            pct = 100;
            mode = 'ready';
        }
        bar.style.width = `${pct}%`;
        track.classList.toggle('active', pct > 0);
        track.classList.toggle('mode-scan', mode === 'scan');
        track.classList.toggle('mode-probe', mode === 'probe');
        track.classList.toggle('mode-ready', mode === 'ready');
        const label = $('geosurvey-progress-label');
        if (label) {
            if (mode === 'scan') label.textContent = `${t('geoSurvey.probe.lock') || 'Сканирование ядра'} — ${Math.floor(pct)}%`;
            else if (mode === 'probe') label.textContent = `${t('geoSurvey.probe.progress') || 'Зонд'} — ${Math.floor(pct)}%`;
            else if (mode === 'ready') label.textContent = t('geoSurvey.probe.ready') || 'Готово к запуску зонда';
            else label.textContent = '';
        }
    }
    const status = $('geosurvey-status');
    if (status && entry) {
        status.textContent = statusMessageFor(
            lastSignal.zone, !!(keys.space && isGeoSurveyCameraStill()), done,
            entry.scannedCount, entry.total
        );
    }
    const badge = $('geosurvey-complete-badge');
    if (badge) badge.style.display = done ? 'block' : 'none';
}

function startLoop() {
    stopLoop();
    canvas = $('geosurvey-scope');
    if (canvas) {
        ctx = canvas.getContext('2d');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth || 400;
        const h = canvas.clientHeight || 120;
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const tick = (now) => {
        rafId = requestAnimationFrame(tick);
        tickSurvey(now);
    };
    rafId = requestAnimationFrame(tick);
}

function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
}

function tickSurvey(now) {
    const body = getGeoSurveyBody() || currentLocation;
    if (!body?.mesh || !panelVisible) return;

    const angles = getGeoSurveyAngles();
    const still = isGeoSurveyCameraStill();
    const scanning = !!(keys.space && still && !isBodySurveyComplete(body) && !probeBusy);

    lastSignal = signalAt(body, angles.yaw, angles.pitch);
    if (scanning) {
        startScannerAudio(lastSignal.strength, lastSignal.zone);
        updateScannerAudio(lastSignal.strength, lastSignal.zone);
    } else {
        stopScannerAudio();
    }

    // 5 сек непрерывного скана в ядре → разблок зонда
    // после 100% unlock держится даже если отпустили пробел (пока смотрим ту же залежь)
    if (scanning && lastSignal.zone === 'inner' && lastSignal.deposit && !probeBusy) {
        if (innerHoldDepositId !== lastSignal.deposit.id) {
            innerHoldDepositId = lastSignal.deposit.id;
            innerHoldStartMs = performance.now();
            probeUnlocked = false;
        }
        innerHoldMs = performance.now() - innerHoldStartMs;
        if (innerHoldMs >= INNER_HOLD_MS) probeUnlocked = true;
    } else if (!probeBusy) {
        if (!lastSignal.deposit || lastSignal.deposit.id !== innerHoldDepositId) {
            // ушли с залежи — полный сброс
            probeUnlocked = false;
            innerHoldDepositId = null;
            innerHoldMs = 0;
            innerHoldStartMs = 0;
        } else if (!scanning && !probeUnlocked) {
            // отпустили пробел до 100% — сброс прогресса, но не «чужой» unlock
            innerHoldMs = 0;
            innerHoldStartMs = 0;
        }
        // если probeUnlocked && та же залежь — оставляем кнопку активной
    }

    // probe progress
    if (probeBusy) {
        probeProgress = Math.min(1, (performance.now() - probeStartMs) / PROBE_MS);
        if (probeProgress >= 1) {
            markDepositScanned(body, probeDepositId);
            probeBusy = false;
            probeDepositId = null;
            probeProgress = 0;
            try { rebuildFog(body); } catch (_) {}
        }
    }

    drawScope(lastSignal.strength, scanning, lastSignal.zone);
    updateSurveyVisuals(body, angles, lastSignal, scanning);
    updatePanelMeta(body);
}

function drawScope(strength, scanning, zone) {
    if (!ctx || !canvas) return;
    const w = canvas.clientWidth || 400;
    const h = canvas.clientHeight || 120;
    // фон
    ctx.fillStyle = 'rgba(4, 12, 10, 0.92)';
    ctx.fillRect(0, 0, w, h);
    // сетка
    ctx.strokeStyle = 'rgba(0, 220, 180, 0.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 20) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 16) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // центральная линия
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.2)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const s = scanning ? strength : strength * 0.15;
    const tnow = performance.now() * 0.001;
    // sample
    let amp = 4 + s * (h * 0.38);
    if (zone === 'inner') amp *= 1.15;
    if (zone === 'noise' || !scanning) amp = 3 + Math.random() * 4;

    const y = h / 2 + Math.sin(tnow * (6 + s * 18)) * amp
        + Math.sin(tnow * (13 + s * 40)) * amp * 0.35
        + (Math.random() - 0.5) * (2 + s * 10);
    waveHistory.push(y);
    const maxSamples = Math.floor(w);
    if (waveHistory.length > maxSamples) waveHistory.shift();

    // история (тусклее)
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0, 180, 140, 0.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i < waveHistory.length; i++) {
        const x = i * (w / maxSamples);
        const yy = waveHistory[i] * 0.55 + h * 0.22;
        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();

    // основная кривая
    ctx.beginPath();
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    if (zone === 'inner' && scanning) {
        grad.addColorStop(0, 'rgba(0,255,200,0.3)');
        grad.addColorStop(0.5, 'rgba(120,255,80,0.95)');
        grad.addColorStop(1, 'rgba(255,220,60,0.9)');
    } else if (zone === 'outer' && scanning) {
        grad.addColorStop(0, 'rgba(0,200,255,0.4)');
        grad.addColorStop(1, 'rgba(0,255,180,0.85)');
    } else {
        grad.addColorStop(0, 'rgba(0,160,140,0.35)');
        grad.addColorStop(1, 'rgba(0,220,180,0.7)');
    }
    ctx.strokeStyle = grad;
    ctx.lineWidth = zone === 'inner' ? 2.2 : 1.5;
    ctx.shadowColor = zone === 'inner' ? 'rgba(180,255,80,0.55)' : 'rgba(0,255,200,0.25)';
    ctx.shadowBlur = zone === 'inner' ? 8 : 3;
    for (let i = 0; i < waveHistory.length; i++) {
        const x = i * (w / maxSamples);
        const yy = waveHistory[i];
        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // бегущий луч
    const beamX = (tnow * 60) % w;
    ctx.fillStyle = 'rgba(0,255,220,0.06)';
    ctx.fillRect(beamX - 30, 0, 60, h);
}

function onProbeClick() {
    const body = getGeoSurveyBody() || currentLocation;
    if (!body || probeBusy || isBodySurveyComplete(body)) return;
    if (lastSignal.zone !== 'inner' || !lastSignal.deposit) return;
    probeBusy = true;
    probeProgress = 0;
    probeDepositId = lastSignal.deposit.id;
    probeStartMs = performance.now();
    pulseProbeToDeposit(body, lastSignal.deposit);
    // Волна только после посадки зонда (~1.1 с анимации)
    const landMs = 1100;
    const waveMs = Math.max(1200, PROBE_MS - landMs);
    setTimeout(() => {
        try { startProbeWave(body, waveMs); } catch (_) {}
    }, landMs);
    updatePanelMeta(body);
}

export function initGeoSurveyUI() {
    onLanguageChange(() => {
        if (!panelVisible) return;
        refreshI18n($('geosurvey-panel'));
        updatePanelMeta(getGeoSurveyBody() || currentLocation);
    });
    document.addEventListener('click', (e) => {
        if (e.target?.id === 'geosurvey-probe-btn') onProbeClick();
    });
    console.log('Geo-survey UI ready');
}

export function isGeoSurveyPanelOpen() {
    return panelVisible;
}
