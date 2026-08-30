import { state } from './state.js';
import { calcLocationSettled } from './population.js';

/** Все роли специалистов (порядок важен для UI) */
export const ROLES = ['engineers', 'agronomists', 'scientists', 'expeditioners'];

export function getLocationSpecialists(locationId) {
    const lid = Number(locationId);
    if (!state.locationSpecialists) state.locationSpecialists = {};
    if (!state.locationSpecialists[lid]) {
        state.locationSpecialists[lid] = {
            engineers: 0,
            agronomists: 0,
            scientists: 0,
            expeditioners: 0
        };
    }
    const s = state.locationSpecialists[lid];
    for (const r of ROLES) {
        if (s[r] == null || Number.isNaN(Number(s[r]))) s[r] = 0;
        else s[r] = Math.max(0, Math.floor(Number(s[r]) || 0));
    }
    return s;
}

export function clampSpecialistsToSettled(locationId) {
    const settled = Math.max(0, calcLocationSettled(locationId));
    const s = getLocationSpecialists(locationId);
    if (settled <= 0) {
        for (const r of ROLES) s[r] = 0;
        return s;
    }
    let total = ROLES.reduce((sum, r) => sum + (s[r] || 0), 0);
    if (total <= settled) return s;
    if (total <= 0) return s;

    const scale = settled / total;
    for (const r of ROLES) {
        s[r] = Math.floor((s[r] || 0) * scale);
    }
    let assigned = ROLES.reduce((sum, r) => sum + (s[r] || 0), 0);
    let left = settled - assigned;
    for (const r of ROLES) {
        if (left <= 0) break;
        s[r] += 1;
        left -= 1;
    }
    return s;
}

export function getSpecialistStats(locationId) {
    clampSpecialistsToSettled(locationId);
    const settled = calcLocationSettled(locationId);
    const s = getLocationSpecialists(locationId);
    const engineers = s.engineers;
    const agronomists = s.agronomists;
    const scientists = s.scientists;
    const expeditioners = s.expeditioners;
    const creators = engineers + agronomists + scientists + expeditioners;
    const idlers = Math.max(0, settled - creators);
    return {
        settled,
        idlers,
        creators,
        engineers,
        agronomists,
        scientists,
        expeditioners,
        maxEngineers: engineers + idlers,
        maxAgronomists: agronomists + idlers,
        maxScientists: scientists + idlers,
        maxExpeditioners: expeditioners + idlers
    };
}

export function setSpecialistCount(locationId, role, value) {
    if (!ROLES.includes(role)) return getSpecialistStats(locationId);
    const s = getLocationSpecialists(locationId);
    const settled = calcLocationSettled(locationId);
    const others = ROLES.filter(r => r !== role).reduce((sum, r) => sum + (s[r] || 0), 0);
    const maxForRole = Math.max(0, settled - others);
    s[role] = Math.max(0, Math.min(maxForRole, Math.floor(Number(value) || 0)));
    return getSpecialistStats(locationId);
}

export function setSpecialistPercent(locationId, role, percent) {
    const stats = getSpecialistStats(locationId);
    const maxMap = {
        engineers: stats.maxEngineers,
        agronomists: stats.maxAgronomists,
        scientists: stats.maxScientists,
        expeditioners: stats.maxExpeditioners
    };
    const max = maxMap[role] || 0;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const count = Math.round((p / 100) * max);
    return setSpecialistCount(locationId, role, count);
}

export function rolePercent(count, max) {
    if (!max || max <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((count / max) * 100)));
}
