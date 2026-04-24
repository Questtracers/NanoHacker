import * as THREE from 'three';
import { isWall } from './map.js';

export class Bullet {
  constructor(scene, x, z, dx, dz, owner = 'enemy') {
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
    this.scene = scene;
  }

  update(dt, map, player, enemies) {
    if (!this.alive) return;
    const step = this.speed * dt;
    const p = this.mesh.position;
    p.x += this.dx * step;
    p.z += this.dz * step;
    this.life -= dt;
    if (this.life <= 0 || isWall(map, p.x, p.z)) return this.destroy();

    if (this.owner === 'enemy') {
      // Hostile bullet: damages the player AND any hack-linked (friendly) enemy.
      const pp = player.position;
      if (Math.hypot(p.x - pp.x, p.z - pp.z) < 0.4) {
        this.destroy();
        return 'hit';
      }
      if (enemies) {
        for (const e of enemies) {
          if (!e.alive) continue;
          if (e.faction !== 'friendly') continue;
          const ep = e.mesh.position;
          const d  = Math.hypot(p.x - ep.x, p.z - ep.z);
          if (d < 0.45) {
            this.destroy();
            if (typeof e.onBulletNearby === 'function') e.onBulletNearby(this.dx, this.dz);
            if (typeof e.takeDamage === 'function')     e.takeDamage(1);
            else                                         e.kill();
            return 'hit-friendly';
          }
        }
      }
    } else if (this.owner === 'player' && enemies) {
      // Player / friendly bullet: only damages hostile entities.
      for (const e of enemies) {
        if (!e.alive) continue;
        if (e.faction === 'friendly') continue;
        const ep = e.mesh.position;
        const d  = Math.hypot(p.x - ep.x, p.z - ep.z);
        if (d < 0.45) {
          this.destroy();
          if (typeof e.onBulletNearby === 'function') e.onBulletNearby(this.dx, this.dz);
          if (typeof e.takeDamage === 'function')     e.takeDamage(1);
          else                                         e.kill();
          return 'hit-enemy';
        }
        // Whoosh effect — only awakens hostiles too.
        if (d < 1.3 && !(this._notified && this._notified.has(e))) {
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
