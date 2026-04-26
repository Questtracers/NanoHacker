import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// SoldierRig — owns the rifle-soldier skinned mesh, AnimationMixer, and a
// dual-bundle locomotion blend tree (normal patrol + battle/aggressive).
// Same architecture as CharacterRig but trimmed to what an enemy needs
// (no hack/recoil/hit/death yet — easy to add later).
//
// Public surface:
//   const rig = new SoldierRig(scene);
//   rig.load();
//   rig.position   = { x, z };
//   rig.facing     = radians;
//   rig.battleMode = true / false;     // ramps modeBlend → swap bundles
//   rig.setMovement(wx, wz);           // world-space step direction
//   rig.update(dt);

const ASSET_DIR = 'Assets/Soldier_Enemy/';

const ANIM_FILES = {
  // Skinned source — provides rig + textures + the normal idle clip.
  source:     'Rifle Idle simple.fbx',
  idle:       'Rifle Idle simple.fbx',
  // Battle idle = Rifle Agressive Idle on loop — rifle-up combat stance.
  battleIdle: 'Rifle Agressive Idle.fbx',
  // One-shots (additive overlays + a death clip). All filenames match the
  // exact spelling on disk including any typos ("riffle", "Agreesive").
  firing:     'Firing Rifle.fbx',
  hitNormal:  'Hit Reaction.fbx',
  hitBattle:  'Agreesive Hit Reaction.fbx',          // file has typo "Agreesive"
  death:      'riffle dying.fbx',
  // Normal patrol bundle.
  normal: {
    forward: 'Rifle Walk.fbx',
    back:    'Rifle Walk Backwards.fbx',
    left:    'Rifle Agressive Walk Left.fbx',
    right:   'Rifle Agressive Walk Right.fbx',
  },
  // Battle bundle.
  battle: {
    forward: 'Rifle Agresive Walking forward.fbx',   // file has typo "Agresive" (one s)
    back:    'Rifle Agressive Walking Backwards.fbx',
    left:    'Rifle Agressive Walk Left.fbx',
    right:   'Rifle Agressive Walk Right.fbx',
  },
};

const MESH_FACING_OFFSET = 0;
const CLIP_SPEED         = 1.4;
const BLEND_RATE         = 8;
const MODE_BLEND_RATE    = 4;     // slower than move ramp — feels weightier
const FBX_SCALE          = 2.0;

// Additive-overlay intensity multipliers. With three.js's additive blend
// mode, the action's effective weight scales the per-bone delta that gets
// added on top of the base pose. Values above 1 amplify the motion past
// what the clip authored; below 1 attenuate it.
//   • Firing — pushed well past 1 so the recoil reads clearly even when
//     the soldier is also walking.
//   • Hit reaction — kept below 1 so it reads as a flinch instead of
//     throwing the soldier completely off-pose.
const FIRING_INTENSITY = 4.0;
const HIT_INTENSITY    = 0.45;

export class SoldierRig {
  constructor(scene, options = {}) {
    this.scene     = scene;
    this.moveSpeed = options.moveSpeed ?? 1.6;

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

    // One-shot states.
    this._firing  = false;       // brief additive overlay on shooting
    this._hitting = false;       // brief additive overlay on damage
    this._hitSlot = null;        // 'hitNormal' | 'hitBattle' | null
    this._dying   = false;

    this._actions = {
      idle:       null,          // normal-mode idle  (Rifle Idle simple)
      battleIdle: null,          // battle-mode idle  (Firing Rifle on loop)
      firing:     null,          // additive overlay  (Firing Rifle delta)
      hitNormal:  null,          // additive
      hitBattle:  null,          // additive
      death:      null,
      normal:  { forward: null, back: null, left: null, right: null },
      battle:  { forward: null, back: null, left: null, right: null },
    };
    this._weights = {
      idle:       1,
      battleIdle: 0,
      firing:     0,
      hitNormal:  0,
      hitBattle:  0,
      death:      0,
      normal:  { forward: 0, back: 0, left: 0, right: 0 },
      battle:  { forward: 0, back: 0, left: 0, right: 0 },
    };
    this._moveBlend  = 0;
    this._modeBlend  = 0;     // 0 = normal, 1 = battle
    this._firingBlend = 0;
    this._hitBlend    = 0;
    this._deathBlend  = 0;
    this._smoothFw = 0;
    this._smoothBw = 0;
    this._smoothLw = 0;
    this._smoothRw = 0;

    this._loadCount = 0;
    // source + 4 normal + 4 battle + firing + battleIdle + 2 hits + death.
    this._loadTotal = 1 + 4 + 4 + 1 + 1 + 2 + 1;

    // Mixamo prefix detected from the source FBX's animation tracks. Each
    // re-upload to Mixamo can produce a different prefix (mixamorig:,
    // mixamorig1:, ...). Animations from a different upload won't bind to
    // this rig's skeleton until we rewrite their track names to use this
    // canonical prefix — symptom of the mismatch is a T-pose despite the
    // action having weight.
    this._canonicalPrefix = '';
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
    if (this._fbx) this._fbx.rotation.y = rad + MESH_FACING_OFFSET;
  }
  get battleMode()  { return this._battle; }
  set battleMode(v) { this._battle = !!v; }
  get loaded()       { return this._loaded; }
  get loadProgress() { return this._loadCount / this._loadTotal; }

  setMovement(wx, wz) {
    this._wx = wx;
    this._wz = wz;
  }

  get isDying() { return this._dying; }

  // Brief shooting overlay — additive, plays on top of locomotion. Returns
  // false if already firing, dying, or the clip isn't loaded yet.
  triggerFiring() {
    if (this._firing || this._dying) return false;
    const a = this._actions.firing;
    if (!a) return false;
    this._firing = true;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.reset();
    a.setEffectiveWeight(0);
    a.play();
    return true;
  }

  // Hit reaction — additive overlay. Picks the variant that matches the
  // soldier's current locomotion bundle (battle vs normal), so the
  // reaction blends correctly with the underlying body state.
  triggerHit() {
    if (this._hitting || this._dying) return false;
    const slot = this._battle ? 'hitBattle' : 'hitNormal';
    const a = this._actions[slot];
    if (!a) return false;
    this._hitting = true;
    this._hitSlot = slot;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.reset();
    a.setEffectiveWeight(0);
    a.play();
    return true;
  }

  // Death — one-shot full-body fall. Locks every other animation out for
  // the rest of the soldier's existence (call resetDeath() to revive).
  triggerDeath() {
    if (this._dying) return false;
    const a = this._actions.death;
    if (!a) return false;
    this._dying = true;
    // Cancel any in-flight overlays.
    this._firing  = false;
    this._hitting = false;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.reset();
    a.setEffectiveWeight(0);
    a.play();
    return true;
  }

  resetDeath() {
    this._dying = false;
    if (this._actions.death) this._actions.death.stop();
  }

  // ── Loading ─────────────────────────────────────────────────────────
  load() {
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = new Promise((resolve, reject) => {
      const onFail = (err, file) =>
        console.error(`SoldierRig: failed to load ${file}`, err);
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
          this._fbx = fbx;
          this._mixer = new THREE.AnimationMixer(fbx);

          // Wire up the 'finished' event so one-shot clips can flip their
          // flags off when they end (death deliberately stays clamped).
          this._mixer.addEventListener('finished', (e) => {
            const a = e.action;
            if (a === this._actions.firing)    this._firing  = false;
            if (a === this._actions.hitNormal && this._hitSlot === 'hitNormal') this._hitting = false;
            if (a === this._actions.hitBattle && this._hitSlot === 'hitBattle') this._hitting = false;
          });

          // Capture the bone-prefix convention BEFORE attaching anything.
          // Each subsequent clip's tracks will be rewritten to match.
          const sourceClip = fbx.animations?.[0];
          this._canonicalPrefix = this._detectPrefix(sourceClip);
          if (sourceClip) this._attach('idle', sourceClip);

          oneDone();

          // Load both locomotion bundles + the one-shots in parallel.
          const queue = [];
          for (const dir of ['forward', 'back', 'left', 'right']) {
            queue.push({ slot: `normal.${dir}`, file: ANIM_FILES.normal[dir] });
            queue.push({ slot: `battle.${dir}`, file: ANIM_FILES.battle[dir] });
          }
          queue.push({ slot: 'battleIdle', file: ANIM_FILES.battleIdle });
          queue.push({ slot: 'firing',     file: ANIM_FILES.firing });
          queue.push({ slot: 'hitNormal',  file: ANIM_FILES.hitNormal });
          queue.push({ slot: 'hitBattle',  file: ANIM_FILES.hitBattle });
          queue.push({ slot: 'death',      file: ANIM_FILES.death });

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

    const dying = this._dying;
    const moving = (this._wx * this._wx + this._wz * this._wz) > 1e-6;
    const targetMove   = (!dying && moving) ? 1 : 0;
    const targetMode   = this._battle ? 1 : 0;
    const targetFiring = (!dying && this._firing) ? 1 : 0;
    const targetHit    = (!dying && this._hitting) ? 1 : 0;
    const targetDeath  = dying ? 1 : 0;
    const stepFast = Math.min(1, dt * BLEND_RATE);
    const stepSlow = Math.min(1, dt * MODE_BLEND_RATE);
    this._moveBlend   += (targetMove   - this._moveBlend)   * stepFast;
    this._modeBlend   += (targetMode   - this._modeBlend)   * stepSlow;
    this._firingBlend += (targetFiring - this._firingBlend) * stepFast;
    this._hitBlend    += (targetHit    - this._hitBlend)    * stepFast;
    this._deathBlend  += (targetDeath  - this._deathBlend)  * stepFast;

    // Project world movement onto the soldier's local axes.
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

    // Compose weights:
    //   • Death dominates everything. Its weight comes off the very top.
    //   • The remainder after the (single) idle goes to the locomotion
    //     bundles, split between normal and battle by modeBlend.
    //   • Inside each bundle, the directional weights share the moving slice.
    //   • Additive overlays (firing, hit) ride on top; their weights are
    //     independent of the bundle weights — the mixer adds their delta.
    const nonDeath = 1 - this._deathBlend;
    const nMul     = (1 - this._modeBlend) * nonDeath;
    const bMul     = this._modeBlend       * nonDeath;
    const moveN    = this._moveBlend * nMul;
    const moveB    = this._moveBlend * bMul;
    // Idle is now split per-mode: normal idle (Rifle Idle simple) when in
    // patrol mode, battle idle (Firing Rifle on loop) when in battle mode.
    // The split mirrors the locomotion bundles — modeBlend cross-fades the
    // two idles smoothly during the TAB transition.
    const idleN    = (1 - this._moveBlend) * nMul;
    const idleB    = (1 - this._moveBlend) * bMul;
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
    // Additive overlays — suppressed during death. Intensity multipliers
    // exaggerate (>1) or attenuate (<1) the per-bone delta the mixer adds
    // on top of the locomotion pose.
    w.firing    = this._firingBlend * FIRING_INTENSITY * nonDeath;
    w.hitNormal = (this._hitSlot === 'hitNormal')
      ? this._hitBlend * HIT_INTENSITY * nonDeath
      : 0;
    w.hitBattle = (this._hitSlot === 'hitBattle')
      ? this._hitBlend * HIT_INTENSITY * nonDeath
      : 0;
    w.death     = this._deathBlend;

    this._applyWeights();

    // Phase-sync every strider (in both bundles) to a single master
    // (normal.forward), proportional by clip duration.
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
  }

  // ── Internals ────────────────────────────────────────────────────────

  // Pull the Mixamo prefix from the first track of the source clip.
  // Handles both colon-separated ("mixamorig:Hips.position") and prefix-
  // attached ("mixamorigHips.position") variants. Returns "" if none.
  _detectPrefix(clip) {
    if (!clip || !clip.tracks?.length) return '';
    const first = clip.tracks[0].name;
    // Drop the trailing ".position" / ".quaternion" / ".scale".
    const dot = first.indexOf('.');
    const path = dot > 0 ? first.slice(0, dot) : first;
    // Pattern: optional "mixamorig" + optional digits + optional ":".
    const m = path.match(/^(mixamorig\d*:?)/);
    return m ? m[1] : '';
  }

  // Rewrite every track on the given clip so its bone-prefix matches the
  // rig's canonical one. Each Mixamo upload of the same model can produce
  // a different prefix (`mixamorig:`, `mixamorig1:`, etc., with or without
  // the colon). Without this, an animation FBX from a mismatched upload
  // binds zero tracks → T-pose.
  _normalizeClipTracks(clip, slot = '?') {
    if (!clip || !clip.tracks?.length) return;
    const canonical = this._canonicalPrefix;
    if (canonical == null) return;
    // Match any "mixamorig"-style prefix at the start, with optional digits
    // and optional colon. Replacing with canonical lets a "mixamorig1:"-
    // exported clip run on a "mixamorig:" rig and vice versa.
    const re = /^mixamorig\d*:?/;
    let rewritten = 0;
    for (const t of clip.tracks) {
      if (re.test(t.name)) {
        const before = t.name;
        t.name = t.name.replace(re, canonical);
        if (before !== t.name) rewritten++;
      }
    }
    if (rewritten > 0) {
      console.log(
        `SoldierRig: normalised ${rewritten}/${clip.tracks.length} ` +
        `tracks on "${slot}" → canonical prefix "${canonical}"`,
      );
    }
  }

  _attach(slot, clip) {
    if (!clip || !this._mixer) return null;
    clip.name = slot;
    this._normalizeClipTracks(clip, slot);
    // Additive overlays: shooting + hit reactions. Their pose is treated as
    // a delta from frame 0 and ADDED on top of the base locomotion bundle,
    // letting the soldier fire / take a hit while still walking.
    const isAdditive = (slot === 'firing' || slot === 'hitNormal' || slot === 'hitBattle');
    if (isAdditive) {
      THREE.AnimationUtils.makeClipAdditive(clip);
    }
    const action = this._mixer.clipAction(clip);
    if (slot === 'idle') {
      this._actions.idle = action;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(1);
      action.play();
    } else if (slot === 'battleIdle') {
      // Looping base pose for battle stance — same logic as a strider, but
      // it's the idle slot of the battle bundle. Plays continuously at
      // weight 0 until modeBlend ramps it up.
      this._actions.battleIdle = action;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(0);
      action.play();
    } else if (isAdditive || slot === 'death') {
      this._actions[slot] = action;
      if (isAdditive) action.blendMode = THREE.AdditiveAnimationBlendMode;
      // One-shots stay primed but inert until triggered.
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
    if (a.idle)             a.idle.setEffectiveWeight(w.idle);
    if (a.battleIdle)       a.battleIdle.setEffectiveWeight(w.battleIdle);
    if (a.normal.forward)   a.normal.forward.setEffectiveWeight(w.normal.forward);
    if (a.normal.back)      a.normal.back.setEffectiveWeight(w.normal.back);
    if (a.normal.left)      a.normal.left.setEffectiveWeight(w.normal.left);
    if (a.normal.right)     a.normal.right.setEffectiveWeight(w.normal.right);
    if (a.battle.forward)   a.battle.forward.setEffectiveWeight(w.battle.forward);
    if (a.battle.back)      a.battle.back.setEffectiveWeight(w.battle.back);
    if (a.battle.left)      a.battle.left.setEffectiveWeight(w.battle.left);
    if (a.battle.right)     a.battle.right.setEffectiveWeight(w.battle.right);
    if (a.firing)           a.firing.setEffectiveWeight(w.firing);
    if (a.hitNormal)        a.hitNormal.setEffectiveWeight(w.hitNormal);
    if (a.hitBattle)        a.hitBattle.setEffectiveWeight(w.hitBattle);
    if (a.death)            a.death.setEffectiveWeight(w.death);
  }
}
