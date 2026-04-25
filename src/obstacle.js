import * as THREE from 'three';

const MAX_HP = 2;

// A destructible obstacle = one or more adjacent grid cells (originally type 2
// in the map grid). Each cell is its OWN destructible: it tracks HP, takes
// damage, and gets removed independently of its siblings. The Obstacle
// container just owns the THREE.Group + a shared geometry, and reports
// `alive` as long as at least one cell remains.
export class Obstacle {
  constructor(scene, cells) {
    this.scene        = scene;
    this.maxHpPerCell = MAX_HP;
    // Shared geometry so we don't allocate one per cell. Disposed once the
    // last cell of this obstacle dies.
    this.geo = new THREE.BoxGeometry(1, 0.5, 1);
    this.group = new THREE.Group();

    const baseColor = new THREE.Color(0x6a4a2a);
    let sumX = 0, sumZ = 0;
    this.cells = [];
    for (const c of cells) {
      const m = new THREE.Mesh(
        this.geo,
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
      this.cells.push({
        row:   c.row,
        col:   c.col,
        hp:    MAX_HP,
        alive: true,
        mesh:  m,
      });
      sumX += c.col;
      sumZ += c.row;
    }
    this.center = { x: sumX / cells.length, z: sumZ / cells.length };
    scene.add(this.group);
  }

  // True while at least one cell is still standing.
  get alive() { return this.cells.some(c => c.alive); }

  // Returns the live cell at integer (x, z), or null.
  _findCell(x, z) {
    const ix = Math.round(x), iz = Math.round(z);
    for (const c of this.cells) {
      if (c.alive && c.col === ix && c.row === iz) return c;
    }
    return null;
  }

  containsCell(x, z) { return this._findCell(x, z) !== null; }

  // Damage just the cell at (x, z). Returns the cell object if THIS hit
  // killed it, or null if it survived / no cell was found. The caller is
  // responsible for any world-side bookkeeping (grid clearing, index update).
  takeDamageAt(x, z, n = 1) {
    const c = this._findCell(x, z);
    if (!c) return null;
    c.hp -= n;
    const ratio = Math.max(0, c.hp / this.maxHpPerCell);
    c.mesh.material.color.setRGB(
      0.42 + 0.45 * (1 - ratio),
      0.29 * ratio + 0.05,
      0.16 * ratio,
    );
    c.mesh.material.emissive.setRGB(
      0.10 + 0.55 * (1 - ratio),
      0.05 * ratio,
      0,
    );
    if (c.hp <= 0) {
      this._killCell(c);
      this._maybeDisposeGeo();
      return c;
    }
    return null;
  }

  // Instantly destroy the cell at (x, z) — used by the mecha's plough sweep.
  destroyCellAt(x, z) {
    const c = this._findCell(x, z);
    if (!c) return null;
    this._killCell(c);
    this._maybeDisposeGeo();
    return c;
  }

  _killCell(c) {
    c.alive = false;
    if (c.mesh) {
      this.group.remove(c.mesh);
      // Geometry is shared at the obstacle level — only material is per-cell.
      if (c.mesh.material?.dispose) c.mesh.material.dispose();
      c.mesh = null;
    }
  }

  _maybeDisposeGeo() {
    if (this.alive) return;
    this.scene.remove(this.group);
    if (this.geo?.dispose) this.geo.dispose();
    this.geo = null;
  }
}
