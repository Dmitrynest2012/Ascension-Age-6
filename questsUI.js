/**
 * UI: список поручений + модальное окно квеста
 */
import {
    getVisibleQuestCards,
    getQuestViewModel,
    setQuestPageIndex,
    applyChoiceActions,
    completeQuest,
    tickQuests,
    applyGenderToHeader,
    markPageRead,
    resolvePageText,
    resolvePageImage,
    resolveChoiceLabel,
    resolveQuestTitle,
    getPlayerGender
} from './quests.js';
import { evaluateNpcTriggers } from './npcDialogue.js';
import { renderHintMarkup, bindHintLinks, clearAllHints, bindHintHostPanel } from './uiHints.js';
import { t, getEffectiveVolume, onVolumeChange } from './settings.js';
import { attachFirmScroll, updateFirmScroll } from './firmScroll.js';

let _questPageScroll = null;
function ensureQuestPageScroll() {
    const host = document.getElementById('quest-page-text');
    if (!host) return null;
    if (!_questPageScroll) {
        try {
            _questPageScroll = attachFirmScroll(host, {
                axis: 'y',
                mirrorV: true,
                host: 'self',
                fillHost: true
            });
        } catch (e) {
            console.warn('quest page firmScroll', e);
        }
    }
    return host.querySelector(':scope > .firm-scroll-inner') || host;
}
function refreshQuestPageScroll() {
    try { _questPageScroll?.update(); } catch (_) {}
    try { updateFirmScroll(document.getElementById('quest-page-text')); } catch (_) {}
}

let openQuestId = null;
let audioMusic = null;
let audioAmbient = null;
let lastMusicSrc = null;
let lastAmbientSrc = null;
let cardsAnimated = false;

function isVideoUrl(url) {
    if (!url) return false;
    return /\.(mp4|webm|ogg)(\?|$)/i.test(url);
}

function stopAudio(keepMusicSrc = null, keepAmbientSrc = null) {
    if (audioMusic && audioMusic.src && (!keepMusicSrc || !audioMusic.src.includes(keepMusicSrc))) {
        audioMusic.pause();
        audioMusic = null;
        lastMusicSrc = null;
    }
    if (audioAmbient && audioAmbient.src && (!keepAmbientSrc || !audioAmbient.src.includes(keepAmbientSrc))) {
        audioAmbient.pause();
        audioAmbient = null;
        lastAmbientSrc = null;
    }
}

function playLoop(src, kind) {
    if (!src) return null;
    const prev = kind === 'music' ? lastMusicSrc : lastAmbientSrc;
    if (prev && (prev === src || prev.endsWith(src))) {
        return kind === 'music' ? audioMusic : audioAmbient;
    }
    const a = new Audio(src);
    a.loop = true;
    a.volume = getEffectiveVolume(kind === 'music' ? 'music' : 'ambient');
    a.play().catch(() => {});
    if (kind === 'music') {
        if (audioMusic) audioMusic.pause();
        audioMusic = a;
        lastMusicSrc = src;
    } else {
        if (audioAmbient) audioAmbient.pause();
        audioAmbient = a;
        lastAmbientSrc = src;
    }
    return a;
}

function applyQuestAudioVolumes() {
    if (audioMusic) audioMusic.volume = getEffectiveVolume('music');
    if (audioAmbient) audioAmbient.volume = getEffectiveVolume('ambient');
}
onVolumeChange(() => applyQuestAudioVolumes());

function highlightActiveQuestCard() {
    const list = document.getElementById('quests-list');
    if (!list) return;
    list.querySelectorAll('.quest-card').forEach(btn => {
        const on = openQuestId && btn.dataset.questId === openQuestId;
        btn.classList.toggle('quest-card-active', !!on);
    });
}

export function renderQuestList() {
    const list = document.getElementById('quests-list');
    if (!list) return;
    const cards = getVisibleQuestCards();
    list.innerHTML = cards.map((q, i) => {
        const title = resolveQuestTitle(q);
        const activeCls = (openQuestId && q.id === openQuestId) ? ' quest-card-active' : '';
        return `<button type="button" class="quest-card${activeCls}${cardsAnimated ? '' : ' quest-card-enter'}" data-quest-id="${q.id}" style="animation-delay:${i * 0.08}s">
            <span class="quest-card-title">${title}</span>
        </button>`;
    }).join('');

    list.querySelectorAll('.quest-card').forEach(btn => {
        btn.addEventListener('click', () => openQuestModal(btn.dataset.questId));
    });
    cardsAnimated = true;
    highlightActiveQuestCard();
}

export function openQuestModal(questId) {
    const modal = document.getElementById('quest-modal');
    if (!modal) return;
    openQuestId = questId;
    modal.style.display = 'flex';
    highlightActiveQuestCard();
    refreshQuestModal();
}

export function closeQuestModal() {
    clearAllHints();
    const modal = document.getElementById('quest-modal');
    if (modal) modal.style.display = 'none';
    const was = openQuestId;
    openQuestId = null;
    highlightActiveQuestCard();
    stopAudio();
    // если квест готов и закрыли — убрать карточку / перейти дальше по правилам
    if (was) {
        const vm = getQuestViewModel(was);
        if (vm?.readyToComplete) {
            completeQuest(was, { removeCard: true, activateNext: true });
            renderQuestList();
        }
    }
}

export function refreshQuestModal() {
    if (!openQuestId) return;
    const vm = getQuestViewModel(openQuestId);
    if (!vm) return;

    const titleEl = document.getElementById('quest-modal-title');
    const chapterEl = document.getElementById('quest-modal-chapter');
    const pageEl = document.getElementById('quest-modal-page');
    const objEl = document.getElementById('quest-objectives');
    const textEl = document.getElementById('quest-page-text');
    const choicesEl = document.getElementById('quest-choices');
    const mediaEl = document.getElementById('quest-media');
    const prevBtn = document.getElementById('quest-page-prev');
    const nextBtn = document.getElementById('quest-page-next');

    if (titleEl) titleEl.textContent = vm.title || '';
    const infoTitle = document.getElementById('quest-info-title');
    if (infoTitle) infoTitle.textContent = vm.title || '';
    if (chapterEl) {
        chapterEl.style.display = vm.chapter ? '' : 'none';
        chapterEl.innerHTML = vm.chapter
            ? `<span class="qi-label">${t('quests.chapter')}</span> ${vm.chapter}`
            : '';
    }
    if (pageEl) {
        pageEl.innerHTML = `<span class="qi-label">${t('quests.page')}</span> ${vm.pageIndex + 1} / ${Math.max(1, vm.pageCount)}`;
    }

    // objectives
    if (objEl) {
        objEl.innerHTML = vm.objectives.map(o => {
            const cls = o.status === 'completed' ? 'obj-done' : o.status === 'failed' ? 'obj-fail' : 'obj-pending';
            const mark = o.status === 'completed' ? '✓' : o.status === 'failed' ? '✗' : '';
            return `<div class="quest-objective ${cls}">
                <span class="quest-obj-mark">${mark}</span>
                <span class="quest-obj-label">${o.label}</span>
            </div>`;
        }).join('') || `<div class="quest-objective obj-pending">${t('quests.noObjectives')}</div>`;
    }

    const page = vm.page;
    // media (image / image_man / image_woman)
    if (mediaEl) {
        mediaEl.innerHTML = '';
        const mediaSrc = resolvePageImage(openQuestId, page);
        if (mediaSrc) {
            if (isVideoUrl(mediaSrc)) {
                const v = document.createElement('video');
                v.src = mediaSrc;
                v.autoplay = true;
                v.loop = true;
                v.muted = true;
                v.playsInline = true;
                v.className = 'quest-media-el';
                mediaEl.appendChild(v);
                v.play().catch(() => {});
            } else {
                const img = document.createElement('img');
                img.src = mediaSrc;
                img.alt = '';
                img.className = 'quest-media-el';
                img.onerror = () => { img.style.opacity = '0.25'; };
                mediaEl.appendChild(img);
            }
        }
    }

    // text (с учётом пола + localization)
    if (textEl) {
        const viewport = ensureQuestPageScroll() || textEl;
        const lines = resolvePageText(openQuestId, page);
        viewport.innerHTML = lines.map(line => {
            const raw = String(line);
            // Курсивные описания (*^** … **^*) не режем по первому «:» —
            // иначе маркеры остаются сырым текстом (стр. 2/4/5 главы 3).
            const trimmed = raw.trim();
            if (trimmed.startsWith('*^**') || trimmed.startsWith('<em')) {
                return `<p class="quest-line quest-line-desc">${renderHintMarkup(raw)}</p>`;
            }
            const m = raw.match(/^([^:]{1,48}):\s+([\s\S]*)$/);
            const name = m ? m[1].trim() : '';
            const looksLikeSpeaker = !!(m && name && !name.includes('*^') && !/[.!?]/.test(name) && name.split(/\s+/).length <= 5);
            if (looksLikeSpeaker) {
                return `<p class="quest-line"><span class="quest-speaker">${name}:</span> ${renderHintMarkup(m[2])}</p>`;
            }
            return `<p class="quest-line">${renderHintMarkup(raw)}</p>`;
        }).join('');
        bindHintLinks(viewport);
        requestAnimationFrame(() => refreshQuestPageScroll());
    }

    // choices (клики через делегирование в initQuestsUI — здесь только разметка)
    if (choicesEl) {
        const choices = page?.choices || [];
        const gender = getPlayerGender();
        const selectedGenderId = gender === 'male' ? 'CH_MALE' : gender === 'female' ? 'CH_FEMALE' : null;
        const genderIds = new Set(['CH_MALE', 'CH_FEMALE']);
        const made = (vm.prog?.choicesMade || []);
        choicesEl.innerHTML = choices.map(ch => {
            const label = resolveChoiceLabel(openQuestId, page.id, ch);
            // пол: только одна активная кнопка; прочие choices — по choicesMade
            let active = false;
            if (genderIds.has(ch.id)) {
                active = selectedGenderId === ch.id;
            } else {
                active = made.includes(ch.id);
            }
            return `<button type="button" class="quest-choice-btn${active ? ' active' : ''}" data-choice-id="${ch.id}">${label}</button>`;
        }).join('');
    }

    // audio continuity
    const music = page?.music || null;
    const ambient = page?.ambient || null;
    stopAudio(music, ambient);
    if (music) playLoop(music, 'music');
    if (ambient) playLoop(ambient, 'ambient');

    if (page) markPageRead(openQuestId, page.id);

    if (prevBtn) {
        prevBtn.disabled = vm.pageIndex <= 0;
    }
    if (nextBtn) {
        const last = vm.pageIndex >= vm.pageCount - 1;
        nextBtn.disabled = false;
        nextBtn.dataset.atEnd = last ? '1' : '0';
        nextBtn.title = last && vm.readyToComplete && vm.quest.nextQuestId
            ? t('quests.nextQuest')
            : (last ? t('quests.lastPage') : t('quests.next'));
    }
}

function onPrevPage() {
    if (!openQuestId) return;
    const vm = getQuestViewModel(openQuestId);
    if (!vm || vm.pageIndex <= 0) return;
    setQuestPageIndex(openQuestId, vm.pageIndex - 1);
    tickQuests();
    evaluateNpcTriggers();
    refreshQuestModal();
}

function onNextPage() {
    if (!openQuestId) return;
    const vm = getQuestViewModel(openQuestId);
    if (!vm) return;
    const last = vm.pageIndex >= vm.pageCount - 1;
    if (!last) {
        setQuestPageIndex(openQuestId, vm.pageIndex + 1);
        tickQuests();
        evaluateNpcTriggers();
        refreshQuestModal();
        return;
    }
    // последняя страница
    if (vm.readyToComplete && vm.quest.nextQuestId) {
        const nextId = completeQuest(openQuestId, { removeCard: true, activateNext: true });
        if (nextId) {
            openQuestId = nextId;
            setQuestPageIndex(nextId, 0);
            renderQuestList();
            refreshQuestModal();
        } else {
            openQuestId = null;
            renderQuestList();
            closeQuestModal();
        }
        return;
    }
    // просто остаёмся
    tickQuests();
    evaluateNpcTriggers();
    refreshQuestModal();
}

function refreshQuestObjectivesOnly() {
    if (!openQuestId) return;
    const vm = getQuestViewModel(openQuestId);
    if (!vm) return;
    const objEl = document.getElementById('quest-objectives');
    if (!objEl) return;
    objEl.innerHTML = vm.objectives.map(o => {
        const cls = o.status === 'completed' ? 'obj-done' : o.status === 'failed' ? 'obj-fail' : 'obj-pending';
        const mark = o.status === 'completed' ? '✓' : o.status === 'failed' ? '✗' : '';
        return `<div class="quest-objective ${cls}">
                <span class="quest-obj-mark">${mark}</span>
                <span class="quest-obj-label">${o.label}</span>
            </div>`;
    }).join('') || `<div class="quest-objective obj-pending">${t('quests.noObjectives')}</div>`;
    // обновить title next-btn если ready
    const nextBtn = document.getElementById('quest-page-next');
    if (nextBtn) {
        const last = vm.pageIndex >= vm.pageCount - 1;
        nextBtn.dataset.atEnd = last ? '1' : '0';
        nextBtn.title = last && vm.readyToComplete && vm.quest.nextQuestId
            ? t('quests.nextQuest')
            : (last ? t('quests.lastPage') : t('quests.next'));
    }
}

export function tickQuestsUI() {
    const changes = tickQuests();
    if (changes.length) {
        evaluateNpcTriggers();
        refreshQuestObjectivesOnly();
        renderQuestList();
    } else if (openQuestId) {
        // только счётчики/статусы — НЕ пересобираем кнопки выбора (иначе клик срывается)
        refreshQuestObjectivesOnly();
    }
}

export function initQuestsUI() {
    applyGenderToHeader();
    renderQuestList();

    const qModal = document.getElementById('quest-modal');
    if (qModal) bindHintHostPanel(qModal);
    ensureQuestPageScroll();

    document.getElementById('quest-modal-close')?.addEventListener('click', closeQuestModal);
    document.getElementById('quest-page-prev')?.addEventListener('click', onPrevPage);
    document.getElementById('quest-page-next')?.addEventListener('click', onNextPage);

    // Делегирование кликов по кнопкам выбора (пол и т.д.)
    const choicesEl = document.getElementById('quest-choices');
    if (choicesEl && !choicesEl.dataset.bound) {
        choicesEl.dataset.bound = '1';
        choicesEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.quest-choice-btn');
            if (!btn || !openQuestId) return;
            e.preventDefault();
            e.stopPropagation();
            const vm = getQuestViewModel(openQuestId);
            const page = vm?.page;
            if (!page) return;
            const ch = (page.choices || []).find(c => c.id === btn.dataset.choiceId);
            if (!ch) return;
            applyChoiceActions(ch.actions || []);
            const prog = vm.prog;
            if (prog) {
                if (!prog.choicesMade) prog.choicesMade = [];
                // взаимоисключение пола: в choicesMade остаётся только последний выбор
                if (ch.id === 'CH_MALE' || ch.id === 'CH_FEMALE') {
                    prog.choicesMade = prog.choicesMade.filter(id => id !== 'CH_MALE' && id !== 'CH_FEMALE');
                }
                if (!prog.choicesMade.includes(ch.id)) prog.choicesMade.push(ch.id);
            }
            // мгновенный визуальный сброс: активна только нажатая кнопка из пары пола
            const box = document.getElementById('quest-choices');
            if (box && (ch.id === 'CH_MALE' || ch.id === 'CH_FEMALE')) {
                box.querySelectorAll('.quest-choice-btn').forEach(b => {
                    if (b.dataset.choiceId === 'CH_MALE' || b.dataset.choiceId === 'CH_FEMALE') {
                        b.classList.toggle('active', b.dataset.choiceId === ch.id);
                    }
                });
            }
            tickQuests();
            evaluateNpcTriggers();
            refreshQuestModal();
            renderQuestList();
        });
    }
}

export function getOpenQuestId() {
    return openQuestId;
}