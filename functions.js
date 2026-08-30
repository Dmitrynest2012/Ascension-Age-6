import { t } from './settings.js';


export function initCamera(scene, keys) {
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.set(0, 100, 0);
    camera.rotation.set(-Math.PI / 2, 0, 0);

    const baseSpeed = 0.5;
    const zoomSpeed = 0.1;
    const lerpFactor = 0.1;
    const shiftSpeedBonus = 1.5;
    let targetY = 100;

    const minY = 20;
    const maxY = 2000;

    const heightElement = document.getElementById('height');
    const levelElement = document.getElementById('level');

    document.addEventListener('keydown', (e) => {
        const lowerKey = e.key.toLowerCase();
        if (lowerKey === 'w') keys.w = true;
        if (lowerKey === 'a') keys.a = true;
        if (lowerKey === 's') keys.s = true;
        if (lowerKey === 'd') keys.d = true;
        if (e.key === 'Shift') keys.shift = true;
    });

    document.addEventListener('keyup', (e) => {
        const lowerKey = e.key.toLowerCase();
        if (lowerKey === 'w') keys.w = false;
        if (lowerKey === 'a') keys.a = false;
        if (lowerKey === 's') keys.s = false;
        if (lowerKey === 'd') keys.d = false;
        if (e.key === 'Shift') keys.shift = false;
    });

    window.addEventListener('wheel', (e) => {
        targetY += e.deltaY * zoomSpeed;
        targetY = Math.max(minY, Math.min(maxY, targetY));
    });

    function update() {
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, targetY, lerpFactor);

        const currentHeight = camera.position.y;
        let level = '';
        let speedModifier = 1.0;
        if (currentHeight >= 20 && currentHeight < 100) {
            level = 'небесное тело';
            speedModifier = 1.0;
        } else if (currentHeight >= 100 && currentHeight < 500) {
            level = 'гравитационный колодец';
            speedModifier = 1.5;
        } else if (currentHeight >= 500 && currentHeight < 2000) {
            level = 'звездная система';
            speedModifier = 2.0;
        } else {
            level = 'неизвестно';
            speedModifier = 1.0;
        }

        const finalSpeedModifier = keys.shift ? speedModifier * shiftSpeedBonus : speedModifier;
        const speed = baseSpeed * finalSpeedModifier;

        if (keys.w) camera.position.z -= speed;
        if (keys.s) camera.position.z += speed;
        if (keys.a) camera.position.x -= speed;
        if (keys.d) camera.position.x += speed;

        const currentHeightDisplay = currentHeight.toFixed(1);
        heightElement.textContent = `Высота: ${currentHeightDisplay}`;
        levelElement.textContent = `Уровень: ${level}`;
    }

    return { camera, update };
}

export function initTimeControl(bodyMap) {
    const speeds = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
    let currentSpeedIndex = speeds.indexOf(8192);
    let lastNonZeroSpeedIndex = currentSpeedIndex;
    let timeSpeed = 8192;

    const speedIndicator = document.getElementById('speed-indicator');
    const currentTimeElement = document.getElementById('current-time');
    const slowDownButton = document.getElementById('slow-down');
    const pauseButton = document.getElementById('pause');
    const speedUpButton = document.getElementById('speed-up');

    let lastUpdate = performance.now();
    let simulatedTime = new Date('2108-01-07T00:00:00');

    function formatTime(date) {
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${hours}:${minutes}:${seconds} ${day}:${month}:${year}`;
    }

    function setTimeSpeed(newSpeed, newIndex) {
        timeSpeed = newSpeed;
        speedIndicator.textContent = timeSpeed === 0 ? '0x' : `${timeSpeed}x`;
        if (newSpeed !== 0) {
            lastNonZeroSpeedIndex = newIndex;
        }
        currentSpeedIndex = newIndex;
        bodyMap.forEach((body) => {
            if (body.userData.yearLength) {
                body.userData.orbitSpeedModifier = timeSpeed;
            }
        });
    }

    speedIndicator.textContent = `${timeSpeed}x`;

    slowDownButton.addEventListener('click', () => {
        if (timeSpeed === 0) {
            let targetIndex = Math.max(0, lastNonZeroSpeedIndex - 1);
            setTimeSpeed(speeds[targetIndex], targetIndex);
        } else if (currentSpeedIndex > 0) {
            setTimeSpeed(speeds[currentSpeedIndex - 1], currentSpeedIndex - 1);
        }
    });

    pauseButton.addEventListener('click', () => {
        if (timeSpeed === 0) {
            setTimeSpeed(speeds[lastNonZeroSpeedIndex], lastNonZeroSpeedIndex);
        } else {
            setTimeSpeed(0, currentSpeedIndex);
        }
    });

    speedUpButton.addEventListener('click', () => {
        if (timeSpeed === 0) {
            setTimeSpeed(speeds[lastNonZeroSpeedIndex], lastNonZeroSpeedIndex);
        } else if (currentSpeedIndex < speeds.length - 1) {
            setTimeSpeed(speeds[currentSpeedIndex + 1], currentSpeedIndex + 1);
        }
    });

    function updateTime() {
        const now = performance.now();
        const deltaTime = (now - lastUpdate) / 1000;
        lastUpdate = now;

        if (timeSpeed !== 0) {
            simulatedTime.setTime(simulatedTime.getTime() + deltaTime * 1000 * timeSpeed);
        }

        currentTimeElement.textContent = formatTime(simulatedTime);
        return { deltaTime, timeSpeed };
    }

    return { timeSpeed, updateTime, setTimeSpeed };
}

export function updateRotation(bodyMap, deltaTime, timeSpeed) {
    bodyMap.forEach((body) => {
        if (body.userData.dayLength && body.userData.name !== 'Солнце') {
            const dayRotation = (2 * Math.PI * deltaTime * timeSpeed) / body.userData.dayLength;
            body.rotation.y += dayRotation;
        }
        if (body.userData.yearLength && body.userData.distanceFromParent > 0 && body.parent) {
            const yearRotation = (2 * Math.PI * deltaTime * body.userData.orbitSpeedModifier) / body.userData.yearLength;
            body.userData.orbitAngle += yearRotation;
            const distance = body.userData.distanceFromParent;
            body.position.set(
                distance * Math.cos(body.userData.orbitAngle),
                0,
                distance * Math.sin(body.userData.orbitAngle)
            );
            if (body.userData.name === 'Луна') {
                const worldPos = body.getWorldPosition(new THREE.Vector3());
                console.log(`Luna position: ${body.position.x}, ${body.position.y}, ${body.position.z}, Parent: ${body.parent ? body.parent.userData.name : 'undefined'}, World: ${worldPos.x}, ${worldPos.y}, ${worldPos.z}`);
            }
        }
    });
}

export async function loadJson(path) {
    const response = await fetch(path);
    return await response.json();
}

/**
 * Форматирование мощности (Вт) с автосменой единиц:
 * Вт → кВт (≥1000 Вт) → МВт (≥1000 кВт) → ГВт → ТВт
 *
 * @param {number} watts
 * @param {{ decimals?: number, withUnit?: boolean }} [opts]
 * @returns {{ value: number, unit: string, text: string, watts: number }}
 */
export function formatEnergy(watts, opts = {}) {
    const decimals = opts.decimals ?? 2;
    const withUnit = opts.withUnit !== false;
    const n = Number(watts);
    const safe = Number.isFinite(n) ? n : 0;
    const sign = safe < 0 ? -1 : 1;
    let abs = Math.abs(safe);

    const levels = [
        { unitKey: 'unit.W',  factor: 1 },
        { unitKey: 'unit.kW', factor: 1e3 },
        { unitKey: 'unit.MW', factor: 1e6 },
        { unitKey: 'unit.GW', factor: 1e9 },
        { unitKey: 'unit.TW', factor: 1e12 }
    ];

    let chosen = levels[0];
    for (let i = levels.length - 1; i >= 1; i--) {
        if (abs >= levels[i].factor) {
            chosen = levels[i];
            break;
        }
    }

    const unitLabel = t(chosen.unitKey);
    const scaled = sign * (abs / chosen.factor);
    let valueStr;
    if (chosen.factor === 1) {
        valueStr = Number.isInteger(scaled)
            ? String(scaled)
            : String(parseFloat(scaled.toFixed(decimals)));
    } else {
        valueStr = (sign * (abs / chosen.factor)).toFixed(decimals);
    }

    const text = withUnit ? `${valueStr} ${unitLabel}` : valueStr;
    return {
        value: sign * (abs / chosen.factor),
        unit: unitLabel,
        text,
        watts: safe
    };
}

/**
 * Пара «текущее / максимум» в одной единице (по большему значению).
 */
export function formatEnergyPair(currentWatts, maxWatts, opts = {}) {
    const decimals = opts.decimals ?? 2;
    const cur = Number(currentWatts) || 0;
    const max = Number(maxWatts) || 0;
    const ref = Math.max(Math.abs(cur), Math.abs(max));

    const levels = [
        { unitKey: 'unit.W',  factor: 1 },
        { unitKey: 'unit.kW', factor: 1e3 },
        { unitKey: 'unit.MW', factor: 1e6 },
        { unitKey: 'unit.GW', factor: 1e9 },
        { unitKey: 'unit.TW', factor: 1e12 }
    ];
    let chosen = levels[0];
    for (let i = levels.length - 1; i >= 1; i--) {
        if (ref >= levels[i].factor) {
            chosen = levels[i];
            break;
        }
    }

    const unitLabel = t(chosen.unitKey);
    const fmt = (w) => {
        const scaled = (Number(w) || 0) / chosen.factor;
        if (chosen.factor === 1) {
            return Number.isInteger(scaled)
                ? String(scaled)
                : String(parseFloat(scaled.toFixed(decimals)));
        }
        return scaled.toFixed(decimals);
    };

    return {
        text: `${fmt(cur)} ${unitLabel} / ${fmt(max)} ${unitLabel}`,
        unit: unitLabel,
        currentText: `${fmt(cur)} ${unitLabel}`,
        maxText: `${fmt(max)} ${unitLabel}`
    };
}


/**
 * Форматирование энергии (Вт·ч) с автосменой единиц:
 * Вт·ч → кВт·ч → МВт·ч → ГВт·ч → ТВт·ч
 */
export function formatEnergyWh(wattHours, opts = {}) {
    const decimals = opts.decimals ?? 2;
    const withUnit = opts.withUnit !== false;
    const n = Number(wattHours);
    const safe = Number.isFinite(n) ? n : 0;
    const sign = safe < 0 ? -1 : 1;
    const abs = Math.abs(safe);

    const levels = [
        { unitKey: 'unit.Wh',  factor: 1 },
        { unitKey: 'unit.kWh', factor: 1e3 },
        { unitKey: 'unit.MWh', factor: 1e6 },
        { unitKey: 'unit.GWh', factor: 1e9 },
        { unitKey: 'unit.TWh', factor: 1e12 }
    ];

    let chosen = levels[0];
    for (let i = levels.length - 1; i >= 1; i--) {
        if (abs >= levels[i].factor) {
            chosen = levels[i];
            break;
        }
    }

    const unitLabel = t(chosen.unitKey);
    const scaled = sign * (abs / chosen.factor);
    let valueStr;
    if (chosen.factor === 1) {
        valueStr = Number.isInteger(scaled)
            ? String(scaled)
            : String(parseFloat(scaled.toFixed(decimals)));
    } else {
        valueStr = scaled.toFixed(decimals);
    }

    const text = withUnit ? `${valueStr} ${unitLabel}` : valueStr;
    return { value: sign * (abs / chosen.factor), unit: unitLabel, text, wattHours: safe };
}

/**
 * Пара «текущее / максимум» в Вт·ч в одной единице.
 */
export function formatEnergyWhPair(currentWh, maxWh, opts = {}) {
    const decimals = opts.decimals ?? 2;
    const cur = Number(currentWh) || 0;
    const max = Number(maxWh) || 0;
    const ref = Math.max(Math.abs(cur), Math.abs(max));

    const levels = [
        { unitKey: 'unit.Wh',  factor: 1 },
        { unitKey: 'unit.kWh', factor: 1e3 },
        { unitKey: 'unit.MWh', factor: 1e6 },
        { unitKey: 'unit.GWh', factor: 1e9 },
        { unitKey: 'unit.TWh', factor: 1e12 }
    ];
    let chosen = levels[0];
    for (let i = levels.length - 1; i >= 1; i--) {
        if (ref >= levels[i].factor) {
            chosen = levels[i];
            break;
        }
    }

    const unitLabel = t(chosen.unitKey);
    const fmt = (w) => {
        const scaled = (Number(w) || 0) / chosen.factor;
        if (chosen.factor === 1) {
            return Number.isInteger(scaled)
                ? String(scaled)
                : String(parseFloat(scaled.toFixed(decimals)));
        }
        return scaled.toFixed(decimals);
    };

    return {
        text: `${fmt(cur)} ${unitLabel} / ${fmt(max)} ${unitLabel}`,
        unit: unitLabel
    };
}
