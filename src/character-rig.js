import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// CharacterRig — owns the FBX skinned mesh, the AnimationMixer, and the
// blend tree that picks which clip(s) play. Designed to be the SOLE thing
// you carry over from the debug-level test arena into the main game.
//
// Public surface:
//   const rig = new CharacterRig(scene);
//   await rig.load();                       // resolves once all clips are in
//   rig.position = { x, z };                // floor-anchored at y=0
//   rig.facing   = radians;                 // applies MESH_FACING_OFFSET internally
//   rig.battleMode = true / false;          // ramps modeBlend → swap stealth/battle
//   rig.setMovement(wx, wz);                // world-space step direction
//   rig.triggerHack();                      // one-shot; movement interrupts
//   rig.update(dt);                         // ticks the mixer + applies weights
//
// The rig adds a THREE.Group to `scene` immediately (rig.root), and the FBX
// content streams into that Group as it loads. Until then the Group is empty
// — useful so the host can position the player even before assets are ready.

const ASSET_DIR = 'Assets/CyberPunk_Hacker/';

const ANIM_FILES = {
  // Skinned source — provides rig + textures + the stealth idle clip.
  source:    'Crouch Idle.fbx',
  hack:      'Hacking.fbx',
  recoil:    'Standing Aim Recoil.fbx',
  deathBack: 'Falling Back Death.fbx',
  deathFront:'Falling Forward Death.fbx',
  // Hit reactions — additive overlays played when the player takes damage.
  // The rig auto-picks the variant matching its current battle/stealth pose.
  hitCrouch: 'Crouch Hit.fbx',
  hitBattle: 'Standing Aim Hit.fbx',
  // Direct mapping — state name matches file name.
  stealth: {
    idle:    'Crouch Idle.fbx',                // also the source FBX
    forward: 'Crouch Walk Forward.fbx',
    back:    'Crouch Walk Back.fbx',
    left:    'Crouch Walk Left.fbx',
    right:   'Crouch Walk Right.fbx',
  },
  battle: {
    idle:    'Standing Aim Idle.fbx',
    forward: 'Standing Aim Walk Forward.fbx',
    back:    'Standing Aim Walk Back.fbx',
    left:    'Standing Aim Walk Left.fbx',
    right:   'Standing Aim Walk Right.fbx',
  },
};

// Tunables. Centralised here so adjustments propagate to debug + game.
// MESH_FACING_OFFSET = 0 → body rotates with the same convention as the
// floor-arrow in the main game (`facingTri.rotation.y = facing`). Setting
// it to π would make body 180° opposite to the arrow.
const MESH_FACING_OFFSET = 0;
const CLIP_SPEED         = 1.4;         // m/s baked into the strider clips
const BLEND_RATE         = 8;           // 1/s — move + hack scalar ramp
const MODE_BLEND_RATE    = 4;           // 1/s — slower posture swap
const FBX_SCALE          = 2.0;         // 2× the Mixamo native size so the FBX
                                         // reads at a reasonable scale at the
                                         // game's isometric camera distance

export class CharacterRig {
  /**
   * @param {THREE.Scene} scene
   * @param {{ moveSpeed?: number }} [options]
   */
  constructor(scene, options = {}) {
    this.scene     = scene;
    this.moveSpeed = options.moveSpeed ?? 2.5;

    // root Group is added IMMEDIATELY so the host can set position before
    // the FBX content arrives. The skinned mesh streams into root later.
    // Position lives on the Group; rotation is applied directly to the FBX
    // root once it loads (mirroring the original inline implementation),
    // which avoids any rotation composition with whatever transform the
    // FBX file may have baked in.
    this._root = new THREE.Group();
    scene.add(this._root);

    this._fbx      = null;
    this._mixer    = null;
    this._loaded   = false;
    this._loadingPromise = null;
    this._facing   = 0;
    this._wx       = 0;
    this._wz       = 0;
    this._battle   = false;
    this._hacking  = false;
    this._recoiling = false;            // brief additive overlay on shoot
    this._hitting  = false;             // brief additive overlay on damage
    this._hitSlot  = null;              // 'hitCrouch' | 'hitBattle' | null
    this._dying    = false;
    this._deathSlot = null;             // 'deathBack' | 'deathFront' | null

    // Two parallel locomotion bundles + the one-shots.
    this._actions = {
      hack:       null,
      recoil:     null,    // additive — adds on top of locomotion
      hitCrouch:  null,    // additive
      hitBattle:  null,    // additive
      deathBack:  null,
      deathFront: null,
      stealth: { idle: null, forward: null, back: null, left: null, right: null },
      battle:  { idle: null, forward: null, back: null, left: null, right: null },
    };
    // Live weight bag — applied to actions every frame.
    this._weights = {
      hack:       0,
      recoil:     0,
      hitCrouch:  0,
      hitBattle:  0,
      deathBack:  0,
      deathFront: 0,
      stealth: { idle: 1, forward: 0, back: 0, left: 0, right: 0 },
      battle:  { idle: 0, forward: 0, back: 0, left: 0, right: 0 },
    };
    // Smoothed scalars — ramp toward their input targets each frame.
    this._moveBlend  = 0;   // 0 = idle, 1 = full locomotion
    this._hackBlend  = 0;   // 0 = nothing, 1 = pure hack pose
    this._modeBlend  = 0;   // 0 = full stealth, 1 = full battle
    this._recoilBlend = 0;  // 0 = nothing, 1 = full recoil overlay
    this._hitBlend   = 0;   // 0 = nothing, 1 = full hit overlay
    this._deathBlend = 0;   // 0 = alive, 1 = death pose dominant
    // Smoothed directional split. Updated only while moving — when the
    // player releases keys these stay frozen at the last value so the
    // global moveBlend can cleanly fade the active stride out into idle.
    // Without this freeze the four directional weights snap to 0 the
    // instant input drops, creating a visible pop in the strider pose.
    this._smoothFw = 0;
    this._smoothBw = 0;
    this._smoothLw = 0;
    this._smoothRw = 0;

    this._loadCount = 0;
    // source + 4 stealth striders + 5 battle + hack + recoil + 2 deaths
    // + 2 hit reactions (crouch + battle).
    this._loadTotal = 1 + 4 + 5 + 1 + 1 + 2 + 2;
  }

  // ── Public getters / setters ─────────────────────────────────────────
  get root()     { return this._root; }
  get position() { return this._root.position; }
  set position(v) {
    if (!v) return;
    this._root.position.set(v.x ?? 0, 0, v.z ?? 0);
  }
  get facing()   { return this._facing; }
  set facing(rad) {
    this._facing = rad;
    // Apply rotation directly to the FBX root once it's loaded — avoids any
    // composition with a Group's rotation (which can double up if the FBX
    // file itself has a baked-in rotation). Pre-load the value is just
    // queued; we apply it the moment the FBX arrives.
    if (this._fbx) this._fbx.rotation.y = rad + MESH_FACING_OFFSET;
  }
  get battleMode()   { return this._battle; }
  set battleMode(v)  { this._battle = !!v; }
  get isHacking()    { return this._hacking; }
  get loaded()       { return this._loaded; }
  get loadProgress() { return this._loadCount / this._loadTotal; }

  // World-space step direction (per frame, post-collision). The rig stores
  // these and projects onto its own facing every update().
  setMovement(wx, wz) {
    this._wx = wx;
    this._wz = wz;
  }

  // One-shot hack play-through. Returns true if started, false if already
  // hacking or hack clip not yet loaded. setMovement(non-zero) interrupts.
  triggerHack() {
    if (this._hacking) return false;
    const a = this._actions.hack;
    if (!a) return false;
    this._hacking = true;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.reset();
    a.setEffectiveWeight(0);   // hackBlend ramps this up
    a.play();
    return true;
  }

  // Brief shooting recoil — plays as an ADDITIVE overlay on top of whatever
  // the locomotion bundle is doing, so the character can shoot while moving
  // or idle without the legs freezing. Returns false if already mid-recoil
  // or the clip isn't loaded yet.
  triggerRecoil() {
    if (this._recoiling || this._dying) return false;
    const a = this._actions.recoil;
    if (!a) return false;
    this._recoiling = true;
    a.setLoop(THREE.LoopOnce, 1);
    // clampWhenFinished = true keeps the additive pose alive at the end of
    // the clip; combined with recoilBlend ramping back to 0 in update(),
    // the overlay smoothly fades into the underlying pose instead of
    // snapping (the action would otherwise reset to frame 0 immediately).
    a.clampWhenFinished = true;
    a.reset();
    a.setEffectiveWeight(0);           // recoilBlend ramps this up
    a.play();
    return true;
  }

  // Hit reaction — additive overlay played when the player takes damage.
  // Auto-picks the variant matching the current battle/stealth pose so the
  // reaction blends correctly with the underlying body state. Returns
  // false if already mid-hit, dying, or the matching clip isn't loaded.
  triggerHit() {
    if (this._hitting || this._dying) return false;
    const slot = this._battle ? 'hitBattle' : 'hitCrouch';
    const a = this._actions[slot];
    if (!a) return false;
    this._hitting = true;
    this._hitSlot = slot;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;        // hold final pose; weight ramps down
    a.reset();
    a.setEffectiveWeight(0);           // hitBlend ramps this up
    a.play();
    return true;
  }

  // Death — plays a one-shot full-body fall. Locks the rig out of every
  // other animation; recovery requires reset() (not exposed yet, easy to
  // add when respawn flow exists).
  //   direction = 'back'  → Falling Back Death
  //   direction = 'front' → Falling Forward Death
  triggerDeath(direction = 'back') {
    if (this._dying) return false;
    const slot = (direction === 'front') ? 'deathFront' : 'deathBack';
    const a = this._actions[slot];
    if (!a) return false;
    this._dying = true;
    this._deathSlot = slot;
    // Cancel any other one-shots that might still be ramping.
    this._hacking   = false;
    this._recoiling = false;
    this._hitting   = false;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;        // hold the final pose
    a.reset();
    a.setEffectiveWeight(0);           // deathBlend ramps this up
    a.play();
    return true;
  }

  // Clear the death state (e.g. on respawn). Does not auto-play idle —
  // weights resume normally as soon as deathBlend ramps back to 0.
  resetDeath() {
    this._dying = false;
    this._deathSlot = null;
    if (this._actions.deathBack)  this._actions.deathBack.stop();
    if (this._actions.deathFront) this._actions.deathFront.stop();
  }

  // ── Loading ─────────────────────────────────────────────────────────
  // Returns a Promise that resolves once every clip has finished loading.
  // Safe to call multiple times — subsequent calls return the same promise.
  load() {
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = new Promise((resolve, reject) => {
      const onFail = (err, file) => {
        console.error(`CharacterRig: failed to load ${file}`, err);
      };
      const oneDone = () => {
        this._loadCount++;
        if (this._loadCount >= this._loadTotal) {
          this._primeLocomotion();
          this._loaded = true;
          resolve();
        }
      };

      const sourceLoader = new FBXLoader();
      sourceLoader.load(
        ASSET_DIR + ANIM_FILES.source,
        (fbx) => {
          fbx.scale.setScalar(FBX_SCALE);
          fbx.position.set(0, 0, 0);
          // Apply current facing directly to the FBX root. Setting rotation
          // here (and in the facing setter) means we OVERWRITE any rotation
          // the FBX file had baked in — same behaviour as the original
          // inline debug-level which set character.rotation.y directly.
          fbx.rotation.set(0, this._facing + MESH_FACING_OFFSET, 0);
          fbx.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow    = true;
            child.receiveShadow = true;
            const fixMat = (m) => {
              if (m.map) {
                m.map.colorSpace = THREE.SRGBColorSpace;
                m.map.anisotropy = 4;
              }
              m.metalness = 0.05;
              m.roughness = 0.85;
              if (m.color && m.map) m.color.set(0xffffff);
              m.needsUpdate = true;
            };
            if (Array.isArray(child.material)) child.material.forEach(fixMat);
            else if (child.material)            fixMat(child.material);
          });
          this._root.add(fbx);
          this._fbx = fbx;     // facing setter targets this from now on

          this._mixer = new THREE.AnimationMixer(fbx);
          this._mixer.addEventListener('finished', (e) => {
            if (this._actions.hack && e.action === this._actions.hack) {
              this._hacking = false;
            }
            if (this._actions.recoil && e.action === this._actions.recoil) {
              this._recoiling = false;
            }
            const hitAction = this._hitSlot ? this._actions[this._hitSlot] : null;
            if (hitAction && e.action === hitAction) {
              this._hitting = false;
            }
            // Death actions clamp at the final pose; we don't reset
            // _dying here. Caller invokes resetDeath() on respawn.
          });

          // Source FBX's first clip = stealth idle.
          const sourceClip = fbx.animations?.[0];
          if (sourceClip) this._attach('stealth.idle', sourceClip);

          oneDone();

          // Now load all the other clips in parallel.
          const queue = [];
          for (const dir of ['forward', 'back', 'left', 'right']) {
            queue.push({ slot: `stealth.${dir}`, file: ANIM_FILES.stealth[dir] });
          }
          for (const dir of ['idle', 'forward', 'back', 'left', 'right']) {
            queue.push({ slot: `battle.${dir}`, file: ANIM_FILES.battle[dir] });
          }
          queue.push({ slot: 'hack',       file: ANIM_FILES.hack });
          queue.push({ slot: 'recoil',     file: ANIM_FILES.recoil });
          queue.push({ slot: 'hitCrouch',  file: ANIM_FILES.hitCrouch });
          queue.push({ slot: 'hitBattle',  file: ANIM_FILES.hitBattle });
          queue.push({ slot: 'deathBack',  file: ANIM_FILES.deathBack });
          queue.push({ slot: 'deathFront', file: ANIM_FILES.deathFront });

          for (const job of queue) {
            const ld = new FBXLoader();
            ld.load(
              ASSET_DIR + job.file,
              (animFbx) => {
                this._attach(job.slot, animFbx.animations?.[0]);
                oneDone();
              },
              undefined,
              (err) => { onFail(err, job.file); oneDone(); },
            );
          }
        },
        undefined,
        (err) => { onFail(err, ANIM_FILES.source); reject(err); },
      );
    });
    return this._loadingPromise;
  }

  // ── Per-tick driver ─────────────────────────────────────────────────
  update(dt) {
    if (!this._mixer) return;

    // Movement aborts a hack play-through. Death does not get aborted.
    const moving = (this._wx * this._wx + this._wz * this._wz) > 1e-6;
    if (this._hacking && moving) this._hacking = false;

    // Ramp the high-level scalars toward their input targets. Death wins
    // outright — once dying, every other blend is forced down.
    const dying      = this._dying;
    const targetMove = (!dying && moving && !this._hacking) ? 1 : 0;
    const targetHack = (!dying && this._hacking) ? 1 : 0;
    const targetMode = this._battle ? 1 : 0;
    const targetRecoil = this._recoiling ? 1 : 0;
    const targetHit    = this._hitting ? 1 : 0;
    const targetDeath  = dying ? 1 : 0;
    const stepFast = Math.min(1, dt * BLEND_RATE);
    const stepSlow = Math.min(1, dt * MODE_BLEND_RATE);
    this._moveBlend   += (targetMove   - this._moveBlend)   * stepFast;
    this._hackBlend   += (targetHack   - this._hackBlend)   * stepFast;
    this._modeBlend   += (targetMode   - this._modeBlend)   * stepSlow;
    this._recoilBlend += (targetRecoil - this._recoilBlend) * stepFast;
    this._hitBlend    += (targetHit    - this._hitBlend)    * stepFast;
    this._deathBlend  += (targetDeath  - this._deathBlend)  * stepFast;

    // Project world movement onto the character's local axes and SMOOTH
    // the four directional weights:
    //   forward = (sin θ, cos θ)
    //   right   = forward × up = (-cos θ, sin θ)
    //
    // While moving, the targets come from the input projection. While NOT
    // moving, the targets are simply the current smoothed values (i.e. no
    // change) — combined with moveBlend ramping to 0, that lets the active
    // stride pose fade smoothly into idle instead of snapping.
    let targetFw = this._smoothFw;
    let targetBw = this._smoothBw;
    let targetLw = this._smoothLw;
    let targetRw = this._smoothRw;
    if (moving) {
      const θ  = this._facing;
      const fx =  Math.sin(θ);
      const fz =  Math.cos(θ);
      const rx = -Math.cos(θ);
      const rz =  Math.sin(θ);
      const fwdC = this._wx * fx + this._wz * fz;
      const rgtC = this._wx * rx + this._wz * rz;
      targetFw = Math.max(0,  fwdC);
      targetBw = Math.max(0, -fwdC);
      targetRw = Math.max(0,  rgtC);
      targetLw = Math.max(0, -rgtC);
      const sum = targetFw + targetBw + targetLw + targetRw;
      if (sum > 0) {
        targetFw /= sum; targetBw /= sum;
        targetLw /= sum; targetRw /= sum;
      }
    }
    this._smoothFw += (targetFw - this._smoothFw) * stepFast;
    this._smoothBw += (targetBw - this._smoothBw) * stepFast;
    this._smoothLw += (targetLw - this._smoothLw) * stepFast;
    this._smoothRw += (targetRw - this._smoothRw) * stepFast;
    const fw = this._smoothFw;
    const bw = this._smoothBw;
    const lw = this._smoothLw;
    const rw = this._smoothRw;

    // Compose final weights:
    //   • death pulls weight off the very top — dominates everything else.
    //   • hack pulls next.
    //   • The remainder splits between the two MODE bundles by modeBlend.
    //   • Inside each bundle, idle vs. moving splits by moveBlend, and the
    //     directional weights share the moving slice.
    //   • Recoil is ADDITIVE — its weight is independent (added on top of
    //     the base pose by the mixer's additive blend mode).
    const w         = this._weights;
    const nonDeath  = 1 - this._deathBlend;
    const nonHack   = (1 - this._hackBlend) * nonDeath;
    const sMul      = (1 - this._modeBlend) * nonHack;
    const bMul      = this._modeBlend       * nonHack;
    const moveS     = this._moveBlend       * sMul;
    const idleS     = (1 - this._moveBlend) * sMul;
    const moveB     = this._moveBlend       * bMul;
    const idleB     = (1 - this._moveBlend) * bMul;
    w.hack            = this._hackBlend * nonDeath;
    w.stealth.idle    = idleS;
    w.stealth.forward = fw * moveS;
    w.stealth.back    = bw * moveS;
    w.stealth.left    = lw * moveS;
    w.stealth.right   = rw * moveS;
    w.battle.idle     = idleB;
    w.battle.forward  = fw * moveB;
    w.battle.back     = bw * moveB;
    w.battle.left     = lw * moveB;
    w.battle.right    = rw * moveB;
    // Additive overlays ride on top regardless of mode. Suppressed during death.
    w.recoil          = this._recoilBlend * nonDeath;
    // Only the matching hit slot gets weight (crouch vs battle).
    w.hitCrouch       = (this._hitSlot === 'hitCrouch') ? this._hitBlend * nonDeath : 0;
    w.hitBattle       = (this._hitSlot === 'hitBattle') ? this._hitBlend * nonDeath : 0;
    // Only the active death slot gets weight; the other stays at 0.
    w.deathBack       = (this._deathSlot === 'deathBack')  ? this._deathBlend : 0;
    w.deathFront      = (this._deathSlot === 'deathFront') ? this._deathBlend : 0;

    this._applyWeights();

    // Phase-sync every strider to the master (stealth.forward) by relative
    // PHASE (time / clip.duration), not absolute time. If we copied the
    // absolute time and a clip's duration didn't match the master's exactly
    // (Mixamo clips drift by a frame or two), the forced time would hit the
    // wrong point in the wrap cycle and produce a visible jump every loop.
    // With proportional sync the wrap points align in phase space and the
    // per-clip absolute time stays inside its own range.
    const ref = this._actions.stealth.forward;
    if (ref) {
      const refClip = ref.getClip();
      const refDur  = refClip ? refClip.duration : 0;
      if (refDur > 0) {
        const phase = ref.time / refDur;
        const a = this._actions;
        const setPhase = (act) => {
          if (!act) return;
          const c = act.getClip();
          if (c && c.duration > 0) act.time = phase * c.duration;
        };
        setPhase(a.stealth.back);
        setPhase(a.stealth.left);
        setPhase(a.stealth.right);
        setPhase(a.battle.forward);
        setPhase(a.battle.back);
        setPhase(a.battle.left);
        setPhase(a.battle.right);
      }
    }

    this._mixer.update(dt);
  }

  // ── Internals ────────────────────────────────────────────────────────
  _attach(slot, clip) {
    if (!clip || !this._mixer) return null;
    clip.name = slot;
    // Additive clips: their pose is interpreted as a DELTA from frame 0
    // and the mixer adds that delta onto whatever else is playing. This
    // is what lets the character fire / take a hit while still walking
    // or strafing underneath.
    const isAdditive = (slot === 'recoil' || slot === 'hitCrouch' || slot === 'hitBattle');
    if (isAdditive) {
      THREE.AnimationUtils.makeClipAdditive(clip);
    }
    const action = this._mixer.clipAction(clip);
    if (slot === 'hack' || slot === 'recoil' ||
        slot === 'hitCrouch' || slot === 'hitBattle' ||
        slot === 'deathBack' || slot === 'deathFront') {
      this._actions[slot] = action;
      if (isAdditive) action.blendMode = THREE.AdditiveAnimationBlendMode;
    } else {
      const [bundle, name] = slot.split('.');
      this._actions[bundle][name] = action;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(0);
      action.play();
    }
    return action;
  }

  // Run once after the last clip finishes loading: timeScale + initial
  // weights + cross-bundle phase sync.
  _primeLocomotion() {
    const speedRatio = CLIP_SPEED > 0 ? (this.moveSpeed / CLIP_SPEED) : 1;
    const setupBundle = (set) => {
      for (const name of ['idle', 'forward', 'back', 'left', 'right']) {
        const a = set[name];
        if (!a) continue;
        a.enabled = true;
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.setEffectiveWeight(0);
        a.timeScale = (name === 'idle') ? 1 : speedRatio;
        if (!a.isRunning()) a.play();
      }
    };
    setupBundle(this._actions.stealth);
    setupBundle(this._actions.battle);
    if (this._actions.stealth.idle) this._actions.stealth.idle.setEffectiveWeight(1);

    // syncWith only copies time + timeScale ONCE — the per-frame sync in
    // update() is what actually keeps phases locked over time. This call
    // just bootstraps the relationship.
    const ref = this._actions.stealth.forward;
    if (ref) {
      for (const name of ['back', 'left', 'right']) {
        const a = this._actions.stealth[name];
        if (a) a.syncWith(ref);
      }
      for (const name of ['forward', 'back', 'left', 'right']) {
        const a = this._actions.battle[name];
        if (a) a.syncWith(ref);
      }
    }
  }

  _applyWeights() {
    const w = this._weights;
    const a = this._actions;
    if (a.stealth.idle)    a.stealth.idle.setEffectiveWeight(w.stealth.idle);
    if (a.stealth.forward) a.stealth.forward.setEffectiveWeight(w.stealth.forward);
    if (a.stealth.back)    a.stealth.back.setEffectiveWeight(w.stealth.back);
    if (a.stealth.left)    a.stealth.left.setEffectiveWeight(w.stealth.left);
    if (a.stealth.right)   a.stealth.right.setEffectiveWeight(w.stealth.right);
    if (a.battle.idle)     a.battle.idle.setEffectiveWeight(w.battle.idle);
    if (a.battle.forward)  a.battle.forward.setEffectiveWeight(w.battle.forward);
    if (a.battle.back)     a.battle.back.setEffectiveWeight(w.battle.back);
    if (a.battle.left)     a.battle.left.setEffectiveWeight(w.battle.left);
    if (a.battle.right)    a.battle.right.setEffectiveWeight(w.battle.right);
    if (a.hack)            a.hack.setEffectiveWeight(w.hack);
    if (a.recoil)          a.recoil.setEffectiveWeight(w.recoil);
    if (a.hitCrouch)       a.hitCrouch.setEffectiveWeight(w.hitCrouch);
    if (a.hitBattle)       a.hitBattle.setEffectiveWeight(w.hitBattle);
    if (a.deathBack)       a.deathBack.setEffectiveWeight(w.deathBack);
    if (a.deathFront)      a.deathFront.setEffectiveWeight(w.deathFront);
  }
}
