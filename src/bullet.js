import * as THREE from 'three';
import { isWall } from './map.js';

export class Bullet {
  constructor(scene, x, z, dx, dz, owner = 'enemy', shooter = null) {
    const isPlayerShot = owner === 'player';
    const geo = new THREE.SphereGeometry(0.14, 10, 10);
    const mat = new THREE.MeshStandardMaterial({
      color:    isPlayerShot ? 0x66ffff : 0xffff66,
      emissive: isPlayerShot ? 0x00aaff : 0xffaa00,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(x, 0.6, z);
    scene.add(this.mesh);
    this.dx = dx; this.dz = dz;
    this.speed = 12;
    this.life  = 3;
    this.alive = true;
    this.owner = owner;
    // Damage applied to player on a 'hit' return — most bullets are 1, but
    // exposing it lets explosive rounds (rockets) report a heavier hit.
    this.damage = 1;
    // Whoever fired this bullet — excluded from collision so they can't
    // self-damage at spawn. Friendly fire is otherwise on for everyone else.
    this.shooter = shooter;
    this.scene = scene;
  }

  update(dt, map, player, enemies, game) {
    if (!this.alive) return;
    const step = this.speed * dt;
    const p = this.mesh.position;
    p.x += this.dx * step;
    p.z += this.dz * step;
    this.life -= dt;
    if (this.life <= 0) return this.destroy();
    if (isWall(map, p.x, p.z)) {
      // If the wall hit is actually a destructible obstacle, deal 1 HP.
      // Walls (grid==1) just absorb the bullet silently.
      if (game?.damageObstacleAt) game.damageObstacleAt(p.x, p.z, 1);
      return this.destroy();
    }
    // Closed doors block bullets too — they're not in the static grid so
    // the AI can pathfind through them, but for projectiles they're solid.
    if (game?.cellBlockedByDoor && game.cellBlockedByDoor(p.x, p.z)) {
      return this.destroy();
    }

    // Friendly fire is universal — any bullet that touches a body deals
    // damage, regardless of who fired it. The only exemption is the shooter
    // (so a freshly-spawned bullet doesn't immediately kill its source).
    if (player) {
      const pp = player.position;
      if (Math.hypot(p.x - pp.x, p.z - pp.z) < 0.4) {
        this.destroy();
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
          this.destroy();
          if (typeof e.onBulletNearby === 'function') e.onBulletNearby(this.dx, this.dz);
          if (typeof e.takeDamage === 'function')     e.takeDamage(1);
          else                                         e.kill();
          return 'hit-entity';
        }
        // Whoosh — bullet passing close still triggers a snap-turn reaction.
        if (d < hitR + 0.85 && !(this._notified && this._notified.has(e))) {
          if (typeof e.onBulletNearby === 'function') e.onBulletNearby(this.dx, this.dz);
          (this._notified ??= new Set()).add(e);
        }
      }
    }
  }

  destroy() {
    this.alive = false;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}
