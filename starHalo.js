/**
 * starHalo.js — корона-кольцо и цепочка бликов на 3ZC.
 * Гало = RingGeometry: дырка = диск звезды (+ атмосфера), свечение только снаружи.
 * Блики: цепочка от звезды к краю экрана, чем дальше — тем крупнее.
 */

import {
    starHaloVertexShader,
    starHaloFragmentShader,
    starFlareVertexShader,
    starFlareFragmentShader
} from './shaders.js';
import { state } from './state.js';

const _world = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _ghost = new THREE.Vector3();
const _lift = new THREE.Vector3();

const FLARE_SPECS = [
    { frac: 0.22, pxSize: 56, color: new THREE.Color(1.00, 0.84, 0.55), softness: 0.88, alpha: 0.30 },
    { frac: 0.55, pxSize: 120, color: new THREE.Color(1.00, 0.74, 0.42), softness: 0.86, alpha: 0.26 },
    { frac: 1.06, pxSize: 272, color: new THREE.Color(0.55, 0.92, 0.88), softness: 0.90, alpha: 0.22 }
];

const ANAM_X = 0.978;
const ANAM_Y = 0.208;

function makeFlare(spec) {
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            flareColor: { value: spec.color.clone() },
            opacity: { value: 0 },
            softness: { value: spec.softness }
        },
        vertexShader: starFlareVertexShader,
        fragmentShader: starFlareFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 92;
    mesh.visible = false;
    mesh.userData.frac = spec.frac;
    mesh.userData.pxSize = spec.pxSize;
    mesh.userData.alpha = spec.alpha;
    return mesh;
}

export function createStarHaloFx(starColor) {
    const col = starColor?.clone ? starColor.clone() : new THREE.Color(starColor || 0xffb45a);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            starColor: { value: col.clone() },
            opacity: { value: 0 },
            innerRatio: { value: 1.48 / 2.05 }
        },
        vertexShader: starHaloVertexShader,
        fragmentShader: starHaloFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const geo = new THREE.RingGeometry(1.48, 2.05, 96, 1);
    const halo = new THREE.Mesh(geo, mat);
    halo.frustumCulled = false;
    halo.renderOrder = 88;
    halo.visible = false;
    halo.name = 'starHaloRing';
    halo.userData.ringVer = 5;
    return { halo, flares: FLARE_SPECS.map(makeFlare) };
}

export function addStarHaloToScene(scene, fx) {
    if (!scene || !fx) return;
    scene.add(fx.halo);
    fx.flares.forEach(f => scene.add(f));
}

export function starHaloVisibility(camY, levelId) {
    if (state.geoSurveyBlocking) return 0;
    const y = Number(camY) || 0;
    if (levelId && levelId !== '3ZC') return 0;
    if (y < 17 || y > 400) return 0;
    let a = 1;
    if (y < 28) {
        const t = Math.max(0, Math.min(1, (y - 17) / 11));
        a *= t * t * (3 - 2 * t);
    }
    if (y > 240) {
        const t = Math.max(0, Math.min(1, (y - 240) / 160));
        a *= 1 - t * t * (3 - 2 * t);
    }
    return a;
}

function worldPerPixelAt(cam, dist) {
    const vFOV = (cam.fov * Math.PI) / 180;
    return (2 * Math.max(dist, 0.2) * Math.tan(vFOV / 2)) / Math.max(window.innerHeight, 1);
}

function visualStarRadius(entry, mesh) {
    const size = Math.max(Number(entry.data?.size) || 2, 0.4);
    const sc = mesh.scale?.x || 1;
    const atmo = Number(entry.data?.atmosphereScale);
    const atmoMul = (entry.data?.hasAtmosphere && Number.isFinite(atmo) && atmo > 1) ? atmo : 1.08;
    return size * sc * atmoMul;
}

export function updateStarHaloFx(entry, currentLevelId) {
    const fx = entry?.starHaloFx;
    const mesh = entry?.mesh;
    const cam = state.camera;
    if (!fx?.halo || !mesh || !cam) return;

    const vis = starHaloVisibility(cam.position.y, currentLevelId);
    if (vis < 0.012 || !mesh.visible) {
        fx.halo.visible = false;
        fx.flares.forEach(f => { f.visible = false; });
        return;
    }

    mesh.getWorldPosition(_world);
    const dist = Math.max(cam.position.distanceTo(_world), 0.25);
    const visualR = visualStarRadius(entry, mesh);

    cam.getWorldDirection(_lift);
    fx.halo.position.copy(_world).addScaledVector(_lift, -visualR * 0.08);
    fx.halo.quaternion.copy(cam.quaternion);
    fx.halo.scale.setScalar(Math.max(visualR, 0.01));
    if (fx.halo.userData.ringVer !== 5) {
        fx.halo.geometry?.dispose?.();
        fx.halo.geometry = new THREE.RingGeometry(1.48, 2.05, 96, 1);
        fx.halo.userData.ringVer = 5;
        if (fx.halo.material?.uniforms && !fx.halo.material.uniforms.innerRatio) {
            fx.halo.material.uniforms.innerRatio = { value: 1.48 / 2.05 };
        }
    }
    if (fx.halo.material?.uniforms?.opacity) {
        fx.halo.material.uniforms.opacity.value = vis * 0.07;
        if (fx.halo.material.uniforms.innerRatio) {
            fx.halo.material.uniforms.innerRatio.value = 1.48 / 2.05;
        }
    }
    fx.halo.visible = true;

    _ndc.copy(_world).project(cam);
    if (!Number.isFinite(_ndc.x) || !Number.isFinite(_ndc.z) || _ndc.z < -0.99 || _ndc.z > 1.0) {
        fx.flares.forEach(f => { f.visible = false; });
        return;
    }

    const starPxR = visualR / worldPerPixelAt(cam, dist);

    let closeFade = 1;
    if (starPxR > 70) closeFade = 1 - Math.max(0, Math.min(1, (starPxR - 70) / 90));
    let farFade = 1;
    if (starPxR < 6) farFade = Math.max(0, starPxR / 6);

    const fromLen = Math.hypot(_ndc.x, _ndc.y);
    let ax = ANAM_X;
    let ay = ANAM_Y;
    if (fromLen > 0.04) {
        const nx = _ndc.x / fromLen;
        const ny = _ndc.y / fromLen;
        const k = Math.max(0, Math.min(1, (fromLen - 0.04) / 0.55));
        const kk = k * k * (3 - 2 * k);
        ax = ANAM_X * (1 - kk) + nx * kk;
        ay = ANAM_Y * (1 - kk) + ny * kk;
        const al = Math.hypot(ax, ay) || 1;
        ax /= al;
        ay /= al;
    }

    const fade = vis * closeFade * farFade;
    if (fade < 0.02) {
        fx.flares.forEach(f => { f.visible = false; });
        return;
    }

    const wppStar = worldPerPixelAt(cam, dist);
    const edgeT = distToNdcEdge(_ndc.x, _ndc.y, ax, ay);

    fx.flares.forEach((f) => {
        const frac = f.userData.frac != null ? f.userData.frac : 0.5;
        const t = edgeT * frac;
        const px = f.userData.pxSize || 16;
        _ghost.set(
            _ndc.x + ax * t,
            _ndc.y + ay * t,
            _ndc.z
        );
        _ghost.unproject(cam);
        f.position.copy(_ghost);
        f.quaternion.copy(cam.quaternion);
        f.scale.setScalar(Math.max(px * wppStar, 0.001));
        if (f.material?.uniforms?.opacity) {
            f.material.uniforms.opacity.value = fade * (f.userData.alpha || 0.25);
        }
        f.visible = true;
    });
}

function distToNdcEdge(cx, cy, ax, ay) {
    let t = 1e6;
    if (ax > 1e-5) t = Math.min(t, (1.12 - cx) / ax);
    if (ax < -1e-5) t = Math.min(t, (-1.12 - cx) / ax);
    if (ay > 1e-5) t = Math.min(t, (1.12 - cy) / ay);
    if (ay < -1e-5) t = Math.min(t, (-1.12 - cy) / ay);
    if (!Number.isFinite(t) || t < 0.08) t = 1.05;
    return t;
}