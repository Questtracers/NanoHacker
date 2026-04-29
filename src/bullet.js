import * as THREE from 'three';
import { isWall } from './map.js';

// Player-arrow visual constants.
const ARROW_COLOR        = 0x66ffcc;
const ARROW_EMISSIVE     = 0x44ddaa;
const ARROW_LENGTH_SCALE = 3.2;
const ARROW_RADIUS       = 0.10;
const TRAIL_PARTICLES    = 24;
const TRAIL_SPAWN_DT     = 0.018;
const TRAIL_LIFETIME     = 0.42;
const EXPLOSION_PARTICLES = 28;
const EXPLOSION_LIFE_MIN = 1.40;
const EXPLOSION_LIFE_MAX = 2.40;
const EXPLOSION_FADE_TIME = 2.40;
const EXPLOSION_SPEED    = 3.2;

// Soldier-bullet visual constants.
//   tracer   = the bullet itself (thin white rectangle stretched along
//              its flight axis, additive emissive so it reads as a
//              high-speed tracer round).
//   muzzle   = brief flash mesh at the gun barrel on spawn.
//   ricochet = sparks burst on impact (stretched-billboard style:
//              small additive quads scaled along their velocity).
const TRACER_COLOR         = 0xffffff;
const TRACER_EMISSIVE      = 0xfff0c0;
const TRACER_LEN           = 0.55;       // metres along flight axis
const TRACER_WIDTH         = 0.06;       // perpendicular width
const MUZZLE_COLOR         = 0xfff2a0;
const MUZZLE_LIFE          = 0.08;       // seconds — quick pop
// Flash is now a small ellipse, elongated along the flight axis. It
// anchors AT the muzzle hotspot (not centered on it) and pokes forward
// like a flame jet, kept smaller than the original sphere version.
const MUZZLE_LENGTH        = 0.32;       // forward extent (along +Z)
const MUZZLE_WIDTH         = 0.10;       // perpendicular radius
const RICOCHET_PARTICLES   = 18;
const RICOCHET_LIFE_MIN    = 0.80;
const RICOCHET_LIFE_MAX    = 1.60;
const RICOCHET_FADE_TIME   = 1.60;
const RICOCHET_SPEED       = 6.5;
const RICOCHET_PIECE_LEN   = 0.30;
const RICOCHET_PIECE_WIDTH = 0.04;
const RICOCHET_COLOR       = 0xfff0c0;
// Floor "rigid body" parameters for the bouncing-spark physics:
//   FLOOR_Y      — collision plane (slightly above 0 so sparks hit
//                  the visible floor, not slip below the geometry).
//   RESTITUTION  — vy after bounce = -vy * this. Energy retained.
//   FRICTION     — horizontal velocity multiplier on each bounce.
//   GRAVITY      — m/s²; applied every frame.
const RICOCHET_FLOOR_Y     = 0.04;
const RICOCHET_RESTITUTION = 0.45;
const RICOCHET_FRICTION    = 0.65;
const RICOCHET_GRAVITY     = 11.0;

const HIDDEN_Y           = -1e4;

// Module-level VFX pools. main.js / debug-level calls
// updatePlayerArrowVFX(dt) once per frame to integrate all of them.
const _liveExplosions     = [];
const _liveMuzzleFlashes  = [];
const _liveRicochets      = [];

// ── Soldier muzzle flash ─────────────────────────────────────────────
// Brief expanding additive sphere at the gun's tip on each shot. Reads
// as a flame-pop of muzzle ignition. Scales out + fades over MUZZLE_LIFE.
function spawnSoldierMuzzleFlash(scene, x, y, z, dx = 0, dz = 1) {
  // Stretched sphere → ellipse: scale local +Z (forward) so the flame
  // pokes out ahead of the muzzle. Then translate by half the length
  // along the flight axis so the *back* of the ellipse sits on the
  // hotspot rather than its center (visually the flash starts at the
  // gun barrel and extends forward).
  const geo = new THREE.SphereGeometry(MUZZLE_WIDTH, 10, 8);
  const mat = new THREE.MeshBasicMaterial({
    color: MUZZLE_COLOR,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len, nz = dz / len;
  mesh.position.set(x + nx * MUZZLE_LENGTH * 0.5, y, z + nz * MUZZLE_LENGTH * 0.5);
  // Local +Z aligned with flight direction, then stretched.
  mesh.lookAt(mesh.position.x + nx, y, mesh.position.z + nz);
  mesh.scale.set(1, 1, MUZZLE_LENGTH / MUZZLE_WIDTH);
  scene.add(mesh);
  // Punchy short-range light at the muzzle so the flash actually
  // illuminates the rifle / shooter for that frame.
  const light = new THREE.PointLight(MUZZLE_COLOR, 1.6, 2.2, 2);
  light.position.set(x, y, z);
  scene.add(light);
  _liveMuzzleFlashes.push({ mesh, light, age: 0, life: MUZZLE_LIFE });
}

// ── Soldier ricochet ─────────────────────────────────────────────────
// Stretched-billboard-style sparks (elongated boxes oriented along
// their velocity vector). Spawned on every wall / body / door hit.
function spawnSoldierRicochet(scene, x, y, z) {
  const parts = [];
  for (let i = 0; i < RICOCHET_PARTICLES; i++) {
    const ang  = Math.random() * Math.PI * 2;
    const elev = -0.1 + Math.random() * 0.7;
    const sp   = RICOCHET_SPEED * (0.5 + Math.random() * 0.6);
    const vx   = Math.cos(ang) * Math.cos(elev) * sp;
    const vy   = Math.sin(elev) * sp + 1.4;
    const vz   = Math.sin(ang) * Math.cos(elev) * sp;
    const geo  = new THREE.BoxGeometry(RICOCHET_PIECE_WIDTH, RICOCHET_PIECE_WIDTH, RICOCHET_PIECE_LEN);
    const mat  = new THREE.MeshBasicMaterial({
      color: RICOCHET_COLOR,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    // Stretched along velocity: orient local +Z toward (pos + velocity).
    mesh.lookAt(x + vx, y + vy, z + vz);
    scene.add(mesh);
    parts.push({
      mesh, vx, vy, vz, age: 0,
      // Per-particle angular velocity so each spark tumbles
      // independently after a bounce — reads as proper rigid-body
      // chaos rather than choreographed sparks.
      avx: (Math.random() - 0.5) * 14,
      avy: (Math.random() - 0.5) * 14,
      avz: (Math.random() - 0.5) * 14,
      life: RICOCHET_LIFE_MIN + Math.random() * (RICOCHET_LIFE_MAX - RICOCHET_LIFE_MIN),
    });
  }
  const light = new THREE.PointLight(RICOCHET_COLOR, 1.0, 2.0, 2);
  light.position.set(x, y, z);
  scene.add(light);
  _liveRicochets.push({ parts, light, age: 0 });
}

export function updatePlayerArrowVFX(dt) {
  if (dt <= 0) return;
  for (let i = _liveExplosions.length - 1; i >= 0; i--) {
    const ex = _liveExplosions[i];
    ex.totalAge += dt;
    let alive = 0;
    const pos = ex.points.geometry.attributes.position;
    for (let j = 0; j < ex.parts.length; j++) {
      const p = ex.parts[j];
      p.age += dt;
      if (p.age >= p.life) { pos.setXYZ(j, 0, HIDDEN_Y, 0); continue; }
      alive++;
      // Air drag + gravity. Drag is gentle so embers travel further
      // before settling onto the floor.
      const drag = Math.pow(0.985, dt * 60);
      p.vx *= drag; p.vy *= drag; p.vz *= drag;
      p.vy -= 7.0 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      // Floor bounce — arrow embers behave like the soldier sparks:
      // reflect vy with restitution, damp horizontal velocity. Gives
      // the explosion an actual "shower of debris" silhouette.
      if (p.y < RICOCHET_FLOOR_Y) {
        p.y = RICOCHET_FLOOR_Y;
        if (p.vy < 0) {
          p.vy = -p.vy * RICOCHET_RESTITUTION;
          p.vx *= RICOCHET_FRICTION;
          p.vz *= RICOCHET_FRICTION;
          if (p.vy < 0.3) p.vy = 0;
        }
      }
      pos.setXYZ(j, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    ex.points.material.opacity = alive ? Math.max(0, 1 - ex.totalAge / EXPLOSION_FADE_TIME) : 0;
    if (ex.light) ex.light.intensity = Math.max(0, 1.4 * (1 - ex.totalAge / 0.4));
    if (alive === 0) {
      ex.points.parent?.remove(ex.points);
      ex.points.material.dispose();
      if (ex.light) ex.light.parent?.remove(ex.light);
      _liveExplosions.splice(i, 1);
    }
  }
  // Soldier muzzle flashes — expand outward + fade alpha + dim light.
  for (let i = _liveMuzzleFlashes.length - 1; i >= 0; i--) {
    const f = _liveMuzzleFlashes[i];
    f.age += dt;
    const t = f.age / f.life;
    if (t >= 1) {
      f.mesh.parent?.remove(f.mesh);
      f.mesh.geometry.dispose();
      f.mesh.material.dispose();
      f.light.parent?.remove(f.light);
      _liveMuzzleFlashes.splice(i, 1);
      continue;
    }
    // Bloom outward over its lifetime while preserving the original
    // ellipse aspect ratio (forward-stretched).
    const s = 1 + t * 1.4;
    const stretch = MUZZLE_LENGTH / MUZZLE_WIDTH;
    f.mesh.scale.set(s, s, s * stretch);
    f.mesh.material.opacity = 1 - t;
    f.light.intensity = 1.6 * (1 - t);
  }
  // Soldier ricochet sparks — integrate velocity + gravity + drag,
  // fade material alpha, dispose when all parts have aged out.
  for (let i = _liveRicochets.length - 1; i >= 0; i--) {
    const r = _liveRicochets[i];
    r.age += dt;
    let alive = 0;
    for (const p of r.parts) {
      if (p.age >= p.life) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.mesh.parent?.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        continue;
      }
      alive++;
      // Air drag (gentle so sparks travel further before settling).
      const drag = Math.pow(0.985, dt * 60);
      p.vx *= drag; p.vy *= drag; p.vz *= drag;
      p.vy -= RICOCHET_GRAVITY * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      // ── Floor bounce (rigid-body lite) ──────────────────────────
      // When the spark crosses the floor plane we reflect vy with
      // restitution and damp horizontal velocity by FRICTION. Once
      // the bounce energy drops below a threshold the spark "settles"
      // (vy clamped to 0) so it can roll to a stop instead of
      // jittering on the floor for the rest of its lifetime.
      if (p.mesh.position.y < RICOCHET_FLOOR_Y) {
        p.mesh.position.y = RICOCHET_FLOOR_Y;
        if (p.vy < 0) {
          p.vy = -p.vy * RICOCHET_RESTITUTION;
          p.vx *= RICOCHET_FRICTION;
          p.vz *= RICOCHET_FRICTION;
          // Tumble harder after each bounce — sells the rigid-body feel.
          p.avx *= 0.7; p.avy *= 0.7; p.avz *= 0.7;
          if (p.vy < 0.4) p.vy = 0;
        }
      }
      // Tumble — apply per-axis angular velocity to the box.
      p.mesh.rotation.x += p.avx * dt;
      p.mesh.rotation.y += p.avy * dt;
      p.mesh.rotation.z += p.avz * dt;
      // Re-orient stretched billboard to current velocity (only when
      // it's actually moving fast enough; otherwise the lookAt would
      // overwrite the tumble we just set).
      const speed = Math.hypot(p.vx, p.vy, p.vz);
      if (speed < 0.3) {
        // Settled — skip the lookAt block below.
        p.mesh.material.opacity = Math.max(0, 1 - r.age / RICOCHET_FADE_TIME);
        continue;
      }
      p.mesh.lookAt(
        p.mesh.position.x + p.vx,
        p.mesh.position.y + p.vy,
        p.mesh.position.z + p.vz,
      );
      p.mesh.material.opacity = Math.max(0, 1 - r.age / RICOCHET_FADE_TIME);
    }
    r.light.intensity = Math.max(0, 1.0 * (1 - r.age / 0.25));
    if (alive === 0) {
      r.light.parent?.remove(r.light);
      _liveRicochets.splice(i, 1);
    }
  }
}

function spawnArrowExplosion(scene, x, y, z) {
  const positions = new Float32Array(EXPLOSION_PARTICLES * 3);
  const parts = [];
  for (let i = 0; i < EXPLOSION_PARTICLES; i++) {
    positions[i * 3]     = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    // Spherical outward velocity, slight upward bias so the burst
    // doesn't flatten into the floor.
    const ang   = Math.random() * Math.PI * 2;
    const elev  = (Math.random() - 0.2) * Math.PI * 0.8;   // -π/2.5..+π/2
    const sp    = EXPLOSION_SPEED * (0.5 + Math.random() * 0.5);
    parts.push({
      x, y, z,
      vx: Math.cos(ang) * Math.cos(elev) * sp,
      vy: Math.sin(elev) * sp + 0.6,
      vz: Math.sin(ang) * Math.cos(elev) * sp,
      age: 0,
      life: EXPLOSION_LIFE_MIN + Math.random() * (EXPLOSION_LIFE_MAX - EXPLOSION_LIFE_MIN),
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: ARROW_COLOR,
    size: 0.18,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  // Brief light flash at the impact point — fades out over 0.4 s.
  const light = new THREE.PointLight(ARROW_COLOR, 1.4, 3.0, 1.5);
  light.position.set(x, y, z);
  scene.add(light);
  _liveExplosions.push({ points, parts, light, totalAge: 0 });
}

export class Bullet {
  constructor(scene, x, z, dx, dz, owner = 'enemy', shooter = null, y = 0.6) {
    const isPlayerShot = owner === 'player';
    if (isPlayerShot) {
      // Glowing cyan arrow — sphere stretched along its flight axis.
      // We rotate the mesh so its local +Z aligns with the flight
      // direction; that lets us simply scale Z to make it elliptical.
      const geo = new THREE.SphereGeometry(ARROW_RADIUS, 12, 10);
      const mat = new THREE.MeshStandardMaterial({
        color:               ARROW_COLOR,
        emissive:            ARROW_EMISSIVE,
        emissiveIntensity:   1.6,
        roughness:           0.25,
        metalness:           0.45,
      });
      this.mesh = new THREE.Mesh(geo, mat);
      this.mesh.scale.set(0.7, 0.7, ARROW_LENGTH_SCALE);
      // Honour the caller's spawn y — for the player arrow this is the
      // LeftHand bone's world height (~1.4 m) so the arrow leaves the
      // bow rather than appearing at foot level.
      this.mesh.position.set(x, y, z);
      // Point local +Z along the flight direction.
      this.mesh.lookAt(x + dx, y, z + dz);
      scene.add(this.mesh);
      // Subtle illumination — small cyan light parented to the arrow
      // so it lights walls / characters as it flies past.
      const light = new THREE.PointLight(ARROW_COLOR, 0.5, 2.0, 1.5);
      this.mesh.add(light);
      this._light = light;
      // Per-arrow particle trail. Each frame we spawn a particle at
      // the arrow's current position; existing particles fade out in
      // place. Buffer size caps simultaneous on-screen particles.
      this._initTrail(scene);
    } else {
      // Enemy bullet — white rectangular tracer, stretched along its
      // flight axis so it reads as a high-speed bullet round.
      const geo = new THREE.BoxGeometry(TRACER_WIDTH, TRACER_WIDTH, TRACER_LEN);
      const mat = new THREE.MeshStandardMaterial({
        color:               TRACER_COLOR,
        emissive:            TRACER_EMISSIVE,
        emissiveIntensity:   2.0,
        roughness:           0.4,
        metalness:           0.2,
      });
      this.mesh = new THREE.Mesh(geo, mat);
      this.mesh.position.set(x, y, z);
      // Local +Z aligned with flight direction for proper stretching.
      this.mesh.lookAt(x + dx, y, z + dz);
      scene.add(this.mesh);
      // Subtle warm light parented to the tracer.
      const light = new THREE.PointLight(TRACER_EMISSIVE, 0.4, 1.6, 1.5);
      this.mesh.add(light);
      this._light = light;
      // Muzzle flash at the spawn (gun barrel) position. The flash is
      // an ellipse stretched along the flight axis so it reads as a
      // flame jet emerging from the barrel.
      spawnSoldierMuzzleFlash(scene, x, y, z, dx, dz);
    }
    this.dx = dx; this.dz = dz;
    this.speed = 12;
    this.life  = 3;
    this.alive = true;
    this.owner = owner;
    this.damage = 1;
    this.shooter = shooter;
    this.scene = scene;
    this._isPlayerShot = isPlayerShot;
  }

  _initTrail(scene) {
    const positions = new Float32Array(TRAIL_PARTICLES * 3).fill(HIDDEN_Y);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: ARROW_COLOR,
      size: 0.14,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this._trail = new THREE.Points(geo, mat);
    scene.add(this._trail);
    this._trailParts = [];
    for (let i = 0; i < TRAIL_PARTICLES; i++) {
      this._trailParts.push({ x: 0, y: 0, z: 0, age: 1e6, life: 1 });
    }
    this._trailNextIdx = 0;
    this._trailSpawnAccum = 0;
  }

  _updateTrail(dt) {
    if (!this._trail) return;
    // Spawn new particles at fixed interval so trail density doesn't
    // change with framerate.
    this._trailSpawnAccum += dt;
    while (this._trailSpawnAccum > TRAIL_SPAWN_DT) {
      this._trailSpawnAccum -= TRAIL_SPAWN_DT;
      const i = this._trailNextIdx;
      const p = this._trailParts[i];
      // Spawn slightly BEHIND the arrow so the trail reads as
      // emitting from its tail.
      p.x = this.mesh.position.x - this.dx * 0.15;
      p.y = this.mesh.position.y;
      p.z = this.mesh.position.z - this.dz * 0.15;
      p.age = 0;
      p.life = TRAIL_LIFETIME;
      this._trailNextIdx = (this._trailNextIdx + 1) % TRAIL_PARTICLES;
    }
    // Age + park expired.
    const pos = this._trail.geometry.attributes.position;
    let alive = 0;
    for (let i = 0; i < this._trailParts.length; i++) {
      const p = this._trailParts[i];
      p.age += dt;
      if (p.age >= p.life) {
        pos.setXYZ(i, 0, HIDDEN_Y, 0);
        continue;
      }
      alive++;
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    // Fade trail material as a whole when arrow nears end-of-life.
    this._trail.material.opacity = 0.85 * Math.min(1, this.life / 1.0);
  }

  update(dt, map, player, enemies, game) {
    if (!this.alive) return;
    const step = this.speed * dt;
    const p = this.mesh.position;
    p.x += this.dx * step;
    p.z += this.dz * step;
    this.life -= dt;
    if (this._isPlayerShot) this._updateTrail(dt);
    if (this.life <= 0) return this.destroy(true);
    if (isWall(map, p.x, p.z)) {
      if (game?.damageObstacleAt) game.damageObstacleAt(p.x, p.z, 1);
      return this.destroy(true);
    }
    if (game?.cellBlockedByDoor && game.cellBlockedByDoor(p.x, p.z)) {
      return this.destroy(true);
    }

    if (player) {
      const pp = player.position;
      if (Math.hypot(p.x - pp.x, p.z - pp.z) < 0.4) {
        this.destroy(true);
        return 'hit';
      }
    }
    if (enemies) {
      for (const e of enemies) {
        if (!e.alive) continue;
        if (e === this.shooter) continue;
        const ep   = e.mesh.position;
        const d    = Math.hypot(p.x - ep.x, p.z - ep.z);
        const hitR = e.hitRadius ?? 0.45;
        if (d < hitR) {
          this.destroy(true);
          if (typeof e.onBulletNearby === 'function') e.onBulletNearby(this.dx, this.dz);
          if (typeof e.takeDamage === 'function')     e.takeDamage(1);
          else                                         e.kill();
          return 'hit-entity';
        }
        if (d < hitR + 0.85 && !(this._notified && this._notified.has(e))) {
          if (typeof e.onBulletNearby === 'function') e.onBulletNearby(this.dx, this.dz);
          (this._notified ??= new Set()).add(e);
        }
      }
    }
  }

  // `withImpact` flags whether the arrow hit something (vs. expired
  // mid-air on the lifetime timer). Player arrows spawn an explosion
  // burst on impact only.
  destroy(withImpact = false) {
    this.alive = false;
    if (this._isPlayerShot && withImpact) {
      spawnArrowExplosion(this.scene, this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
    } else if (!this._isPlayerShot && withImpact) {
      spawnSoldierRicochet(this.scene, this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
    }
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    if (this._trail) {
      this.scene.remove(this._trail);
      this._trail.geometry.dispose();
      this._trail.material.dispose();
      this._trail = null;
    }
  }
}
