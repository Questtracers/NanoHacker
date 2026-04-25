import * as THREE from 'three';
import { isWall } from './map.js';

// Mecha-only rocket round. Travels in a straight line like a bullet but
// detonates on first contact (wall, door, entity, obstacle) into a circular
// AOE that damages everything inside. The shooter is exempt from the AOE so
// the mecha can't blow itself up at point-blank.
const ROCKET_RADIUS     = 0.32;
const ROCKET_SPEED      = 9;
const ROCKET_LIFE       = 4;     // s — self-detonates if it just keeps going
export const EXPLOSION_RADIUS = 2.5; // = HACK_RANGE / 2 (5.0 / 2)
const EXPLOSION_DAMAGE  = 3;
const EXPLOSION_VISUAL  = 0.45;  // s of bloom animation after detonation

export class Rocket {
  constructor(scene, x, z, dx, dz, owner = 'player', shooter = null) {
    const geo = new THREE.SphereGeometry(ROCKET_RADIUS, 14, 14);
    const mat = new THREE.MeshStandardMaterial({
      color:    0xff7733,
      emissive: 0xff5511,
      roughness: 0.35,
      metalness: 0.4,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(x, 0.7, z);
    scene.add(this.mesh);

    // Glowing trail tail behind the warhead so it reads as a rocket, not a
    // big bullet. Stretched along the travel axis.
    const tailGeo = new THREE.SphereGeometry(ROCKET_RADIUS * 0.7, 10, 10);
    const tailMat = new THREE.MeshBasicMaterial({
      color: 0xffcc66, transparent: true, opacity: 0.6,
    });
    this.tail = new THREE.Mesh(tailGeo, tailMat);
    this.tail.scale.set(2.4, 1, 1);
    // Align the stretched tail with the travel direction.
    this.tail.rotation.y = Math.atan2(dx, dz);
    this.tail.position.copy(this.mesh.position);
    scene.add(this.tail);

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
    if (this.tail) this.tail.position.copy(p);
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
    const visGeo = new THREE.SphereGeometry(EXPLOSION_RADIUS, 18, 18);
    const visMat = new THREE.MeshBasicMaterial({
      color: 0xff7722, transparent: true, opacity: 0.7, depthWrite: false,
    });
    this._explosion = new THREE.Mesh(visGeo, visMat);
    this._explosion.position.copy(ep);
    this._explosion.scale.setScalar(0.05);
    this.scene.add(this._explosion);

    // Hide warhead + tail, keep the bullets slot until the bloom finishes
    // (the bloom phase below applies damage frame-by-frame).
    this.scene.remove(this.mesh);
    if (this.mesh.geometry?.dispose) this.mesh.geometry.dispose();
    if (this.mesh.material?.dispose) this.mesh.material.dispose();
    this.mesh = null;
    if (this.tail) {
      this.scene.remove(this.tail);
      this.tail.geometry?.dispose();
      this.tail.material?.dispose();
      this.tail = null;
    }

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
      if (this.mesh.geometry?.dispose) this.mesh.geometry.dispose();
      if (this.mesh.material?.dispose) this.mesh.material.dispose();
      this.mesh = null;
    }
    if (this.tail) {
      this.scene.remove(this.tail);
      this.tail.geometry?.dispose();
      this.tail.material?.dispose();
      this.tail = null;
    }
  }
}
