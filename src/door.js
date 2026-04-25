import * as THREE from 'three';

// A corridor door. Closed by default; auto-opens when any non-player entity
// is approaching (≤ 1.4 cells away); player must Hack-Link to open. A hacked
// door stays open for the rest of the run and exposes the same hack-link
// surface as enemies (`alive`, `faction`, `mesh.position`, `hackLink()`).
// Door slab dimensions. The width is now per-instance — measured against the
// corridor at spawn so the slab actually touches both walls of any-width
// passage rather than being a one-size-fits-all 3-cell rectangle.
const SLAB_THICKNESS  = 0.20;
const SLAB_HEIGHT     = 1.5;
// Auto-open check: enemies approaching within these box bounds open the door.
const TRIGGER_AHEAD   = 2.0; // cells along the travel axis
const TRIGGER_SIDE    = 1.5; // cells along the perpendicular (3-wide corridor)
const ANIM_SPEED      = 5.5;
const PLAYER_BLOCK_TH = 0.6;

export class Door {
  // corridorDir: 'EW' (east-west passage — slab spans N–S) or
  //              'NS' (north-south passage — slab spans E–W).
  // corridorWidth: passable width perpendicular to the travel axis, in cells.
  //                Defaults to 3 (the standard map corridor) but the spawner
  //                measures the actual width and passes it in.
  constructor(scene, x, z, corridorDir = 'EW', corridorWidth = 3) {
    this.x           = x;
    this.z           = z;
    this.corridorDir = corridorDir;
    this.alive       = true;
    this.faction     = 'door';   // ignored by the AI's friend/foe checks
    this.hacked      = false;
    this.openness    = 0;
    this.scene       = scene;

    const isEW = corridorDir === 'EW';
    // Slab fills the corridor exactly so the door touches both side walls.
    const slabWidth = corridorWidth;
    this.slabWidth  = slabWidth;
    const w = isEW ? SLAB_THICKNESS : slabWidth;
    const d = isEW ? slabWidth      : SLAB_THICKNESS;
    const h = SLAB_HEIGHT;
    this._isEW = isEW;

    // Grid cells the slab occupies. When the door is closed/closing we mark
    // these cells as walls so bullets, vision cones and pathfinding all
    // respect the door — when it opens we set them back to floor.
    const halfNeg = Math.floor((slabWidth - 1) / 2);
    const halfPos = Math.ceil((slabWidth - 1) / 2);
    this.cells = [];
    for (let i = -halfNeg; i <= halfPos; i++) {
      this.cells.push(isEW ? { r: z + i, c: x } : { r: z, c: x + i });
    }
    this._blockingMap = false; // tracked separately to avoid redundant writes

    const slabGeo = new THREE.BoxGeometry(w, h, d);
    const slabMat = new THREE.MeshStandardMaterial({
      color:    0xff5544,
      emissive: 0x441111,
      roughness: 0.45, metalness: 0.55,
      transparent: true, opacity: 0.95,
    });
    this.mesh = new THREE.Mesh(slabGeo, slabMat);
    this.mesh.position.set(x, h / 2, z);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Floor strip — long marker along the corridor showing where the door is
    const stripGeo = new THREE.PlaneGeometry(
      isEW ? 0.55 : slabWidth,
      isEW ? slabWidth : 0.55,
    );
    const stripMat = new THREE.MeshBasicMaterial({
      color: 0xff8866, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(stripGeo, stripMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(x, 0.02, z);
    scene.add(this.ring);
  }

  // True iff the door is currently obstructing things in general. Enemies
  // pass freely thanks to auto-open; this only matters for the player.
  blocksPlayer() {
    if (this.hacked) return false;
    return this.openness < PLAYER_BLOCK_TH;
  }

  // True if the player at world position (x, z) is overlapping this door's
  // 3-cell-wide footprint. Used by Player.update's per-axis collision check.
  blocksPlayerAt(x, z) {
    if (!this.blocksPlayer()) return false;
    const ahead = this._isEW ? Math.abs(x - this.x) : Math.abs(z - this.z);
    const side  = this._isEW ? Math.abs(z - this.z) : Math.abs(x - this.x);
    return ahead < 0.55 && side < this.slabWidth / 2;
  }

  // True if (x, z) overlaps any of this door's footprint cells. Used for
  // bullet collision and cone ray-march early-out — both consult a global
  // door blocker registered against the door list.
  containsCell(x, z) {
    const cx = Math.round(x), cz = Math.round(z);
    for (const c of this.cells) {
      if (c.r === cz && c.c === cx) return true;
    }
    return false;
  }

  update(dt, world) {
    let target = this.hacked ? 1 : 0;
    if (!this.hacked) {
      // Auto-open when any soldier or drone is about to cross. Axis-aligned
      // box matching the door's 3-cell footprint.
      const all = (world.enemies || []).concat(world.drones || []);
      for (const e of all) {
        if (!e.alive) continue;
        const dx = e.mesh.position.x - this.x;
        const dz = e.mesh.position.z - this.z;
        const ahead = this._isEW ? Math.abs(dx) : Math.abs(dz);
        const side  = this._isEW ? Math.abs(dz) : Math.abs(dx);
        if (ahead < TRIGGER_AHEAD && side < TRIGGER_SIDE) { target = 1; break; }
      }
    }
    // Player can never trigger or hold the door open. Even if they get
    // caught mid-crossing while it closes, the host's `doorBlocksPlayer`
    // check lets them keep moving AWAY from the slab so they're never stuck.

    if      (this.openness < target) this.openness = Math.min(1, this.openness + dt * ANIM_SPEED);
    else if (this.openness > target) this.openness = Math.max(0, this.openness - dt * ANIM_SPEED);

    // Slab fades + recedes upward as it opens. Hidden when basically open.
    this.mesh.material.opacity = (1 - this.openness) * 0.95;
    this.mesh.position.y       = 0.7 + this.openness * 0.3;
    this.mesh.visible          = this.openness < 0.99;

    // Ring colour: red while closed, amber while opening, cyan when hacked.
    if (this.hacked) {
      this.ring.material.color.setHex(0x66ccff);
    } else if (target === 1) {
      this.ring.material.color.setHex(0xffaa66);
    } else {
      this.ring.material.color.setHex(0xff8866);
    }
  }

  // Permanently open. Match the hacked-ally palette so it reads at a glance.
  hackLink() {
    if (this.hacked) return;
    this.hacked  = true;
    this.faction = 'friendly';   // matches the existing "skip friendly" filter
    this.mesh.material.color.setHex(0x66ccff);
    this.mesh.material.emissive.setHex(0x113355);
    this.ring.material.color.setHex(0x66ccff);
  }
}
