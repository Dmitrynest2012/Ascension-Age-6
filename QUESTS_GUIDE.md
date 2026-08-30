# Инструкция: поручения и диалоги NPC

Файлы:
- `quests.json` — каталог квестов (карточки, страницы, пункты)
- `npcDialogues.json` — внешние реплики NPC (правый нижний угол)
- `quests.js` / `questsUI.js` / `quests.css`
- `npcDialogue.js` / `npcDialogue.css`

Язык строк: почти везде `[ "Русский", "English" ]` — в игре сейчас берётся **первый** элемент.

---

## quests.json

### Корень
```json
{ "meta": { "version": 1 }, "quests": [ /* ... */ ] }
```

### Квест
| Поле | Смысл |
|------|--------|
| `id` | Уникальный id, например `QST_INTRO_001` |
| `title` | Название (на карточке и в модалке) |
| `chapter` | Строка «Глава: …» (можно `null`) |
| `activeOnStart` | `true` — появляется при загрузке |
| `nextQuestId` | id следующего квеста или `null` |
| `removeCardOnComplete` | убрать карточку после завершения |
| `objectives` | массив пунктов |
| `pages` | страницы диалога |

### Пункт (objective)
Общие поля: `id`, `label` (можно `{current}` / `{target}`), `type`, `required` (по умолчанию true).

**Типы `type`:**

1. **`pagesRead`** — игрок открыл страницы  
   - `pages`: `"all"` или массив id страниц `["P1","P2"]`

2. **`flag`** — флаг из `state.quests.flags`  
   - `flag`: например `"playerGenderSet"`

3. **`specialists`** — число специалистов  
   - `role`: `engineers` \| `agronomists` \| `scientists` \| `expeditioners`  
   - `target`: число  
   - `locationId`: id тела или `null` (сумма по всем)

4. **`resourceStock`** — склад  
   - `resourceId`: id из `resources.json`  
   - `target`, `locationId` (`null` = все тела)

5. **`energyProduction`** — производство энергии (Вт) на теле  
   - `locationId`, `target`, `mode`: `"atLeast"` \| `"exists"`

6. **`buildingStructure`** — ОЖ здания  
   - `buildingId`, `locationId`, `target`, `mode`: `"atLeast"` \| `"exists"`

7. **`npcLinked`** — статус только вручную / из actions

8. **`cartographyMission`** — активная экспедиция на 2D-карте  
   - `locationId`, `mission` (`mine`/`scout`/`return`), опционально `nodeId`, `nodeResourceId`

9. **`resourceProduction`** — суммарная выработка ресурса на теле (ед./мин)  
   - `locationId`, `resourceId`, `target`

10. **`recipeLocalPower`** — локальная мощность схемы в здании (0–100)  
    - `locationId`, `buildingId`, `recipeId`, `target`

11. **`buildingStructurePercent`** — ОЖ здания в % от максимума уровня  
    - `locationId`, `buildingId`, `target` (обычно 100)  
    - `deadlineHour` / `deadlineMinute` + `failOnDeadline` — провал, если срок игрового времени вышел

### Страница
| Поле | Смысл |
|------|--------|
| `id` | id страницы |
| `image` | картинка **или** видео (`.mp4`/`.webm`) в большой слот |
| `music` | цикл; тот же файл на соседних страницах — **не перезапускается** |
| `ambient` | звук окружения, та же логика |
| `text` | массив строк; формат `Имя: реплика` подсвечивает имя |
| `choices` | кнопки выбора |

### Choice / actions
```json
{
  "id": "CH_MALE",
  "label": ["Мужчина", "Male"],
  "actions": [
    { "type": "setGender", "value": "male" },
    { "type": "setFlag", "flag": "playerGenderSet", "value": true },
    { "type": "activateQuest", "questId": "QST_XXX" },
    { "type": "completeObjective", "questId": "QST_XXX", "objectiveId": "OBJ_Y" },
    { "type": "failObjective", "questId": "QST_XXX", "objectiveId": "OBJ_Y" }
  ]
}
```

Пол: `male` → `manhero.png`, `female` → `womanhero.png`, иначе `gender_unknown.png` (в шапке).

### Навигация
- Стрелки листают страницы.
- На **последней** странице, если все required-пункты выполнены и есть `nextQuestId`, «вправо» открывает **следующий** квест.
- Назад в уже завершённый квест нельзя: карточка снимается.
- Закрытие модалки при `readyToComplete` тоже завершает квест и снимает карточку.

---

## npcDialogues.json

```json
{
  "id": "NPC_SELEZNEV_HIRED",
  "priority": 10,
  "once": true,
  "triggers": [
    { "questId": "QST_INTRO_002", "objectiveId": "OBJ_HIRE_ENG", "status": "completed" }
  ],
  "npc": {
    "name": ["Профессор Селезнев", "Professor Seleznev"],
    "avatar": "assets/textures/npc/seleznev.png",
    "avatarVideo": null
  },
  "ambient": null,
  "voice": null,
  "text": [ "Профессор Селезнев: …" ]
}
```

- Окно справа внизу, закрывается крестиком.
- Триггеры проверяются **даже если** модалка квеста закрыта.
- Все `triggers` должны совпасть (`status`: `completed` \| `failed` \| `pending`).
- `once: true` — показать один раз.
- `avatarVideo` / video в `avatar` — проигрыш **один раз**, без UI-плеера.
- `priority` — больше = раньше в очереди.

---

## Id небесных тел
Смотри `hev.body.json` → поле `id` (например Земля = `3`). Подставляй в `locationId`.

## Иконки / медиа (локально)
- `assets/textures/icons/gender_unknown.png`, `womanhero.png`
- `assets/textures/quests/…`, `assets/audio/quests/…`
- `assets/textures/npc/…`

---

## questsLocalization.json (диалоги)

Тексты квестов и NPC вынесены сюда для ru / en / de.

```json
"quests": {
  "QST_INTRO_001": {
    "title": { "ru": "…", "en": "", "de": "" },
    "chapter": { "ru": "…", "en": "", "de": "" },
    "objectives": { "OBJ_ID": { "ru": "…", "en": "", "de": "" } },
    "pages": {
      "P1": {
        "text": { "ru": ["строка1", "Имя: реплика"], "en": [], "de": [] },
        "text_man": { "ru": ["…"], "en": [], "de": [] },
        "text_woman": { "ru": ["…"], "en": [], "de": [] },
        "choices": { "CH_MALE": { "ru": "Мужчина", "en": "Male", "de": "" } }
      }
    }
  }
},
"npc": {
  "NPC_ID": {
    "name": { "ru": "…", "en": "", "de": "" },
    "text_man": { "ru": ["…"], "en": [], "de": [] },
    "text_woman": { "ru": ["…"], "en": [], "de": [] }
  }
}
```

Приоритет текста страницы: `text_man`/`text_woman` по полу → общий `text`.

### Звуки в quests.json
- `objectiveCompleteSound` — при выполнении пункта
- `completeSound` — когда все required-пункты выполнены (квест ready)
