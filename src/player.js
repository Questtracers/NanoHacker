import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { isWall } from './map.js';
import { CharacterRig } from './character-rig.js';

// Must match the camera yaw in main.js so WASD feels screen-aligned.
const CAM_YAW = Math.PI * 75 / 180;

// Stealth auto-correct: only kicks in after the player hasn't touched Q/E for
// AUTO_ALIGN_DELAY seconds, and rotates at AUTO_ALIGN_SPEED — much gentler
// than the manual turn rate so it doesn't fight the player's intent.
const AUTO_ALIGN_DELAY = 1.6;
const AUTO_ALIGN_SPEED = 0.6; // rad/s

// Bow-on-RightHand calibration values, tuned in the debug-level
// weapon-calibration tool. All in the bone's LOCAL space.
const BOW_FILE = 'Assets/Weapons/main_bow.glb';
const BOW_BONE = 'LeftHand';
const BOW_POS  = new THREE.Vector3(0.02, 0.02, 0.02);
const BOW_ROT  = new THREE.Euler(
  -95.0 * Math.PI / 180,
    5.0 * Math.PI / 180,
 -100.0 * Math.PI / 180,
  'XYZ',
);
const BOW_SCALE = 0.711;

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
    // Bow weapon — parented to the rig's RightHand bone via GLTF +
    // skeleton traversal once the rig FBX has streamed in. Hidden by
    // default; visible only while the rig is in the battle bundle
    // (standing-aim idle / aim-walk / recoil overlay).
    this._bow = null;
    // Post-shot bow hold: when the player fires (notifyShot()) we
    // bump this timer so the rig stays in the battle pose long enough
    // to play the recoil + a brief settle window before swapping back
    // to stealth and letting the bow fade out.
    this._postShotHold = 0;
    this._loadBowAndAttach();

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
    // Battle stance trades agility for aim — the rig animation is
    // weightier, and rotation drops 25 % to match. Both are deliberate
    // game-feel choices, not technical constraints.
    this.battleTurnFactor = 0.75;
    // Disabled mode (e.g. while the death clip is playing) — clears
    // the held-keys set and ignores future input until re-enabled.
    this._inputDisabled = false;
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
      color: 0x66ffcc, transparent: true, opacity: 0.25, side: THREE.DoubleSide,
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
    // Default aim-line tint is white; the host re-tints it red each
    // frame whenever the line crosses an enemy's hitRadius (see
    // `setAimLineHostile()` below + the call site in main.js).
    const aimMat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85,
    });
    this.aimLine = new THREE.Line(aimGeo, aimMat);
    this.aimLine.visible = false;
    scene.add(this.aimLine);

    window.addEventListener('keydown', e => {
      if (this._inputDisabled) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup',   e => this.keys.delete(e.key.toLowerCase()));
  }

  // Public: gate input. Used by the host on death — held keys clear so
  // the player can't keep walking while the falling-back-death clip
  // plays, and new keydowns are dropped until re-enabled (which we
  // never do mid-run; the overlay reloads the page).
  setInputDisabled(disabled) {
    this._inputDisabled = !!disabled;
    if (disabled) this.keys.clear();
  }

  // Flip the battle aim-line tint between hostile (red) and neutral
  // (white). Called once per frame from main.js after a quick segment
  // ray-test against live enemies.
  setAimLineHostile(hostile) {
    if (!this.aimLine) return;
    this.aimLine.material.color.setHex(hostile ? 0xff3344 : 0xffffff);
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
      // Battle stance turns slower than stealth — combat is meant to
      // feel deliberate, so rotation is throttled by battleTurnFactor.
      const speed = this.turnSpeed * (battleMode ? this.battleTurnFactor : 1);
      this.facing += turn * speed * dt;
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
      // Margin 0.40 — wide enough to keep the rig's silhouette out of
      // the wall geometry (wall tiles now sit entirely on the wall-cell
      // side of the boundary), tight enough that the player fits
      // through a 1-cell gap between obstacle crates.
      const M = 0.40;
      if (!blockX &&
          !isWall(map, nx, p.z) && !isWall(map, nx + Math.sign(wx) * M, p.z) &&
          !isWall(map, nx, p.z + M) && !isWall(map, nx, p.z - M)) p.x = nx;
      if (!blockZ &&
          !isWall(map, p.x, nz) && !isWall(map, p.x + M, nz) &&
          !isWall(map, p.x - M, nz) && !isWall(map, p.x, nz + Math.sign(wz) * M)) p.z = nz;
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
    // Post-shot hold ticks down on real-time-ish dt so the recoil
    // settle window doesn't get stretched to infinity by slow-mo.
    if (this._postShotHold > 0) this._postShotHold -= dt;

    // Battle pose is active whenever the world is in battle mode AND
    // the shot is ready, OR while we're inside the post-shot grace
    // window (recoil + settle). The grace window is what "waits a bit
    // for the recoil to end" — even a stealth-mode shot temporarily
    // puts the rig into battle pose for the recoil clip.
    const inBattlePose = (battleMode && shotReady) || this._postShotHold > 0;
    this.rig.battleMode = inBattlePose;

    if (this._bow) {
      const wantVisible = inBattlePose;
      // Fire the particle burst on EITHER transition direction. On
      // show: appear effect. On hide: dissolve effect — particles
      // are world-space so they survive the bow becoming invisible.
      if (wantVisible !== this._lastBowVisible && this._bowVFX) {
        this._bowVFX.trigger();
      }
      this._bow.visible = wantVisible;
      if (this._bowLight) this._bowLight.visible = wantVisible;
      this._lastBowVisible = wantVisible;
      if (this._bowVFX) this._bowVFX.update(dt);
    }
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

  // World position of the bow-hand bone — gameplay reads this to
  // spawn arrows from the actual bow rather than the player's centre.
  // Falls back to the player's footing if the rig hasn't loaded yet.
  getBowMuzzleWorldPos(out = new THREE.Vector3()) {
    if (this._bow && this._bow.parent) {
      this._bow.parent.getWorldPosition(out);
    } else {
      out.set(this.position.x, 0.6, this.position.z);
    }
    return out;
  }

  // Hook called by the host whenever the player fires an arrow.
  // Triggers the rig's recoil overlay and bumps the post-shot hold
  // so the bow stays armed through the recoil + a brief settle window
  // before unarming + dissolving.
  notifyShot() {
    this.rig.triggerRecoil();
    // Recoil clip is ~0.4 s; add a 0.7 s settle on top so the player
    // sees the recoil land + the bow stand still briefly before the
    // dissolve burst fires.
    this._postShotHold = 1.1;
  }

  // Stream the bow GLB and parent it to the LeftHand bone with the
  // calibrated transform. Waits on this.rig.load() so the FBX's
  // skeleton is guaranteed to exist before the bone lookup runs.
  // Also wires the always-on emissive glow + the spawn-in particle
  // effect that fires whenever the bow transitions from hidden to
  // shown (i.e. each time the player enters the battle pose).
  async _loadBowAndAttach() {
    try {
      const [gltf] = await Promise.all([
        new GLTFLoader().loadAsync(BOW_FILE),
        this.rig._loadingPromise || this.rig.load(),
      ]);
      let mesh = null;
      gltf.scene.traverse((c) => { if (c.isMesh && !mesh) mesh = c; });
      if (!mesh || !this.rig._fbx) return;
      // Bake the GLB's authored transform into the geometry so the
      // mesh's local origin is at the bow's authored origin (not at
      // some offset corner).
      mesh.updateMatrixWorld(true);
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      // Clone the material so we can override the emissive without
      // affecting any other instance that shares this asset.
      const material = mesh.material.clone();
      if (material.emissive !== undefined) {
        material.emissive = new THREE.Color(0x66ffcc);
        material.emissiveIntensity = 0.9;
      }
      const bow = new THREE.Mesh(geo, material);
      bow.castShadow = true;
      // Apply the bone-local calibration from the debug tuner.
      bow.position.copy(BOW_POS);
      bow.rotation.copy(BOW_ROT);
      bow.scale.setScalar(BOW_SCALE);
      bow.visible = false;       // shown only while battle pose is active
      // Find the bone — Mixamo names are prefix-fused
      // ("mixamorigLeftHand"), so a suffix match is enough.
      let hand = null;
      this.rig._fbx.traverse((node) => {
        if (!hand && new RegExp(`${BOW_BONE}$`).test(node.name || '')) hand = node;
      });
      if (!hand) {
        console.warn(`Player: ${BOW_BONE} bone not found; bow not attached`);
        return;
      }
      hand.add(bow);
      // Subtle illumination — a tiny cyan point light parented to the
      // bow so it casts onto the rig + nearby walls when armed.
      const bowLight = new THREE.PointLight(0x66ffcc, 0.5, 2.5, 1.5);
      bow.add(bowLight);
      this._bowLight = bowLight;
      this._bow = bow;
      this._bowVFX = new BowVFX(bow, this.rig.root.parent);
      this._lastBowVisible = false;
    } catch (err) {
      console.error('Player: failed to load / attach bow', err);
    }
  }
}

// ── Bow VFX ───────────────────────────────────────────────────────────
// Particle burst that fires whenever the bow becomes visible — points
// emanate from random vertices of the bow's geometry, drift outward
// while decelerating, and fade. Inspired by the wawa-vfx custom-geometry
// preset: emit FROM the model's geometry rather than a generic point
// source so the burst silhouettes the bow's shape.
const VFX_PARTICLES = 50;
const VFX_LIFE_MIN  = 0.55;
const VFX_LIFE_MAX  = 1.10;
const VFX_SPEED_MIN = 0.6;
const VFX_SPEED_MAX = 1.6;
const VFX_DECEL     = 0.92;     // per-frame velocity decay multiplier
const VFX_HIDDEN_Y  = -1e4;     // park dead particles offscreen

class BowVFX {
  constructor(bow, scene) {
    this.bow = bow;
    this.scene = scene;
    const positions = new Float32Array(VFX_PARTICLES * 3).fill(VFX_HIDDEN_Y);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x66ffcc,
      size: 0.06,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.visible = false;
    // Parent to SCENE not bow — particles need to survive the bow's
    // visibility flip, otherwise the disappear burst would be hidden
    // along with the bow before it gets a chance to render.
    scene.add(this.points);

    // Per-particle ballistic state, kept on the JS side so we don't
    // re-allocate every frame.
    this.parts = [];
    for (let i = 0; i < VFX_PARTICLES; i++) {
      this.parts.push({
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        age: 1e6, life: 1,        // start expired
      });
    }
    this._anyAlive = false;
  }

  // Fresh burst: sample VFX_PARTICLES random vertices from the bow
  // and seed each particle in WORLD space. World-space integration
  // means the particles linger where the bow was — useful for the
  // hide-burst that has to outlive the bow's visibility flip.
  trigger() {
    this.bow.updateMatrixWorld(true);
    const verts = this.bow.geometry.attributes.position;
    const tmp = new THREE.Vector3();
    const mw = this.bow.matrixWorld;
    for (const p of this.parts) {
      const vi = Math.floor(Math.random() * verts.count);
      tmp.set(verts.getX(vi), verts.getY(vi), verts.getZ(vi)).applyMatrix4(mw);
      p.x = tmp.x; p.y = tmp.y; p.z = tmp.z;
      // Outward direction biased upward — reads as "magic dust rising
      // off the weapon" rather than a uniform sphere blast.
      const ang = Math.random() * Math.PI * 2;
      const up  = 0.4 + Math.random() * 0.8;
      const sp  = VFX_SPEED_MIN + Math.random() * (VFX_SPEED_MAX - VFX_SPEED_MIN);
      p.vx = Math.cos(ang) * sp;
      p.vy = up * sp;
      p.vz = Math.sin(ang) * sp;
      p.age = 0;
      p.life = VFX_LIFE_MIN + Math.random() * (VFX_LIFE_MAX - VFX_LIFE_MIN);
    }
    this.points.visible = true;
    this._anyAlive = true;
  }

  // Per-frame integration. Called from Player.update(); slow-mo
  // applies because we just pass through whatever dt the caller hands
  // us — no special clock.
  update(dt) {
    if (!this._anyAlive) { this.points.visible = false; return; }
    let alive = 0;
    const pos = this.points.geometry.attributes.position;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.age += dt;
      if (p.age >= p.life) {
        pos.setXYZ(i, 0, VFX_HIDDEN_Y, 0);
        continue;
      }
      alive++;
      // Frame-rate-independent decay isn't critical here — visuals
      // only — so a fixed multiplier on each tick reads fine.
      p.vx *= VFX_DECEL; p.vy *= VFX_DECEL; p.vz *= VFX_DECEL;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    this._anyAlive = alive > 0;
    this.points.visible = this._anyAlive;
  }
}
