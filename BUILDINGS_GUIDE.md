# Справочник зданий (`buildings.json`)

Файл — массив шаблонов зданий. Экземпляры на локации живут в `state.locationBuildings[locationId][buildingId]`  
(`built_count`, `currentLevel`, `currentStructure`, …) через `buildingHelpers.js`.

Индексация массивов уровня: **уровень 1 → индекс 0**, уровень N → индекс N−1.

---

## Идентификация и UI

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`id`** | `string` | Уникальный id (`CONSTRC001`, …). |
| **`name`** | `{ ru, en, de }` | Название. |
| **`description`** | `{ ru, en, de }` | Описание в модалке. |
| **`avatar`** | `string` | Путь к картинке здания. |
| **`parentBodyId`** | `number` | Id небесного тела, для которого шаблон «родной» (фильтрация списка). |
| **`constructionZone`** | `string` | Зона стройки: `MC1`…`MC5` (вкладки подменю). |
| **`category`** | `string` | Категория списка: `COP01`…`COP06`. |
| **`unique_building`** | `boolean` | Нельзя построить больше одного (на локации). |
| **`max_count`** | `number` (опц.) | Жёсткий лимит числа построек. |
| **`departments`** | `string` | Отделы через запятую: `DEP1, DEP2, …` (специалисты). |

### Категории (`category`)

| Код | Раздел (ru) |
|-----|-------------|
| `COP01` | Инфраструктура |
| `COP02` | Добыча |
| `COP03` | Промышленность |
| `COP04` | Энергетика |
| `COP05` | Наука |
| `COP06` | Особое |

---

## Уровень и количество (шаблон + runtime)

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`currentLevel`** | `number` | Стартовый уровень шаблона (часто 0 = ещё не построено, 1 = уже стоит). |
| **`maxLevel`** | `number` | Макс. уровень. |
| **`built_count`** | `number` | Стартовое число на теле (уникальные базы часто `1`). Runtime переопределяет. |

---

## Площадь и строительство

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`OccupiedArea`** | `number[]` | Занимаемая площадь по уровням (км² или доля — как в данных тела). |
| **`BuildTime`** | `number[]` (опц.) | Время постройки/апа по уровням (игровые единицы). |
| **`DismantlePenalty`** | `number` (опц.) | Штраф при разборе (0…1). |
| **`DowngradePenalty`** | `number` (опц.) | Штраф при понижении уровня. |

---

## Энергия

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`RequiresElectricity`** | `boolean` | Здание потребляет энергию. |
| **`EnergyConsumption`** | `number[]` | Потребление (Вт) по уровням **на 1 шт.** |
| **`ProducesElectricity`** | `boolean` | Производит энергию (часто через схемы). |
| **`EnergyProduction`** | `number[]` | Множитель/база производства по уровням (см. схемы с `scaleWithBuildingEnergyProduction`). |
| **`ExtractionBonus`** | `number[]` | Множитель добычи гео→склад (насос, карьер; `scaleWithBuildingExtractionBonus`). |
| **`StoresEnergy`** | `boolean` | Аккумулятор. |
| **`MaxEnergyCapacity`** | `number[]` | Множитель (или сырая ёмкость) накопителя по уровням. При наличии рецепта с `scaleWithBuildingMaxEnergyCapacity` (напр. «Обслуживание подстанции») итоговая ёмкость Вт·ч = `perMinute` × `MaxEnergyCapacity[level]` × мощность × эффективность × count. Без такого рецепта — абсолютные Вт·ч × мощность здания. Подстанция даёт существенно больший множитель, чем База Космистов. |
| **`ChargeRate`** / **`DischargeRate`** | `number[]` | Заряд / отдача (Вт). |

Логика накопителей: `energyStorage.js`.

---

## Жильё и население

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`IsResidential`** | `boolean` | Жилое здание. |
| **`PopulationCapacity`** | `number[]` | Мест для поселенцев по уровням (на 1 здание). |
| **`ReservePopulationCapacity`** | `number[]` (опц.) | Резерв / доп. ёмкость. |

---

## Структура (ОЖ)

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`Structure`** | `number[]` | Макс. очки структуры по уровням. |
| **`StartingStructure`** | `number` | Стартовые ОЖ при появлении (может быть меньше макса). |

Ремонт через эффект `EFF_REPAIR_STRUCTURE` в рецептах.

---

## Склад ресурсов

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`IsResourceStorage`** | `boolean` | Здание — склад. |
| **`ResourceStorageCategory`** | `string \| null` | Категория приёма форм. |
| **`ResourceStorageCapacity`** | `number[]` | **Множитель** стэка по уровням (не кг напрямую). |

Вместимость ресурса R ≈ `storageStackSize(R) × multiplier(level) × built_count`  
(сумма по всем подходящим складам). Подробнее — `RESOURCES_GUIDE.md`, `resourceStorage.js`.

### Категории склада

| Код | Принимает |
|-----|-----------|
| `3a` | solid + liquid |
| `3b` | solid |
| `3c` | liquid |
| `2a` | solid + liquid + gas |
| `2b` | gas |
| `1a` | solid + liquid + gas + plasma + exotic |
| `1b` | plasma |
| `1c` | exotic |

Маска «Склад» у Базы Космистов скрыта до **завершения главы II** (`isBuildingInfoMasked` / `isChapter2Done`).

---

## Специалисты (ёмкости отделов)

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`maxEngineeringCapacity`** | `number` или `number[]` | Слоты инженеров. |
| **`maxBotanicalCapacity`** | то же | Агрономы. |
| **`maxScientificCapacity`** | то же | Учёные. |
| **`maxExpeditionCapacity`** | то же | Экспедиторы. |
| **`current*Capacity`** | `number` | Runtime-заполненность (в шаблоне часто 0). |

`CurrentBuildingCapacity` — общая/служебная ёмкость загрузки здания (0…100 в UI).

---

## Связанные системы

| Система | Файл |
|---------|------|
| Список / модалка | `buildingUI.js` |
| Данные локации | `buildingHelpers.js` |
| Стройка | `construction.js` |
| Схемы на здании | `recipes.js` (`buildingIds`) |
| Склад | `resourceStorage.js` |
| Энергия | `energyStorage.js`, `buildingHelpers.js` |
| Население | `population.js` |
| Маски | `uiMasks.js` |

---

## Чеклист нового здания

1. `id`, `name`, `description` (3 языка), `avatar`.
2. `parentBodyId`, `constructionZone`, `category`.
3. `maxLevel`, массивы по уровням согласованы по длине.
4. Энергия: потребление и/или производство / батарея.
5. Если жильё — `IsResidential` + `PopulationCapacity`.
6. Если склад — `IsResourceStorage` + категория + `ResourceStorageCapacity`.
7. `Structure` / `StartingStructure` при необходимости.
8. Привязать схемы в `recipes.json` → `buildingIds`.
9. При необходимости добавить id в `childStructureIds` небесного тела.

---

## ResourceCosts — стоимость постройки / улучшения

Новый параметр (опциональный). Если **отсутствует**, используется прежняя логика без ресурсов.

```json
"ResourceCosts": [
  [ { "resourceId": "RES_IRON_SHEET", "amount": 40 }, { "resourceId": "RES_IRON_RODS", "amount": 25 } ],
  [ { "resourceId": "RES_IRON_SHEET", "amount": 62 }, ... ]
],
"ResourceRefundFactor": 0.5
```

| Поле | Смысл |
|------|--------|
| `ResourceCosts` | Массив по **уровню здания**. Индекс `0` = уровень 0, `1` = уровень 1, … |
| `ResourceCosts[level][]` | Список `{ resourceId, amount }` для **одной** единицы здания на этом уровне |
| `ResourceRefundFactor` | Доля возврата (0…1) при **разобрать** / **ухудшить**. По умолчанию `0.5` |

### Как считается итог

| Действие | Формула |
|----------|---------|
| **Построить** | `ResourceCosts[currentLevel]` × 1 |
| **Улучшить** | `ResourceCosts[currentLevel + 1]` × `built_count` |
| **Разобрать** | возврат `floor( sum(ResourceCosts[0..currentLevel]) × ResourceRefundFactor )` на **одну** единицу (накопленные вложения) |
| **Ухудшить** | возврат `floor( ResourceCosts[currentLevel] × built_count × ResourceRefundFactor )` — только **последний шаг** улучшения |

- Списание со склада локации — **в момент старта** build/upgrade.
- Возврат на склад — **по завершении** dismantle/downgrade.
- Нехватка ресурсов → кнопки «Построить» / «Улучшить» в `locked`.
- UI: `buildingResourceCosts.js` + `.css` — панель под кнопками, hover + во время операции.

Тестовый пример: `CONSTRC001` (База Космистов) — листы, прутья, набор шурупов/гаек.



## Плановое строительство (инпуты у кнопок)

При `body.plannedConstruction === true` слева от разблокированных кнопок BUILNG001–004 появляется инпут (до 6 цифр):

- **Построить / Разобрать** — целевое **количество** (шт.)
- **Улучшить / Ухудшить** — целевой **уровень**

Стоимость и время суммируются по шагам. Нехватка ресурсов на cost-действие подсвечивает кнопку жёлтым (`plan-unaffordable`) и блокирует старт. Логика: `buildingPlanInputs.js`.


## Энергоёмкость и схемы

- Здания с `StoresEnergy: true` накапливают энергию.
- Рецепт **`RCP_SUBSTATION_MAINTENANCE`** («Обслуживание подстанции») задаёт **макс. энергоёмкость** аналогично тому, как фотосинтез задаёт выработку Вт:
  - нужен инженер, нужна электроэнергия (`requiresEnergy`);
  - зависит от рычага мощности рецепта и общей мощности здания;
  - `MaxEnergyCapacity[level]` здания — **множитель** к base `perMinute` выхода `RES_ENERGY_CAPACITY`.
- Доступен в `CONSTRC001` / `CONSTRC0011` (База) и `CONSTRC047` (малая аккумуляторная подстанция). На базе — маска знания как у остальных схем (после главы 2). На подстанции схемы открыты сразу.
- Вкладка **Уровни**: столбец накопления показывает множитель и теоретический макс. `[Вт·ч]` при 100% мощности/штата.


## Складская вместимость и схемы

- `IsResourceStorage` + `ResourceStorageCapacity[level]` — **базовая** вместимость (всегда, как PopulationCapacity у жилья).
- Рецепт **`RCP_WAREHOUSE_MAINTENANCE`** («Обслуживание склада») **добавляет бонус** поверх базы:
  - инженер + электроэнергия;
  - `bonus = perMinute × ResourceStorageCapacity[level] × мощность × эффективность × count`;
  - итого на ресурс: `stack × (baseMult × count + bonus)`.
- Здания: База Космистов (`3a`) и **Склад твёрдых материалов** `CONSTRC090` (`3b`, более высокий множитель).
- На складе нужны слоты инженеров (`maxEngineeringCapacity`).


## Жилплощадь и схемы

- `PopulationCapacity[level]` — **базовая** вместимость населения (всегда, × count × мощность здания; без энергии — `ReservePopulationCapacity` если задан).
- Рецепт **`RCP_HOUSING_MAINTENANCE`** («Обслуживание жилплощади») **добавляет бонус** поверх базы:
  - инженер + электроэнергия;
  - `bonus = perMinute × PopulationCapacity[level] × мощность рецепта × эффективность × count`;
  - итого: `floor(base + bonus)`.
- База Космистов — умеренный `PopulationCapacity`; **Лагерь Выживальщиков** (`CONSTRC002`) — заметно выше → сильнее и база, и бонус рецепта.
