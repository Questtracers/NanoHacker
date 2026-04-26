import * as THREE from 'three';
import { isWall } from './map.js';
import { CharacterRig } from './character-rig.js';

// Must match the camera yaw in main.js so WASD feels screen-aligned.
const CAM_YAW = Math.PI * 75 / 180;

// Stealth auto-correct: only kicks in after the player hasn't touched Q/E for
// AUTO_ALIGN_DELAY seconds, and rotates at AUTO_ALIGN_SPEED — much gentler
// than the manual turn rate so it doesn't fight the player's intent.
const AUTO_ALIGN_DELAY = 1.6;
const AUTO_ALIGN_SPEED = 0.6; // rad/s

export class Player {
  constructor(scene, x, z) {
    // CharacterRig owns the visible body, the AnimationMixer, and the blend
    // tree that picks animations. Its root Group is added to `scene`
    // immediately (empty) and the FBX content streams in over a few seconds —
    // by the time the corp logo finishes, it's loaded.
    //
    // We alias `this.mesh` to rig.root so existing code that touches
    // this.mesh.position / .visible (collision, mecha possession, etc.)
    // keeps working without changes.
    this.rig = new CharacterRig(scene, { moveSpeed: 4.5 });
    this.rig.load();
    this.rig.position = { x, z };
    this.mesh = this.rig.root;
    this.mesh.castShadow = true;

    this.speed = 4.5;
    this.keys = new Set();
    this.movedThisFrame    = false;
    this.turningThisFrame  = false;
    this.lastMoveAmount    = 0;
    // Facing is now controlled directly with Q (left) / E (right) — movement
    // doesn't change it. The gun shot fires along this vector and the on-
    // floor arrow + battle aim line both render off it.
    this.facing    = Math.PI / 2;            // start looking east
    this.facingDir = { x: 1, z: 0 };
    this.turnSpeed = Math.PI;                // rad/s
    this.idleTurnTime = AUTO_ALIGN_DELAY;    // start aligned-ready (no startup grace)
    this.rig.facing = this.facing;           // sync rig orientation up front

    // Floor arrow showing facing direction.
    const triGeo = new THREE.BufferGeometry();
    triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
       0,    0,  0.55,   // tip (forward)
      -0.28, 0, -0.18,
       0.28, 0, -0.18,
    ]), 3));
    triGeo.computeVertexNormals();
    const triMat = new THREE.MeshBasicMaterial({
      color: 0x66ffcc, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    });
    this.facingTri = new THREE.Mesh(triGeo, triMat);
    this.facingTri.position.y = 0.04;
    scene.add(this.facingTri);

    // Battle-only aim line — a thin segment extending forward.
    const aimGeo = new THREE.BufferGeometry();
    aimGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0.5, 0.4,
      0, 0.5, 6,
    ]), 3));
    const aimMat = new THREE.LineBasicMaterial({
      color: 0xff8866, transparent: true, opacity: 0.7,
    });
    this.aimLine = new THREE.Line(aimGeo, aimMat);
    this.aimLine.visible = false;
    scene.add(this.aimLine);

    window.addEventListener('keydown', e => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup',   e => this.keys.delete(e.key.toLowerCase()));
  }

  get position() { return this.mesh.position; }

  update(dt, map, doorBlocks = null, battleMode = false, shotReady = true) {
    // ── Manual turning (Q/E) — works in BOTH modes. Real-time even during
    // slow-mo so aim stays responsive.
    let turn = 0;
    if (this.keys.has('q')) turn -= 1;
    if (this.keys.has('e')) turn += 1;
    this.turningThisFrame = turn !== 0;
    if (turn) {
      this.facing += turn * this.turnSpeed * dt;
      while (this.facing >  Math.PI) this.facing -= Math.PI * 2;
      while (this.facing < -Math.PI) this.facing += Math.PI * 2;
      this.idleTurnTime = 0;
    } else {
      this.idleTurnTime += dt;
    }

    // ── Movement (WASD).
    let ix = 0, iz = 0;
    if (this.keys.has('w')) iz -= 1;
    if (this.keys.has('s')) iz += 1;
    if (this.keys.has('a')) ix -= 1;
    if (this.keys.has('d')) ix += 1;
    const len = Math.hypot(ix, iz);
    this.movedThisFrame = len > 0;
    let wx = 0, wz = 0;
    if (this.movedThisFrame) {
      ix /= len; iz /= len;
      wx =  iz;
      wz = -ix;
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
    } else {
      this.lastMoveAmount = 0;
    }

    // Stealth auto-correct: a *very* gentle nudge that pulls facing toward
    // the movement direction — but only after the player has gone hands-off
    // Q/E for AUTO_ALIGN_DELAY seconds. Doesn't run in battle (combat demands
    // deliberate aim) and doesn't run while the player is steering manually.
    if (!battleMode &&
        this.movedThisFrame &&
        this.idleTurnTime >= AUTO_ALIGN_DELAY) {
      const tgt = Math.atan2(wx, wz);
      let diff = tgt - this.facing;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.facing += Math.sign(diff) * Math.min(Math.abs(diff), AUTO_ALIGN_SPEED * dt);
      while (this.facing >  Math.PI) this.facing -= Math.PI * 2;
      while (this.facing < -Math.PI) this.facing += Math.PI * 2;
    }

    this.facingDir.x = Math.sin(this.facing);
    this.facingDir.z = Math.cos(this.facing);

    // Push state into the rig and tick its blend tree. The rig handles its
    // own mesh-rotation offset internally (Mixamo's -Z forward), so we just
    // pass the logical facing.
    //
    // Battle stance is gated on shotReady — the standing-aim pose is only
    // shown when the player can actually fire. While reloading, the rig
    // falls back to the stealth (crouch) bundle as a clear visual cue that
    // the shot UI status is matched by the body.
    this.rig.facing     = this.facing;
    this.rig.battleMode = battleMode && shotReady;
    this.rig.setMovement(
      this.movedThisFrame ? wx : 0,
      this.movedThisFrame ? wz : 0,
    );
    this.rig.update(dt);

    // Sync arrow + aim line to the player's footing.
    const pp = this.mesh.position;
    this.facingTri.position.set(pp.x, 0.04, pp.z);
    this.facingTri.rotation.y = this.facing;
    this.aimLine.position.set(pp.x, 0, pp.z);
    this.aimLine.rotation.y = this.facing;
  }
}
