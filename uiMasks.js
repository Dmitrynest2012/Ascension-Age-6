import { t } from './settings.js';
/**
 * UI-маски, завязанные на прогресс квестов.
 */
import { state } from './state.js';
import { formatTime } from './ui.js';

const CHAPTER1_ID = 'QST_INTRO_002'; // Разговор с профессором
const CHAPTER2_ID = 'QST_INTRO_003'; // Знакомство с коллективом

/** База Космистов и её «клон» */
export const COSMIST_BASE_IDS = new Set(['CONSTRC001', 'CONSTRC0011']);

/** Рецепты Базы Космистов */
export const BASE_RECIPE_IDS = {
    PHOTOSYNTHESIS: 'RCP_PHOTOSYNTHESIS',
    REPAIR: 'RCP_BASE_REPAIR',
    FREEZE: 'RCP_FREEZE_DISTILL',
    LETTUCE: 'RCP_GROW_LETTUCE',
    SCIENCE: 'RCP_SCIENTIFIC_DISCOVERIES'
};

function questsState() {
    return state.quests || { completed: [], active: [], progress: {} };
}

export function isQuestCompleted(questId) {
    const qs = questsState();
    if ((qs.completed || []).includes(questId)) return true;
    // все обязательные пункты выполнены, но formal completeQuest ещё не вызван
    const prog = qs.progress?.[questId];
    if (prog && prog.readyToComplete) return true;
    return false;
}

/** Глава I выполнена */
export function isChapter1Done() {
    return isQuestCompleted(CHAPTER1_ID);
}

/** Глава II выполнена */
export function isChapter2Done() {
    return isQuestCompleted(CHAPTER2_ID);
}

/** @deprecated alias */
export function isProfessorQuestDone() {
    return isChapter1Done();
}

/** Часы: «неизвестно» до главы I */
export function getMaskedTimeText(date) {
    if (!isChapter1Done()) return t('common.unknownLower');
    return formatTime(date);
}

export function refreshTimeMask(date) {
    const el = document.getElementById('current-time');
    if (!el) return;
    el.textContent = getMaskedTimeText(date);
}

/** Сырьё / Материалы / Компоненты / Продукция / Продовольствие — маска до главы II */
export function isStockSectionMasked() {
    return !isChapter2Done();
}

/** Инфо Базы Космистов в модалке — маска до главы II */
export function isBuildingInfoMasked(buildingId) {
    return COSMIST_BASE_IDS.has(String(buildingId)) && !isChapter2Done();
}

/**
 * Состояние знания схемы:
 *  - 'unknown'  — неизвестная (чёрная карточка, ?)
 *  - 'locked'   — неизученная (серый контент + жёлтые полосы)
 *  - 'unlocked' — обычная работа
 *
 * Правила (для Базы Космистов):
 *  до гл.I  — все unknown
 *  после I  — Фотосинтез unlocked; остальные locked
 *  после II — все unlocked
 * Для прочих зданий — unlocked.
 */
export function getRecipeKnowledgeState(recipeId, buildingId) {
    const bid = String(buildingId || '');
    const rid = String(recipeId || '');

    // схемы не Базы Космистов — без маски
    if (!COSMIST_BASE_IDS.has(bid)) return 'unlocked';

    // До главы I: все схемы базы «неизвестны»
    if (!isChapter1Done()) return 'unknown';

    // После главы I, до главы II: Фотосинтез открыт, остальные — «не изучены»
    if (!isChapter2Done()) {
        if (rid === BASE_RECIPE_IDS.PHOTOSYNTHESIS) return 'unlocked';
        return 'locked';
    }

    // После главы II: всё открыто
    return 'unlocked';
}

export function isRecipeInteractable(recipeId, buildingId) {
    return getRecipeKnowledgeState(recipeId, buildingId) === 'unlocked';
}
