import * as THREE from 'three';

const MAX_HP = 2;

// A destructible obstacle = one or more adjacent grid cells (originally type 2
// in the map grid). Rendered as a Group of small Box meshes — one per cell —
// so each cell stays visually distinct rather than being a single instanced
// mesh. Tracks HP so player bullets can chip it down; mechas instantly destroy.
export class Obstacle {
  constructor(scene, cells) {
    this.cells   = cells; // [{ row, col }]
    this.maxHp   = MAX_HP;
    this.hp      = MAX_HP;
    this.alive   = true;
    this.scene   = scene;

    const baseColor = new THREE.Color(0x6a4a2a);
    // Boxes are exactly 1 cell wide so adjacent cells of the same obstacle
    // share faces — the structure reads as a single chunk and visually
    // closes off cone rays from leaking between sub-boxes.
    const geo = new THREE.BoxGeometry(1, 0.5, 1);

    this.group = new THREE.Group();
    this.boxes = [];
    let sumX = 0, sumZ = 0;
    for (const c of cells) {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: baseColor.clone(),
          emissive: 0x1a0c00,
          roughness: 0.9,
        }),
      );
      m.position.set(c.col, 0.25, c.row);
      m.castShadow    = true;
      m.receiveShadow = true;
      this.group.add(m);
      this.boxes.push(m);
      sumX += c.col;
      sumZ += c.row;
    }
    this.center = { x: sumX / cells.length, z: sumZ / cells.length };
    scene.add(this.group);
  }

  containsCell(x, z) {
    const ix = Math.round(x), iz = Math.round(z);
    return this.cells.some(c => c.col === ix && c.row === iz);
  }

  takeDamage(n = 1) {
    if (!this.alive) return;
    this.hp -= n;
    // Visual feedback — boxes turn redder + emit more glow as HP drops.
    const ratio = Math.max(0, this.hp / this.maxHp);
    for (const b of this.boxes) {
      b.material.color.setRGB(0.42 + 0.45 * (1 - ratio), 0.29 * ratio + 0.05, 0.16 * ratio);
      b.material.emissive.setRGB(0.10 + 0.55 * (1 - ratio), 0.05 * ratio, 0);
    }
    if (this.hp <= 0) this.destroy();
  }

  // Instant destruction (mecha walks through it, or HP hit zero).
  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.scene.remove(this.group);
    for (const b of this.boxes) {
      if (b.geometry?.dispose) b.geometry.dispose();
      if (b.material?.dispose) b.material.dispose();
    }
  }
}
