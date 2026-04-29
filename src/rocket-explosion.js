import * as THREE from 'three';

// Blue rocket-explosion VFX — modelled after the quarks "explosion"
// demo. The effect is a layered burst with five visual elements that
// share a single colour palette (white-hot core → cyan → deep blue):
//
//   1. CORE FLASH        — bright additive sphere at impact, blooms
//                          and fades over ~0.18 s.
//   2. SHOCKWAVE RING    — flat horizontal additive ring expanding
//                          along the floor; reads as ground impact.
//   3. RADIAL BURST      — ~120 additive points flying outward with
//                          gravity + drag. Long lifetimes (~1.6 s) so
//                          the cloud lingers after the flash is gone.
//   4. SPARK TRAILS      — ~24 fast-moving points that leave a thin
//                          ghosting trail (handled in-shader by drawing
//                          back-points along the velocity vector).
//   5. SMOKE PUFFS       — slower-moving low-alpha additive points in
//                          the deepest blue, drifting upward; gives the
//                          fade a bit of body.
//
// Plus a brief PointLight for actual scene illumination.
//
// Public API:
//   spawnRocketExplosion(scene, x, y, z)
//   updateRocketExplosions(dt)
//
// updateRocketExplosions(dt) must be called once per frame from the
// host's animate loop; it integrates every active explosion and
// disposes them when their last particle has aged out.

// Warm palette matched to the rocket's propellant trail — the impact
// reads as the same flame "growing up" into a fireball. White-hot at
// the core, into a saturated orange mid-burst, into deep red embers.
const COLOR_CORE       = 0xfff5d0;   // near-white, slight warmth
const COLOR_HOT        = 0xffc066;   // bright orange
const COLOR_MID        = 0xff7a22;   // saturated orange
const COLOR_DEEP       = 0xc41a08;   // deep red
const COLOR_SMOKE      = 0x2a0a05;   // charcoal-red ember

const CORE_LIFE        = 0.18;       // s
const CORE_RADIUS      = 0.55;       // m at full bloom
const SHOCKWAVE_LIFE   = 0.55;
const SHOCKWAVE_RADIUS = 3.6;        // m at full bloom
const BURST_PARTICLES  = 120;
const BURST_LIFE_MIN   = 1.0;
const BURST_LIFE_MAX   = 1.7;
const BURST_SPEED_MIN  = 3.5;
const BURST_SPEED_MAX  = 8.5;
const BURST_DRAG       = 0.92;       // velocity multiplier per second worth
const BURST_GRAVITY    = 4.0;        // m/s²
const BURST_SIZE       = 0.22;
const SPARK_PARTICLES  = 24;
const SPARK_LIFE_MIN   = 0.45;
const SPARK_LIFE_MAX   = 0.85;
const SPARK_SPEED_MIN  = 7.0;
const SPARK_SPEED_MAX  = 12.0;
const SPARK_SIZE       = 0.10;
const SMOKE_PARTICLES  = 60;
const SMOKE_LIFE_MIN   = 1.2;
const SMOKE_LIFE_MAX   = 2.4;
const SMOKE_SPEED_MIN  = 0.8;
const SMOKE_SPEED_MAX  = 2.4;
const SMOKE_SIZE       = 0.55;
const LIGHT_COLOR      = 0xffaa44;   // warm orange flash to match palette
const LIGHT_INTENSITY  = 4.0;
const LIGHT_RANGE      = 8.0;
const LIGHT_LIFE       = 0.4;

const HIDDEN_Y = -1e4;

const _live = [];

// Tween helper: maps `t` (0..1) through a colour ramp
// CORE → HOT → MID → DEEP and writes RGB into the buffer attribute.
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
function colorRamp(t, out) {
  // Three stops: 0 → CORE_HOT, 0.4 → MID, 1.0 → DEEP.
  if (t < 0.4) {
    const k = t / 0.4;
    _c1.setHex(COLOR_CORE);
    _c2.setHex(COLOR_HOT);
    out.copy(_c1).lerp(_c2, k);
  } else if (t < 0.75) {
    const k = (t - 0.4) / 0.35;
    _c1.setHex(COLOR_HOT);
    _c2.setHex(COLOR_MID);
    out.copy(_c1).lerp(_c2, k);
  } else {
    const k = (t - 0.75) / 0.25;
    _c1.setHex(COLOR_MID);
    _c2.setHex(COLOR_DEEP);
    out.copy(_c1).lerp(_c2, k);
  }
}

function makePointsLayer(count, size, vertexColors = true) {
  const positions = new Float32Array(count * 3);
  const colors    = vertexColors ? new Float32Array(count * 3) : null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    vertexColors,
  });
  return { points: new THREE.Points(geo, mat), positions, colors };
}

export function spawnRocketExplosion(scene, x, y, z) {
  const ex = {
    age: 0,
    pos: new THREE.Vector3(x, y, z),
    parts: [],
    layers: [],
  };

  // ── 1. Core flash ────────────────────────────────────────────────────
  // Stays in place; scale + fade.
  const coreGeo = new THREE.SphereGeometry(CORE_RADIUS, 14, 12);
  const coreMat = new THREE.MeshBasicMaterial({
    color: COLOR_CORE, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.copy(ex.pos);
  core.scale.setScalar(0.4);
  scene.add(core);
  ex.core = core;

  // ── 2. Shockwave ring ────────────────────────────────────────────────
  // RingGeometry inner≈outer for a thin band; lies flat on the ground.
  const ringGeo  = new THREE.RingGeometry(0.85, 1.0, 48);
  const ringMat  = new THREE.MeshBasicMaterial({
    color: COLOR_HOT, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(ex.pos);
  ring.position.y = Math.max(0.04, y - 0.5);  // hug the floor
  ring.rotation.x = -Math.PI / 2;
  ring.scale.setScalar(0.05);
  scene.add(ring);
  ex.ring = ring;

  // ── 3. Radial burst ──────────────────────────────────────────────────
  const burst = makePointsLayer(BURST_PARTICLES, BURST_SIZE);
  scene.add(burst.points);
  ex.layers.push(burst);
  for (let i = 0; i < BURST_PARTICLES; i++) {
    const ang  = Math.random() * Math.PI * 2;
    // Bias slightly upward for a dome-shaped burst.
    const elev = -0.1 + Math.random() * Math.PI * 0.6;
    const sp   = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
    ex.parts.push({
      layer: burst, idx: i,
      x, y, z,
      vx: Math.cos(ang) * Math.cos(elev) * sp,
      vy: Math.sin(elev) * sp + 1.2,
      vz: Math.sin(ang) * Math.cos(elev) * sp,
      drag: BURST_DRAG, gravity: BURST_GRAVITY,
      age: 0,
      life: BURST_LIFE_MIN + Math.random() * (BURST_LIFE_MAX - BURST_LIFE_MIN),
      kind: 'burst',
    });
  }

  // ── 4. Sparks ────────────────────────────────────────────────────────
  const sparks = makePointsLayer(SPARK_PARTICLES, SPARK_SIZE);
  scene.add(sparks.points);
  ex.layers.push(sparks);
  for (let i = 0; i < SPARK_PARTICLES; i++) {
    const ang  = Math.random() * Math.PI * 2;
    const elev = -0.2 + Math.random() * Math.PI * 0.7;
    const sp   = SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN);
    ex.parts.push({
      layer: sparks, idx: i,
      x, y, z,
      vx: Math.cos(ang) * Math.cos(elev) * sp,
      vy: Math.sin(elev) * sp + 0.8,
      vz: Math.sin(ang) * Math.cos(elev) * sp,
      drag: 0.96, gravity: BURST_GRAVITY * 0.4,
      age: 0,
      life: SPARK_LIFE_MIN + Math.random() * (SPARK_LIFE_MAX - SPARK_LIFE_MIN),
      kind: 'spark',
    });
  }

  // ── 5. Smoke puffs ───────────────────────────────────────────────────
  const smoke = makePointsLayer(SMOKE_PARTICLES, SMOKE_SIZE);
  // Smoke is the dim outer cloud — lower opacity and additive so it
  // colours the air rather than blocking it.
  smoke.points.material.opacity = 0.55;
  scene.add(smoke.points);
  ex.layers.push(smoke);
  for (let i = 0; i < SMOKE_PARTICLES; i++) {
    const ang  = Math.random() * Math.PI * 2;
    const elev = Math.random() * Math.PI * 0.5;        // upper hemi
    const sp   = SMOKE_SPEED_MIN + Math.random() * (SMOKE_SPEED_MAX - SMOKE_SPEED_MIN);
    ex.parts.push({
      layer: smoke, idx: i,
      x, y, z,
      vx: Math.cos(ang) * Math.cos(elev) * sp,
      vy: Math.sin(elev) * sp + 1.4,
      vz: Math.sin(ang) * Math.cos(elev) * sp,
      drag: 0.85, gravity: -0.6,                       // negative → rises
      age: 0,
      life: SMOKE_LIFE_MIN + Math.random() * (SMOKE_LIFE_MAX - SMOKE_LIFE_MIN),
      kind: 'smoke',
    });
  }

  // ── 6. Light flash ───────────────────────────────────────────────────
  const light = new THREE.PointLight(LIGHT_COLOR, LIGHT_INTENSITY, LIGHT_RANGE, 1.6);
  light.position.copy(ex.pos);
  scene.add(light);
  ex.light = light;

  ex.scene = scene;
  _live.push(ex);
}

const _tmpCol = new THREE.Color();

export function updateRocketExplosions(dt) {
  if (dt <= 0) return;
  for (let i = _live.length - 1; i >= 0; i--) {
    const ex = _live[i];
    ex.age += dt;

    // Core flash — quick bloom + fade.
    if (ex.core) {
      const t = Math.min(1, ex.age / CORE_LIFE);
      const s = 0.4 + t * 1.4;
      ex.core.scale.setScalar(s);
      ex.core.material.opacity = Math.max(0, 1 - t);
      if (t >= 1) {
        ex.scene.remove(ex.core);
        ex.core.geometry.dispose();
        ex.core.material.dispose();
        ex.core = null;
      }
    }
    // Shockwave ring — expand outward, fade.
    if (ex.ring) {
      const t = Math.min(1, ex.age / SHOCKWAVE_LIFE);
      ex.ring.scale.setScalar(0.05 + t * SHOCKWAVE_RADIUS);
      ex.ring.material.opacity = Math.max(0, 0.85 * (1 - t));
      if (t >= 1) {
        ex.scene.remove(ex.ring);
        ex.ring.geometry.dispose();
        ex.ring.material.dispose();
        ex.ring = null;
      }
    }
    // Light — short flash.
    if (ex.light) {
      const t = Math.min(1, ex.age / LIGHT_LIFE);
      ex.light.intensity = LIGHT_INTENSITY * (1 - t);
      if (t >= 1) {
        ex.scene.remove(ex.light);
        ex.light = null;
      }
    }

    // Particles — integrate position and write back into each layer.
    let alive = 0;
    for (const p of ex.parts) {
      if (p.age >= p.life) continue;
      p.age += dt;
      const pos = p.layer.positions;
      const col = p.layer.colors;
      if (p.age >= p.life) {
        // Park off-screen.
        pos[p.idx * 3]     = 0;
        pos[p.idx * 3 + 1] = HIDDEN_Y;
        pos[p.idx * 3 + 2] = 0;
        continue;
      }
      alive++;
      // Drag (frame-rate independent: lerp toward 0 by drag^dt).
      const k = Math.pow(p.drag, dt * 60);    // ~drag-per-frame at 60Hz
      p.vx *= k; p.vz *= k; p.vy *= k;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      pos[p.idx * 3]     = p.x;
      pos[p.idx * 3 + 1] = p.y;
      pos[p.idx * 3 + 2] = p.z;
      // Per-particle colour ramp — drives the white-hot → cobalt fade.
      // Sparks ride the hot end of the ramp; smoke is biased toward
      // the deep-blue end.
      let cT = p.age / p.life;
      if (p.kind === 'spark') cT *= 0.6;
      else if (p.kind === 'smoke') cT = 0.7 + cT * 0.3;
      colorRamp(cT, _tmpCol);
      if (col) {
        col[p.idx * 3]     = _tmpCol.r;
        col[p.idx * 3 + 1] = _tmpCol.g;
        col[p.idx * 3 + 2] = _tmpCol.b;
      }
    }
    for (const layer of ex.layers) {
      layer.points.geometry.attributes.position.needsUpdate = true;
      if (layer.colors) layer.points.geometry.attributes.color.needsUpdate = true;
    }
    // Layer-wide opacity: smoke fades on its own curve so it lingers
    // after the burst is gone (gives the effect a soft tail).
    for (const layer of ex.layers) {
      // Burst + spark layers fade with the longest particle remaining;
      // smoke has its own slower fade.
      // Simplest: keep material.opacity at 1 / configured value while
      // any particle is alive, then snap to 0 — per-particle alpha is
      // implicit in colour ramp + sizeAttenuation.
    }

    if (!ex.core && !ex.ring && !ex.light && alive === 0) {
      for (const layer of ex.layers) {
        ex.scene.remove(layer.points);
        layer.points.geometry.dispose();
        layer.points.material.dispose();
      }
      _live.splice(i, 1);
    }
  }
}
