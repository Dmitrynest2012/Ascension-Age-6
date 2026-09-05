/**
 * Экран Интро: полёт камеры → видео → титры → загрузка основной игры.
 * Таймеры настраиваются константами ниже.
 */
import { t, getLang, onLanguageChange, getEffectiveVolume, onVolumeChange } from './settings.js';
import {
    introSunVertexShader,
    introSunFragmentShader,
    atmosphereVertexShader,
    atmosphereFragmentShader,
    auroraVertexShader,
    auroraFragmentShader
} from './shaders.js';

/* ========== НАСТРОЙКИ (меняй здесь) ========== */
/** Длительность полёта камеры до Земли, мс */
export let INTRO_FLIGHT_MS = 37000;
/** Второй таймер: от старта видео до выезда названия, мс */
export let INTRO_TITLE_DELAY_MS = 75000;
/** Пауза после остановки титров до затемнения, мс */
export let INTRO_TITLE_HOLD_MS = 1800;
/** Длительность затемнения, мс */
export let INTRO_FADE_MS = 1200;

/** Пути к медиа (файлы можно добавить позже — интро продолжит работу без них) */
export const INTRO_MEDIA = {
    music: 'assets/audio/intro/intro_space.mp3',
    voiceRu: 'assets/audio/intro/intro_voice_ru.mp3',
    voiceEn: 'assets/audio/intro/intro_voice_en.mp3',
    video: 'assets/video/intro/intro_chronicles.mp4',
    sun: 'assets/textures/planets/sun.jpg',
    earth: 'assets/textures/planets/earth.jpg',
    earthSpecular: 'assets/textures/planets/earth_specular.jpg',
    earthClouds: 'assets/textures/planets/earth_clouds.jpg',
    moon: 'assets/textures/planets/moon.jpg'
};

let sessionName = '';
let introActive = false;
let introSkipRequested = false;
let rafId = 0;
let sceneApi = null;
let musicAudio = null;
let voiceAudio = null;
let onIntroComplete = null;
/** resolve текущей фазы ожидания (skip прерывает sleep-фазы) */
let phaseWaitResolve = null;

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/** Ожидание с возможностью прерывания скипом */
function sleepInterruptible(ms) {
    return new Promise(resolve => {
        const start = performance.now();
        const tick = () => {
            if (!introActive || introSkipRequested) {
                phaseWaitResolve = null;
                return resolve(true); // interrupted
            }
            if (performance.now() - start >= ms) {
                phaseWaitResolve = null;
                return resolve(false);
            }
            phaseWaitResolve = () => resolve(true);
            setTimeout(tick, 40);
        };
        tick();
    });
}

function showSkipButton(show, { instant = false } = {}) {
    const btn = document.getElementById('intro-skip-btn');
    if (!btn) return;
    if (instant) {
        const prev = btn.style.transition;
        btn.style.transition = 'none';
        btn.classList.toggle('visible', !!show);
        // force reflow so transition:none applies
        void btn.offsetWidth;
        btn.style.transition = prev || '';
    } else {
        btn.classList.toggle('visible', !!show);
    }
    if (show) btn.textContent = t('intro.skip');
}

/**
 * Пропуск интро → сразу экран загрузки.
 * Вызывается кнопкой; также дергается из циклов по флагу.
 */
async function skipIntroToLoading() {
    if (!introActive || introSkipRequested) return;
    introSkipRequested = true;
    if (typeof phaseWaitResolve === 'function') {
        try { phaseWaitResolve(); } catch (_) {}
        phaseWaitResolve = null;
    }

    const screen = document.getElementById('intro-screen');
    const canvas = document.getElementById('intro-canvas');
    const videoFrame = document.getElementById('intro-video-frame');
    const fade = document.getElementById('intro-fade');
    const loading = document.getElementById('intro-loading');
    const loadFill = document.getElementById('intro-loading-fill');
    const loadPct = document.getElementById('intro-loading-pct');
    const title1 = document.getElementById('intro-title-line1');
    const title2 = document.getElementById('intro-title-line2');
    const video = document.getElementById('intro-video');

    // Сначала мгновенно убрать кнопку — до прогрессбара
    showSkipButton(false, { instant: true });
    screen?.classList.add('intro-skipping', 'video-focus');
    hideCaption();

    // остановить медиа
    stopAudio(musicAudio); musicAudio = null;
    stopAudio(voiceAudio); voiceAudio = null;
    if (video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
    }
    videoFrame?.classList.remove('visible', 'fade-chrome');
    title1?.classList.remove('animate-in');
    title2?.classList.remove('animate-in');
    if (canvas) {
        canvas.style.transition = 'opacity 0.4s ease';
        canvas.style.opacity = '0';
    }
    cancelAnimationFrame(rafId);
    if (sceneApi) {
        try { sceneApi.dispose(); } catch (_) {}
        sceneApi = null;
    }

    // Сразу загрузка
    fade?.classList.add('visible');
    loading?.classList.add('visible');
    let progress = 0;
    const bump = (to) => {
        progress = Math.max(progress, to);
        if (loadFill) loadFill.style.width = `${Math.round(progress)}%`;
        if (loadPct) loadPct.textContent = `${Math.round(progress)}%`;
    };
    bump(5);

    const loadPromise = (typeof onIntroComplete === 'function')
        ? Promise.resolve().then(() => onIntroComplete({ phase: 'load', report: bump }))
        : sleep(800);

    const progTimer = setInterval(() => {
        if (progress < 90) bump(progress + 3 + Math.random() * 5);
    }, 160);

    try {
        await loadPromise;
        bump(100);
    } catch (e) {
        console.error('Intro skip load error', e);
        bump(100);
    }
    clearInterval(progTimer);
    await sleep(300);
    cleanupIntro();
}

function tryPlay(audio) {
    if (!audio) return Promise.resolve();
    return audio.play().catch(() => {});
}

function stopAudio(a) {
    if (!a) return;
    try { a.pause(); a.src = ''; } catch (_) {}
}

function applyIntroVolumes() {
    if (musicAudio) musicAudio.volume = getEffectiveVolume('music');
    if (voiceAudio) voiceAudio.volume = getEffectiveVolume('voice');
    const video = document.getElementById('intro-video');
    // Звуковая дорожка видео = канал music
    if (video) {
        video.muted = false;
        video.volume = getEffectiveVolume('music');
    }
}

/* ---------- Модалка имени сессии ---------- */
export function openSessionNameModal() {
    const modal = document.getElementById('session-name-modal');
    const input = document.getElementById('session-name-input');
    const immerse = document.getElementById('session-immerse-btn');
    if (!modal) return;
    modal.classList.add('open');
    if (input) {
        input.value = sessionName || '';
        input.focus();
        updateImmerseState();
    }
    if (immerse) immerse.disabled = !(input && input.value.trim().length > 0);
}

export function closeSessionNameModal() {
    document.getElementById('session-name-modal')?.classList.remove('open');
}

function updateImmerseState() {
    const input = document.getElementById('session-name-input');
    const immerse = document.getElementById('session-immerse-btn');
    if (!immerse) return;
    immerse.disabled = !(input && input.value.trim().length > 0);
}

export function getSessionName() {
    return sessionName;
}

/* ---------- 3D сцена интро ---------- */
/** Круглая мягкая точка для Points (без квадратных пикселей) */
function makeCirclePointTexture(size = 64, soft = true) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const half = size / 2;
    const g = ctx.createRadialGradient(half, half, 0, half, half, half);
    if (soft) {
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
        g.addColorStop(0.7, 'rgba(255,255,255,0.15)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
    } else {
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.55, 'rgba(255,255,255,1)');
        g.addColorStop(0.85, 'rgba(255,255,255,0.35)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
}

const CIRCLE_POINT_TEX = makeCirclePointTexture(64, true);

function createStars(count = 2500) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const r = 80 + Math.random() * 420;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const x = r * Math.sin(phi) * Math.cos(theta);
        const y = r * Math.sin(phi) * Math.sin(theta);
        const z = r * Math.cos(phi);
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        // дальше от центра — краснее
        const dist = r / 500;
        col[i * 3] = 0.55 + dist * 0.45;
        col[i * 3 + 1] = 0.55 - dist * 0.25;
        col[i * 3 + 2] = 0.7 - dist * 0.4;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        size: 0.7,
        map: CIRCLE_POINT_TEX,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending
    });
    return new THREE.Points(geo, mat);
}

function createDust(count = 600) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        // вдоль коридора полёта (ось Z), лёгкий разброс
        pos[i * 3] = (Math.random() - 0.5) * 28;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 18;
        pos[i * 3 + 2] = 90 - Math.random() * 220;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        size: 0.28,
        map: CIRCLE_POINT_TEX,
        color: 0xa8b8c8,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending
    });
    return new THREE.Points(geo, mat);
}

function createNebula() {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(256, 256, 20, 256, 256, 250);
    g.addColorStop(0, 'rgba(90, 110, 140, 0.35)');
    g.addColorStop(0.4, 'rgba(40, 50, 70, 0.18)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(500, 300), mat);
    mesh.position.set(40, -20, -280);
    return mesh;
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerpVec(a, b, t, out) {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    return out;
}


/** Объёмная атмосфера интро — тот же ray–sphere exp(-h/H), что и в основной карте */

/** Облака интро — как в основной игре (Lambert + alphaMap) */
function createIntroClouds(size, cloudTex, density = 0.65) {
    if (!cloudTex) return null;
    const scale = 1.025;
    const alphaTex = cloudTex.clone();
    alphaTex.needsUpdate = true;
    const mat = new THREE.MeshLambertMaterial({
        map: cloudTex,
        alphaMap: alphaTex,
        color: new THREE.Color(1.4, 1.4, 1.45),
        transparent: true,
        opacity: 0.55 + density * 0.45,
        depthWrite: false,
        side: THREE.FrontSide,
        emissive: new THREE.Color(0.2, 0.2, 0.22),
        emissiveMap: alphaTex
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(size * scale, 96, 96), mat);
    shell.name = 'intro-clouds';
    shell.renderOrder = 1;
    return shell;
}

/** Полярное сияние интро — тот же шейдер, что в игре */
function createIntroAurora(size, intensity = 0.4) {
    const scale = 1.09;
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0 },
            intensity: { value: intensity }
        },
        vertexShader: auroraVertexShader,
        fragmentShader: auroraFragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(size * scale, 96, 96), mat);
    shell.name = 'intro-aurora';
    shell.renderOrder = 3;
    return shell;
}

function createIntroAtmosphere(size, opts = {}) {
    const isStar = !!opts.isStar;
    const scale = opts.scale ?? (isStar ? 1.2 : 1.07);
    const intensity = opts.intensity ?? (isStar ? 1.55 : 0.85);
    const heightFrac = opts.heightFrac ?? (isStar ? 0.3 : 0.18);
    const outerR = size * scale;
    const innerR = size;
    const thickness = Math.max(outerR - innerR, size * 0.01);
    const color = new THREE.Color(opts.color || (isStar ? '#ffb45a' : '#6BA3FF'));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            glowColor: { value: color },
            planetCenter: { value: new THREE.Vector3(0, 0, 0) },
            sunPosition: { value: new THREE.Vector3(0, 0, 0) },
            lightResponse: { value: isStar ? 0.0 : 1.0 },
            innerRadius: { value: innerR },
            outerRadius: { value: outerR },
            densityMul: { value: intensity },
            scaleHeight: { value: thickness * heightFrac }
        },
        vertexShader: atmosphereVertexShader,
        fragmentShader: atmosphereFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(outerR, 64, 64), mat);
    shell.name = 'intro-atmosphere';
    shell.renderOrder = 2;
    return shell;
}

function syncIntroAtmosphere(bodyMesh, atmo, sunPos, bodyWorldPos) {
    if (!atmo?.material?.uniforms) return;
    const u = atmo.material.uniforms;
    if (bodyWorldPos) {
        u.planetCenter.value.copy(bodyWorldPos);
    } else if (bodyMesh) {
        bodyMesh.getWorldPosition(u.planetCenter.value);
    }
    if (sunPos && u.sunPosition) {
        u.sunPosition.value.set(sunPos.x, sunPos.y, sunPos.z);
    }
}

function buildIntroScene(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    // В интро классическая модель света — иначе Земля/Луна на дистанции ~125 становятся почти чёрными
    if (renderer.physicallyCorrectLights !== undefined) renderer.physicallyCorrectLights = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000004);
    scene.fog = new THREE.FogExp2(0x000004, 0.0009);

    const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.set(0, 22, 95);

    // Освещение: читаемый день, тёмная ночь, без пересвета
    scene.add(new THREE.AmbientLight(0x14141e, 0.18));
    const sunLight = new THREE.PointLight(0xfff2d8, 1.6, 0, 1);
    sunLight.position.set(0, 0, 0);
    scene.add(sunLight);
    // Дневной свет на Землю/Луну
    const sunDir = new THREE.DirectionalLight(0xffefd8, 1.35);
    sunDir.position.set(0, 5, 80);
    sunDir.target.position.set(0, 0, -125);
    scene.add(sunDir);
    scene.add(sunDir.target);
    const fill = new THREE.DirectionalLight(0x2e3a52, 0.14);
    fill.position.set(20, 15, -180);
    scene.add(fill);

    const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy?.() || 4);
    const loader = new THREE.TextureLoader();
    const loadTex = (url) => new Promise(resolve => {
        loader.load(url, tex => {
            tex.encoding = THREE.sRGBEncoding;
            tex.anisotropy = maxAniso;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            resolve(tex);
        }, undefined, () => resolve(null));
    });

    const stars = createStars();
    scene.add(stars);
    const dust = createDust();
    scene.add(dust);
    const nebula = createNebula();
    scene.add(nebula);

    // --- Солнце: шейдер плазмы/пятен (как в игре) + объёмная атмосфера ---
    const SUN_R = 8;
    const EARTH_R = 3.2;
    const sunGroup = new THREE.Group();
    // 1×1 плейсхолдер до загрузки текстуры
    const sunPlaceholder = new THREE.DataTexture(new Uint8Array([255, 220, 180, 255]), 1, 1, THREE.RGBAFormat);
    sunPlaceholder.needsUpdate = true;
    const sunMat = new THREE.ShaderMaterial({
        uniforms: {
            sunTexture: { value: sunPlaceholder },
            time: { value: 0 },
            cameraDistance: { value: 95 }
        },
        vertexShader: introSunVertexShader,
        fragmentShader: introSunFragmentShader
    });
    sunMat.toneMapped = false;
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 128, 128), sunMat);
    sunGroup.add(sunMesh);
    // Атмосфера / хромосфера Солнца
    const sunAtmo = createIntroAtmosphere(SUN_R, {
        color: '#ffb45a',
        scale: 1.2,
        intensity: 1.55,
        heightFrac: 0.3,
        isStar: true
    });
    if (sunAtmo) sunMesh.add(sunAtmo);
    scene.add(sunGroup);

    // --- Земля: Phong + specularMap + облака + атмосфера + сияние; Луна: узкий блик ---
    const EARTH_Z = -125;
    const earthGroup = new THREE.Group();
    earthGroup.position.set(0, 0, EARTH_Z);

    // Узкий блик как в игре; specularMap подключится после загрузки
    const earthMat = new THREE.MeshPhongMaterial({
        color: 0x1a3050,
        specular: new THREE.Color(0x3a3a48),
        shininess: 180,
        emissive: 0x000000
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 128, 128), earthMat);
    earthGroup.add(earth);

    let earthClouds = null;
    let earthAurora = null;

    const earthAtmo = createIntroAtmosphere(EARTH_R, {
        color: '#6BA3FF',
        scale: 1.07,
        intensity: 0.85,
        heightFrac: 0.18,
        isStar: false
    });
    if (earthAtmo) earth.add(earthAtmo);

    // Сияние сразу (без текстуры)
    earthAurora = createIntroAurora(EARTH_R, 0.4);
    if (earthAurora) earth.add(earthAurora);

    const moonPivot = new THREE.Object3D();
    earthGroup.add(moonPivot);
    // Луна: узкий блик без specularMap
    const moonMat = new THREE.MeshPhongMaterial({
        color: 0x3a3a3a,
        specular: new THREE.Color(0x141418),
        shininess: 160,
        emissive: 0x000000
    });
    const moon = new THREE.Mesh(new THREE.SphereGeometry(0.85, 64, 64), moonMat);
    moon.position.set(6.5, 0.4, 1.5);
    moonPivot.add(moon);
    scene.add(earthGroup);

    // Прямая траектория камеры (X = 0)
    const path = [
        new THREE.Vector3(0, 22, 95),
        new THREE.Vector3(0, 14, 40),
        new THREE.Vector3(0, 11.2, 12),
        new THREE.Vector3(0, 8, -30),
        new THREE.Vector3(0, 5, -90),
        new THREE.Vector3(0, 3.6, -118)
    ];
    const lookPath = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 2, 0),
        new THREE.Vector3(0, 4, -5),
        new THREE.Vector3(0, 1, -80),
        new THREE.Vector3(0, 0, EARTH_Z),
        new THREE.Vector3(0, 0, EARTH_Z)
    ];

    // Bloom с нуля — включаем только после текстур (убирает вспышку 1-й секунды)
    const composer = new THREE.EffectComposer(renderer);
    composer.setSize(window.innerWidth, window.innerHeight);
    composer.addPass(new THREE.RenderPass(scene, camera));
    const bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.0,   // strength стартует с 0
        0.55,  // radius
        0.5    // threshold
    );
    composer.addPass(bloomPass);

    const BLOOM_STRENGTH = 0.75;
    const texturesReady = Promise.all([
        loadTex(INTRO_MEDIA.sun),
        loadTex(INTRO_MEDIA.earth),
        loadTex(INTRO_MEDIA.earthSpecular),
        loadTex(INTRO_MEDIA.earthClouds),
        loadTex(INTRO_MEDIA.moon)
    ]).then(([sunT, earthT, earthSpecT, earthCloudT, moonT]) => {
        if (sunT) {
            sunT.wrapS = sunT.wrapT = THREE.RepeatWrapping;
            sunMat.uniforms.sunTexture.value = sunT;
            sunMat.needsUpdate = true;
        }
        if (earthT) {
            earthMat.map = earthT;
            earthMat.color.set(0xffffff);
            earthMat.shininess = 180;
            earthMat.specular = new THREE.Color(0x3a3a48);
            earthMat.needsUpdate = true;
        }
        if (earthSpecT) {
            earthMat.specularMap = earthSpecT;
            earthMat.shininess = 220;
            earthMat.specular = new THREE.Color(0x5a5a68);
            earthMat.needsUpdate = true;
        }
        if (earthCloudT && !earthClouds) {
            earthClouds = createIntroClouds(EARTH_R, earthCloudT, 0.65);
            if (earthClouds) earth.add(earthClouds);
        }
        if (moonT) {
            moonMat.map = moonT;
            moonMat.color.set(0xffffff);
            moonMat.shininess = 160;
            moonMat.specular = new THREE.Color(0x141418);
            moonMat.needsUpdate = true;
        }
        bloomPass.strength = BLOOM_STRENGTH;
        bloomPass.threshold = 0.5;
    });

    const tmpLook = new THREE.Vector3();
    const earthWorld = new THREE.Vector3();

    function samplePath(points, t, out) {
        const n = points.length - 1;
        const f = Math.max(0, Math.min(1, t)) * n;
        const i = Math.min(n - 1, Math.floor(f));
        const local = f - i;
        return lerpVec(points[i], points[i + 1], local, out);
    }

    let flightT = 0;
    let running = true;

    function onResize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        composer.setSize(w, h);
        bloomPass.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    function tick(dt) {
        if (!running) return;
        const t = performance.now();
        // Лёгкая пульсация (амплитуда небольшая — без заметных скачков)
        sunLight.intensity = 1.55 + Math.sin(t * 0.0016) * 0.12;
        sunDir.intensity = 1.3 + Math.sin(t * 0.0016) * 0.08;
        // Плазма/пятна: крайне медленно (игрок почти не замечает движения)
        sunMat.uniforms.time.value = t * 0.000012;
        sunMat.uniforms.cameraDistance.value = camera.position.distanceTo(sunGroup.position);
        // Центры атмосфер (день/ночь у Земли, свечение у Солнца)
        syncIntroAtmosphere(sunMesh, sunAtmo, sunGroup.position);
        earthGroup.getWorldPosition(earthWorld);
        syncIntroAtmosphere(earth, earthAtmo, sunGroup.position, earthWorld);
        // Сияние: медленная анимация (интро без timeSpeed)
        if (earthAurora?.material?.uniforms?.time) {
            earthAurora.material.uniforms.time.value += dt * 0.15;
        }
        earth.rotation.y += dt * 0.07;
        moonPivot.rotation.y += dt * 0.028;
        moon.lookAt(earthWorld);
        stars.rotation.y += dt * 0.0025;
        dust.position.z += dt * 1.5;
    }

    function setFlightProgress(t01) {
        flightT = Math.max(0, Math.min(1, t01));
        const e = easeInOutCubic(flightT);
        samplePath(path, e, camera.position);
        samplePath(lookPath, e, tmpLook);
        camera.lookAt(tmpLook);
        // Плавное ослабление bloom у Земли
        if (bloomPass.strength > 0.01) {
            bloomPass.strength = BLOOM_STRENGTH - e * 0.18;
            bloomPass.threshold = 0.5 + e * 0.08;
        }
    }

    function render() {
        composer.render();
    }

    function dispose() {
        running = false;
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(rafId);
        composer?.dispose?.();
        renderer.dispose();
        scene.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose?.());
                else obj.material.dispose?.();
            }
        });
    }

    return { camera, scene, renderer, composer, setFlightProgress, tick, render, dispose, earthGroup, texturesReady };
}

/* ---------- Подписи ---------- */
function showCaption(key) {
    const el = document.getElementById('intro-caption');
    if (!el) return;
    el.textContent = t(key);
    el.classList.add('visible');
}

function hideCaption() {
    document.getElementById('intro-caption')?.classList.remove('visible');
}

/* ---------- Основной пайплайн ---------- */
export function isIntroActive() {
    return !!introActive;
}

export async function startIntroSequence({ onComplete } = {}) {
    if (introActive) return;
    introActive = true;
    window.__introActive = true;
    introSkipRequested = false;
    onIntroComplete = onComplete || null;
    import('./epochalMusic.js').then(m => m.pauseEpochalMusic?.()).catch(() => {});

    const screen = document.getElementById('intro-screen');
    const canvas = document.getElementById('intro-canvas');
    const videoFrame = document.getElementById('intro-video-frame');
    const video = document.getElementById('intro-video');
    const fade = document.getElementById('intro-fade');
    const loading = document.getElementById('intro-loading');
    const loadFill = document.getElementById('intro-loading-fill');
    const loadPct = document.getElementById('intro-loading-pct');
    const title1 = document.getElementById('intro-title-line1');
    const title2 = document.getElementById('intro-title-line2');

    if (!screen || !canvas) {
        introActive = false;
        window.__introActive = false;
        onComplete?.();
        return;
    }

    closeSessionNameModal();
    screen.classList.add('active');
    document.body.classList.add('intro-active');

    // сброс UI
    hideCaption();
    videoFrame?.classList.remove('visible', 'fade-chrome');
    fade?.classList.remove('visible');
    loading?.classList.remove('visible');
    if (loadFill) loadFill.style.width = '0%';
    title1?.classList.remove('animate-in');
    title2?.classList.remove('animate-in');
    if (title1) title1.textContent = t('game.titleMain');
    if (title2) title2.textContent = t('game.titleSub');
    screen.classList.remove('video-focus', 'intro-skipping');
    showSkipButton(false);

    // музыка
    stopAudio(musicAudio);
    musicAudio = new Audio(INTRO_MEDIA.music);
    musicAudio.loop = false; // один раз, без повтора
    musicAudio.volume = getEffectiveVolume('music');
    tryPlay(musicAudio);

    sceneApi = buildIntroScene(canvas);
    // Чёрный кадр, пока текстуры не готовы — без вспышки solid-цветов + bloom
    canvas.style.opacity = '0';
    canvas.style.transition = 'opacity 0.7s ease';
    sceneApi.setFlightProgress(0);
    sceneApi.render();
    try {
        await sceneApi.texturesReady;
    } catch (_) {}
    // Один кадр с текстурами до fade-in
    sceneApi.setFlightProgress(0);
    sceneApi.render();
    canvas.style.opacity = '1';
    await sleep(50);

    // Кнопка пропуска — плавное появление в начале интро
    showSkipButton(true);

    showCaption('intro.caption.system');

    let last = performance.now();
    const flightStart = performance.now();
    let captionEarthShown = false;

    await new Promise(resolve => {
        const loop = (now) => {
            if (!introActive || introSkipRequested) return resolve();
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const elapsed = now - flightStart;
            const t01 = Math.min(1, elapsed / INTRO_FLIGHT_MS);
            sceneApi.setFlightProgress(t01);
            sceneApi.tick(dt);
            sceneApi.render();

            if (!captionEarthShown && t01 > 0.62) {
                captionEarthShown = true;
                showCaption('intro.caption.earth');
            }
            if (t01 >= 1) return resolve();
            rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
    });

    if (introSkipRequested || !introActive) {
        // skipIntroToLoading уже ведёт загрузку
        return;
    }

    // держим последний кадр
    const holdLoop = (now) => {
        if (!introActive || introSkipRequested || !sceneApi) return;
        const dt = 0.016;
        sceneApi.tick(dt);
        sceneApi.render();
        rafId = requestAnimationFrame(holdLoop);
    };
    rafId = requestAnimationFrame(holdLoop);

    // Видео + озвучка
    showCaption('intro.caption.chronicles');
    if (video) {
        video.src = INTRO_MEDIA.video;
        // Уже есть user gesture (кнопка «Погружение») — можно со звуком
        video.muted = false;
        video.volume = getEffectiveVolume('music');
        video.playsInline = true;
        video.loop = true;
        try {
            await video.play();
        } catch (err) {
            // Fallback: если браузер всё же блокирует — mute и play, потом unmute
            console.warn('Intro video play with sound failed, retry muted', err);
            video.muted = true;
            try {
                await video.play();
                video.muted = false;
                video.volume = getEffectiveVolume('music');
            } catch (_) {}
        }
    }
    videoFrame?.classList.add('visible');

    stopAudio(voiceAudio);
    const lang = getLang();
    const voiceSrc = lang === 'en' ? INTRO_MEDIA.voiceEn : INTRO_MEDIA.voiceRu;
    voiceAudio = new Audio(voiceSrc);
    voiceAudio.volume = getEffectiveVolume('voice');
    tryPlay(voiceAudio);

    // Плавно гасим космос, подпись позиции и рамку плеера — фокус только на видео
    // (длительность синхронизирована с CSS transition ~2.8s)
    requestAnimationFrame(() => {
        screen.classList.add('video-focus');
        canvas.style.transition = 'opacity 2.8s ease';
        canvas.style.opacity = '0';
        videoFrame?.classList.add('fade-chrome');
        const cap = document.getElementById('intro-caption');
        if (cap) {
            cap.style.transition = 'opacity 2.8s ease';
            cap.classList.remove('visible');
            cap.style.opacity = '0';
        }
    });

    const skippedDuringVideo = await sleepInterruptible(INTRO_TITLE_DELAY_MS);
    if (introSkipRequested || !introActive) return;

    // Титры
    title1?.classList.add('animate-in');
    title2?.classList.add('animate-in');
    const skippedDuringTitles = await sleepInterruptible(1400 + INTRO_TITLE_HOLD_MS);
    if (introSkipRequested || !introActive) return;

    // Затемнение + загрузка
    showSkipButton(false);
    fade?.classList.add('visible');
    await sleep(INTRO_FADE_MS);
    if (introSkipRequested || !introActive) return;
    loading?.classList.add('visible');

    // Параллельно грузим основную игру
    let progress = 0;
    const bump = (to) => {
        progress = Math.max(progress, to);
        if (loadFill) loadFill.style.width = `${Math.round(progress)}%`;
        if (loadPct) loadPct.textContent = `${Math.round(progress)}%`;
    };
    bump(5);

    // Имитация + реальная загрузка через callback
    const loadPromise = (typeof onIntroComplete === 'function')
        ? Promise.resolve().then(() => onIntroComplete({ phase: 'load', report: bump }))
        : sleep(1500);

    // плавный прогресс, пока ждём
    const progTimer = setInterval(() => {
        if (progress < 90) bump(progress + 2 + Math.random() * 4);
    }, 200);

    try {
        await loadPromise;
        bump(100);
    } catch (e) {
        console.error('Intro load error', e);
        bump(100);
    }
    clearInterval(progTimer);
    await sleep(400);

    cleanupIntro();
}

export function cleanupIntro() {
    introActive = false;
    window.__introActive = false;
    import('./epochalMusic.js').then(m => m.resumeEpochalMusic?.()).catch(() => {});
    cancelAnimationFrame(rafId);
    const canvas = document.getElementById('intro-canvas');
    if (canvas) { canvas.style.opacity = ''; canvas.style.transition = ''; }
    stopAudio(musicAudio); musicAudio = null;
    stopAudio(voiceAudio); voiceAudio = null;
    const video = document.getElementById('intro-video');
    if (video) { try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {} }
    document.getElementById('intro-video-frame')?.classList.remove('visible');
    document.getElementById('intro-fade')?.classList.remove('visible');
    document.getElementById('intro-loading')?.classList.remove('visible');
    hideCaption();
    if (sceneApi) { sceneApi.dispose(); sceneApi = null; }
    const introScreen = document.getElementById('intro-screen');
    if (introScreen) {
        introScreen.classList.remove('active', 'video-focus');
    }
    document.getElementById('intro-video-frame')?.classList.remove('fade-chrome');
    const capEl = document.getElementById('intro-caption');
    if (capEl) { capEl.style.opacity = ''; capEl.style.transition = ''; }
    showSkipButton(false);
    const introScreen2 = document.getElementById('intro-screen');
    introScreen2?.classList.remove('intro-skipping');
    introSkipRequested = false;
    document.body.classList.remove('intro-active');
}

export function initIntroUI({ startGameLoad } = {}) {
    const input = document.getElementById('session-name-input');
    const cancel = document.getElementById('session-cancel-btn');
    const immerse = document.getElementById('session-immerse-btn');

    onVolumeChange(() => applyIntroVolumes());

    const skipBtn = document.getElementById('intro-skip-btn');
    skipBtn?.addEventListener('click', () => {
        skipIntroToLoading();
    });

    input?.addEventListener('input', () => {
        updateImmerseState();
    });
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && immerse && !immerse.disabled) immerse.click();
    });
    cancel?.addEventListener('click', () => closeSessionNameModal());

    immerse?.addEventListener('click', async () => {
        if (!input || !input.value.trim()) return;
        sessionName = input.value.trim();
        window.__sessionName = sessionName;
        window.__pendingNewGame = true;
        import('./saveSystem.js').then(m => {
            if (m.setSessionNameMemory) m.setSessionNameMemory(sessionName);
        }).catch(() => {});
        closeSessionNameModal();

        // Синхронное гашение меню + соц. постера + превью + кнопки сборок
        const fadeEls = [
            document.getElementById('main-menu'),
            document.getElementById('social-panel'),
            document.getElementById('social-poster'),
            document.getElementById('vh-preview-wrap'),
            document.getElementById('vh-build-btn')
        ].filter(Boolean);

        fadeEls.forEach(el => {
            el.style.transition = 'opacity 1s ease';
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
        });
        await sleep(1000);

        const mainMenu = document.getElementById('main-menu');
        if (mainMenu) {
            mainMenu.style.display = 'none';
            mainMenu.classList.add('hidden');
            mainMenu.style.opacity = '';
            mainMenu.style.transition = '';
        }
        // сброс inline-стилей оверлеев (дальше управляет main-menu-active / intro)
        ['social-panel', 'social-poster', 'vh-preview-wrap', 'vh-build-btn'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.opacity = '';
            el.style.transition = '';
            el.style.pointerEvents = '';
        });
        document.body.classList.remove('main-menu-active');

        await startIntroSequence({
            onComplete: async (msg) => {
                if (msg?.phase === 'load') {
                    // startGameLoad должен грузить игру и вызывать report(0..100)
                    if (typeof startGameLoad === 'function') {
                        await startGameLoad(msg.report);
                    } else {
                        msg.report?.(100);
                    }
                }
            }
        });
    });

    onLanguageChange(() => {
        const t1 = document.getElementById('intro-title-line1');
        const t2 = document.getElementById('intro-title-line2');
        if (t1) t1.textContent = t('game.titleMain');
        if (t2) t2.textContent = t('game.titleSub');
        const cap = document.getElementById('intro-caption');
        if (cap?.classList.contains('visible') && cap.dataset.key) {
            cap.textContent = t(cap.dataset.key);
        }
    });
}
