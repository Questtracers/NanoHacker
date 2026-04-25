import * as THREE from 'three';
import { isWall } from './map.js';

// Must match the camera yaw in main.js so WASD feels screen-aligned.
const CAM_YAW = Math.PI * 75 / 180;

export class Player {
  constructor(scene, x, z) {
    const geo = new THREE.CapsuleGeometry(0.28, 0.4, 4, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x22ffcc, emissive: 0x0a3a33 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(x, 0.55, z);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    this.speed = 4.5;
    this.keys = new Set();
    this.movedThisFrame = false;
    this.lastMoveAmount = 0;
    // Last direction the player was moving in (persists when idle). The gun
    // shot uses this as its firing vector. Default: "up" (screen-wise).
    this.facingDir = { x: 1, z: 0 };

    window.addEventListener('keydown', e => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup',   e => this.keys.delete(e.key.toLowerCase()));
  }

  get position() { return this.mesh.position; }

  // Isometric WASD: input mapped so "up" is into-screen along iso axis.
  // `doorBlocks(x, z)` is an optional callback that returns true if a closed
  // door currently obstructs the player at that world position.
  update(dt, map, doorBlocks = null) {
    let ix = 0, iz = 0;
    if (this.keys.has('w')) iz -= 1;
    if (this.keys.has('s')) iz += 1;
    if (this.keys.has('a')) ix -= 1;
    if (this.keys.has('d')) ix += 1;
    const len = Math.hypot(ix, iz);
    this.movedThisFrame = len > 0;
    if (!this.movedThisFrame) { this.lastMoveAmount = 0; return; }
    ix /= len; iz /= len;

    const wx =  iz;
    const wz = -ix;

    const step = this.speed * dt;
    this.lastMoveAmount = step;
    const p = this.mesh.position;
    const nx = p.x + wx * step;
    const nz = p.z + wz * step;
    const blockX = doorBlocks ? doorBlocks(nx, p.z) : false;
    const blockZ = doorBlocks ? doorBlocks(p.x, nz) : false;
    if (!blockX &&
        !isWall(map, nx, p.z) && !isWall(map, nx + Math.sign(wx) * 0.3, p.z) &&
        !isWall(map, nx, p.z + 0.3) && !isWall(map, nx, p.z - 0.3)) p.x = nx;
    if (!blockZ &&
        !isWall(map, p.x, nz) && !isWall(map, p.x + 0.3, nz) &&
        !isWall(map, p.x - 0.3, nz) && !isWall(map, p.x, nz + Math.sign(wz) * 0.3)) p.z = nz;

    // face movement direction and memorize it for the gun shot
    this.mesh.rotation.y = Math.atan2(wx, wz);
    this.facingDir.x = wx;
    this.facingDir.z = wz;
  }
}
