import { getEffectiveVolume, onVolumeChange } from './settings.js';
/**
 * Система внешнего диалога NPC-поручителя (саттелит квестов).
 */
import { state } from './state.js';
import { getQuestProgress, resolveNpcText, resolveNpcName, resolveNpcAvatar } from './quests.js';
import { renderHintMarkup, bindHintLinks, clearAllHints, bindHintHostPanel } from './uiHints.js';
import { refreshVersionVisibility } from './versionHistory.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';

let _npcTextScroll = null;
function ensureNpcTextScroll() {
    const host = document.getElementById('npc-dialogue-text');
    if (!host) return null;
    if (!_npcTextScroll) {
        try {
            _npcTextScroll = attachFirmScroll(host, {
                axis: 'y',
                mirrorV: true,
                host: 'self',
                fillHost: true
            });
        } catch (e) {
            console.warn('npc dialogue firmScroll', e);
        }
    }
    return host.querySelector(':scope > .firm-scroll-inner') || host;
}
function refreshNpcTextScroll() {
    try { _npcTextScroll?.update(); } catch (_) {}
    try { updateFirmScroll(document.getElementById('npc-dialogue-text')); } catch (_) {}
}

let dialogueCatalog = [];
let loaded = false;

export async function loadNpcDialogues() {
    if (loaded) return dialogueCatalog;
    try {
        const res = await fetch('npcDialogues.json');
        const data = await res.json();
        dialogueCatalog = Array.isArray(data.dialogues) ? data.dialogues : [];
        loaded = true;
        if (!state.npcDialogue) {
            state.npcDialogue = { shown: [], queue: [] };
        }
        console.log('NPC dialogues loaded:', dialogueCatalog.length);
    } catch (e) {
        console.error('Failed to load npcDialogues.json', e);
        dialogueCatalog = [];
    }
    return dialogueCatalog;
}

function triggerMatch(tr) {
    const prog = getQuestProgress(tr.questId);
    const st = prog.objectives?.[tr.objectiveId] || 'pending';
    return st === tr.status;
}

export function evaluateNpcTriggers() {
    if (!state.npcDialogue) state.npcDialogue = { shown: [], queue: [] };
    const shown = new Set(state.npcDialogue.shown || []);
    const candidates = [];

    for (const d of dialogueCatalog) {
        if (d.once && shown.has(d.id)) continue;
        if (state.npcDialogue.queue.some(x => x.id === d.id)) continue;
        const triggers = d.triggers || [];
        if (!triggers.length) continue;
        const ok = triggers.every(triggerMatch);
        if (ok) candidates.push(d);
    }

    candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    if (!candidates.length) return;

    // Окно уже открыто: не помечаем остальных shown (иначе более приоритетный
    // уже показанный диалог, ещё не попавший в shown, «съест» следующий).
    // Кладём в очередь только то, чего ещё нет; сменим окно на самый приоритетный новый.
    if (currentNpc) {
        // если текущий уже once-показан — можно заменить на новый top
        const top = candidates[0];
        if (top && top.id !== currentNpc.id) {
            // очередь: top + остальные без дублей, без пометки shown
            state.npcDialogue.queue = [];
            for (const d of candidates) {
                if (d?.id && d.id !== currentNpc.id) {
                    state.npcDialogue.queue.push(d);
                }
            }
            // если top новый — показать его сейчас
            if (top.id !== currentNpc.id) {
                state.npcDialogue.queue = [top, ...state.npcDialogue.queue.filter(x => x.id !== top.id)];
                showNextNpcDialogue();
            }
        }
        return;
    }

    for (const d of candidates) {
        state.npcDialogue.queue.push(d);
    }
    showNextNpcDialogue();
}

let currentNpc = null;
let npcAmbient = null;

function isVideoUrl(url) {
    return url && /\.(mp4|webm|ogg)(\?|$)/i.test(url);
}

export function showNextNpcDialogue() {
    const panel = document.getElementById('npc-dialogue-panel');
    if (!panel) return;

    const next = state.npcDialogue?.queue?.shift();
    if (!next) {
        // очередь пуста — текущее окно не трогаем (закроет игрок)
        if (!currentNpc) panel.style.display = 'none';
        return;
    }
    // если уже открыто другое окно — автоматически заменяем его новым
    if (currentNpc && npcAmbient) {
        try { npcAmbient.pause(); } catch (_) {}
        npcAmbient = null;
    }
    currentNpc = next;
    // once-диалоги помечаем shown в момент показа, иначе при следующем
    // evaluateNpcTriggers тот же диалог снова попадает в candidates
    // с более высоким priority и «съедает» следующие (например SCHEMES после найма).
    if (next?.once && next?.id) {
        if (!state.npcDialogue) state.npcDialogue = { shown: [], queue: [] };
        if (!Array.isArray(state.npcDialogue.shown)) state.npcDialogue.shown = [];
        if (!state.npcDialogue.shown.includes(next.id)) {
            state.npcDialogue.shown.push(next.id);
        }
    }
    panel.style.display = 'flex';
    fillNpcPanel(next, { playAudio: true });
    try { refreshVersionVisibility(); } catch (_) {}
}

/** Заполнить панель NPC (имя/текст/аватар) с учётом текущего языка */
function fillNpcPanel(dialogue, { playAudio = false } = {}) {
    if (!dialogue) return;
    const nameEl = document.getElementById('npc-dialogue-name');
    const textEl = document.getElementById('npc-dialogue-text');
    const avatarEl = document.getElementById('npc-dialogue-avatar');

    const name = resolveNpcName(dialogue);
    if (nameEl) nameEl.textContent = name;

    const lines = resolveNpcText(dialogue);
    if (textEl) {
        const viewport = ensureNpcTextScroll() || textEl;
        viewport.innerHTML = lines.map(l => {
            const raw = String(l);
            const m = raw.match(/^([^:]+):\s*(.*)$/);
            if (m) return `<p><span class="npc-speaker">${m[1]}:</span> ${renderHintMarkup(m[2])}</p>`;
            return `<p>${renderHintMarkup(raw)}</p>`;
        }).join('');
        bindHintLinks(viewport);
        requestAnimationFrame(() => refreshNpcTextScroll());
    }

    if (avatarEl) {
        // при смене языка аватар не пересоздаём, если уже есть медиа
        const hasMedia = avatarEl.querySelector('.npc-avatar-media');
        if (!hasMedia) {
            avatarEl.innerHTML = '';
            const { avatar: imgSrc, avatarVideo: videoSrc } = resolveNpcAvatar(dialogue);
            if (videoSrc && isVideoUrl(videoSrc)) {
                const v = document.createElement('video');
                v.src = videoSrc;
                v.playsInline = true;
                v.className = 'npc-avatar-media';
                v.onended = () => { v.pause(); };
                avatarEl.appendChild(v);
                v.play().catch(() => {});
            } else if (imgSrc) {
                if (isVideoUrl(imgSrc)) {
                    const v = document.createElement('video');
                    v.src = imgSrc;
                    v.playsInline = true;
                    v.className = 'npc-avatar-media';
                    v.onended = () => { v.pause(); };
                    avatarEl.appendChild(v);
                    v.play().catch(() => {});
                } else {
                    const img = document.createElement('img');
                    img.src = imgSrc;
                    img.alt = name;
                    img.className = 'npc-avatar-media';
                    img.onerror = () => { img.style.opacity = '0.3'; };
                    avatarEl.appendChild(img);
                }
            }
        } else {
            const img = avatarEl.querySelector('img.npc-avatar-media');
            if (img) img.alt = name;
        }
    }

    if (playAudio) {
        if (npcAmbient) { npcAmbient.pause(); npcAmbient = null; }
        const amb = dialogue.ambient || dialogue.voice;
        if (amb) {
            npcAmbient = new Audio(amb);
            npcAmbient.loop = !!dialogue.ambient && !dialogue.voice;
            // voice → канал voice, ambient → ambient
            const ch = dialogue.voice && amb === dialogue.voice ? 'voice' : 'ambient';
            npcAmbient.volume = getEffectiveVolume(ch);
            npcAmbient._volChannel = ch;
            npcAmbient.play().catch(() => {});
        }
    }
}

/** Перерисовать открытый NPC-диалог после смены языка */
onVolumeChange(() => {
    if (npcAmbient) {
        const ch = npcAmbient._volChannel || 'ambient';
        npcAmbient.volume = getEffectiveVolume(ch);
    }
});

export function refreshActiveNpcDialogue() {
    if (!currentNpc) return;
    const panel = document.getElementById('npc-dialogue-panel');
    if (!panel || panel.style.display === 'none') return;
    fillNpcPanel(currentNpc, { playAudio: false });
}

export function closeNpcDialogue() {
    // снять подсветку-подсказку сразу при закрытии
    clearAllHints();
    const panel = document.getElementById('npc-dialogue-panel');
    if (panel) panel.style.display = 'none';
    currentNpc = null;
    try { refreshVersionVisibility(); } catch (_) {}
    if (npcAmbient) { npcAmbient.pause(); npcAmbient = null; }
    // Непросмотренные (устаревшие) окна из очереди считаем закрытыми —
    // после свежего диалога старые больше не открываем.
    if (state.npcDialogue?.queue?.length) {
        if (!Array.isArray(state.npcDialogue.shown)) state.npcDialogue.shown = [];
        for (const d of state.npcDialogue.queue) {
            if (d?.id && !state.npcDialogue.shown.includes(d.id)) {
                state.npcDialogue.shown.push(d.id);
            }
        }
        state.npcDialogue.queue = [];
    }
}

export function initNpcDialogueUI() {
    document.getElementById('npc-dialogue-close')?.addEventListener('click', closeNpcDialogue);
    const panel = document.getElementById('npc-dialogue-panel');
    if (panel) bindHintHostPanel(panel);
    ensureNpcTextScroll();
}