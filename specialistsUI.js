import { currentLocation } from './camera.js';
import {
    getSpecialistStats,
    setSpecialistPercent,
    rolePercent
} from './specialists.js';
import { updateResourceBar } from './resourceUI.js';
import { evaluateNpcTriggers } from './npcDialogue.js';
import { tickQuests } from './quests.js';

let listenersBound = false;
let _specAnimTok = 0;

export function refreshSpecialistsPanel(locationId) {
    const panel = document.getElementById('specialists-panel');
    if (!panel || panel.style.display === 'none') return;

    const stats = getSpecialistStats(locationId);

    const idlersEl = document.getElementById('spec-summary-idlers');
    const creatorsEl = document.getElementById('spec-summary-creators');
    if (idlersEl) idlersEl.textContent = String(stats.idlers);
    if (creatorsEl) creatorsEl.textContent = String(stats.creators);

    const roles = [
        { key: 'engineers', max: stats.maxEngineers, count: stats.engineers },
        { key: 'agronomists', max: stats.maxAgronomists, count: stats.agronomists },
        { key: 'scientists', max: stats.maxScientists, count: stats.scientists },
        { key: 'expeditioners', max: stats.maxExpeditioners, count: stats.expeditioners }
    ];

    for (const r of roles) {
        const pct = rolePercent(r.count, r.max);
        const slider = document.getElementById(`spec-slider-${r.key}`);
        const pctEl = document.getElementById(`spec-pct-${r.key}`);
        const countsEl = document.getElementById(`spec-counts-${r.key}`);
        if (slider && document.activeElement !== slider) {
            slider.value = String(pct);
        } else if (slider && document.activeElement === slider) {
            // во время драга не перебиваем value — обновим meta
        } else if (slider) {
            slider.value = String(pct);
        }
        if (pctEl) pctEl.textContent = `${pct}%`;
        // [нанято / свободные тунеядцы]
        if (countsEl) countsEl.textContent = `[${r.count} / ${stats.idlers}]`;
    }
}

export function showSpecialistsPanel(show) {
    const panel = document.getElementById('specialists-panel');
    if (!panel) return;
    if (show) {
        const already = panel.style.display === 'flex'
            && panel.classList.contains('open')
            && panel.dataset.panelAnim !== 'leave';
        _specAnimTok += 1;
        panel.classList.remove('is-leaving');
        panel.style.display = 'flex';
        if (!already) {
            panel.dataset.panelAnim = 'enter';
            panel.classList.remove('open');
            void panel.offsetWidth;
            requestAnimationFrame(() => {
                panel.classList.add('open');
                panel.dataset.panelAnim = 'open';
            });
        } else {
            panel.classList.add('open');
            panel.dataset.panelAnim = 'stay';
        }
        if (currentLocation?.data?.id != null) {
            refreshSpecialistsPanel(currentLocation.data.id);
        }
        return;
    }
    if (panel.style.display !== 'flex' || panel.dataset.panelAnim === 'leave') {
        panel.style.display = 'none';
        panel.classList.remove('open', 'is-leaving');
        panel.dataset.panelAnim = '';
        return;
    }
    const tok = ++_specAnimTok;
    panel.dataset.panelAnim = 'leave';
    panel.classList.remove('open');
    panel.classList.add('is-leaving');
    const finish = () => {
        if (tok !== _specAnimTok) return;
        panel.style.display = 'none';
        panel.classList.remove('open', 'is-leaving');
        panel.dataset.panelAnim = '';
    };
    const onEnd = (e) => {
        if (e.target !== panel) return;
        panel.removeEventListener('transitionend', onEnd);
        finish();
    };
    panel.addEventListener('transitionend', onEnd);
    setTimeout(finish, 520);
}

function onSliderInput(e) {
    const slider = e.target;
    const role = slider.dataset.role;
    if (!role || !currentLocation?.data?.id) return;
    const locId = currentLocation.data.id;
    const percent = Number(slider.value) || 0;
    setSpecialistPercent(locId, role, percent);
    refreshSpecialistsPanel(locId);
    // бар населения / popup
    updateResourceBar(currentLocation);
    // сразу пересчитать квест (найм инженера → OBJ_HIRE_ONE_ENG → подсказка Селезнёва)
    try {
        tickQuests();
        evaluateNpcTriggers();
    } catch (_) {}
}

export function initSpecialistsUI() {
    if (listenersBound) return;
    listenersBound = true;
    document.querySelectorAll('.specialist-slider').forEach(slider => {
        slider.addEventListener('input', onSliderInput);
        slider.addEventListener('change', onSliderInput);
    });
}
