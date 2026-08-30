export const heightLevels = {
    '1ZC': { min: 3, max: 10, title: 'Планеты и луны', cameraSpeed: 3, zoomInSpeed: 0.02, zoomOutSpeed: 0.02 },
    '2ZC': { min: 10, max: 17, title: 'Планеты', cameraSpeed: 4, zoomInSpeed: 0.05, zoomOutSpeed: 0.05 },
    '3ZC': { min: 17, max: 400, title: 'Звездная система', cameraSpeed: 6, zoomInSpeed: 0.1, zoomOutSpeed: 0.1 },
    '4ZC': { min: 400, max: 6500, title: 'Межзвездная туманность', cameraSpeed: 256, zoomInSpeed: 1.2, zoomOutSpeed: 1.2 },
    '5ZC': { min: 6500, max: 25000, title: 'Галактика', cameraSpeed: 1024, zoomInSpeed: 4.0, zoomOutSpeed: 4.0 },
    '6ZC': { min: 25000, max: 160000, title: 'Вселенная', cameraSpeed: 4096, zoomInSpeed: 14.0, zoomOutSpeed: 14.0 },
    '7ZC': { min: 160000, max: 480000, title: 'Мультивселенная', cameraSpeed: 16384, zoomInSpeed: 48.0, zoomOutSpeed: 48.0 }
};

/** Глобальный потолок высоты камеры (Мультивселенная — высший уровень). */
export const CAMERA_Y_MAX = 480000;