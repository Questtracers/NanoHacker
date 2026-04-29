import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// MechaRig — owns the rocket-mecha skinned mesh + AnimationMixer + a dual-
// bundle locomotion blend tree (normal patrol + battle / aggressive
// stance), the same architecture as SoldierRig and CharacterRig.
//
// Public surface:
//   const rig = new MechaRig(scene);
//   rig.load();
//   rig.position   = { x, z };
//   rig.facing     = radians;
//   rig.battleMode = true / false;     // ramps modeBlend → swap bundles
//   rig.setMovement(wx, wz);           // world-space step direction
//   rig.update(dt);

const ASSET_DIR = 'Assets/Mecha_Rocket/';

const ANIM_FILES = {
  // Skinned source — provides rig + textures + the normal idle clip.
  source:     'Rocket Mecha Idle.fbx',
  idle:       'Rocket Mecha Idle.fbx',
  battleIdle: 'Rocket Mecha Battle Idle.fbx',
  // One-shots: hit is an additive overlay (rides on top of the running
  // locomotion / idle pose, so the mecha can react while moving), death
  // is a full-body dominant clip that suppresses everything else.
  hit:        'Rocket Mecha Battle Hit.fbx',
  death:      'Rocket Mecha Death.fbx',
  // Cannon: the clip is a "lower the cannon" animation — frame 0 = aim
  // pose, end = lowered. We play it REVERSED so it reads as raising into
  // aim, and hold at t = 0 where the aim pose actually lives. Recoil
  // pumps from a small time offset back down to t = 0.
  cannon:     'Rocket Mecha Cannon reverse.fbx',
  // Rocket arm: opposite layout — frame 0 = un-armed, end = armed pose.
  // Plays forward; held at t = duration.
  rocket:     'Rocket Mecha Arm Rocket.fbx',
  normal: {
    forward: 'Rocket Mecha Forward.fbx',
    back:    'Rocket Mecha Backwards.fbx',
    left:    'Rocket Mecha Left Strafe.fbx',
    right:   'Rocket Mecha Right Strafe.fbx',
  },
  battle: {
    forward: 'Rocket Mecha Battle Walk Forward.fbx',
    back:    'Rocket Mecha Battle Walk Back.fbx',
    left:    'Rocket Mecha Battle Walk Left.fbx',
    right:   'Rocket Mecha Battle Walk Right.fbx',
  },
};

const MESH_FACING_OFFSET = 0;
// Auto-scale target — the Rocket Mecha FBX is in cm units (~100 m native),
// so we measure the bbox on load and pick a scale that fits TARGET_HEIGHT.
const TARGET_HEIGHT      = 2.8;
// Authored leg-cycle speed of the strider clips, in m/s. Higher value =
// slower visible leg cycle relative to MOVE_SPEED (timeScale = MOVE / CLIP).
// Bumped from 1.4 → 2.4 so the feet match the body translation rate
// instead of running ahead of it.
const CLIP_SPEED         = 2.4;
const BLEND_RATE         = 8;     // 1/s — move ramp speed
const MODE_BLEND_RATE    = 4;     // 1/s — slower posture swap
// Additive hit overlay — values >1 amplify the recoil delta on top of the
// underlying pose. Tuned to read well on the mecha's heavy frame.
const HIT_INTENSITY      = 1.6;
// Arm overlays (cannon + rocket). NOT additive — the clips have their
// leg/foot/hip tracks stripped, and they play as normal-blend at high
// effective weight. Combined with stripping Spine* tracks from every
// locomotion clip (so the torso is ONLY ever written by cannon/rocket),
// the held aim pose stays anchored regardless of which loco direction
// is feeding the legs. Live-tunable via U/J in debug.
const ARM_INTENSITY      = 40.0;
// Cannon raise rate — how fast the reverse-played raise runs (|timeScale|).
// 1.0 = native reverse speed, >1 = quicker.
const CANNON_RAISE_RATE    = 2.0;
// Recoil defaults (shared between cannon + rocket via the live tunables).
// 0.25 ≈ slow & weighty pump; 2 frames at 30 fps ≈ a tiny rewind window.
const CANNON_RECOIL_OFFSET = 2 / 30;
const CANNON_RECOIL_RATE   = 0.25;

// Rocket-arm clip — same mechanic as cannon but played FORWARD. Held pose
// lives at t = duration; recoil rewinds a small window from the end and
// plays forward to duration.
const ROCKET_RAISE_RATE    = 2.0;
// Extra master-clock multiplier applied while the normal bundle is in a
// back+strafe diagonal blend. The back clip's authored step length is
// shorter than the strafes', so the blended footfall reads as half-a-step
// slow. Pure-back and pure-strafe look fine because each runs one full
// cycle per master loop; only the diagonal blend needs a kick. Battle's
// clips don't have this mismatch, so the boost is gated to normal mode.
const DIAGONAL_BACK_BOOST = 0.40;

// Scratch quaternions / matrices for the post-mixer Spine counter-rotation.
// Reused every frame to avoid per-tick allocations.
const _tmpQ1 = new THREE.Quaternion();
const _tmpQ2 = new THREE.Quaternion();
const _tmpQ3 = new THREE.Quaternion();
const _tmpQ4 = new THREE.Quaternion();
const _tmpQ5 = new THREE.Quaternion();
const _Y_AXIS = new THREE.Vector3(0, 1, 0);

export class MechaRig {
  constructor(scene, options = {}) {
    this.scene     = scene;
    this.moveSpeed = options.moveSpeed ?? 2.0;

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
    this._hitting    = false;          // additive overlay during recoil
    this._dying      = false;          // full-body death dominant
    this._cannoning  = false;          // raising / holding cannon pose
    this._cannonHeld = false;          // true once raise reverse-clip arrives at t=0
    this._rocketing  = false;          // raising / holding rocket-arm pose
    this._rocketHeld = false;          // true once forward play arrives at t=duration
    // Disarm phase — set to 'cannon' or 'rocket' while the lowering/un-arming
    // animation is playing. While set, the post-mixer Spine anchor is
    // disabled so the body actually follows the cannon/rocket clip's
    // authored lowering pose instead of staying frozen in aim. Cleared
    // by the 'finished' listener.
    this._disarming  = null;

    this._actions = {
      idle:       null,
      battleIdle: null,
      hit:        null,                // additive overlay
      death:      null,                // full-body one-shot
      cannon:     null,                // full-body, played reversed
      rocket:     null,                // full-body, played forward
      normal:  { forward: null, back: null, left: null, right: null },
      battle:  { forward: null, back: null, left: null, right: null },
    };
    this._weights = {
      idle:       1,
      battleIdle: 0,
      hit:        0,
      death:      0,
      cannon:     0,
      rocket:     0,
      normal:  { forward: 0, back: 0, left: 0, right: 0 },
      battle:  { forward: 0, back: 0, left: 0, right: 0 },
    };
    this._moveBlend   = 0;
    this._modeBlend   = 0;    // 0 = normal, 1 = battle
    this._hitBlend    = 0;    // 0 = nothing, 1 = full hit overlay
    this._deathBlend  = 0;    // 0 = alive, 1 = death pose dominant
    this._cannonBlend = 0;    // 0 = nothing, 1 = full cannon-aim pose
    this._rocketBlend = 0;    // 0 = nothing, 1 = full rocket-arm pose
    // Live tunables — exposed so the debug level can scrub them at runtime.
    this.diagonalBackBoost = DIAGONAL_BACK_BOOST;
    // Shared recoil rate + offset for cannon + rocket pumps. Both
    // triggerCannon and triggerRocket read these at fire time, so live
    // tweaks in the debug level take effect on the very next press.
    // recoilOffset is in seconds; the debug HUD also surfaces it as
    // frames-at-30fps for animator-friendly tuning.
    this.recoilRate        = CANNON_RECOIL_RATE;
    this.recoilOffset      = CANNON_RECOIL_OFFSET;
    this.armIntensity      = ARM_INTENSITY;
    this._smoothFw  = 0;
    this._smoothBw  = 0;
    this._smoothLw  = 0;
    this._smoothRw  = 0;

    this._loadCount = 0;
    // source + battleIdle + 4 normal + 4 battle + hit + death + cannon + rocket.
    this._loadTotal = 1 + 1 + 4 + 4 + 1 + 1 + 1 + 1;

    this._canonicalPrefix = '';

    // Bone references + cached world rotation for the post-mixer Spine
    // counter-rotation. We grab the bones once after the source FBX loads
    // and capture the desired Spine WORLD quaternion the first time the
    // cannon or rocket reports a held aim. Each frame, while armed, we
    // solve the Spine LOCAL quaternion that reproduces that world target
    // given the current parent (Hips) world transform — this works even
    // if Spine isn't a direct child of Hips, and is robust to whatever
    // Hips happens to be doing for the walk.
    this._hipsBone        = null;
    this._spineBone       = null;
    // Captured spine rotation expressed RELATIVE TO THE FBX ROOT, not
    // world space. This is what keeps the torso following the body's
    // facing (Q/E rotation) while still anchoring against locomotion's
    // pelvis cycling. World-space anchoring would freeze the torso
    // pointing one direction even as the body rotated underneath it.
    this._spineFbxTarget   = null;
    // The mixer's 'finished' event fires DURING mixer.update(), before
    // the binding-apply step that actually writes bone.quaternion. So we
    // can't capture the held world rotation inside the listener — the
    // bone still holds the previous frame's value at that point. Set a
    // pending flag instead and do the capture after mixer.update() in
    // update(), when the bone has the freshly-applied held pose.
    this._pendingSpineCapture = false;
    // Diagnostics surfaced to the debug HUD so we can verify the post-
    // mixer compensation is actually running and producing a non-zero
    // change to spine.quaternion. Updated every frame in update().
    this._diag = {
      hipsName:        '',           // captured Hips bone name (or '')
      spineName:       '',           // captured Spine bone name (or '')
      spineParent:     '',           // name of Spine's parent bone
      targetCaptured:  false,        // is _spineFbxTarget set?
      armBlend:        0,            // max(cannonBlend, rocketBlend)
      adjustDeg:       0,            // angle (degrees) we slerped Spine by this frame
      hipsWorldDeg:    0,            // current Hips world rotation magnitude (degrees)
      compensated:     false,        // did the compensation block actually run?
      frame:           0,            // increments every update() call past the mixer guard
    };
    // Forced-test mode: when true, the post-mixer block slams spine.quaternion
    // to identity unconditionally. Used to verify the bone-reference and
    // modification path actually affect rendering, independent of the
    // cannon/rocket capture-and-solve logic. Toggled from the debug HUD.
    this.forceSpineIdentity = false;
    // Per-weapon spine-yaw offsets (radians) applied to the upper body
    // while the corresponding arm is held. Cannon and rocket clips
    // each plant the torso slightly off the bullet axis, so we steer
    // each one back independently — weighted by its blend value so a
    // mid-swap (e.g. snapRocketHeld during a cannon hold) interpolates
    // smoothly between the two offsets without popping.
    this._cannonUpperBodyYaw = 0;
    this._rocketUpperBodyYaw = 0;
  }

  get diagnostics() { return this._diag; }

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
    if (this._fbx) this._fbx.rotation.y = rad + MESH_FACING_OFFSET;
  }
  get battleMode()   { return this._battle; }
  set battleMode(v)  { this._battle = !!v; }
  get loaded()       { return this._loaded; }
  get loadProgress() { return this._loadCount / this._loadTotal; }

  setMovement(wx, wz) {
    this._wx = wx;
    this._wz = wz;
  }

  // Public — set the per-weapon spine-yaw offsets (radians). Each is
  // independently weighted by its own arm-blend in the post-mixer
  // spine block so a swap from cannon → rocket interpolates between
  // the two offsets instead of snapping. Pass either named arg to
  // update only that weapon.
  setShootingUpperBodyYaw({ cannon, rocket } = {}) {
    if (typeof cannon === 'number') this._cannonUpperBodyYaw = cannon;
    if (typeof rocket === 'number') this._rocketUpperBodyYaw = rocket;
  }
  getShootingUpperBodyYaw() {
    return { cannon: this._cannonUpperBodyYaw, rocket: this._rocketUpperBodyYaw };
  }

  get isHit()        { return this._hitting; }
  get isDying()      { return this._dying; }
  get isCannoning()  { return this._cannoning; }
  get isCannonHeld() { return this._cannonHeld; }
  get isRocketing()  { return this._rocketing; }
  get isRocketHeld() { return this._rocketHeld; }

  // Hit reaction — additive overlay played when the mecha takes damage.
  // Rides on top of whatever locomotion / idle pose is active so the body
  // can keep walking or strafing underneath. Re-triggers on every call:
  // resets to frame 0 even if a previous hit is still ramping out.
  triggerHit() {
    if (this._dying) return false;
    const a = this._actions.hit;
    if (!a) return false;
    this._hitting = true;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;        // hold final pose; weight ramps down
    a.reset();
    a.setEffectiveWeight(0);           // hitBlend ramps this up
    a.play();
    return true;
  }

  // Death — full-body one-shot. Dominates everything: hit, locomotion,
  // and idles all get scaled down by (1 - deathBlend) so the death pose
  // takes over cleanly. Caller invokes resetDeath() on respawn.
  triggerDeath() {
    if (this._dying) return false;
    const a = this._actions.death;
    if (!a) return false;
    this._dying = true;
    this._hitting = false;             // cancel any in-flight hit overlay
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.reset();
    a.setEffectiveWeight(0);           // deathBlend ramps this up
    a.play();
    return true;
  }

  resetDeath() {
    this._dying = false;
    if (this._actions.death) this._actions.death.stop();
  }

  // SPACE — first press: raise the cannon by playing the source clip
  // REVERSED (end → start). When it lands at t=0 the mecha holds the aim
  // pose. Subsequent presses while held: pump back to a small offset and
  // snap to t=0 again at CANNON_RECOIL_RATE — reads as a fire/recoil.
  // Movement aborts the whole stance (handled in update()).
  triggerCannon() {
    if (this._dying) return false;
    const a = this._actions.cannon;
    if (!a) return false;
    const clip = a.getClip();
    const duration = clip ? clip.duration : 0;
    if (duration <= 0) return false;

    if (!this._cannoning) {
      // Cannon and rocket are mutually exclusive — arming one disarms the
      // other. The rocket's blend ramps down via update() so the swap is
      // smooth instead of a hard cut.
      if (this._rocketing) this.resetRocket();
      // Stage 1 — raise into aim. The clip is authored as a "lower"
      // (frame 0 = aim, end = lowered), so we play it REVERSED: start
      // at t=duration, run timeScale<0 down to t=0 where the aim pose
      // lives. clampWhenFinished holds at t=0 once 'finished' fires.
      this._cannoning  = true;
      this._cannonHeld = false;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.reset();
      a.time      = duration;
      a.timeScale = -CANNON_RAISE_RATE;
      a.paused    = false;
      a.setEffectiveWeight(0);   // cannonBlend ramps this up
      a.play();
    } else if (this._cannonHeld) {
      // Stage 2 — recoil pump. Jump a hair INTO the clip (away from the
      // held t=0 aim pose) and snap back to 0 at the recoil rate.
      a.paused    = false;
      a.time      = Math.min(duration, this.recoilOffset);
      a.timeScale = -this.recoilRate;
      this._cannonHeld = false;  // re-armed when this pump 'finished'
      a.play();
    }
    return true;
  }

  // Drop out of the cannon stance (e.g. on respawn or external cancel).
  resetCannon() {
    this._cannoning  = false;
    this._cannonHeld = false;
    if (this._actions.cannon) this._actions.cannon.stop();
    if (!this._rocketing) this._spineFbxTarget = null;
  }

  // R — first press: arm the rocket by playing the source clip FORWARD
  // (start → end). When it lands at t=duration the mecha holds the armed
  // pose. Subsequent presses while held: pump back a hair from the end
  // and snap forward at ROCKET_RECOIL_RATE — reads as a fire/recoil.
  // Movement aborts the stance (handled in update()).
  triggerRocket() {
    if (this._dying) return false;
    const a = this._actions.rocket;
    if (!a) return false;
    const clip = a.getClip();
    const duration = clip ? clip.duration : 0;
    if (duration <= 0) return false;

    if (!this._rocketing) {
      // Mutually exclusive with cannon (see triggerCannon for the rationale).
      if (this._cannoning) this.resetCannon();
      this._rocketing  = true;
      this._rocketHeld = false;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.reset();
      a.time      = 0;
      a.timeScale = ROCKET_RAISE_RATE;
      a.paused    = false;
      a.setEffectiveWeight(0);   // rocketBlend ramps this up
      a.play();
    } else if (this._rocketHeld) {
      a.paused    = false;
      a.time      = Math.max(0, duration - this.recoilOffset);
      a.timeScale = this.recoilRate;
      this._rocketHeld = false;
      a.play();
    }
    return true;
  }

  resetRocket() {
    this._rocketing  = false;
    this._rocketHeld = false;
    if (this._actions.rocket) this._actions.rocket.stop();
    if (!this._cannoning) this._spineFbxTarget = null;
  }

  // ── Possessed-mode entry points ─────────────────────────────────────
  // The player firing should not show the raise animation — the cannon
  // appears already-held the instant the first shot leaves. snapCannonHeld
  // jumps to the held pose silently (no raise), and the caller follows up
  // with triggerCannon() to play the recoil pump for the actual shot.
  snapCannonHeld() {
    if (this._dying) return false;
    const a = this._actions.cannon;
    if (!a) return false;
    if (this._rocketing) this.resetRocket();
    this._cannoning  = true;
    this._cannonHeld = true;
    this._disarming  = null;
    this._spineFbxTarget = null;
    this._pendingSpineCapture = true;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.reset();
    a.time      = 0;
    a.timeScale = 1;
    a.paused    = true;          // freeze at held aim pose
    a.setEffectiveWeight(0);     // cannonBlend ramps this up
    a.play();
    return true;
  }

  snapRocketHeld() {
    if (this._dying) return false;
    const a = this._actions.rocket;
    if (!a) return false;
    const clip = a.getClip();
    const dur = clip ? clip.duration : 0;
    if (dur <= 0) return false;
    if (this._cannoning) this.resetCannon();
    this._rocketing  = true;
    this._rocketHeld = true;
    this._disarming  = null;
    this._spineFbxTarget = null;
    this._pendingSpineCapture = true;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.reset();
    a.time      = dur;
    a.timeScale = 1;
    a.paused    = true;
    a.setEffectiveWeight(0);
    a.play();
    return true;
  }

  // ── Smooth disarm (reverses the raise) ──────────────────────────────
  // Cannon: held pose lives at t=0 (reversed playback); to lower we play
  // FORWARD from 0 → duration. Rocket: held at t=duration; to un-arm we
  // play REVERSED from duration → 0. _disarming flag suppresses the
  // post-mixer Spine anchor for the duration of the lowering so the
  // animated lowering pose is actually visible.
  disarmCannon() {
    if (!this._cannoning || this._disarming) return false;
    const a = this._actions.cannon;
    if (!a) return false;
    this._cannonHeld = false;
    this._disarming  = 'cannon';
    a.paused = false;
    a.time      = 0;
    a.timeScale = CANNON_RAISE_RATE;     // forward, same speed as raise
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = false;         // let the action stop at the end
    a.play();
    return true;
  }

  disarmRocket() {
    if (!this._rocketing || this._disarming) return false;
    const a = this._actions.rocket;
    if (!a) return false;
    const clip = a.getClip();
    const dur = clip ? clip.duration : 0;
    if (dur <= 0) return false;
    this._rocketHeld = false;
    this._disarming  = 'rocket';
    a.paused = false;
    a.time      = dur;
    a.timeScale = -ROCKET_RAISE_RATE;    // reversed, same speed as arm-up
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = false;
    a.play();
    return true;
  }

  // ── Loading ─────────────────────────────────────────────────────────
  load() {
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = new Promise((resolve, reject) => {
      const onFail = (err, file) =>
        console.error(`MechaRig: failed to load ${file}`, err);
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
          // Auto-scale: measure native bbox, fit height to TARGET_HEIGHT.
          fbx.scale.setScalar(1);
          fbx.position.set(0, 0, 0);
          fbx.rotation.set(0, 0, 0);
          const box = new THREE.Box3().setFromObject(fbx);
          const size = box.getSize(new THREE.Vector3());
          const autoScale = (size.y > 0.01) ? TARGET_HEIGHT / size.y : 1;
          console.log(
            `MechaRig: native bbox = ${size.x.toFixed(2)} × ` +
            `${size.y.toFixed(2)} × ${size.z.toFixed(2)} m → ` +
            `auto-scale ${autoScale.toFixed(4)} (target ${TARGET_HEIGHT} m)`,
          );
          fbx.scale.setScalar(autoScale);
          fbx.rotation.y = this._facing + MESH_FACING_OFFSET;

          fbx.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow    = true;
            child.receiveShadow = true;
            const fixMat = (m) => {
              if (m.map) {
                m.map.colorSpace = THREE.SRGBColorSpace;
                m.map.anisotropy = 4;
              }
              m.metalness = 0.15;
              m.roughness = 0.7;
              if (m.color && m.map) m.color.set(0xffffff);
              m.needsUpdate = true;
            };
            if (Array.isArray(child.material)) child.material.forEach(fixMat);
            else if (child.material)            fixMat(child.material);
          });
          this._root.add(fbx);
          this._fbx = fbx;
          this._captureUpperBodyBones(fbx);
          this._mixer = new THREE.AnimationMixer(fbx);
          this._mixer.addEventListener('finished', (e) => {
            if (this._actions.hit && e.action === this._actions.hit) {
              this._hitting = false;
            }
            // Disarm completion — finalize the cannon/rocket state so
            // the locomotion bundle takes back over via cannonBlend → 0.
            if (this._disarming === 'cannon' &&
                this._actions.cannon && e.action === this._actions.cannon) {
              this._disarming  = null;
              this._cannoning  = false;
              this._cannonHeld = false;
              this._spineFbxTarget = null;
              this._pendingSpineCapture = false;
              this._actions.cannon.stop();
            } else if (this._disarming === 'rocket' &&
                this._actions.rocket && e.action === this._actions.rocket) {
              this._disarming  = null;
              this._rocketing  = false;
              this._rocketHeld = false;
              this._spineFbxTarget = null;
              this._pendingSpineCapture = false;
              this._actions.rocket.stop();
            }
            // Cannon: after the reverse-raise (or recoil pump) completes,
            // arrive at the held aim pose. clampWhenFinished keeps time
            // pinned at 0; setting paused = true also stops mixer ticks
            // from bumping it. We only flag held when the rig is still
            // cannoning (movement may have aborted the stance mid-flight).
            if (this._actions.cannon && e.action === this._actions.cannon) {
              if (this._cannoning) {
                // Cannon plays reversed; held aim pose is at t=0.
                this._cannonHeld = true;
                this._actions.cannon.paused = true;
                this._actions.cannon.time = 0;
                // Capture ONLY on the first hold of this arming session.
                // The recoil pump also fires 'finished' (snap-back to
                // t=0), but if we re-captured then, locomotion's walk-
                // phase contribution to Spine would be different from
                // the initial capture and the anchor target would shift
                // a few degrees — the torso would visibly jump on every
                // recoil tap. resetCannon clears the target so a fresh
                // arm-up next time picks up the new direction.
                if (!this._spineFbxTarget) this._pendingSpineCapture = true;
              }
            }
            // Rocket: same idea but the held pose is at t = duration.
            if (this._actions.rocket && e.action === this._actions.rocket) {
              if (this._rocketing) {
                const c = this._actions.rocket.getClip();
                const dur = c ? c.duration : 0;
                this._rocketHeld = true;
                this._actions.rocket.paused = true;
                this._actions.rocket.time = dur;
                if (!this._spineFbxTarget) this._pendingSpineCapture = true;
              }
            }
            // Death clamps at the final pose; we don't reset _dying here.
          });

          const sourceClip = fbx.animations?.[0];
          this._canonicalPrefix = this._detectPrefix(sourceClip);
          if (sourceClip) this._attach('idle', sourceClip);

          oneDone();

          // Load battle idle + both locomotion bundles in parallel.
          const queue = [];
          queue.push({ slot: 'battleIdle', file: ANIM_FILES.battleIdle });
          queue.push({ slot: 'hit',        file: ANIM_FILES.hit });
          queue.push({ slot: 'death',      file: ANIM_FILES.death });
          queue.push({ slot: 'cannon',     file: ANIM_FILES.cannon });
          queue.push({ slot: 'rocket',     file: ANIM_FILES.rocket });
          for (const dir of ['forward', 'back', 'left', 'right']) {
            queue.push({ slot: `normal.${dir}`, file: ANIM_FILES.normal[dir] });
            queue.push({ slot: `battle.${dir}`, file: ANIM_FILES.battle[dir] });
          }
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

    const moving = (this._wx * this._wx + this._wz * this._wz) > 1e-6;
    const dying  = this._dying;
    // Cannon and rocket are now ADDITIVE overlays — they ride on top of
    // locomotion instead of replacing it, so movement no longer aborts
    // them. Walk while aimed; fire while strafing; both work fine.
    const targetMove   = moving ? 1 : 0;
    const targetMode   = this._battle ? 1 : 0;
    const targetHit    = this._hitting ? 1 : 0;
    const targetDeath  = dying ? 1 : 0;
    const targetCannon = (this._cannoning && !dying) ? 1 : 0;
    const targetRocket = (this._rocketing && !dying) ? 1 : 0;
    const stepFast = Math.min(1, dt * BLEND_RATE);
    const stepSlow = Math.min(1, dt * MODE_BLEND_RATE);
    this._moveBlend   += (targetMove   - this._moveBlend)   * stepFast;
    this._modeBlend   += (targetMode   - this._modeBlend)   * stepSlow;
    this._hitBlend    += (targetHit    - this._hitBlend)    * stepFast;
    this._deathBlend  += (targetDeath  - this._deathBlend)  * stepFast;
    this._cannonBlend += (targetCannon - this._cannonBlend) * stepFast;
    this._rocketBlend += (targetRocket - this._rocketBlend) * stepFast;

    // Project world movement onto the mecha's local axes and SMOOTH the
    // four directional weights.
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

    // Compose weights — death pulls weight off the very top (everything
    // gets scaled by nonDeath). Inside that, locomotion splits between the
    // two mode bundles by modeBlend, and within each bundle the directional
    // weights share the moving slice. Idle is a per-mode pair. Hit is an
    // ADDITIVE overlay so its weight is independent of the bundle split,
    // it just rides on top of whatever pose is below.
    // Death pulls weight off the locomotion stack outright. Cannon and
    // rocket are additive overlays now, so they DON'T multiply against
    // locomotion — they layer on top. nonDeath is the only dominant factor.
    const nonDeath  = 1 - this._deathBlend;
    const nMul   = (1 - this._modeBlend) * nonDeath;
    const bMul   = this._modeBlend       * nonDeath;
    const moveN  = this._moveBlend * nMul;
    const moveB  = this._moveBlend * bMul;
    const idleN  = (1 - this._moveBlend) * nMul;
    const idleB  = (1 - this._moveBlend) * bMul;
    const fw = this._smoothFw, bw = this._smoothBw,
          lw = this._smoothLw, rw = this._smoothRw;

    const w = this._weights;
    w.idle           = idleN;
    w.battleIdle     = idleB;
    w.normal.forward = fw * moveN;
    w.normal.back    = bw * moveN;
    w.normal.left    = lw * moveN;
    w.normal.right   = rw * moveN;
    w.battle.forward = fw * moveB;
    w.battle.back    = bw * moveB;
    w.battle.left    = lw * moveB;
    w.battle.right   = rw * moveB;
    // Additive hit overlay — suppressed during death, amplified by the
    // intensity constant for visual punch on the heavy mecha frame.
    w.hit            = this._hitBlend * nonDeath * HIT_INTENSITY;
    w.death          = this._deathBlend;
    w.cannon         = this._cannonBlend * nonDeath * this.armIntensity;
    w.rocket         = this._rocketBlend * nonDeath * this.armIntensity;

    this._applyWeights();

    // Diagonal-back boost on the master clock. Active only while the normal
    // bundle is in a back+strafe blend. Because every locomotion clip is
    // phase-synced to normal.forward, bumping the master's timeScale speeds
    // up the entire phase advance — back, left, and right all accelerate
    // TOGETHER, so their feet stay aligned. Clips at weight 0 are invisible
    // so it doesn't matter that forward also "speeds up" while it's silent.
    const diagBack = 4 * this._smoothBw *
                     (this._smoothLw + this._smoothRw) *
                     (1 - this._modeBlend);
    const boost = 1 + this.diagonalBackBoost * Math.min(1, diagBack);
    const speedRatio = CLIP_SPEED > 0 ? (this.moveSpeed / CLIP_SPEED) : 1;
    if (this._actions.normal.forward) {
      this._actions.normal.forward.timeScale = speedRatio * boost;
    }

    // Phase-sync EVERY strider (in both bundles) to a single master
    // (normal.forward), proportional by clip duration. This keeps gait
    // coherence on diagonal blends — pressing W+D blends forward+right
    // and both clips land their feet at the same phase.
    //
    // CRITICAL: every locomotion clip MUST be in this list. If a clip is
    // left out, it free-runs via the mixer at its own timeScale, and even
    // though syncWith() was called once at prime time, clips with slightly
    // different durations drift in phase over time. The visible symptom is
    // "the same input combo looks fine for a while, then glitches, then
    // recovers" — purely a function of how far the omitted clip has drifted
    // from the master's phase wrap. Same bug we hit on CharacterRig; the
    // fix is the same — sync them all, proportional by duration.
    const ref = this._actions.normal.forward;
    if (ref) {
      const refClip = ref.getClip();
      const refDur  = refClip ? refClip.duration : 0;
      if (refDur > 0) {
        const phase = ref.time / refDur;
        const setPhase = (act) => {
          if (!act) return;
          const c = act.getClip();
          if (c && c.duration > 0) act.time = phase * c.duration;
        };
        setPhase(this._actions.normal.back);
        setPhase(this._actions.normal.left);
        setPhase(this._actions.normal.right);
        setPhase(this._actions.battle.forward);
        setPhase(this._actions.battle.back);
        setPhase(this._actions.battle.left);
        setPhase(this._actions.battle.right);
      }
    }

    this._mixer.update(dt);

    // Post-mixer Spine anchor. mixer.update() has just applied bindings,
    // so bone.quaternion now reflects this frame's authored values. Two
    // phases, both expressed in FBX-ROOT-LOCAL SPACE so the lock follows
    // the body's facing (Q/E) but ignores Hips gait cycling:
    //
    //   1. Pending capture — set inside the 'finished' listener. We
    //      snapshot Spine's rotation RELATIVE TO THE FBX ROOT
    //      (fbxWorld⁻¹ * spineWorld) at the moment of the held aim.
    //
    //   2. Per-frame anchor — while armed, build the desired Spine WORLD
    //      rotation as fbxWorld * target (so it follows facing), then
    //      solve the Spine LOCAL quaternion that produces it given the
    //      current parent (Hips + Armature). Slerp by armBlend.
    this._diag.frame = (this._diag.frame + 1) | 0;

    if (this._pendingSpineCapture && this._spineBone && this._fbx) {
      if (!this._spineFbxTarget) this._spineFbxTarget = new THREE.Quaternion();
      const fbxQ   = this._fbx.getWorldQuaternion(_tmpQ1);
      const spineQ = this._spineBone.getWorldQuaternion(_tmpQ2);
      this._spineFbxTarget.copy(fbxQ).invert().multiply(spineQ);
      this._pendingSpineCapture = false;
    }
    const armBlend = Math.max(this._cannonBlend, this._rocketBlend);
    this._diag.armBlend       = armBlend;
    this._diag.targetCaptured = !!this._spineFbxTarget;
    this._diag.compensated    = false;
    this._diag.adjustDeg      = 0;
    if (this._hipsBone) {
      const hq = this._hipsBone.getWorldQuaternion(_tmpQ4);
      const w = Math.min(1, Math.abs(hq.w));
      this._diag.hipsWorldDeg = 2 * Math.acos(w) * 180 / Math.PI;
    }
    // Forced-test path — slams spine.quaternion to identity, no math, no
    // capture, no blending. Smoking-gun verifier for the bone reference.
    if (this.forceSpineIdentity && this._spineBone) {
      const preSpine = _tmpQ3.copy(this._spineBone.quaternion);
      this._spineBone.quaternion.set(0, 0, 0, 1);
      this._diag.adjustDeg   = preSpine.angleTo(this._spineBone.quaternion) * 180 / Math.PI;
      this._diag.compensated = true;
    } else if (armBlend > 0.001 && !this._disarming &&
               this._spineBone && this._spineFbxTarget && this._fbx) {
      const spineParent = this._spineBone.parent;
      if (spineParent) {
        // desiredSpineWorld = fbxWorld * target_relative_to_fbx
        const fbxQ   = this._fbx.getWorldQuaternion(_tmpQ1);
        const desired = _tmpQ2.copy(fbxQ).multiply(this._spineFbxTarget);
        // desiredLocal = spineParent.world⁻¹ * desiredSpineWorld
        const parentInv = spineParent.getWorldQuaternion(_tmpQ4).invert();
        const desiredLocal = parentInv.multiply(desired);
        const preSpine = _tmpQ3.copy(this._spineBone.quaternion);
        this._spineBone.quaternion.slerp(desiredLocal, armBlend);
        this._diag.adjustDeg   = preSpine.angleTo(this._spineBone.quaternion) * 180 / Math.PI;
        this._diag.compensated = true;
      }
    }
    // Shooting-time yaw offset — applied independently of the spine
    // anchor block above. The anchor only activates once the raise
    // animation completes (capture happens in the 'finished' handler),
    // but we want the torso rotation to ramp PROGRESSIVELY during the
    // raise itself — otherwise the yaw pops in on the frame after the
    // raise lands. Gating purely on the per-weapon blend gives a
    // smooth ramp during arming and an immediate snap on disarm
    // (because _cannonBlend / _rocketBlend ramp down via the smoother
    // BUT we also force-skip while _disarming is set so the disarm
    // animation plays its lowering pose without the offset).
    if (!this._disarming && this._spineBone) {
      const yaw = this._cannonUpperBodyYaw * this._cannonBlend
                + this._rocketUpperBodyYaw * this._rocketBlend;
      if (yaw) {
        _tmpQ5.setFromAxisAngle(_Y_AXIS, yaw);
        this._spineBone.quaternion.multiply(_tmpQ5);
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  // Walk the FBX skeleton once on load and grab references to the Hips
  // bone and the FIRST Spine bone (immediate child of Hips, NOT Spine1
  // or Spine2). These are used every frame in update() for the post-
  // mixer counter-rotation that anchors the upper body when armed.
  //
  // Bone matching is intentionally tolerant — some FBX exports don't
  // tag bones with isBone=true (they ship as plain Object3D), and the
  // Mixamo prefix can be `mixamorig:` / `mixamorig1:` / absent. We do
  // a name match first (suffix `Hips` / `Spine` respecting the colon
  // separator), then fall back to picking the first child of Hips
  // whose name contains "Spine" if the strict match misses.
  _captureUpperBodyBones(fbx) {
    // Bone names from this FBX export are prefix-fused (e.g.
    // "mixamorigHips", "mixamorigSpine") — there's no colon separator
    // like the docs would suggest. Match the suffix only; "Spine$"
    // excludes "Spine1" / "Spine2" naturally because $ anchors at the
    // end of the string.
    const isHips  = (n) => /Hips$/.test(n);
    const isSpine = (n) => /Spine$/.test(n);
    const boneNames = [];
    fbx.traverse((node) => {
      if (node.name) boneNames.push(node.name);
      if (!this._hipsBone  && isHips(node.name))  this._hipsBone  = node;
      if (!this._spineBone && isSpine(node.name)) this._spineBone = node;
    });
    // Fallback: first child of Hips that looks like a spine bone.
    if (this._hipsBone && !this._spineBone) {
      for (const c of this._hipsBone.children) {
        if (/Spine/i.test(c.name || '')) { this._spineBone = c; break; }
      }
    }
    console.log('MechaRig: counter-rotation bones',
      { hips: this._hipsBone?.name, spine: this._spineBone?.name,
        spineParent: this._spineBone?.parent?.name,
        nodeCount: boneNames.length });
    if (!this._hipsBone || !this._spineBone) {
      console.warn('MechaRig: bone capture failed — full node list:', boneNames);
    } else if (this._spineBone.parent !== this._hipsBone) {
      console.warn(
        'MechaRig: Spine bone is NOT a direct child of Hips. Counter-rotation ' +
        'still works (it solves in world space) but the parent chain has extra ' +
        'links: ' + (this._spineBone.parent?.name ?? '<none>'),
      );
    }
    this._diag.hipsName    = this._hipsBone?.name  || '';
    this._diag.spineName   = this._spineBone?.name || '';
    this._diag.spineParent = this._spineBone?.parent?.name || '';
  }

  _attach(slot, clip) {
    if (!clip || !this._mixer) return null;
    clip.name = slot;
    this._normalizeClipTracks(clip);
    // Strip baked-in root translation so the clip plays "in place" and our
    // manual charPos drives the actual displacement. Mixamo's directional
    // walks often ship with root motion on a Hips/Armature/Root bone, and
    // when that's added on top of our own MOVE_SPEED translation the body
    // ends up drifting wrong / sliding off direction.
    //
    // Death keeps its root motion — the fall-down clip needs the body to
    // travel/tip with the authored animation; otherwise the mecha just
    // collapses in place looking glued to the floor.
    if (slot !== 'death') this._stripRootMotion(clip);
    // No upper-body stripping on locomotion clips. The original Spine /
    // arm tracks play back authored when un-armed (so idle and walks
    // look correct), and when armed the cannon/rocket overlay at
    // armIntensity=40 dominates the mixer blend (~97% cannon) plus the
    // post-mixer FBX-relative Spine anchor in update() takes over
    // spine.quaternion entirely — it doesn't matter what the mixer
    // wrote there because we replace it.
    // Hit stays additive (small recoil overlay reads better as a delta).
    // Cannon and rocket are NORMAL-blend, just bone-masked: their leg /
    // hip tracks are stripped so locomotion fully owns the lower body,
    // and they play at high weight (armIntensity) so the mixer's per-bone
    // weighted blend essentially replaces the locomotion's arm swing
    // with the held aim pose — no quaternion-extrapolation distortion.
    if (slot === 'hit') {
      THREE.AnimationUtils.makeClipAdditive(clip);
    } else if (slot === 'cannon' || slot === 'rocket') {
      this._maskToUpperBody(clip);
    }
    const action = this._mixer.clipAction(clip);
    if (slot === 'idle') {
      this._actions.idle = action;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(1);
      action.play();
    } else if (slot === 'battleIdle') {
      this._actions.battleIdle = action;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(0);
      action.play();
    } else if (slot === 'hit') {
      this._actions.hit = action;
      action.blendMode = THREE.AdditiveAnimationBlendMode;
      action.setLoop(THREE.LoopOnce, 1);
      action.setEffectiveWeight(0);
    } else if (slot === 'death') {
      this._actions.death = action;
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.setEffectiveWeight(0);
    } else if (slot === 'cannon') {
      this._actions.cannon = action;
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.setEffectiveWeight(0);
    } else if (slot === 'rocket') {
      this._actions.rocket = action;
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.setEffectiveWeight(0);
    } else {
      const [bundle, name] = slot.split('.');
      this._actions[bundle][name] = action;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(0);
      action.play();
    }
    return action;
  }

  _primeLocomotion() {
    const speedRatio = CLIP_SPEED > 0 ? (this.moveSpeed / CLIP_SPEED) : 1;
    const setupBundle = (set) => {
      for (const name of ['forward', 'back', 'left', 'right']) {
        const a = set[name];
        if (!a) continue;
        a.enabled = true;
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.setEffectiveWeight(0);
        a.timeScale = speedRatio;
        if (!a.isRunning()) a.play();
      }
    };
    if (this._actions.idle) {
      this._actions.idle.timeScale = 1;
      this._actions.idle.setEffectiveWeight(1);
    }
    if (this._actions.battleIdle) {
      this._actions.battleIdle.timeScale = 1;
      this._actions.battleIdle.setEffectiveWeight(0);
    }
    setupBundle(this._actions.normal);
    setupBundle(this._actions.battle);

    const ref = this._actions.normal.forward;
    if (ref) {
      for (const name of ['back', 'left', 'right']) {
        const a = this._actions.normal[name];
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
    if (a.idle)           a.idle.setEffectiveWeight(w.idle);
    if (a.battleIdle)     a.battleIdle.setEffectiveWeight(w.battleIdle);
    if (a.normal.forward) a.normal.forward.setEffectiveWeight(w.normal.forward);
    if (a.normal.back)    a.normal.back.setEffectiveWeight(w.normal.back);
    if (a.normal.left)    a.normal.left.setEffectiveWeight(w.normal.left);
    if (a.normal.right)   a.normal.right.setEffectiveWeight(w.normal.right);
    if (a.battle.forward) a.battle.forward.setEffectiveWeight(w.battle.forward);
    if (a.battle.back)    a.battle.back.setEffectiveWeight(w.battle.back);
    if (a.battle.left)    a.battle.left.setEffectiveWeight(w.battle.left);
    if (a.battle.right)   a.battle.right.setEffectiveWeight(w.battle.right);
    if (a.hit)            a.hit.setEffectiveWeight(w.hit);
    if (a.death)          a.death.setEffectiveWeight(w.death);
    if (a.cannon)         a.cannon.setEffectiveWeight(w.cannon);
    if (a.rocket)         a.rocket.setEffectiveWeight(w.rocket);
  }

  _detectPrefix(clip) {
    if (!clip || !clip.tracks?.length) return '';
    const first = clip.tracks[0].name;
    const dot = first.indexOf('.');
    const path = dot > 0 ? first.slice(0, dot) : first;
    const m = path.match(/^(mixamorig\d*:?)/);
    return m ? m[1] : '';
  }

  _normalizeClipTracks(clip) {
    if (!clip || !clip.tracks?.length) return;
    const canonical = this._canonicalPrefix;
    if (!canonical) return;
    const re = /^mixamorig\d*:?/;
    for (const t of clip.tracks) {
      if (re.test(t.name)) t.name = t.name.replace(re, canonical);
    }
  }

  // Strip lower-body tracks from a clip so it only animates the upper body
  // (spine, chest, neck, head, shoulders, arms, hands). Used on the cannon
  // and rocket additive overlays — the locomotion bundle owns the legs and
  // we don't want the additive delta perturbing the gait.
  //
  // Mixamo bone names contain "UpLeg" / "Leg" / "Foot" / "Toe" for every
  // lower-body joint regardless of side or prefix variant; substring
  // match is enough. Hips is also stripped — keeping it would have the
  // cannon's authored aim-stance pelvis pose fight locomotion's cyclic
  // walking pelvis at the mixer level, which makes the legs swing
  // relative to a partially-locked pelvis and read as broken. With
  // Hips locomotion-only, legs animate correctly; the cost is that the
  // upper body rotates slightly with the walking pelvis when armed
  // (arms-aim drift) — a separate problem to solve via post-mixer
  // counter-rotation if it ever needs fixing.
  _maskToUpperBody(clip) {
    if (!clip || !clip.tracks?.length) return;
    const isLower = (bone) => /Hips|UpLeg|Leg|Foot|Toe/.test(bone);
    clip.tracks = clip.tracks.filter((t) => {
      const dot = t.name.lastIndexOf('.');
      const bone = dot < 0 ? t.name : t.name.slice(0, dot);
      return !isLower(bone);
    });
    clip.resetDuration?.();
  }

  // Strip ONLY Spine* (Spine, Spine1, Spine2) tracks from a locomotion
  // clip. Cannon and rocket clips are the SOLE authors of Spine when
  // armed (post-mixer FBX-anchor takes it from there); when un-armed,
  // Spine sits in bind pose during walking — acceptable on a robotic
  // mecha and avoids the "torso pulled by gait" wobble.
  //
  // Arms / Shoulders / Neck / Head are KEPT in locomotion clips so
  // un-armed walking has a natural arm swing. When armed, the cannon
  // overlay at armIntensity=40 dominates those bones at the mixer
  // level (97% override) and the Spine FBX-anchor cancels the residual
  // Hips→Spine→arms FK propagation, which together is enough to
  // anchor the held aim pose.
  //
  // Hips is also KEPT — Mixamo leg tracks (UpLeg/Leg/Foot) are
  // authored relative to a cycling Hips, so stripping Hips would
  // place the legs at wrong angles.
  _stripSpineFromLoco(clip) {
    if (!clip || !clip.tracks?.length) return;
    clip.tracks = clip.tracks.filter((t) => {
      const dot = t.name.lastIndexOf('.');
      const bone = dot < 0 ? t.name : t.name.slice(0, dot);
      return !/Spine/.test(bone);
    });
    clip.resetDuration?.();
  }

  // Remove position tracks on the root (Armature / Hips / RootNode etc.)
  // so the clip plays "in place" — the host owns body translation via
  // setMovement / charPos. Returns the list of removed track names.
  _stripRootMotion(clip) {
    if (!clip || !clip.tracks?.length) return [];
    const removed = [];
    clip.tracks = clip.tracks.filter((t) => {
      // A track name is "<bone>.<property>". We strip POSITION tracks on
      // bones whose name reads as a root: literally "Armature", "RootNode",
      // anything ending in "Hips", or the canonical-prefixed Hips.
      const dot = t.name.lastIndexOf('.');
      if (dot < 0) return true;
      const bone = t.name.slice(0, dot);
      const prop = t.name.slice(dot + 1);
      if (prop !== 'position') return true;
      // Bone names from this FBX export can be either prefix-fused
      // ("mixamorigHips") or colon/underscore-separated ("mixamorig:Hips",
      // "mixamorig_Hips"). The previous regex required a colon/underscore
      // separator and silently missed the fused form, leaving a Hips
      // position track in every loco clip — the body bounced with the
      // walk gait and dragged everything above it (including the held
      // aim arms) up and down. Plain suffix match handles all variants.
      const isRoot =
        bone === 'Armature' ||
        bone === 'RootNode' ||
        /Hips$/.test(bone);
      if (isRoot) {
        removed.push(t.name);
        return false;
      }
      return true;
    });
    if (removed.length) clip.resetDuration?.();
    return removed;
  }
}
