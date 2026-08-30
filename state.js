export const state = {
    geoSurveyBlocking: false,
    celestialBodies: {},
    labels: {},
    camera: null,
    renderer: null,
    composer: null,
    particleSystems: {},
    particleOpacity: 1.0,
    targetParticleOpacity: 1.0,
    opacityTransition: null,
    buildings: [],
    locationBuildings: {},  // { [locationId: number]: { [buildingId: string]: { currentLevel, built_count, ... } } }
    locationUnits: {}, // { [bodyId]: { slots, inOrbit } }
    locationCartography: {},
    locationGeoSurvey: {},
    /** Прогресс изучения технологий: { [techId]: { level, invested, researching } } */
    techProgress: {}, // { [bodyId]: { deposits, completed, total, scannedCount } }
    activeSubmenuButton: null,

    /**
     * Инициализирует данные зданий для локации.
     * НИКОГДА не перезаписывает уже существующие данные (прогресс сохраняется).
     */
    initializeLocationBuildings(locationId) {
        const locId = Number(locationId);
        if (!this.locationBuildings[locId]) {
            this.locationBuildings[locId] = {};
        }

        let added = 0;
        this.buildings.forEach(building => {
            const belongsToBody =
                Number(building.parentBodyId) === locId ||
                this.celestialBodies[locId]?.data?.childStructureIds?.includes(building.id) ||
                this.celestialBodies[locId]?.childStructureIds?.includes(building.id);

            // Только если записи ещё нет — сидим из шаблона
            if (belongsToBody && !this.locationBuildings[locId][building.id]) {
                this.locationBuildings[locId][building.id] = {
                    currentLevel: building.currentLevel ?? 0,
                    built_count: building.built_count ?? 0,
                    currentEngineeringCapacity: building.currentEngineeringCapacity ?? 0,
                    currentBotanicalCapacity: building.currentBotanicalCapacity ?? 0,
                    currentScientificCapacity: building.currentScientificCapacity ?? 0,
                    currentBuildingCapacity: (building.currentBuildingCapacity
                        ?? building.CurrentBuildingCapacity
                        ?? 100) || 100,
                    currentStoredEnergy: 0,
                    currentResidents: 0,
                    // структура: StartingStructure или max * count (заполнится в getLocationBuildingData при первом доступе)
                    currentStructure: null
                };
                added++;
            }
        });

        if (added > 0) {
            console.log(`Initialized locationBuildings for ${locId}, added ${added} buildings`);
        }
    },

    addCelestialBody(body) {
        this.celestialBodies[body.id] = body;
        this.initializeLocationBuildings(body.id);
    }
};
