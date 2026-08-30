// bodyParameters.js
import { t, getLang } from './settings.js';

export function calculateBodyParameters(radius) {
    const diameter = radius * 2;
    const surfaceArea = 4 * Math.PI * radius * radius;
    return { diameter, surfaceArea };
}

/** Масштабные приставки: тыс./млн./… или k/M/B/T */
function scalePrefix(value) {
    const v = Number(value) || 0;
    if (v >= 1e12) return { n: v / 1e12, key: 'unit.trillion' };
    if (v >= 1e9)  return { n: v / 1e9,  key: 'unit.billion' };
    if (v >= 1e6)  return { n: v / 1e6,  key: 'unit.million' };
    if (v >= 1e3)  return { n: v / 1e3,  key: 'unit.thousand' };
    return { n: v, key: null };
}

/**
 * @param {number} value
 * @param {string} unit - готовая единица или ключ unit.* (км / unit.km)
 * @param {string} [language] - устаревший параметр, язык берётся из getLang()
 */
export function formatValue(value, unit, language) {
    const { n, key } = scalePrefix(value);
    const formattedValue = (key ? n : Number(value) || 0).toFixed(2);
    const prefix = key ? (t(key) + ' ') : '';
    // unit может быть ключом локализации или литералом
    let unitText = unit || '';
    if (unit === 'км' || unit === 'unit.km') unitText = t('unit.km');
    else if (unit === 'км²' || unit === 'unit.km2') unitText = t('unit.km2');
    else if (unit === 'а.е.' || unit === 'unit.au') unitText = t('unit.au');
    else if (unit === 'а.е.²' || unit === 'unit.au2') unitText = t('unit.au2');
    return `${formattedValue} ${prefix}${unitText}`.replace(/\s+/g, ' ').trim();
}

/** Типы поверхностей (не для звёзд). В JSON задаётся процент от общей площади. */
export const SURFACE_AREA_TYPES = [
    { key: 'land',      i18n: 'surface.land' },
    { key: 'water',     i18n: 'surface.water' },
    { key: 'forests',   i18n: 'surface.forests' },
    { key: 'deserts',   i18n: 'surface.deserts' },
    { key: 'mountains', i18n: 'surface.mountains' },
    { key: 'plains',    i18n: 'surface.plains' },
    { key: 'steppes',   i18n: 'surface.steppes' },
    { key: 'rivers',    i18n: 'surface.rivers' },
    { key: 'lakes',     i18n: 'surface.lakes' },
    { key: 'glaciers',  i18n: 'surface.glaciers' }
];

/**
 * Считает абсолютные площади (км²) по процентам от общей площади.
 */
export function calculateSurfaceBreakdown(surfaceArea, percents = {}) {
    const total = Number(surfaceArea) || 0;
    return SURFACE_AREA_TYPES.map(({ key, i18n }) => {
        const percent = Number(percents[key]) || 0;
        const areaKm2 = total * (percent / 100);
        const label = t(i18n);
        const text = `${formatValue(areaKm2, 'км²')} [${percent % 1 === 0 ? percent : Number(percent.toFixed(2))}%]`;
        return { key, label, percent, areaKm2, text };
    });
}

/** Если км слишком велики (≥ 1e9), показываем в а.е. */
export function formatDistanceAuto(km) {
    const AU = 149597870.7;
    const v = Number(km) || 0;
    if (v >= 1e9) {
        const au = v / AU;
        if (au >= 1000) {
            return `${(au / 1000).toFixed(2)} ${t('unit.thousand')} ${t('unit.au')}`;
        }
        return `${au.toFixed(2)} ${t('unit.au')}`;
    }
    return formatValue(v, 'км');
}
