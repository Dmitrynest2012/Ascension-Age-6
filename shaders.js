/**
 * ============================================================================
 * shaders.js — GLSL-шейдеры проекта (three.js r128)
 * ============================================================================
 *
 * КАРТА ШЕЙДЕРОВ
 * --------------
 * ЗВЁЗДЫ (основная карта)
 *   sunVertexShader / sunFragmentShader
 *   → плазма, пятна, corona; cameraDistance = высота камеры игры
 *
 * ЗВЁЗДЫ (интро)
 *   introSunVertexShader / introSunFragmentShader
 *   → та же визуальная идея, но пороги дистанции под масштаб сцены интро
 *
 * ГРАВИТАЦИОННЫЙ КОЛОДЕЦ
 *   gravityWellLine*  — пунктир/линия границы колодца
 *   gravityWellGradient* — заливка диска колодца
 *
 * ЧАСТИЦЫ / КОЛЬЦА
 *   particleVertexShader / particleFragmentShader
 *   → звёздная пыль и кольца планет (Points)
 *
 * АТМОСФЕРА ПЛАНЕТ/ЗВЁЗД
 *   atmosphereVertexShader / atmosphereFragmentShader
 *   → объёмный optical depth, ρ=exp(−h/H); день/ночь; лимб-маска
 *
 * НОЧНЫЕ ОГНИ ГОРОДОВ
 *   cityLightsVertexShader / cityLightsFragmentShader
 *   → Additive, только ночная сторона, только colonized
 *
 * ПОЛЯРНОЕ СИЯНИЕ
 *   auroraVertexShader / auroraFragmentShader
 *   → шумовые завесы у полюсов; видно на 1ZC; time * timeSpeed
 *
 * Все строки — template literals, экспортируются в bodies.js / intro.js.
 * ============================================================================
 */

/**
 * СОЛНЦЕ — основная карта (bodies.js, type === 'star')
 *
 * Vertex: передаёт normal (view), position (view), uv.
 *
 * Fragment uniforms:
 *   sunTexture      — диффузная карта поверхности
 *   time            — анимация плазмы/пятен (из updateBodies)
 *   cameraDistance  — distance(camera, star); управляет «смыванием» деталей
 *                     при отлёте камеры (высота на основной карте)
 *
 * Слои цвета:
 *   1) текстура + UV-ripple/flow + грануляция (плазма)
 *   2) rim: glow / chromosphere / corona
 *   3) sunspots (вычитание), flicker, protuberance
 *   distFactor / nearFade / detailBoost / detailVis — логика высоты камеры
 */
export const sunVertexShader = `
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec2 vUv;
    void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const sunFragmentShader = `
    uniform sampler2D sunTexture;
    uniform float time;
    uniform float cameraDistance;
    uniform float interstellarMode; // 0 = обычная звезда, 1 = 4ZC восьмиконечная
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec2 vUv;

    float random(vec2 st) {
        return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123);
    }
    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) +
               (c - a) * u.y * (1.0 - u.x) +
               (d - b) * u.x * u.y;
    }

    void main() {
        vec3 viewDir = normalize(-vPosition);
        float rim = 1.0 - max(dot(vNormal, viewDir), 0.0);

        // скорости анимации (time*) — без изменений
        vec2 ripple = 0.002 * vec2(
            sin(vUv.y * 50.0 + time * 2.0),
            cos(vUv.x * 50.0 + time * 2.0)
        );
        vec2 flow = (vec2(
            noise(vUv * 6.0 + vec2(time * 0.03, -time * 0.02)),
            noise(vUv * 6.0 + vec2(-time * 0.02, time * 0.03))
        ) - 0.5) * 0.006;

        vec2 animatedUv = vUv + ripple + flow;
        vec4 texColor = texture2D(sunTexture, animatedUv);

        // --- Плазма / грануляция: сильнее контраст, та же скорость ---
        float gran = noise(vUv * 30.0 + time * 0.1);
        float gran2 = noise(vUv * 48.0 + time * 0.1 + 2.7);
        vec3 baseColor = texColor.rgb * (0.72 + gran * 0.38 + gran2 * 0.12);
        // цветовой перелив плазмы (оранжево-жёлтый)
        vec3 plasmaShimmer = vec3(1.2, 0.5, 0.08) * (gran - 0.42) * 0.55
                           + vec3(1.0, 0.75, 0.2) * (gran2 - 0.5) * 0.28;

        vec3 glow = vec3(1.0, 0.8, 0.2) * pow(rim, 2.0) * 0.6;
        vec3 chromosphere = vec3(1.0, 0.3, 0.1) * pow(rim, 3.0) * 0.3;
        vec3 corona = vec3(0.9, 0.95, 1.0) * pow(rim, 1.3) * 0.08;

        // --- Пятна: глубже и контрастнее, скорость та же ---
        vec2 uvSpots = vUv * 10.0 + vec2(time * 0.1, time * 0.05);
        float spots = noise(uvSpots);
        float spotMask = pow(1.0 - smoothstep(0.26, 0.58, spots), 1.5);
        vec3 sunspots = vec3(1.05, 0.92, 0.8) * spotMask * 0.42;
        // второй слой более мелких пятен
        float spots2 = noise(uvSpots * 2.15 + vec2(4.2, 1.7));
        float spotMask2 = pow(1.0 - smoothstep(0.38, 0.62, spots2), 1.25);
        sunspots += vec3(1.0, 0.95, 0.9) * spotMask2 * 0.18;

        vec2 uvFlicker = vUv * 20.0 + vec2(time * 0.2, time * 0.1);
        // биполярный flicker — заметнее переливы
        float flicker = (noise(uvFlicker) - 0.5) * 0.48;

        // --- Логика камеры — как раньше ---
        float distFactor = clamp((cameraDistance - 2.0) / 8.0, 0.0, 1.0);
        vec3 whiteColor = vec3(1.0);
        vec3 finalBaseColor = mix(baseColor, whiteColor, distFactor * 0.5);

        float nearFade = smoothstep(0.5, 3.0, cameraDistance);
        float brightnessFade = mix(0.35, 1.0, nearFade);
        finalBaseColor *= brightnessFade;
        float detailBoost = 1.0 + (1.0 - nearFade) * 2.0;
        finalBaseColor *= detailBoost;

        float protPhase = sin(time * 1.5 + vUv.x * 30.0 + vUv.y * 10.0);
        float protuberance = max(0.0, pow(rim, 6.0) * (0.4 + 0.6 * protPhase));
        float protoFade = pow(nearFade, 0.8);
        vec3 flare = vec3(1.0, 0.35, 0.05) * protuberance * 0.6 * protoFade;

        // детали поверхности гаснут с дистанцией так же, как «смывание» к белому
        float detailVis = mix(1.15, 0.2, distFactor);

        vec3 finalColor = finalBaseColor
                        + plasmaShimmer * detailVis
                        + (glow + chromosphere + corona) * nearFade
                        + flare
                        - sunspots * detailVis
                        + flicker * detailVis;

        // На 4ZC форма «8 лучей» рисуется отдельным билбордом (starIcon*),
        // сфера остаётся цветным ядром без фейковых спайков на диске.
        gl_FragColor = vec4(finalColor, 1.0);
    }
`;


/**
 * 4ZC — восьмиконечная звезда (билборд в плоскости экрана).
 * Центр сохраняет цвет звезды с нижних масштабов; лучи белые с лёгким оттенком.
 */
export const starIconVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const starIconFragmentShader = `
    uniform vec3 starColor;
    uniform float opacity;
    varying vec2 vUv;

    void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.02) discard;

        float ang = atan(p.y, p.x);
        // 8 лепестков: 4 оси + 4 диагонали
        float ray8 = pow(abs(cos(ang * 4.0)), 11.0);
        float ray4 = pow(abs(cos(ang * 2.0)), 22.0);
        float rays = max(ray8, ray4 * 0.72);
        float rayMask = rays * exp(-r * 2.15) * (1.0 - smoothstep(0.42, 1.0, r));

        float core = exp(-r * r * 32.0);
        float halo = exp(-r * r * 8.5) * 0.55;

        vec3 col = starColor * (core * 1.85 + halo);
        vec3 rayCol = mix(vec3(1.0, 0.98, 0.94), starColor, 0.22);
        col += rayCol * rayMask * 2.05;

        float a = clamp(core * 1.35 + halo * 0.75 + rayMask * 1.25, 0.0, 1.0) * opacity;
        if (a < 0.018) discard;
        gl_FragColor = vec4(col, a);
    }
`;

/**
 * 3ZC — корона/гало звезды (билборд в плоскости экрана).
 * Центр почти прозрачный (диск звезды не перекрываем), кольцо чуть снаружи сферы.
 */
export const starHaloVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const starHaloFragmentShader = `
    uniform vec3 starColor;
    uniform float opacity;
    uniform float innerRatio;
    varying vec2 vUv;

    void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float inn = clamp(innerRatio, 0.15, 0.95);
        if (r < inn || r > 1.0) discard;
        float t = (r - inn) / max(1.0 - inn, 0.001);
        float ring = smoothstep(0.0, 0.42, t) * (1.0 - smoothstep(0.58, 1.0, t));
        float a = ring * opacity;
        if (a < 0.006) discard;
        vec3 col = mix(starColor, starColor * vec3(1.0, 0.78, 0.48), t);
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
    }
`;

/**
 * 3ZC — блик линзы (цветной диск-призрак).
 */
export const starFlareVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const starFlareFragmentShader = `
    uniform vec3 flareColor;
    uniform float opacity;
    uniform float softness;
    varying vec2 vUv;

    void main() {
        // слегка вытянутый блик, не круглая «копия звезды»
        vec2 p = vUv * 2.0 - 1.0;
        p.y *= 1.55;
        float r = length(p);
        if (r > 1.0) discard;
        float s = max(0.18, softness);
        float core = exp(-r * r * 7.5);
        float disc = 1.0 - smoothstep(0.05, s, r);
        float a = (core * 0.55 + disc * 0.35) * opacity;
        if (a < 0.016) discard;
        gl_FragColor = vec4(flareColor * (0.45 + core * 0.55), clamp(a, 0.0, 1.0));
    }
`;

/**
 * СОЛНЦЕ — ИНТРО (intro.js)
 *
 * Отдельная пара шейдеров: НЕ менять sunFragmentShader игры.
 * cameraDistance = длина camera→звезда в сцене интро (порядок 8–120, R☉=8).
 * Пороги distFactor/nearFade заточены под этот масштаб.
 * time из intro подаётся очень малым (почти застывшая плазма).
 */
export const introSunVertexShader = `
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec2 vUv;
    void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const introSunFragmentShader = `
    uniform sampler2D sunTexture;
    uniform float time;
    uniform float cameraDistance;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec2 vUv;

    float random(vec2 st) {
        return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123);
    }
    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) +
               (c - a) * u.y * (1.0 - u.x) +
               (d - b) * u.x * u.y;
    }

    void main() {
        vec3 viewDir = normalize(-vPosition);
        float rim = 1.0 - max(dot(vNormal, viewDir), 0.0);

        // time уже подаётся крайне малым из intro.js — движение почти незаметно
        vec2 ripple = 0.002 * vec2(
            sin(vUv.y * 50.0 + time * 2.0),
            cos(vUv.x * 50.0 + time * 2.0)
        );
        vec2 flow = (vec2(
            noise(vUv * 6.0 + vec2(time * 0.03, -time * 0.02)),
            noise(vUv * 6.0 + vec2(-time * 0.02, time * 0.03))
        ) - 0.5) * 0.006;

        vec2 animatedUv = vUv + ripple + flow;
        vec4 texColor = texture2D(sunTexture, animatedUv);

        float gran = noise(vUv * 30.0 + time * 0.1);
        float gran2 = noise(vUv * 48.0 + time * 0.1 + 2.7);
        vec3 baseColor = texColor.rgb * (0.72 + gran * 0.38 + gran2 * 0.12);
        vec3 plasmaShimmer = vec3(1.2, 0.5, 0.08) * (gran - 0.42) * 0.55
                           + vec3(1.0, 0.75, 0.2) * (gran2 - 0.5) * 0.28;

        vec3 glow = vec3(1.0, 0.8, 0.2) * pow(rim, 2.0) * 0.55;
        vec3 chromosphere = vec3(1.0, 0.3, 0.1) * pow(rim, 3.0) * 0.28;
        vec3 corona = vec3(0.9, 0.95, 1.0) * pow(rim, 1.3) * 0.08;

        vec2 uvSpots = vUv * 10.0 + vec2(time * 0.1, time * 0.05);
        float spots = noise(uvSpots);
        float spotMask = pow(1.0 - smoothstep(0.26, 0.58, spots), 1.5);
        vec3 sunspots = vec3(1.05, 0.92, 0.8) * spotMask * 0.42;
        float spots2 = noise(uvSpots * 2.15 + vec2(4.2, 1.7));
        float spotMask2 = pow(1.0 - smoothstep(0.38, 0.62, spots2), 1.25);
        sunspots += vec3(1.0, 0.95, 0.9) * spotMask2 * 0.18;

        vec2 uvFlicker = vUv * 20.0 + vec2(time * 0.2, time * 0.1);
        float flicker = (noise(uvFlicker) - 0.5) * 0.48;

        /*
         * Дистанция камера↔звезда в ИНТРО (не путать с основной картой):
         *  ~10–18  — пролёт над Солнцем → полные переливы и пятна
         *  ~25–45  — переход
         *  >60     — далёкий диск, детали почти скрыты
         */
        float distFactor = clamp((cameraDistance - 14.0) / 50.0, 0.0, 1.0);
        float nearFade = smoothstep(12.0, 42.0, cameraDistance);
        float brightnessFade = mix(0.55, 1.0, nearFade);
        float detailBoost = 1.0 + (1.0 - nearFade) * 1.8;
        float detailVis = mix(1.2, 0.04, distFactor);

        vec3 whiteColor = vec3(1.0);
        vec3 finalBaseColor = mix(baseColor, whiteColor, distFactor * 0.55);
        finalBaseColor *= brightnessFade;
        finalBaseColor *= detailBoost;

        float protPhase = sin(time * 1.5 + vUv.x * 30.0 + vUv.y * 10.0);
        float protuberance = max(0.0, pow(rim, 6.0) * (0.4 + 0.6 * protPhase));
        float protoFade = pow(nearFade, 0.8);
        vec3 flare = vec3(1.0, 0.35, 0.05) * protuberance * 0.55 * protoFade;

        vec3 finalColor = finalBaseColor
                        + plasmaShimmer * detailVis
                        + (glow + chromosphere + corona) * nearFade
                        + flare
                        - sunspots * detailVis
                        + flicker * detailVis;

        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

/**
 * ГРАВИТАЦИОННЫЙ КОЛОДЕЦ — линия границы (bodies.js)
 * Простой unlit цвет/прозрачность по UV.
 */
export const gravityWellLineVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const gravityWellLineFragmentShader = `
    varying vec2 vUv;
    uniform float dashFrequency; // Добавляем униформу для частоты пунктира
    void main() {
        float dist = length(vUv - vec2(0.5));
        if (dist < 0.45 || dist > 0.5) discard; // Ограничиваем рендеринг кольцом
        float angle = atan(vUv.y - 0.5, vUv.x - 0.5);
        float dash = step(0.5, sin(angle * dashFrequency) * 0.5 + 0.5); // Частота пунктира
        if (dash < 0.5) discard;
        vec3 color = vec3(0.5, 0.5, 0.5); // Серый
        gl_FragColor = vec4(color, 0.2); // Фиксированная прозрачность
    }
`;

/**
 * ГРАВИТАЦИОННЫЙ КОЛОДЕЦ — заливка диска (градиент к краю)
 */
export const gravityWellGradientVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const gravityWellGradientFragmentShader = `
    varying vec2 vUv;
    void main() {
        float dist = length(vUv - vec2(0.5)); // Расстояние от центра
        float alpha = smoothstep(0.2, 0.5, dist); // Инвертированный градиент: плотный центр, прозрачные края
        vec3 color = vec3(0.5, 0.5, 0.5); // Серый
        gl_FragColor = vec4(color, alpha * 0.12);
    }
`;

/**
 * ЧАСТИЦЫ / КОЛЬЦА (Points)
 * randomSeed — фаза мерцания; pointSize масштабируется от cameraDistance.
 * Используется для пыли у звезды и ringSystems планет.
 */
export const particleVertexShader = `
    attribute float randomSeed;
    uniform float time;
    uniform float opacity;
    uniform float pointSize;
    uniform float cameraDistance;
    varying float vBrightness;
    void main() {
        float phase = sin(time * 0.5 + randomSeed * 10.0);
        vBrightness = 0.5 + 0.5 * phase;
        float adjustedPointSize = pointSize * clamp(10.0 / cameraDistance, 0.5, 2.0); // Масштабируем размер частиц
        gl_PointSize = adjustedPointSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const particleFragmentShader = `
    uniform float opacity;
    uniform vec3 color;
    varying float vBrightness;
    void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float dist = length(uv);
        if (dist > 0.5) discard;
        gl_FragColor = vec4(color * vBrightness, opacity);
    }
`;

/**
 * АТМОСФЕРА (bodies.js + intro.js)
 *
 * Объём между innerRadius (поверхность) и outerRadius (верх).
 * Луч камеры → отрезок внутри оболочки → интеграл ρ = exp(−h/H).
 * Гуще у поверхности, рассеивается в космос (не «матрёшка»).
 *
 * Uniforms:
 *   glowColor, planetCenter, sunPosition, lightResponse (0=звезда без дня/ночи),
 *   innerRadius, outerRadius, densityMul, scaleHeight
 *   cameraPosition — встроенный three.js
 *
 * Лимб-маска: центр диска почти без дымки; силуэт и внешнее гало — полная сила.
 * lightResponse>0: каждый сэмпл * dayFactor (ночь ~7%).
 * JSON: hasAtmosphere, atmosphereColor, atmosphereScale, atmosphereIntensity, atmosphereScaleHeight
 */
export const atmosphereVertexShader = `
    varying vec3 vWorldPos;
    varying vec3 vCenter; // центр планеты из modelMatrix — всегда синхронен с геометрией
    void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        // origin меша в world-space (атмосфера — child планеты @ local 0)
        vCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
    }
`;

export const atmosphereFragmentShader = `
    uniform vec3 glowColor;
    uniform vec3 planetCenter;   // legacy, не используем для raymarch
    uniform vec3 sunPosition;
    uniform float lightResponse;
    uniform float innerRadius;
    uniform float outerRadius;
    uniform float densityMul;
    uniform float scaleHeight;
    varying vec3 vWorldPos;
    varying vec3 vCenter;

    bool raySphereLocal(vec3 ro, vec3 rd, float radius, out float tNear, out float tFar) {
        float b = dot(ro, rd);
        float c = dot(ro, ro) - radius * radius;
        float h = b * b - c;
        if (h < 0.0) return false;
        h = sqrt(max(h, 0.0));
        tNear = -b - h;
        tFar  = -b + h;
        return tFar > 0.0;
    }

    float dayFactorLocal(vec3 localPos, vec3 localSunDir) {
        vec3 n = normalize(localPos);
        vec3 l = normalize(localSunDir);
        float ndotl = dot(n, l);
        float day = smoothstep(-0.22, 0.38, ndotl);
        return mix(0.07, 1.0, day);
    }

    void main() {
        // Локальная система: центр = 0. vCenter из той же modelMatrix, что и вершины → нет дрожания
        vec3 center = vCenter;
        vec3 ro = cameraPosition - center;
        vec3 rd = normalize(vWorldPos - cameraPosition);
        vec3 localSun = sunPosition - center;

        float tOutNear, tOutFar;
        if (!raySphereLocal(ro, rd, outerRadius, tOutNear, tOutFar)) discard;

        float tStart = max(tOutNear, 0.0);
        float tEnd   = tOutFar;

        bool hitsPlanet = false;
        float tInNear, tInFar;
        if (raySphereLocal(ro, rd, innerRadius, tInNear, tInFar)) {
            if (tInNear > 0.0) {
                tEnd = min(tEnd, tInNear);
                hitsPlanet = true;
            }
        }
        if (tEnd <= tStart) discard;

        float tCam = max(-dot(ro, rd), 0.0);
        float rClosest = length(ro + rd * tCam);

        float limbMask;
        if (hitsPlanet) {
            limbMask = smoothstep(innerRadius * 0.62, innerRadius * 0.995, rClosest);
            limbMask = max(limbMask * 0.68, 0.025);
        } else {
            limbMask = 1.0;
        }

        const int STEPS = 8;
        float seg = (tEnd - tStart) / float(STEPS);
        float optical = 0.0;
        float H = max(scaleHeight, 1e-4);

        for (int i = 0; i < STEPS; i++) {
            float t = tStart + (float(i) + 0.5) * seg;
            vec3 p = ro + rd * t; // local
            float r = length(p);
            float h = max(r - innerRadius, 0.0);
            float rho = exp(-h / H);
            float day = mix(1.0, dayFactorLocal(p, localSun), lightResponse);
            rho *= day;
            optical += rho * seg;
        }

        float thickness = max(outerRadius - innerRadius, 1e-4);
        float depth = (optical / thickness) * limbMask;

        float alpha = 1.0 - exp(-depth * densityMul * 1.8);
        alpha = pow(clamp(alpha, 0.0, 1.0), 1.35);
        alpha = min(alpha, 0.85);

        vec3 col = glowColor * (0.5 + 0.5 * clamp(depth * densityMul, 0.0, 1.2));

        if (alpha < 0.006) discard;
        gl_FragColor = vec4(col, alpha);
    }
`;


/**
 * НОЧНЫЕ ОГНИ ГОРОДОВ (bodies.js)
 *
 * Условия геймплея (JS): hasCityLights && colonized; mesh.visible обновляется в sync.
 * Шейдер: AdditiveBlending; вклад только если N·L < 0 (ночь), плавный терминатор.
 *
 * Uniforms:
 *   lightsMap     — текстура огней (чёрный фон, яркие города)
 *   sunDirection  — normalize(starWorld − planetWorld), каждый кадр
 *   intensity     — cityLightsIntensity из JSON
 *
 * Vertex отдаёт world-normal (mat3(modelMatrix)*normal), не view-normal —
 * иначе день/ночь ломается при повороте камеры.
 */
export const cityLightsVertexShader = `
    varying vec2 vUv;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;
    void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        // world-space normal для стабильного терминатора
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
`;

export const cityLightsFragmentShader = `
    uniform sampler2D lightsMap;
    uniform vec3 sunDirection; // от центра планеты к звезде (world)
    uniform float intensity;
    varying vec2 vUv;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;

    void main() {
        vec3 n = normalize(vWorldNormal);
        float ndotl = dot(n, normalize(sunDirection));
        // 1 на ночи, 0 на дне
        float night = 1.0 - smoothstep(-0.05, 0.35, ndotl);
        if (night < 0.01) discard;

        vec4 tex = texture2D(lightsMap, vUv);
        float lum = max(tex.r, max(tex.g, tex.b));
        if (lum < 0.04) discard;

        vec3 col = tex.rgb * intensity * night;
        float alpha = lum * night * intensity;
        gl_FragColor = vec4(col, alpha);
    }
`;


/**
 * ПОЛЯРНОЕ СИЯНИЕ (bodies.js + intro.js)
 *
 * Без текстур. Child-сфера планеты (локальный Y = ось) → сияние у полюсов.
 * JS: hasMagneticField; visible только currentLevelId === '1ZC';
 *     time += dt * timeSpeed (в интро — просто dt * const).
 *
 * Алгоритм fragment:
 *   lat = |normalize(localPos).y|  — 0 экватор, 1 полюс
 *   band — узкое кольцо высоких широт (тонкое, чтобы не закрывать планету)
 *   3× fbm-слоя с разными скоростями → «завесы» green/cyan/violet/pink
 *   alpha сильно приглушён (едва заметные переливы)
 *
 * Uniforms: time, intensity (auroraIntensity из JSON)
 */
export const auroraVertexShader = `
    varying vec3 vLocalPos;
    varying vec3 vLocalNormal;
    void main() {
        vLocalPos = position;
        vLocalNormal = normalize(normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const auroraFragmentShader = `
    uniform float time;
    uniform float intensity;
    varying vec3 vLocalPos;
    varying vec3 vLocalNormal;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p *= 2.05;
            a *= 0.5;
        }
        return v;
    }

    void main() {
        vec3 p = normalize(vLocalPos);
        // широта: 0 экватор → 1 полюс
        float lat = abs(p.y);

        // Тонкое кольцо у полюсов (узкая полоса широты)
        float band = smoothstep(0.78, 0.84, lat) * (1.0 - smoothstep(0.90, 0.95, lat));
        if (band < 0.008) discard;

        float lon = atan(p.x, p.z);

        float t = time;
        float n1 = fbm(vec2(lon * 2.5 + t * 0.35, lat * 14.0 - t * 0.12));
        float n2 = fbm(vec2(lon * 4.0 - t * 0.55, lat * 18.0 + t * 0.2));
        float n3 = fbm(vec2(lon * 1.6 + t * 0.2, lat * 10.0 + t * 0.08));

        // редкие завесы, не сплошная заливка
        float curtain = pow(max(n1 * 0.5 + n2 * 0.35 + n3 * 0.2, 0.0), 1.8);
        curtain *= band;
        float soft = smoothstep(0.08, 0.4, curtain);

        vec3 cGreen  = vec3(0.25, 0.95, 0.45);
        vec3 cCyan   = vec3(0.2, 0.85, 0.9);
        vec3 cViolet = vec3(0.55, 0.25, 0.95);
        vec3 cPink   = vec3(0.95, 0.35, 0.65);

        vec3 col = mix(cGreen, cCyan, clamp(n2, 0.0, 1.0));
        col = mix(col, cViolet, clamp(n3 * 0.85, 0.0, 1.0));
        col = mix(col, cPink, clamp(n1 * 0.35, 0.0, 1.0));

        // едва заметная прозрачность
        float alpha = curtain * soft * intensity * 0.38;
        if (alpha < 0.012) discard;

        gl_FragColor = vec4(col * 0.72, alpha);
    }
`;


/**
 * МЕЖЗВЁЗДНАЯ ТУМАННОСТЬ (тип interstellarNebula)
 * Плоскость XZ под звёздами. Несколько цветов, шум, мягкие края (как intro nebula).
 * Uniform opacity — плавное появление на 4ZC.
 */
export const nebulaVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const nebulaFragmentShader = `
    uniform vec3 colorA;
    uniform vec3 colorB;
    uniform vec3 colorC;
    uniform vec3 colorD;
    uniform float opacity;
    uniform float time;
    uniform float noiseScale;
    uniform float edgeSoftness;
    varying vec2 vUv;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
            v += a * noise(p);
            p *= 2.1;
            a *= 0.5;
        }
        return v;
    }

    void main() {
        vec2 uv = vUv * 2.0 - 1.0;
        float dist = length(uv);
        // мягкий край диска туманности
        float edge = 1.0 - smoothstep(0.35, 1.0, dist / max(edgeSoftness, 0.15));
        if (edge < 0.01) discard;

        float t = time * 0.02;
        float n1 = fbm(uv * noiseScale + vec2(t, -t * 0.7));
        float n2 = fbm(uv * noiseScale * 1.7 + vec2(-t * 0.5, t * 0.3));
        float n3 = fbm(uv * (noiseScale * 0.6) + vec2(t * 0.2, t * 0.4));

        vec3 col = mix(colorA, colorB, clamp(n1, 0.0, 1.0));
        col = mix(col, colorC, clamp(n2 * 0.7, 0.0, 1.0));
        col = mix(col, colorD, clamp(n3 * 0.4, 0.0, 1.0));

        float density = pow(max(n1 * 0.45 + n2 * 0.35 + n3 * 0.3, 0.0), 0.9) * edge;
        float alpha = density * opacity * 1.15;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(col * (0.75 + density * 0.6), min(alpha, 1.0));
    }
`;
