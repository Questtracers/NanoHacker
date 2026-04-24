import * as THREE from 'three';
import { isWall } from './map.js';

export class Bullet {
  constructor(scene, x, z, dx, dz) {
    const geo = new THREE.SphereGeometry(0.12, 8, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffff66, emissive: 0xffaa00 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(x, 0.6, z);
    scene.add(this.mesh);
    this.dx = dx; this.dz = dz;
    this.speed = 10;
    this.life = 3;
    this.alive = true;
    this.scene = scene;
  }

  update(dt, map, player) {
    if (!this.alive) return;
    const step = this.speed * dt;
    const p = this.mesh.position;
    p.x += this.dx * step;
    p.z += this.dz * step;
    this.life -= dt;
    if (this.life <= 0 || isWall(map, p.x, p.z)) return this.destroy();
    const pp = player.position;
    if (Math.hypot(p.x - pp.x, p.z - pp.z) < 0.4) {
      this.destroy();
      return 'hit';
    }
  }

  destroy() {
    this.alive = false;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}
