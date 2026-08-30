/**
 * Ядро квестовой системы: каталог, прогресс, проверка пунктов.
 */
import { state } from './state.js';
import { getLocationSpecialists } from './specialists.js';
import { getLocationBuildingData, getStructureMax } from './buildingHelpers.js';
import { calcLocationEnergyProduction } from './buildingHelpers.js';
import { getRecipeLocalPower, getRecipeActualOutput, getRecipesForBuilding } from './recipes.js';
import { getLang, getEffectiveVolume } from './settings.js';

let questCatalog = [];
let questLocalization = null;
let questLang = 'ru';
let loaded = false;

const DEFAULT_OBJ_SOUND = 'assets/audio/quests/objective_complete.ogg';
const DEFAULT_QUEST_SOUND = 'assets/audio/quests/quest_complete.ogg';

/** Актуальный язык: UI-настройка — источник истины */
function activeQuestLang() {
    try {
        const ui = getLang?.();
        if (ui && ['ru', 'en', 'de'].includes(ui)) return ui;
    } catch (_) { /* settings may not be ready */ }
    return questLang || 'ru';
}

export function getQuestLang() { return activeQuestLang(); }
export function setQuestLang(lang) {
    if (['ru', 'en', 'de'].includes(lang)) questLang = lang;
}

export function getLocalization() { return questLocalization; }

/**
 * Достать строку/массив из {ru,en,de}.
 * Язык всегда берётся через activeQuestLang() — синхронно с UI.
 */
export function locPick(node, lang) {
    if (node == null) return null;
    if (typeof node === 'string' || Array.isArray(node)) return node;
    if (typeof node === 'object') {
        const L = (lang && ['ru', 'en', 'de'].includes(lang)) ? lang : activeQuestLang();
        // Без «|| node.ru» вперёд: иначе при отсутствии ключа молча откатываемся на русский,
        // маскируя рассинхрон языка. Сначала точный ключ, потом fallbacks.
        if (node[L] != null && node[L] !== '') return node[L];
        if (node.ru != null && node.ru !== '') return node.ru;
        if (node.en != null && node.en !== '') return node.en;
        if (node.de != null && node.de !== '') return node.de;
        return null;
    }
    return null;
}

/**
 * Текст страницы с учётом пола: text_man / text_woman / text
 * Источник: localization quests[id].pages[pageId] или inline page.text*
 */
export function resolvePageText(questId, page) {
    if (!page) return [];
    const gender = ensureQuestState().playerGender; // male | female | null
    const locPage = questLocalization?.quests?.[questId]?.pages?.[page.id] || {};

    function linesFrom(block) {
        const picked = locPick(block);
        if (Array.isArray(picked)) return picked.filter(Boolean);
        if (typeof picked === 'string' && picked) return [picked];
        return null;
    }

    // 1) localization gender-specific
    if (gender === 'male') {
        const m = linesFrom(locPage.text_man) || linesFrom(page.text_man);
        if (m?.length) return m;
    }
    if (gender === 'female') {
        const w = linesFrom(locPage.text_woman) || linesFrom(page.text_woman);
        if (w?.length) return w;
    }
    // 2) common text
    const common = linesFrom(locPage.text) || linesFrom(page.text);
    if (common?.length) return common;
    // 3) fallback any gender branch if gender not set yet
    return linesFrom(locPage.text_man) || linesFrom(locPage.text_woman)
        || linesFrom(page.text_man) || linesFrom(page.text_woman) || [];
}

/**
 * Картинка/видео страницы с учётом пола:
 * image_man / image_woman → image (fallback)
 * Можно задать в page JSON или в localization.pages[id]
 */
export function resolvePageImage(questId, page) {
    if (!page) return null;
    const gender = ensureQuestState().playerGender;
    const locPage = questLocalization?.quests?.[questId]?.pages?.[page.id] || {};

    function pick(val) {
        if (!val) return null;
        // localization may wrap as {ru,en,de} or plain string
        if (typeof val === 'object' && !Array.isArray(val) && ('ru' in val || 'en' in val || 'de' in val)) {
            return locPick(val) || null;
        }
        return typeof val === 'string' ? val : null;
    }

    if (gender === 'male') {
        const m = pick(page.image_man) || pick(locPage.image_man);
        if (m) return m;
    }
    if (gender === 'female') {
        const w = pick(page.image_woman) || pick(locPage.image_woman);
        if (w) return w;
    }
    return pick(page.image) || pick(locPage.image) || pick(page.image_man) || pick(page.image_woman)
        || pick(locPage.image_man) || pick(locPage.image_woman) || null;
}

/**
 * Аватар NPC: avatar_man / avatar_woman → avatar
 * + avatarVideo_man / avatarVideo_woman → avatarVideo
 */
export function resolveNpcAvatar(dialogue) {
    if (!dialogue) return { avatar: null, avatarVideo: null };
    const gender = ensureQuestState().playerGender;
    const npc = dialogue.npc || {};
    const locNpc = questLocalization?.npc?.[dialogue.id] || {};
    const locNpcNpc = locNpc.npc || locNpc; // allow avatar at root of loc entry

    function pick(val) {
        if (!val) return null;
        if (typeof val === 'object' && !Array.isArray(val) && ('ru' in val || 'en' in val || 'de' in val)) {
            return locPick(val) || null;
        }
        return typeof val === 'string' ? val : null;
    }

    let avatar = null;
    let avatarVideo = null;

    if (gender === 'male') {
        avatar = pick(npc.avatar_man) || pick(locNpcNpc.avatar_man);
        avatarVideo = pick(npc.avatarVideo_man) || pick(locNpcNpc.avatarVideo_man);
    } else if (gender === 'female') {
        avatar = pick(npc.avatar_woman) || pick(locNpcNpc.avatar_woman);
        avatarVideo = pick(npc.avatarVideo_woman) || pick(locNpcNpc.avatarVideo_woman);
    }

    if (!avatar) {
        avatar = pick(npc.avatar) || pick(locNpcNpc.avatar)
            || pick(npc.avatar_man) || pick(npc.avatar_woman)
            || pick(locNpcNpc.avatar_man) || pick(locNpcNpc.avatar_woman);
    }
    if (!avatarVideo) {
        avatarVideo = pick(npc.avatarVideo) || pick(locNpcNpc.avatarVideo)
            || pick(npc.avatarVideo_man) || pick(npc.avatarVideo_woman);
    }
    return { avatar, avatarVideo };
}

export function resolveQuestTitle(quest) {
    if (!quest) return '';
    const loc = questLocalization?.quests?.[quest.id]?.title;
    const v = locPick(loc);
    if (v) return v;
    return Array.isArray(quest.title) ? quest.title[0] : (quest.title || quest.id);
}

export function resolveQuestChapter(quest) {
    if (!quest) return '';
    const loc = questLocalization?.quests?.[quest.id]?.chapter;
    const v = locPick(loc);
    if (v) return v;
    return Array.isArray(quest.chapter) ? quest.chapter[0] : (quest.chapter || '');
}

export function resolveObjectiveLabel(questId, obj, current, target) {
    const loc = questLocalization?.quests?.[questId]?.objectives?.[obj.id];
    let raw = locPick(loc);
    if (!raw) raw = Array.isArray(obj.label) ? obj.label[0] : (obj.label || obj.id);
    const fmt = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v ?? '');
        if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
        return String(Math.round(n * 1000) / 1000);
    };
    return String(raw)
        .replace(/\{current\}/g, fmt(current))
        .replace(/\{target\}/g, fmt(target));
}

export function resolveChoiceLabel(questId, pageId, choice) {
    const loc = questLocalization?.quests?.[questId]?.pages?.[pageId]?.choices?.[choice.id];
    const v = locPick(loc);
    if (v) return v;
    return Array.isArray(choice.label) ? choice.label[0] : (choice.label || choice.id);
}

export function resolveNpcText(dialogue) {
    if (!dialogue) return [];
    const gender = ensureQuestState().playerGender;
    const locNpc = questLocalization?.npc?.[dialogue.id] || {};
    function linesFrom(block) {
        const picked = locPick(block);
        if (Array.isArray(picked)) return picked.filter(Boolean);
        if (typeof picked === 'string' && picked) return [picked];
        return null;
    }
    if (gender === 'male') {
        const m = linesFrom(locNpc.text_man) || linesFrom(dialogue.text_man);
        if (m?.length) return m;
    }
    if (gender === 'female') {
        const w = linesFrom(locNpc.text_woman) || linesFrom(dialogue.text_woman);
        if (w?.length) return w;
    }
    return linesFrom(locNpc.text) || linesFrom(dialogue.text)
        || linesFrom(locNpc.text_man) || linesFrom(locNpc.text_woman) || [];
}

export function resolveNpcName(dialogue) {
    const locNpc = questLocalization?.npc?.[dialogue?.id] || {};
    const v = locPick(locNpc.name);
    if (v) return v;
    const n = dialogue?.npc?.name;
    return Array.isArray(n) ? n[0] : (n || 'NPC');
}

function playSfx(src) {
    if (!src) return;
    try {
        const a = new Audio(src);
        a.volume = getEffectiveVolume('sfx');
        a.play().catch(() => {});
    } catch (_) {}
}


export function getQuestCatalog() {
    return questCatalog;
}

export async function loadQuestsData() {
    if (loaded) return questCatalog;
    try {
        const [resQ, resL] = await Promise.all([
            fetch('quests.json'),
            fetch('questsLocalization.json')
        ]);
        const data = await resQ.json();
        questCatalog = Array.isArray(data.quests) ? data.quests : [];
        if (resL.ok) {
            questLocalization = await resL.json();
            if (!questLocalization.quests) questLocalization.quests = {};
            if (!questLocalization.npc) questLocalization.npc = {};
        } else {
            console.error('questsLocalization.json HTTP', resL.status, resL.statusText);
            questLocalization = { quests: {}, npc: {} };
        }
        // Язык квестов = текущий UI-язык
        const uiLang = activeQuestLang();
        if (uiLang) questLang = uiLang;
        loaded = true;
        ensureQuestState();
        for (const q of questCatalog) {
            if (q.activeOnStart) activateQuest(q.id);
        }
        applyGenderToHeader();
        const nQuests = questLocalization?.quests ? Object.keys(questLocalization.quests).length : 0;
        const nNpc = questLocalization?.npc ? Object.keys(questLocalization.npc).length : 0;
        console.log('Quests loaded:', questCatalog.length, 'locQuests:', nQuests, 'locNpc:', nNpc, 'lang:', activeQuestLang());
    } catch (e) {
        console.error('Failed to load quests.json', e);
        questCatalog = [];
    }
    return questCatalog;
}

/** Полный сброс прогресса квестов для «Новой игры». Каталог не трогаем. */
export function resetQuestsForNewGame() {
    state.quests = {
        active: [],
        completed: [],
        failed: [],
        progress: {},
        flags: {},
        playerGender: null,
        removedCards: []
    };
    if (!state.npcDialogue) state.npcDialogue = { shown: [], queue: [] };
    else {
        state.npcDialogue.shown = [];
        state.npcDialogue.queue = [];
    }
    try { applyGenderToHeader(); } catch (_) {}
    if (Array.isArray(questCatalog)) {
        for (const q of questCatalog) {
            if (q?.activeOnStart) activateQuest(q.id);
        }
    }
    return state.quests;
}

function ensureQuestState() {
    if (!state.quests) {
        state.quests = {
            active: [],          // quest ids
            completed: [],       // quest ids
            failed: [],
            progress: {},        // questId -> { pageIndex, readPages: [], objectives: { id: status }, counters: {} }
            flags: {},           // произвольные флаги (playerGenderSet и т.д.)
            playerGender: null,  // 'male' | 'female' | null
            removedCards: []     // id карточек, которые больше не показывать
        };
    }
    if (!state.quests.progress) state.quests.progress = {};
    if (!state.quests.flags) state.quests.flags = {};
    if (!Array.isArray(state.quests.active)) state.quests.active = [];
    if (!Array.isArray(state.quests.completed)) state.quests.completed = [];
    if (!Array.isArray(state.quests.removedCards)) state.quests.removedCards = [];
    return state.quests;
}

export function getQuestById(id) {
    return questCatalog.find(q => q.id === id) || null;
}

export function getQuestProgress(questId) {
    const qs = ensureQuestState();
    if (!qs.progress[questId]) {
        qs.progress[questId] = {
            pageIndex: 0,
            readPages: [],
            objectives: {},
            counters: {},
            choicesMade: [],
            activatedAt: null,
            completedAt: null,
            failedAt: null,
            outcome: null,
            failedObjectives: null
        };
    }
    const pr = qs.progress[questId];
    if (pr.activatedAt === undefined) pr.activatedAt = null;
    if (pr.completedAt === undefined) pr.completedAt = null;
    if (pr.failedAt === undefined) pr.failedAt = null;
    if (pr.outcome === undefined) pr.outcome = null;
    if (pr.failedObjectives === undefined) pr.failedObjectives = null;
    if (!Array.isArray(pr.choicesMade)) pr.choicesMade = [];
    return pr;
}


/** Снимок текущего игрового времени для цепочки поручений / сейвов */
function snapshotGameTime() {
    try {
        // startTime + elapsed обновляется в ui.js через export
        const { startTime, formatTime } = requireGameTime();
        const d = startTime instanceof Date ? new Date(startTime.getTime()) : new Date();
        return {
            iso: d.toISOString(),
            ms: d.getTime(),
            label: typeof formatTime === 'function' ? formatTime(d) : d.toLocaleString()
        };
    } catch (_) {
        const d = new Date();
        return { iso: d.toISOString(), ms: d.getTime(), label: d.toISOString() };
    }
}

let _timeMod = null;
function requireGameTime() {
    // ленивый импорт избегает циклов; кэш
    return _timeMod || { startTime: new Date(), formatTime: (d) => String(d) };
}

export function bindQuestTimeModule(mod) {
    _timeMod = mod || null;
}

export function activateQuest(questId, opts = {}) {
    const qs = ensureQuestState();
    if (qs.completed.includes(questId)) return false;
    const wasActive = qs.active.includes(questId);
    if (!wasActive) qs.active.push(questId);
    const prog = getQuestProgress(questId);
    if (!prog.activatedAt) prog.activatedAt = snapshotGameTime();

    const quest = getQuestById(questId);
    // Принудительно открыть модалку при старте квеста (openModalOnStart в quests.json)
    const forceOpen = opts.openModal === true
        || (opts.openModal !== false && quest?.openModalOnStart === true);
    // Открываем только при первом активировании; не при загрузке сейва / уже пройденных
    const suppress = typeof window !== 'undefined' && (
        window.__suppressQuestAutoModal === true || window.__loadingSession === true
    );
    if (forceOpen && !wasActive && !suppress && !qs.completed.includes(questId)) {
        import('./questsUI.js').then(mod => {
            if (typeof mod.openQuestModal === 'function') {
                setTimeout(() => {
                    if (window.__suppressQuestAutoModal || window.__loadingSession) return;
                    if (ensureQuestState().completed.includes(questId)) return;
                    mod.openQuestModal(questId);
                }, 80);
            }
        }).catch(() => {});
    }
    return true;
}

export function isQuestActive(questId) {
    return ensureQuestState().active.includes(questId);
}

export function getVisibleQuestCards() {
    const qs = ensureQuestState();
    return qs.active
        .filter(id => !qs.removedCards.includes(id))
        .map(id => getQuestById(id))
        .filter(Boolean);
}

export function getPlayerGender() {
    return ensureQuestState().playerGender;
}

export function setPlayerGender(gender) {
    const qs = ensureQuestState();
    qs.playerGender = gender === 'female' ? 'female' : gender === 'male' ? 'male' : null;
    if (qs.playerGender) qs.flags.playerGenderSet = true;
    applyGenderToHeader();
}

export function applyGenderToHeader() {
    const frame = document.querySelector('.header-icon-frame');
    const img = document.querySelector('#header-left .header-icon, .header-icon-frame img, img.header-icon');
    if (!img) return;
    const g = ensureQuestState().playerGender;
    if (frame) frame.classList.toggle('gender-unknown', !g);
    if (g === 'male') {
        img.src = 'assets/textures/icons/manhero.png';
        img.alt = 'Мужчина';
        img.style.display = '';
    } else if (g === 'female') {
        img.src = 'assets/textures/icons/womanhero.png';
        img.alt = 'Женщина';
        img.style.display = '';
    } else {
        // знак вопроса: картинка-заглушка + CSS ::after «?»
        img.src = 'assets/textures/icons/gender_unknown.png';
        img.alt = '?';
        // если файла нет — прячем img, остаётся «?» из CSS
        img.onerror = () => { img.style.display = 'none'; };
    }
}

export function setQuestFlag(flag, value = true) {
    ensureQuestState().flags[flag] = value;
}

export function getQuestFlag(flag) {
    return !!ensureQuestState().flags[flag];
}

/** Суммарный сток ресурса: locationId=null → все тела */
export function getResourceStockTotal(resourceId, locationId = null) {
    let total = 0;
    const bodies = state.celestialBodies || {};
    for (const [lid, body] of Object.entries(bodies)) {
        if (locationId != null && Number(lid) !== Number(locationId)) continue;
        const stock = body?.data?.resources?.stock || body?.resources?.stock || {};
        total += Number(stock[resourceId]) || 0;
    }
    // fallback: current body map in state if needed
    return total;
}

function countMatchingMissions(obj) {
    const lid = Number(obj.locationId);
    const entry = state.locationCartography?.[lid];
    const units = entry?.units || [];
    const nodes = entry?.resources || [];
    let n = 0;
    for (const u of units) {
        if (!u) continue;
        if (obj.mission && String(u.mission) !== String(obj.mission)) continue;
        if (obj.nodeId && String(u.targetNodeId) !== String(obj.nodeId)) continue;
        if (obj.nodeResourceId) {
            const node = nodes.find(r => String(r.id) === String(u.targetNodeId));
            const rid = node?.resourceId || u.resourceId || u.stockResourceId;
            if (String(rid) !== String(obj.nodeResourceId) && String(u.targetNodeId) !== String(obj.nodeId || '')) continue;
        }
        n += 1;
    }
    return n;
}

function getLocationResourceProduction(locationId, resourceId) {
    const locId = Number(locationId);
    if (!resourceId) return 0;
    let total = 0;
    const locMap = state.locationBuildings?.[locId] || {};
    for (const buildingId of Object.keys(locMap)) {
        const recs = typeof getRecipesForBuilding === 'function' ? getRecipesForBuilding(buildingId) : [];
        for (const recipe of recs || []) {
            try {
                total += Number(getRecipeActualOutput(locId, buildingId, recipe, resourceId)) || 0;
            } catch (_) {}
        }
    }
    return Math.round(total * 1000) / 1000;
}

function isPastQuestDeadline(quest, obj, prog) {
    const hour = Number(obj.deadlineHour);
    if (!Number.isFinite(hour)) return false;
    const minute = Number(obj.deadlineMinute) || 0;
    try {
        const { startTime } = requireGameTime();
        const now = startTime instanceof Date ? startTime : new Date();
        if (!prog.deadlineMs) {
            const d = new Date(now.getTime());
            d.setHours(hour, minute, 0, 0);
            if (now.getTime() >= d.getTime()) d.setDate(d.getDate() + 1);
            prog.deadlineMs = d.getTime();
        }
        return now.getTime() >= Number(prog.deadlineMs);
    } catch (_) {
        return false;
    }
}


/** Все пункты pagesRead в квесте выполнены? */
function isQuestPagesReadDone(quest, prog) {
    const pageObjs = (quest.objectives || []).filter(o => o.type === 'pagesRead');
    if (!pageObjs.length) return true;
    for (const obj of pageObjs) {
        const pages = quest.pages || [];
        const need = obj.pages === 'all'
            ? pages.map(p => p.id)
            : (Array.isArray(obj.pages) ? obj.pages : []);
        const read = new Set(prog.readPages || []);
        const current = need.filter(id => read.has(id)).length;
        const target = need.length || 1;
        if (current < target) return false;
    }
    return true;
}

/**
 * «Сперва текст» (textFirst): пока не прочитаны страницы,
 * остальные пункты не переходят в completed.
 */
function isTextFirstBlocking(quest, prog, obj) {
    if (!quest?.textFirst) return false;
    if (obj?.type === 'pagesRead') return false;
    return !isQuestPagesReadDone(quest, prog);
}

function evalObjective(quest, obj, prog) {
    const type = obj.type;
    let current = 0;
    let target = Number(obj.target) || 1;
    let status = prog.objectives[obj.id] || 'pending'; // pending | completed | failed

    if (status === 'failed') {
        return { status, current, target, label: resolveObjectiveLabel(quest.id, obj, current, target) };
    }

    switch (type) {
        case 'pagesRead': {
            const pages = quest.pages || [];
            const need = obj.pages === 'all'
                ? pages.map(p => p.id)
                : (Array.isArray(obj.pages) ? obj.pages : []);
            const read = new Set(prog.readPages || []);
            current = need.filter(id => read.has(id)).length;
            target = need.length || 1;
            if (current >= target) status = 'completed';
            break;
        }
        case 'flag': {
            current = getQuestFlag(obj.flag) ? 1 : 0;
            target = 1;
            if (current >= 1) status = 'completed';
            break;
        }
        case 'specialists': {
            const lid = obj.locationId;
            if (lid == null) {
                current = 0;
                for (const id of Object.keys(state.celestialBodies || {})) {
                    const s = getLocationSpecialists(id);
                    current += Number(s[obj.role]) || 0;
                }
            } else {
                const s = getLocationSpecialists(lid);
                current = Number(s[obj.role]) || 0;
            }
            target = Number(obj.target) || 1;
            if (current >= target) status = 'completed';
            break;
        }
        case 'resourceStock': {
            current = Math.floor(getResourceStockTotal(obj.resourceId, obj.locationId ?? null));
            target = Number(obj.target) || 1;
            if (current >= target) status = 'completed';
            break;
        }
        case 'energyProduction': {
            const lid = obj.locationId;
            try {
                current = Math.floor(calcLocationEnergyProduction(lid) || 0);
            } catch (_) {
                current = 0;
            }
            target = Number(obj.target) || 1;
            const mode = obj.mode || 'atLeast';
            if (mode === 'exists' || mode === 'atLeast') {
                if (current >= target) status = 'completed';
            }
            break;
        }
        case 'buildingStructure': {
            const loc = getLocationBuildingData(obj.locationId, obj.buildingId);
            current = Math.floor(Number(loc?.currentStructure) || 0);
            target = Number(obj.target) || 1;
            if (obj.mode === 'exists') {
                if (current > 0) status = 'completed';
            } else if (current >= target) {
                status = 'completed';
            }
            break;
        }
        case 'npcLinked': {
            // статус выставляется извне (NPC / actions)
            status = prog.objectives[obj.id] || 'pending';
            current = status === 'completed' ? 1 : 0;
            target = 1;
            break;
        }
        case 'cartographyMission': {
            current = countMatchingMissions(obj);
            target = Number(obj.target) || 1;
            if (current >= target) status = 'completed';
            break;
        }
        case 'resourceProduction': {
            current = getLocationResourceProduction(obj.locationId, obj.resourceId);
            target = Number(obj.target) || 0;
            if (current + 1e-9 >= target) status = 'completed';
            break;
        }
        case 'recipeLocalPower': {
            try {
                current = Math.floor(Number(getRecipeLocalPower(obj.locationId, obj.buildingId, obj.recipeId)) || 0);
            } catch (_) { current = 0; }
            target = Number(obj.target) || 50;
            if (current >= target) status = 'completed';
            break;
        }
        case 'buildingStructurePercent': {
            const loc = getLocationBuildingData(obj.locationId, obj.buildingId);
            const template = (state.buildings || []).find(b => b.id === obj.buildingId);
            const level = loc?.currentLevel ?? template?.currentLevel ?? 0;
            const count = Math.max(1, Number(loc?.built_count) || 1);
            let maxHp = 0;
            try { maxHp = getStructureMax(template, level) * count; } catch (_) { maxHp = 0; }
            const curHp = Number(loc?.currentStructure) || 0;
            current = maxHp > 0 ? Math.floor((curHp / maxHp) * 100 + 1e-9) : 0;
            target = Number(obj.target) || 100;
            if (current >= target) {
                status = 'completed';
            } else if (obj.failOnDeadline && isPastQuestDeadline(quest, obj, prog)) {
                status = 'failed';
            }
            break;
        }
        default:
            status = prog.objectives[obj.id] || 'pending';
    }

    // textFirst: не завершать пункт, пока не прочитан текст квеста
    if (status === 'completed' && isTextFirstBlocking(quest, prog, obj)) {
        status = 'pending';
    }

    prog.objectives[obj.id] = status;
    prog.counters[obj.id] = { current, target };
    return { status, current, target, label: resolveObjectiveLabel(quest.id, obj, current, target) };
}

function formatObjLabel(obj, current, target) {
    const raw = Array.isArray(obj.label) ? obj.label[0] : (obj.label || obj.id);
    return String(raw)
        .replace(/\{current\}/g, String(current))
        .replace(/\{target\}/g, String(target));
}

/** Пересчитать все активные квесты; вернуть список изменившихся objective-статусов */

/** Снять/обновить UI-маски после смены статуса квеста */
function refreshMaskedUiAfterQuest() {
    try {
        import('./camera.js').then(({ currentLocation }) => {
            import('./resourceUI.js').then(({ updateResourceBar }) => {
                updateResourceBar(currentLocation);
            }).catch(() => {});
            import('./buildingUI.js').then(({ refreshBuildingListMasks }) => {
                refreshBuildingListMasks?.(currentLocation);
            }).catch(() => {});
            import('./buildingLevels.js').then(({ updateLevelsTabLock }) => {
                updateLevelsTabLock?.();
            }).catch(() => {});
            import('./ui.js').then(({ updateBodyMenu }) => {
                if (currentLocation) updateBodyMenu(currentLocation);
            }).catch(() => {});
        }).catch(() => {});
        // lock вкладки Уровни можно обновить и без currentLocation
        import('./buildingLevels.js').then(({ updateLevelsTabLock }) => {
            updateLevelsTabLock?.();
        }).catch(() => {});
    } catch (_) {}
}

export function tickQuests() {
    const qs = ensureQuestState();
    const changes = []; // { questId, objectiveId, status }
    for (const questId of [...qs.active]) {
        const quest = getQuestById(questId);
        if (!quest) continue;
        const prog = getQuestProgress(questId);
        for (const obj of quest.objectives || []) {
            const prev = prog.objectives[obj.id] || 'pending';
            const result = evalObjective(quest, obj, prog);
            if (result.status !== prev) {
                changes.push({ questId, objectiveId: obj.id, status: result.status, prev });
                if (result.status === 'completed' && prev !== 'completed') {
                    const sfx = quest.objectiveCompleteSound || DEFAULT_OBJ_SOUND;
                    playSfx(sfx);
                }
            }
        }
        const required = (quest.objectives || []).filter(o => o.required !== false);
        const anyFailed = required.some(o => prog.objectives[o.id] === 'failed');
        if (anyFailed && !qs.failed.includes(questId) && !qs.completed.includes(questId)) {
            const failedIds = required.filter(o => prog.objectives[o.id] === 'failed').map(o => o.id);
            failQuest(questId, failedIds);
            continue;
        }
        const allDone = required.length > 0 && required.every(o => prog.objectives[o.id] === 'completed');
        if (allDone && !qs.completed.includes(questId)) {
            if (!prog.readyToComplete) {
                // впервые стали готовы — звук полного выполнения квеста
                playSfx(quest.completeSound || DEFAULT_QUEST_SOUND);
                prog.readyToComplete = true;
                refreshMaskedUiAfterQuest();
            } else {
                prog.readyToComplete = true;
            }
        }
    }
    return changes;
}

export function markPageRead(questId, pageId) {
    const prog = getQuestProgress(questId);
    if (!prog.readPages.includes(pageId)) prog.readPages.push(pageId);
}

export function setQuestPageIndex(questId, index) {
    const quest = getQuestById(questId);
    if (!quest) return 0;
    const max = Math.max(0, (quest.pages || []).length - 1);
    const i = Math.max(0, Math.min(max, index));
    getQuestProgress(questId).pageIndex = i;
    const page = quest.pages[i];
    if (page) markPageRead(questId, page.id);
    return i;
}

export function applyChoiceActions(actions = []) {
    for (const a of actions || []) {
        if (!a || !a.type) continue;
        const t = String(a.type);
        if (t === 'setGender') {
            setPlayerGender(a.value);
            setQuestFlag('playerGenderSet', true);
        } else if (t === 'setFlag') {
            setQuestFlag(a.flag, a.value !== false && a.value !== 0 && a.value !== 'false');
        } else if (t === 'activateQuest') {
            activateQuest(a.questId);
        } else if (t === 'completeObjective') {
            const prog = getQuestProgress(a.questId);
            prog.objectives[a.objectiveId] = 'completed';
        } else if (t === 'failObjective') {
            const prog = getQuestProgress(a.questId);
            prog.objectives[a.objectiveId] = 'failed';
        }
    }
}

export function completeQuest(questId, { removeCard = true, activateNext = true } = {}) {
    const qs = ensureQuestState();
    const quest = getQuestById(questId);
    qs.active = qs.active.filter(id => id !== questId);
    if (!qs.completed.includes(questId)) qs.completed.push(questId);
    const progC = getQuestProgress(questId);
    progC.completedAt = snapshotGameTime();
    progC.outcome = 'completed';
    progC.failedAt = null;
    refreshMaskedUiAfterQuest();
    if (removeCard || quest?.removeCardOnComplete) {
        if (!qs.removedCards.includes(questId)) qs.removedCards.push(questId);
    }
    // После полного прохождения Главы 1 (QST_INTRO_002) — перезапись текущего слота
    // (не автосейв-слот; чтобы последующая логика квестов/масок была корректной)
    if (questId === 'QST_INTRO_002') {
        try {
            import('./saveSystem.js').then((m) => {
                if (typeof m.saveCurrentGame === 'function') {
                    m.saveCurrentGame({});
                    console.log('[quests] Chapter 1 done → current session overwritten');
                }
            }).catch(() => {});
        } catch (_) {}
    }
    if (activateNext && quest?.nextQuestId) {
        activateQuest(quest.nextQuestId);
        return quest.nextQuestId;
    }
    return null;
}

export function forceObjectiveStatus(questId, objectiveId, status) {
    const prog = getQuestProgress(questId);
    prog.objectives[objectiveId] = status;
}

/** Снимок для UI */
export function getQuestViewModel(questId) {
    const quest = getQuestById(questId);
    if (!quest) return null;
    const prog = getQuestProgress(questId);
    const pageIndex = prog.pageIndex || 0;
    const page = (quest.pages || [])[pageIndex] || null;
    const objectives = (quest.objectives || []).map(obj => {
        const r = evalObjective(quest, obj, prog);
        return {
            id: obj.id,
            status: r.status,
            current: r.current,
            target: r.target,
            label: r.label,
            required: obj.required !== false
        };
    });
    return {
        quest,
        prog,
        pageIndex,
        page,
        pageCount: (quest.pages || []).length,
        objectives,
        title: resolveQuestTitle(quest),
        chapter: resolveQuestChapter(quest),
        readyToComplete: !!prog.readyToComplete
    };
}
/** Провал квеста (задел под будущую логику) */
export function failQuest(questId, failedObjectiveIds = 'all') {
    const qs = ensureQuestState();
    const prog = getQuestProgress(questId);
    qs.active = qs.active.filter(id => id !== questId);
    if (!qs.failed.includes(questId)) qs.failed.push(questId);
    prog.failedAt = snapshotGameTime();
    prog.outcome = 'failed';
    prog.failedObjectives = failedObjectiveIds; // 'all' | string[]
    return true;
}

/** Элемент цепочки для UI / будущего сейва */
export function getQuestChainItem(questId) {
    const quest = getQuestById(questId);
    if (!quest) return null;
    const qs = ensureQuestState();
    const prog = getQuestProgress(questId);
    let status = 'pending';
    if (qs.failed?.includes(questId) || prog.outcome === 'failed') status = 'failed';
    else if (qs.completed?.includes(questId) || prog.outcome === 'completed') status = 'completed';
    else if (qs.active?.includes(questId)) status = 'active';

    const objectives = (quest.objectives || []).map(obj => {
        const st = prog.objectives?.[obj.id] || 'pending';
        return {
            id: obj.id,
            status: st,
            label: resolveObjectiveLabel(quest.id, obj, prog.counters?.[obj.id]?.current || 0, prog.counters?.[obj.id]?.target || 1)
        };
    });

    return {
        questId,
        title: resolveQuestTitle(quest),
        chapter: resolveQuestChapter(quest),
        status,
        isMainStory: quest.isMainStory !== false && !quest.isSideQuest,
        isSideQuest: !!quest.isSideQuest,
        previousQuestId: quest.previousQuestId || null,
        nextQuestId: quest.nextQuestId || null,
        activatedAt: prog.activatedAt || null,
        completedAt: prog.completedAt || null,
        failedAt: prog.failedAt || null,
        failedObjectives: prog.failedObjectives || null,
        objectives,
        // задел под сейв: весь прогресс
        progressSnapshot: {
            pageIndex: prog.pageIndex || 0,
            readPages: [...(prog.readPages || [])],
            objectives: { ...(prog.objectives || {}) },
            counters: { ...(prog.counters || {}) },
            choicesMade: [...(prog.choicesMade || [])]
        }
    };
}

export function getQuestChain(filter = 'main') {
    const qs = ensureQuestState();
    const ids = new Set([
        ...(qs.active || []),
        ...(qs.completed || []),
        ...(qs.failed || [])
    ]);
    // также квесты с activatedAt (на случай рассинхрона)
    for (const id of Object.keys(qs.progress || {})) ids.add(id);

    let items = [...ids].map(getQuestChainItem).filter(Boolean);
    if (filter === 'main') items = items.filter(i => i.isMainStory);
    else if (filter === 'side') items = items.filter(i => i.isSideQuest);

    // Свежие сверху: active всегда выше, затем по времени (ms), fallback — порядок в completed
    const completedOrder = qs.completed || [];
    const score = (it) => {
        if (it.status === 'active') {
            return 2e15 + Number(it.activatedAt?.ms || 0);
        }
        const tms = Number((it.completedAt || it.failedAt || it.activatedAt)?.ms || 0);
        if (tms) return tms;
        // fallback: позже в массиве completed = новее
        const idx = completedOrder.indexOf(it.questId);
        return idx >= 0 ? idx + 1 : 0;
    };
    items.sort((a, b) => score(b) - score(a));
    return items;
}

