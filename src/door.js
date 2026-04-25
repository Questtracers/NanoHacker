import * as THREE from 'three';

// A corridor door. Closed by default; auto-opens when any non-player entity
// is approaching (≤ 1.4 cells away); player must Hack-Link to open. A hacked
// door stays open for the rest of the run and exposes the same hack-link
// surface as enemies (`alive`, `faction`, `mesh.position`, `hackLink()`).
// Doors span the full 3-cell-wide corridor. The slab is thin along the
// corridor's travel axis and 3 cells wide perpendicular.
const SLAB_THICKNESS  = 0.20;
const SLAB_WIDTH      = 2.85;
const SLAB_HEIGHT     = 1.5;
// Auto-open check: enemies approaching within these box bounds open the door.
const TRIGGER_AHEAD   = 2.0; // cells along the travel axis
const TRIGGER_SIDE    = 1.5; // cells along the perpendicular (3-wide corridor)
const ANIM_SPEED      = 5.5;
const PLAYER_BLOCK_TH = 0.6;

export class Door {
  // corridorDir: 'EW' (east-west passage — slab spans N–S) or
  //              'NS' (north-south passage — slab spans E–W).
  constructor(scene, x, z, corridorDir = 'EW') {
    this.x          = x;
    this.z          = z;
    this.corridorDir = corridorDir;
    this.alive      = true;
    this.faction    = 'door';   // ignored by the AI's friend/foe checks
    this.hacked     = false;
    this.openness   = 0;        // 0 closed → 1 fully open
    this.scene      = scene;

    const isEW = corridorDir === 'EW';
    // EW corridor (player traverses east-west) → slab is thin in X, wide in Z
    const w = isEW ? SLAB_THICKNESS : SLAB_WIDTH;
    const d = isEW ? SLAB_WIDTH     : SLAB_THICKNESS;
    const h = SLAB_HEIGHT;
    this._isEW = isEW;

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
      isEW ? 0.55 : SLAB_WIDTH,
      isEW ? SLAB_WIDTH : 0.55,
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
    return ahead < 0.55 && side < SLAB_WIDTH / 2;
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
      // NEVER close on the player: if the player is currently overlapping the
      // door footprint (including a small grace margin so the slab doesn't
      // clip them mid-step) the door stays open until they're clear.
      if (world.player) {
        const px = world.player.position.x;
        const pz = world.player.position.z;
        const ahead = this._isEW ? Math.abs(px - this.x) : Math.abs(pz - this.z);
        const side  = this._isEW ? Math.abs(pz - this.z) : Math.abs(px - this.x);
        if (ahead < 0.75 && side < SLAB_WIDTH / 2 + 0.25) target = 1;
      }
    }

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
