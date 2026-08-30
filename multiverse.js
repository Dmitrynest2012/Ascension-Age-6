/**
 * Уровень высоты «Мультивселенная» (7ZC) — высший масштаб карты.
 * Пока каркас: камера снаружи гипер-пузыря Вселенной-512.
 * Подробная проработка (другие вселенные и т.д.) — позже.
 */
import { state } from './state.js';
import { UNIVERSE_BUBBLE_RADIUS, isCameraOutsideUniverseBubble } from './universe.js';

export const MULTIVERSE_HEIGHT_MIN = 160000;
export const MULTIVERSE_HEIGHT_MAX = 480000;

/**
 * true, если текущий масштаб — Мультивселенная
 * (геометрически снаружи пузыря ИЛИ высота ≥ MULTIVERSE_HEIGHT_MIN).
 */
export function isMultiverseView(camera, height) {
    const h = Number(height);
    if (Number.isFinite(h) && h >= MULTIVERSE_HEIGHT_MIN) return true;
    try {
        return isCameraOutsideUniverseBubble(camera);
    } catch (_) {
        return false;
    }
}

/** Заготовка визуалов мультивселенной (пока пусто — фон чёрный космос). */
export function createMultiverseVisuals(scene) {
    if (!scene) return;
    if (state.multiverseVisual) return;
    state.multiverseVisual = {
        ready: true
    };
}

export function updateMultiverseVisuals(currentLevelId, height) {
    // Задел на будущее: фон, другие вселенные-пузыри и т.д.
    const mv = state.multiverseVisual;
    if (!mv) return;
    // noop for now
}

/** Найти якорь вселенной (body type=universe). По умолчанию — 512. */
export function findUniverseBody(preferId = 4000) {
    const bodies = state.celestialBodies || {};
    if (preferId != null && (bodies[preferId] || bodies[String(preferId)])) {
        const e = bodies[preferId] || bodies[String(preferId)];
        if (e?.data?.type === 'universe') return e;
    }
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        if (e?.data?.type === 'universe') return e;
    }
    return null;
}

export function findMultiverseBody() {
    const bodies = state.celestialBodies || {};
    for (const id of Object.keys(bodies)) {
        const e = bodies[id];
        if (e?.data?.type === 'multiverse') return e;
    }
    return null;
}
