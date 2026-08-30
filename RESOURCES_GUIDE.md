# Справочник рецептов (`recipes.json`)

Файл — массив объектов-схем. Загружается в `recipes.js`, привязывается к зданиям через `buildingIds`.  
Тик производства: `tickRecipes` / логика входов-выходов в `recipes.js`.

---

## Базовые поля

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`id`** | `string` | Уникальный id. Префикс `RCP_…`. |
| **`name`** | `{ ru, en, de }` | Локализованное название схемы. |
| **`buildingIds`** | `string[]` | Список id зданий, где схема доступна (`CONSTRC001`, …). |
| **`processingEfficiency`** | `number` 0..1 (опц.) | Доля выхода от входа при полной мощности (0.5 = 50% потерь). Вход тратится полностью; выход × efficiency. |
| **`requiresEnergy`** | `boolean` | Нужна ли электроэнергия для работы. При нехватке энергии схема может тормозить / останавливаться по логике тика. |
| **`notes`** | `string` (опц.) | Внутренняя пометка для разработчика, в игре не показывается. |

---

## Входы (`inputs`)

Массив объектов:

| Поле | Тип | Описание |
|------|-----|----------|
| **`resourceId`** | `string` | Id ресурса из `resources.json`. |
| **`perMinute`** | `number` | Расход в единицах стока **в минуту** (при полной активности схемы). |
| **`alternatives`** | `string[]` (опц.) | Альтернативные resourceId: достаточно **одного** из списка (вместе с основным или вместо — по логике `recipes.js`). |

Ресурсы с `infinite: true` не списываются со склада.

---

## Выходы (`outputs`)

| Поле | Тип | Описание |
|------|-----|----------|
| **`resourceId`** | `string` | Что производится (или служебный id для эффекта). |
| **`perMinute`** | `number` | Выпуск в минуту при полной мощности. |
| **`scaleWithBuildingEnergyProduction`** | `boolean` (опц.) | Множитель от `EnergyProduction` здания (фотосинтез / панели). |
| **`scaleWithBuildingMaxEnergyCapacity`** | `boolean` (опц.) | Множитель от `MaxEnergyCapacity` здания → вклад в макс. энергоёмкость (Вт·ч), не поток/мин. |
| **`scaleWithBuildingResourceStorageCapacity`** | `boolean` (опц.) | Множитель от `ResourceStorageCapacity` → **бонус** к складской вместимости поверх базовой. |
| **`scaleWithBuildingPopulationCapacity`** | `boolean` (опц.) | Множитель от `PopulationCapacity` → **бонус** к жилплощади поверх базовой. |
| **`scaleWithBuildingExtractionBonus`** | `boolean` (опц.) | Множитель `ExtractionBonus` здания для добычи гео→склад. |
| **`geoResourceId`** (вход) | `string` | Вход из залежей `body.geoDeposits` (не со склада). Расход в кг, current в тоннах. |
| **`isCapacity`** | `boolean` (опц.) | Маркер ёмкостного выхода (не ресурс склада). |
| **`isEffect`** | `boolean` (опц.) | Выход — не складской ресурс, а эффект. |
| **`effectId`** | `string` (опц.) | Например `EFF_REPAIR_STRUCTURE`. |
| **`effectValuePerMinute`** | `number` (опц.) | Сила эффекта в минуту (ОЖ и т.п.). |

Складские выходы проходят через `addResourceClamped` (лимиты склада).  
При переполнении склада схема может получить статус «склад переполнен».

---

## Специалисты (`specialists`)

| Поле | Тип | Описание |
|------|-----|----------|
| **`engineers`** | `number` | Требуется инженеров на схеме. |
| **`agronomists`** | `number` | Агрономы. |
| **`scientists`** | `number` | Учёные. |

`0` — роль не нужна. Допускаются дроби (`0.2`, `0.5`): это доля ставки при 100% локальной мощности и 1 здании. Один нанятый специалист может закрыть несколько схем, если сумма их спроса ≤ 1. Нехватка снижает/блокирует работу по логике тика. Нанятые по-прежнему целые люди.

---

## Оформление карточки

| Параметр | Тип | Описание |
|----------|-----|----------|
| **`gradient`** | `[string, string]` | Два CSS-цвета (rgba) для фона карточки. |
| **`backgroundImage`** | `string` | Путь к фоновой картинке схемы. |

---

## Пример: производство

```json
{
  "id": "RCP_FREEZE_DISTILL",
  "name": { "ru": "Вымораживание", "en": "Freeze Distillation", "de": "Gefrierdestillation" },
  "buildingIds": ["CONSTRC001", "CONSTRC0011"],
  "requiresEnergy": true,
  "inputs": [
    { "resourceId": "RES_ICE", "perMinute": 0.01 },
    { "resourceId": "RES_EMPTY_CANISTER", "perMinute": 0.0005 }
  ],
  "outputs": [
    { "resourceId": "RES_PACKED_WATER", "perMinute": 0.01 }
  ],
  "specialists": { "engineers": 0, "agronomists": 1, "scientists": 0 },
  "gradient": ["rgba(100, 210, 255, 0.18)", "rgba(50, 70, 90, 0.3)"],
  "backgroundImage": "assets/textures/icons/recipe_bg_freeze.png",
  "notes": "20 кг льда ≈ 1 канистра упакованной воды"
}
```

## Пример: эффект ремонта

```json
{
  "outputs": [
    {
      "resourceId": "RES_STRUCT_REPAIR",
      "isEffect": true,
      "effectId": "EFF_REPAIR_STRUCTURE",
      "effectValuePerMinute": 1
    }
  ]
}
```

## Пример: энергия с множителем здания

```json
{
  "requiresEnergy": false,
  "inputs": [{ "resourceId": "RES_SOLAR_RAD", "perMinute": 1 }],
  "outputs": [{
    "resourceId": "RES_ELECTRICITY",
    "perMinute": 2500,
    "scaleWithBuildingEnergyProduction": true
  }]
}
```

---

## Связанные системы

| Система | Файл |
|---------|------|
| Тик, склад, эффекты | `recipes.js` |
| Карточки схем, статусы | `recipesUI.js` |
| Маска «неизвестная схема» | `uiMasks.js` (`getRecipeKnowledgeState`) |
| Каталог ресурсов | `resources.json` |

### Маски знания (База Космистов)

- до главы I — все схемы `unknown`;
- после I до II — фотосинтез `unlocked`, остальные `locked`;
- после II — все `unlocked`.

---

## Чеклист новой схемы

1. Уникальный `RCP_…` id и `name` на 3 языка.
2. `buildingIds` — здания существуют в `buildings.json`.
3. Все `resourceId` есть в `resources.json`.
4. Баланс `perMinute` входов/выходов (масса, штуки, энергия).
5. `specialists` и `requiresEnergy` по задумке.
6. `gradient` + `backgroundImage`.
7. Если эффект — `isEffect` + `effectId`.
8. Проверить склад: выходы не `energy`/`effect` должны иметь `storageStackSize` и подходящий `form`.
