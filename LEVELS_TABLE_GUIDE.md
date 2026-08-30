# LEVELS_TABLE_GUIDE — вкладка «Уровни» в модалке здания

Файлы: `buildingLevels.js`, `buildingLevels.css`, разметка `#levels-panel` в `index.html`.

## Назначение

Таблица по уровням здания (0 … `maxLevel`), чтобы планировать экономику: сколько ресурсов нужно на каждый уровень, как растут структура, площадь, энергия, население.

## Доступ

- Вкладка **Уровни** (`#modal-tab-levels`) **заблокирована**, пока не завершена **Глава 2** (`isChapter2Done()` / квест `QST_INTRO_003`).
- Пока locked: клик по вкладке игнорируется, класс `tab-locked` / `locked`.

## Колонки (модульные)

Всегда:

| id | Заголовок | Источник |
|----|-----------|----------|
| `level` | Уровень | 0 … maxLevel |
| `costs` | Ресурсы | `ResourceCosts[level]` — в ячейке краткий текст (`N…` или `—`). Клик → попап с карточками как на вкладке «Основное» |

Опционально (только если данные есть у шаблона):

| id | Условие показа | JSON |
|----|----------------|------|
| `structure` | есть `Structure[]` | `Structure[level]` + ед. ОЖ |
| `area` | есть `OccupiedArea[]` | м² |
| `energyCons` | `RequiresElectricity` и есть `EnergyConsumption[]` | Вт (`formatEnergy(...).text`) |
| `energyProd` | `ProducesElectricity` / рецепт `RES_ELECTRICITY` / `EnergyProduction[]` | Формат `×множитель [Вт]`: множитель = `EnergyProduction[level]`; в скобках — теоретический макс. при 100% мощности здания и рецепта и полном штате (сумма всех электро-рецептов здания, `perMinute × mult` на 1 ед.) |
| `energyStored` | `StoresEnergy` и есть `MaxEnergyCapacity[]` | Вт·ч |
| `population` | `IsResidential` или есть `PopulationCapacity[]` | чел. |

Правый набор колонок зависит от типа здания: АЭС/солнечная — выработка; жильё — население; аккумулятор — накопление; потребители — расход.

## Поведение UI

- Строка **текущего** `currentLevel` (из `locationBuildings`) — класс `is-current` (голубая подсветка + полоска слева).
- Hover строки — `is-hover`.
- **Sticky** `<thead>` при вертикальном скролле.
- Область `.levels-table-scroll`: вертикальный и горизонтальный скролл, кастомный скроллбар.
- Попап `#levels-cost-popover`: карточки через `renderCostCardsHtml` из `buildingResourceCosts.js` (склад локации для lack/missing).

## Интеграция

1. `buildingUI.js` — при `activeModalTab === 'modal-tab-levels'` скрывает main/controls/power, вызывает `renderLevelsTab(locId, buildingId, bodyData)`.
2. `ui.js` — клик по вкладке levels проверяет `isLevelsTabLocked()` (dynamic import).
3. При открытии main — `showLevelsPanel(false)`, `updateLevelsTabLock()`.

## Связь с ResourceCosts

См. `BUILDINGS_GUIDE.md` § ResourceCosts. В таблице для уровня L показываются **базовые** требования `ResourceCosts[L]` на **одну** единицу (без × `built_count`). Множитель количества учитывается при реальном «Улучшить» на вкладке Основное.

## Расширение

Новая характеристика по уровням:

1. Массив в `buildings.json` (или флаг + массив).
2. Условие в `getLevelsColumns()`.
3. Форматтер в `cellValue()`.
4. Ключ локализации `levels.col.*` (опционально).
