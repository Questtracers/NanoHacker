import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MAX_HP = 2;

// Crate model (Assets/Props/crate_model.glb) replaces the placeholder
// box geometry once it loads. We track a singleton geometry+material
// the moment the GLB resolves, plus every Obstacle instance that's
// alive at that point so we can retro-fit them. New obstacles created
// after the load just use the crate from the start.
let _crateAsset = null;
const _liveObstacles = new Set();
let _crateLoadStarted = false;
function _ensureCrateLoaded() {
  if (_crateAsset || _crateLoadStarted) return;
  _crateLoadStarted = true;
  new GLTFLoader().load(
    'Assets/Props/crate_white.glb',
    (gltf) => {
      let mesh = null;
      gltf.scene.traverse((c) => { if (c.isMesh && !mesh) mesh = c; });
      if (!mesh) return;
      // Bake mesh's local transform, center on XZ origin and bottom at y=0.
      mesh.updateMatrixWorld(true);
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const center = new THREE.Vector3();
      bb.getCenter(center);
      geo.translate(-center.x, -bb.min.y, -center.z);
      geo.computeBoundingBox();
      geo.computeVertexNormals();
      const size = new THREE.Vector3();
      geo.boundingBox.getSize(size);
      // Scale to fit the 1m × 1m grid cell with a sensible height.
      const target = 1.0;
      const scale = target / Math.max(size.x, size.z, 0.0001);
      geo.scale(scale, scale, scale);
      _crateAsset = { geometry: geo, material: mesh.material };
      // Texture color-space fix.
      if (_crateAsset.material?.map) {
        _crateAsset.material.map.colorSpace = THREE.SRGBColorSpace;
        _crateAsset.material.needsUpdate = true;
      }
      // Retro-swap any obstacles already on screen.
      for (const obs of _liveObstacles) obs._upgradeToCrate();
    },
    undefined,
    (err) => console.error('Obstacle: failed to load crate_model.glb', err),
  );
}
// Kick off the load as soon as this module is imported — main.js
// imports it during module-graph init, so the GLB starts streaming
// well before the first Obstacle is constructed.
_ensureCrateLoaded();

// ── Hit shake ─────────────────────────────────────────────────────
// On every non-fatal hit we offset the crate's mesh by a small jitter
// for SHAKE_DURATION seconds, then ease back to its base position.
// The set tracked below is consumed by updateCrateDebris (which we
// also use as the per-frame tick for the shake state since the host
// already calls it every animate frame).
const SHAKE_DURATION = 0.18;            // seconds
const SHAKE_AMPLITUDE = 0.10;           // metres of peak jitter
const _liveShakes = new Set();

// ── Debris ────────────────────────────────────────────────────────
// On crate destruction we spit out a flurry of debris pieces — one
// per Mesh inside crate_white_debris.glb. Each piece flies out with a
// random outward velocity + initial spin, falls under gravity, lands,
// rolls a bit, then fades and disposes.
let _debrisPieces = null;
let _debrisLoadStarted = false;
const _liveDebris = [];

function _ensureDebrisLoaded() {
  if (_debrisPieces || _debrisLoadStarted) return;
  _debrisLoadStarted = true;
  new GLTFLoader().load(
    'Assets/Props/crate_white_debris.glb',
    (gltf) => {
      const pieces = [];
      gltf.scene.traverse((c) => {
        if (!c.isMesh) return;
        c.updateMatrixWorld(true);
        const geo = c.geometry.clone();
        geo.applyMatrix4(c.matrixWorld);
        // Centre the geometry on its own origin so spinning rotates
        // around the piece's centre rather than an offset corner.
        geo.computeBoundingBox();
        const cen = new THREE.Vector3();
        geo.boundingBox.getCenter(cen);
        geo.translate(-cen.x, -cen.y, -cen.z);
        // Shrink — debris reads as smaller than a full crate.
        // 25% smaller than the previous 0.45 → 0.34.
        const s = 0.34;
        geo.scale(s, s, s);
        geo.computeVertexNormals();
        pieces.push({ geometry: geo, material: c.material });
      });
      _debrisPieces = pieces;
    },
    undefined,
    (err) => console.error('Obstacle: failed to load crate_white_debris.glb', err),
  );
}
_ensureDebrisLoaded();

// Spawn a debris burst centred at world position (x, z). Called from
// _killCell on every crate that breaks; main.js calls updateDebris(dt)
// once per frame to integrate them.
// Number of debris chunks per destroyed crate. The GLB ships with
// many pieces but we only need a handful per box — picked at random
// each spawn so different crates look different.
const DEBRIS_PER_SPAWN = 5;

export function spawnCrateDebris(scene, x, z) {
  if (!_debrisPieces || _debrisPieces.length === 0) return;
  // Pick DEBRIS_PER_SPAWN random pieces from the pool. Sampling with
  // replacement is fine — the random transforms below make duplicates
  // unrecognisable.
  const pieces = [];
  for (let i = 0; i < DEBRIS_PER_SPAWN; i++) {
    pieces.push(_debrisPieces[Math.floor(Math.random() * _debrisPieces.length)]);
  }
  for (const piece of pieces) {
    const mat = piece.material.clone();
    mat.transparent = true;
    mat.opacity = 1;
    const mesh = new THREE.Mesh(piece.geometry, mat);
    mesh.position.set(
      x + (Math.random() - 0.5) * 0.3,
      0.5 + Math.random() * 0.2,
      z + (Math.random() - 0.5) * 0.3,
    );
    mesh.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );
    mesh.castShadow = true;
    scene.add(mesh);
    const angle = Math.random() * Math.PI * 2;
    const speed = 2.0 + Math.random() * 2.0;
    _liveDebris.push({
      mesh,
      vx: Math.cos(angle) * speed,
      vy: 3.0 + Math.random() * 2.0,
      vz: Math.sin(angle) * speed,
      ax: (Math.random() - 0.5) * 14,
      ay: (Math.random() - 0.5) * 14,
      az: (Math.random() - 0.5) * 14,
      age: 0,
      life: 2.0 + Math.random() * 0.6,
    });
  }
}

// Per-frame integration. Pure ballistics: gravity, simple ground
// bounce + friction, exponential spin damping once near rest, and
// linear opacity fade-out over the last half-second of life.
export function updateCrateDebris(dt) {
  if (dt <= 0) return;
  // ── Hit-shake pass ─────────────────────────────────────────────
  // Every cell with shakeT > 0 jitters around its base position. The
  // amplitude tapers linearly with remaining time so the shake eases
  // out instead of cutting; once shakeT runs out we restore the
  // mesh's exact base position and remove it from the live set.
  for (const c of _liveShakes) {
    if (!c.alive || !c.mesh) { _liveShakes.delete(c); continue; }
    c.shakeT -= dt;
    if (c.shakeT <= 0) {
      c.mesh.position.set(c.baseX, c.baseY, c.baseZ);
      _liveShakes.delete(c);
      continue;
    }
    const t = c.shakeT / SHAKE_DURATION;        // 1 → 0
    const a = SHAKE_AMPLITUDE * t;
    c.mesh.position.set(
      c.baseX + (Math.random() * 2 - 1) * a,
      c.baseY + (Math.random() * 2 - 1) * a * 0.4,  // less Y jitter
      c.baseZ + (Math.random() * 2 - 1) * a,
    );
  }
  const G = 9.8;
  const FADE = 0.5;
  for (let i = _liveDebris.length - 1; i >= 0; i--) {
    const d = _liveDebris[i];
    d.age += dt;
    d.vy -= G * dt;
    d.mesh.position.x += d.vx * dt;
    d.mesh.position.y += d.vy * dt;
    d.mesh.position.z += d.vz * dt;
    if (d.mesh.position.y < 0) {
      d.mesh.position.y = 0;
      d.vy *= -0.30;
      d.vx *= 0.55;
      d.vz *= 0.55;
      // dampen spin once it's eaten dirt
      d.ax *= 0.6; d.ay *= 0.6; d.az *= 0.6;
    }
    d.mesh.rotation.x += d.ax * dt;
    d.mesh.rotation.y += d.ay * dt;
    d.mesh.rotation.z += d.az * dt;
    const remaining = d.life - d.age;
    if (remaining < FADE) {
      d.mesh.material.opacity = Math.max(0, remaining / FADE);
    }
    if (remaining <= 0) {
      d.mesh.parent?.remove(d.mesh);
      d.mesh.material.dispose();
      _liveDebris.splice(i, 1);
    }
  }
}

// A destructible obstacle = one or more adjacent grid cells (originally type 2
// in the map grid). Each cell is its OWN destructible: it tracks HP, takes
// damage, and gets removed independently of its siblings. The Obstacle
// container just owns the THREE.Group + a shared geometry, and reports
// `alive` as long as at least one cell remains.
export class Obstacle {
  constructor(scene, cells) {
    this.scene        = scene;
    this.maxHpPerCell = MAX_HP;
    // Fallback box geometry — used until the crate GLB streams in.
    // Disposed once the obstacle dies.
    this.geo = new THREE.BoxGeometry(1, 0.5, 1);
    this.group = new THREE.Group();

    const baseColor = new THREE.Color(0x6a4a2a);
    let sumX = 0, sumZ = 0;
    this.cells = [];
    const useCrate = !!_crateAsset;
    for (const c of cells) {
      const geo = useCrate ? _crateAsset.geometry : this.geo;
      const mat = useCrate
        ? _crateAsset.material
        : new THREE.MeshStandardMaterial({
            color: baseColor.clone(), emissive: 0x1a0c00, roughness: 0.9,
          });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(c.col, 0, c.row);
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
    _liveObstacles.add(this);
  }

  // Swap each cell's box geometry for the loaded crate model. Called
  // from the GLB loader once the asset is ready, for any obstacles
  // that were constructed during the streaming window.
  _upgradeToCrate() {
    if (!_crateAsset) return;
    for (const cell of this.cells) {
      if (!cell.alive) continue;
      cell.mesh.geometry = _crateAsset.geometry;
      cell.mesh.material = _crateAsset.material;
      // Crate sits on the floor (origin at base after translate); the
      // box was at y=0.25 with its centre. Reset to y=0.
      cell.mesh.position.y = 0;
    }
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
    // Hit reaction: brief shake instead of a red tint. The previous
    // colour ramp has been removed entirely — we just trigger a shake
    // and leave the crate's authored material untouched. The shake
    // state is consumed by updateCrateDebris (re-purposed to also
    // tick the shaking obstacles).
    if (c.mesh && c.hp > 0) {
      if (c.baseX === undefined) {
        c.baseX = c.mesh.position.x;
        c.baseY = c.mesh.position.y;
        c.baseZ = c.mesh.position.z;
      }
      c.shakeT = SHAKE_DURATION;
      _liveShakes.add(c);
    }
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
      // Snapshot world position before removing the mesh so the
      // debris burst spawns at the right spot.
      const px = c.mesh.position.x;
      const pz = c.mesh.position.z;
      this.group.remove(c.mesh);
      // Geometry is shared at the obstacle level — only material is per-cell.
      if (c.mesh.material?.dispose) c.mesh.material.dispose();
      c.mesh = null;
      spawnCrateDebris(this.scene, px, pz);
    }
  }

  _maybeDisposeGeo() {
    if (this.alive) return;
    this.scene.remove(this.group);
    if (this.geo?.dispose) this.geo.dispose();
    this.geo = null;
  }
}
