import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { isWall } from './map.js';
import { spawnRocketExplosion } from './rocket-explosion.js';

// Rocket projectile mesh — loaded once from the shared GLB and reused
// (geometry+material are baked into world coords so each new Rocket
// gets a Mesh with the authored origin at its centre).
const ROCKET_MODEL_FILE = 'Assets/Weapons/rocket.glb';
let _rocketModel = null;          // { geometry, material }
let _rocketModelPromise = null;
function loadRocketModel() {
  if (_rocketModel) return Promise.resolve(_rocketModel);
  if (_rocketModelPromise) return _rocketModelPromise;
  _rocketModelPromise = new GLTFLoader().loadAsync(ROCKET_MODEL_FILE).then((gltf) => {
    let mesh = null;
    gltf.scene.traverse((c) => { if (c.isMesh && !mesh) mesh = c; });
    if (!mesh) throw new Error('rocket.glb: no mesh found');
    mesh.updateMatrixWorld(true);
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    // Centre the geometry on its own origin so position transforms
    // are predictable regardless of the GLB's authored pivot.
    geometry.center();
    const material = mesh.material.clone();
    _rocketModel = { geometry, material };
    return _rocketModel;
  }).catch((err) => {
    console.error('Rocket: failed to load model', err);
    return null;
  });
  return _rocketModelPromise;
}
// Kick the load early so the first rocket fired in-game already has
// the asset cached.
loadRocketModel();

// Visual scale of the rocket model — tuned so the projectile reads
// well against the level scale without being distractingly big.
const ROCKET_MODEL_SCALE = 0.70;

// Spark-trail tunables — additive points trailing the warhead so it
// reads as a propellant flame from the rocket's nozzle.
const TRAIL_PARTICLES   = 80;
const TRAIL_SPAWN_DT    = 0.012;        // seconds between emissions
const TRAIL_LIFETIME    = 0.45;
const TRAIL_SIZE        = 0.20;
const TRAIL_OFFSET      = 0.32;         // how far behind the warhead they spawn
const TRAIL_JITTER      = 0.08;         // perpendicular spread radius
const TRAIL_BACK_DRIFT  = 1.4;          // m/s drift backward (relative to flight)
const TRAIL_COLOR_HOT   = 0xfff2c0;     // near-white at spawn
const TRAIL_COLOR_MID   = 0xffaa44;     // hot orange mid-life
const TRAIL_COLOR_COOL  = 0xff4422;     // deep red end-of-life

const _trailHotCol  = new THREE.Color(TRAIL_COLOR_HOT);
const _trailMidCol  = new THREE.Color(TRAIL_COLOR_MID);
const _trailCoolCol = new THREE.Color(TRAIL_COLOR_COOL);
const _trailTmpCol  = new THREE.Color();
function trailColor(t, out) {
  if (t < 0.5) out.copy(_trailHotCol).lerp(_trailMidCol, t / 0.5);
  else         out.copy(_trailMidCol).lerp(_trailCoolCol, (t - 0.5) / 0.5);
}

// Mecha-only rocket round. Travels in a straight line like a bullet but
// detonates on first contact (wall, door, entity, obstacle) into a circular
// AOE that damages everything inside. The shooter is exempt from the AOE so
// the mecha can't blow itself up at point-blank.
const ROCKET_RADIUS     = 0.32;
const ROCKET_SPEED      = 9;
const ROCKET_LIFE       = 4;     // s — self-detonates if it just keeps going
export const EXPLOSION_RADIUS = 2.5; // = HACK_RANGE / 2 (5.0 / 2)
const EXPLOSION_DAMAGE  = 10;
const EXPLOSION_VISUAL  = 0.45;  // s of bloom animation after detonation

export class Rocket {
  constructor(scene, x, z, dx, dz, owner = 'player', shooter = null, y = 0.7) {
    // Warhead — actual rocket model from GLB. While the asset streams
    // we fall back to a placeholder sphere so gameplay doesn't stall;
    // _swapInRocketModel() replaces it with the real mesh once ready.
    if (_rocketModel) {
      this.mesh = new THREE.Mesh(_rocketModel.geometry, _rocketModel.material);
    } else {
      const geo = new THREE.SphereGeometry(ROCKET_RADIUS, 10, 10);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xff7733, emissive: 0xff5511,
      });
      this.mesh = new THREE.Mesh(geo, mat);
      this.mesh.userData._isRocketPlaceholder = true;
      // Re-attempt the swap once the GLB resolves.
      loadRocketModel().then(() => this._swapInRocketModel());
    }
    this.mesh.castShadow = true;
    this.mesh.scale.setScalar(ROCKET_MODEL_SCALE);
    this.mesh.position.set(x, y, z);
    // Orient the model so its local +Z aligns with the flight direction.
    this.mesh.lookAt(x + dx, y, z + dz);
    scene.add(this.mesh);

    // ── Spark-trail propellant flame ─────────────────────────────────
    // Continuous additive points emitted from a hotspot behind the
    // warhead. Each particle drifts backward (relative to flight) and
    // ages from white-hot through orange to deep red.
    {
      const positions = new Float32Array(TRAIL_PARTICLES * 3);
      const colors    = new Float32Array(TRAIL_PARTICLES * 3);
      // Park all particles off-screen until first spawn.
      for (let i = 0; i < TRAIL_PARTICLES; i++) positions[i * 3 + 1] = -1e4;
      const tgeo = new THREE.BufferGeometry();
      tgeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      tgeo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
      const tmat = new THREE.PointsMaterial({
        size: TRAIL_SIZE, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
        sizeAttenuation: true, vertexColors: true,
      });
      this._trail = new THREE.Points(tgeo, tmat);
      scene.add(this._trail);
      this._trailParts = [];
      for (let i = 0; i < TRAIL_PARTICLES; i++) {
        this._trailParts.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 1e6, life: 1 });
      }
      this._trailNextIdx   = 0;
      this._trailSpawnAcc  = 0;
    }

    this.dx = dx;
    this.dz = dz;
    this.owner   = owner;
    this.shooter = shooter;
    this.damage  = EXPLOSION_DAMAGE;
    this.life    = ROCKET_LIFE;
    this.alive   = true;
    this.scene   = scene;

    // Detonation phase — once true the rocket has hit something; it lingers
    // on screen for one EXPLOSION_VISUAL window playing the bloom animation
    // before being spliced out of the bullets array. Damage application is
    // spread across the bloom: the AOE grows with the visual sphere, and each
    // target gets damaged at MOST once when the wavefront first sweeps past.
    this._exploding      = false;
    this._explodeTime    = 0;
    this._explosion      = null;
    this._impactX        = 0;
    this._impactZ        = 0;
    this._hitEntities    = new Set();   // entities already damaged
    this._hitObstacles   = new Set();   // 'row,col' keys already damaged
    this._playerHit      = false;       // player already damaged (once)
  }

  update(dt, map, player, entities, game) {
    if (!this.alive) return;

    if (this._exploding) {
      this._explodeTime -= dt;
      // t: 0 at impact → 1 when bloom fully expanded.
      // Damage radius and visual scale share the same `t`, so the orange
      // sphere on screen IS the danger zone. Slow-mo automatically slows
      // the growth (dt is worldDt during the explosion).
      const t = 1 - this._explodeTime / EXPLOSION_VISUAL;
      const scale     = Math.max(0.05, Math.min(1, t));
      const dmgRadius = scale * EXPLOSION_RADIUS;
      this._explosion.scale.setScalar(scale);
      this._explosion.material.opacity = Math.max(0, 0.7 * (1 - t * 0.5));

      // Sweep entity damage — each entity inside the wavefront takes ONE hit
      // the first frame the radius engulfs them, then is added to a hit-set
      // so multiple-frame overlap (slow-mo, growing radius) doesn't stack.
      if (entities) {
        for (const e of entities) {
          if (!e.alive) continue;
          if (e === this.shooter) continue;
          if (this._hitEntities.has(e)) continue;
          const ep = e.mesh.position;
          const d  = Math.hypot(this._impactX - ep.x, this._impactZ - ep.z);
          const r  = dmgRadius + (e.hitRadius ?? 0.45);
          if (d <= r) {
            this._hitEntities.add(e);
            if (typeof e.takeDamage === 'function') e.takeDamage(EXPLOSION_DAMAGE);
            else                                    e.kill();
          }
        }
      }

      // Obstacle cells damaged once each, when the wavefront first reaches
      // them. Iterates a bounding box around the impact and dedupes via key.
      if (game?.damageObstacleAt) {
        const r  = Math.ceil(EXPLOSION_RADIUS);
        const cx = Math.round(this._impactX);
        const cz = Math.round(this._impactZ);
        for (let oz = -r; oz <= r; oz++) {
          for (let ox = -r; ox <= r; ox++) {
            const tx = cx + ox, tz = cz + oz;
            const d  = Math.hypot(tx - this._impactX, tz - this._impactZ);
            if (d > dmgRadius) continue;
            const key = `${tz},${tx}`;
            if (this._hitObstacles.has(key)) continue;
            this._hitObstacles.add(key);
            game.damageObstacleAt(tx, tz, EXPLOSION_DAMAGE);
          }
        }
      }

      // Player damage — at most once. Returned to the host on the frame the
      // wavefront first reaches them, so playerTakeDamage(this.damage) fires.
      let ret = null;
      if (player && !this._playerHit) {
        const pp = player.position;
        const d  = Math.hypot(this._impactX - pp.x, this._impactZ - pp.z);
        if (d <= dmgRadius + 0.4) {
          this._playerHit = true;
          ret = 'hit';
        }
      }

      if (this._explodeTime <= 0) this._cleanup();
      return ret;
    }

    const step = ROCKET_SPEED * dt;
    const p = this.mesh.position;
    p.x += this.dx * step;
    p.z += this.dz * step;
    this._updateTrail(dt);
    this.life -= dt;

    let hit = false;
    if (this.life <= 0)                 hit = true;
    if (!hit && isWall(map, p.x, p.z))  hit = true;
    if (!hit && game?.cellBlockedByDoor && game.cellBlockedByDoor(p.x, p.z)) hit = true;

    // Entity contact (skip the shooter so a fresh rocket doesn't self-trigger).
    if (!hit && entities) {
      for (const e of entities) {
        if (!e.alive) continue;
        if (e === this.shooter) continue;
        const ep = e.mesh.position;
        const d = Math.hypot(p.x - ep.x, p.z - ep.z);
        const hitR = (e.hitRadius ?? 0.45) + ROCKET_RADIUS;
        if (d < hitR) { hit = true; break; }
      }
    }

    // Player contact (only when caller passed them — host suppresses this
    // while the human is possessing the firing mecha).
    if (!hit && player) {
      const pp = player.position;
      if (Math.hypot(p.x - pp.x, p.z - pp.z) < 0.4 + ROCKET_RADIUS) hit = true;
    }

    if (hit) return this._detonate(map, player, entities, game);
    return null;
  }

  _detonate(map, player, entities, game) {
    const ep = this.mesh.position;
    this._impactX = ep.x;
    this._impactZ = ep.z;

    // Bloom — translucent orange sphere whose scale (0..1) maps directly
    // onto the damage radius. We start at 5 % so it's visible at impact, the
    // wavefront grows over EXPLOSION_VISUAL seconds (worldDt-paced — slow-mo
    // stretches it like everything else), and the next frames sweep damage
    // outward to anyone newly inside.
    // The damage-radius sphere itself is invisible — it exists only to
    // drive the wavefront-sweep math below. The visible effect is the
    // layered blue explosion VFX spawned right after, which decouples
    // visual styling from gameplay damage scheduling.
    const visGeo = new THREE.SphereGeometry(EXPLOSION_RADIUS, 6, 6);
    const visMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthWrite: false,
      visible: false,
    });
    this._explosion = new THREE.Mesh(visGeo, visMat);
    this._explosion.position.copy(ep);
    this._explosion.scale.setScalar(0.05);
    this.scene.add(this._explosion);
    // Layered blue VFX (core flash + shockwave + radial burst + sparks
    // + smoke + light flash). Lives in its own pool, ticked from main.
    spawnRocketExplosion(this.scene, ep.x, ep.y, ep.z);

    // Hide warhead + trail, keep the bullets slot until the bloom finishes
    // (the bloom phase below applies damage frame-by-frame). The shared
    // GLB geometry/material are NOT disposed here — they're reused by
    // every Rocket instance.
    this.scene.remove(this.mesh);
    if (this.mesh.userData?._isRocketPlaceholder) {
      // Placeholder sphere is per-instance, safe to dispose.
      if (this.mesh.geometry?.dispose) this.mesh.geometry.dispose();
      if (this.mesh.material?.dispose) this.mesh.material.dispose();
    }
    this.mesh = null;
    this._disposeTrail();

    this._exploding   = true;
    this._explodeTime = EXPLOSION_VISUAL;
    // No instant damage — the bloom phase in update() does it as it grows.
    return null;
  }

  _cleanup() {
    this.alive = false;
    if (this._explosion) {
      this.scene.remove(this._explosion);
      this._explosion.geometry.dispose();
      this._explosion.material.dispose();
      this._explosion = null;
    }
  }

  destroy() {
    this._cleanup();
    if (this.mesh) {
      this.scene.remove(this.mesh);
      if (this.mesh.userData?._isRocketPlaceholder) {
        if (this.mesh.geometry?.dispose) this.mesh.geometry.dispose();
        if (this.mesh.material?.dispose) this.mesh.material.dispose();
      }
      this.mesh = null;
    }
    this._disposeTrail();
  }

  // Replace the placeholder sphere with the actual GLB rocket once
  // the asset finishes streaming. Preserves position/orientation so the
  // mid-flight swap is invisible.
  _swapInRocketModel() {
    if (!_rocketModel || !this.mesh || !this.alive || this._exploding) return;
    if (!this.mesh.userData._isRocketPlaceholder) return;
    const old = this.mesh;
    const fresh = new THREE.Mesh(_rocketModel.geometry, _rocketModel.material);
    fresh.castShadow = true;
    fresh.scale.setScalar(ROCKET_MODEL_SCALE);
    fresh.position.copy(old.position);
    fresh.lookAt(old.position.x + this.dx, old.position.y, old.position.z + this.dz);
    this.scene.add(fresh);
    this.scene.remove(old);
    if (old.geometry?.dispose) old.geometry.dispose();
    if (old.material?.dispose) old.material.dispose();
    this.mesh = fresh;
  }

  // Spawn + integrate the propellant spark trail. Runs at fixed
  // emission interval so density doesn't depend on framerate.
  _updateTrail(dt) {
    if (!this._trail) return;
    this._trailSpawnAcc += dt;
    while (this._trailSpawnAcc > TRAIL_SPAWN_DT) {
      this._trailSpawnAcc -= TRAIL_SPAWN_DT;
      const i = this._trailNextIdx;
      const p = this._trailParts[i];
      // Spawn at a hotspot offset behind the warhead along the
      // negative flight axis, with a small perpendicular jitter.
      const jx = (Math.random() - 0.5) * 2 * TRAIL_JITTER;
      const jy = (Math.random() - 0.5) * 2 * TRAIL_JITTER;
      const jz = (Math.random() - 0.5) * 2 * TRAIL_JITTER;
      p.x = this.mesh.position.x - this.dx * TRAIL_OFFSET + jx;
      p.y = this.mesh.position.y                          + jy;
      p.z = this.mesh.position.z - this.dz * TRAIL_OFFSET + jz;
      // Each particle drifts further behind the rocket so the plume
      // reads as continuous exhaust rather than a frozen cloud.
      p.vx = -this.dx * TRAIL_BACK_DRIFT;
      p.vy = 0.4;                                  // gentle rise
      p.vz = -this.dz * TRAIL_BACK_DRIFT;
      p.age = 0;
      p.life = TRAIL_LIFETIME;
      this._trailNextIdx = (this._trailNextIdx + 1) % TRAIL_PARTICLES;
    }
    const pos = this._trail.geometry.attributes.position;
    const col = this._trail.geometry.attributes.color;
    for (let i = 0; i < this._trailParts.length; i++) {
      const p = this._trailParts[i];
      if (p.age >= p.life) {
        pos.setXYZ(i, 0, -1e4, 0);
        continue;
      }
      p.age += dt;
      if (p.age >= p.life) {
        pos.setXYZ(i, 0, -1e4, 0);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      pos.setXYZ(i, p.x, p.y, p.z);
      trailColor(p.age / p.life, _trailTmpCol);
      col.setXYZ(i, _trailTmpCol.r, _trailTmpCol.g, _trailTmpCol.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  _disposeTrail() {
    if (!this._trail) return;
    this.scene.remove(this._trail);
    this._trail.geometry.dispose();
    this._trail.material.dispose();
    this._trail = null;
  }
}
