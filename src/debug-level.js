import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// Empty test arena used to build up the FBX character + animation pipeline
// in isolation, before wiring it into the real game. Reachable from the
// corp-logo splash by pressing TAB.
//
// Controls:
//   • WASD       — camera-relative move
//   • Q / E      — rotate facing
//   • R (tap)    — play the hack animation (movement interrupts)
//   • TAB        — toggle stealth ⇄ battle mode (different animation set)
//
// Animation pipeline:
//   • Two locomotion bundles run in parallel: stealth (Crouch ...) and
//     battle (Standing Aim ...). Each bundle is a 4-direction blend space
//     (forward / back / left / right) plus an idle clip.
//   • A `modeBlend` scalar smoothly ramps from 0 (full stealth) to 1 (full
//     battle) when TAB is pressed. The blend tree multiplies each bundle's
//     weights by its share, so during the transition both bundles fade
//     across each other for a smooth crouch ⇄ stand morph.
//   • A separate hack one-shot sits on top — when triggered, hackBlend ramps
//     to 1 and the locomotion bundles fade out.

const ASSET_DIR = 'Assets/CyberPunk_Hacker/';
// Two parallel sets — stealth uses Crouch *, battle uses Standing Aim *.
// Both apply the same forward↔back / left↔right swap that aligned with the
// north-facing initial orientation in the previous round.
const ANIM_FILES = {
  // Skinned source — loaded first to get rig + textures + the stealth idle.
  source:  'Crouch Idle.fbx',
  hack:    'Hacking.fbx',
  stealth: {
    idle:    'Crouch Idle.fbx',                // also the source FBX
    forward: 'Crouch Walk Back.fbx',           // swapped
    back:    'Crouch Walk Forward.fbx',        // swapped
    left:    'Crouch Walk Right.fbx',          // swapped
    right:   'Crouch Walk Left.fbx',           // swapped
  },
  battle: {
    idle:    'Standing Aim Idle.fbx',
    forward: 'Standing Aim Walk Back.fbx',     // swapped
    back:    'Standing Aim Walk Forward.fbx',  // swapped
    left:    'Standing Aim Walk Right.fbx',    // swapped
    right:   'Standing Aim Walk Left.fbx',     // swapped
  },
};

// Camera matches the main game's isometric framing for consistency.
const CAM_YAW    = Math.PI * 75 / 180;
const CAM_RADIUS = 9;
const CAM_HEIGHT = 7.5;

const MOVE_SPEED  = 2.5;             // m/s while walking
const TURN_SPEED  = Math.PI;         // rad/s for Q/E
const CLIP_SPEED  = 1.4;             // m/s baked into the strider clips
// Mixamo characters face -Z at rotation.y=0; our facing convention treats
// 0 as +Z. Add π to align the mesh with the facing angle.
const MESH_FACING_OFFSET = Math.PI;

const MODES = ['stealth', 'battle'];

export function runDebugLevel() {
  // Tell the main game module to stand down — its animate loop bails on
  // this flag, and its window key listeners (R, F, SPACE) early-return so
  // they don't fight our input. Same flag also silences the main game's
  // TAB handler so our TAB toggle works cleanly.
  window.__nanoDebugLevel = true;

  // The main game module already constructed its renderer + HUD at import
  // time. Hide everything before we drop our own canvas in.
  document.querySelectorAll('canvas').forEach((c) => { c.style.display = 'none'; });
  ['hud', 'overlay', 'arrow-spot', 'arrow-exit'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // ── Renderer ────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x0a0d14);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0d14, 30, 90);

  // ── Floor + light ──────────────────────────────────────────────────────
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x1c1f29, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(60, 60, 0x224466, 0x162132);
  grid.position.y = 0.001;
  scene.add(grid);

  scene.add(new THREE.AmbientLight(0x99aabb, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12; sun.shadow.camera.right = 12;
  sun.shadow.camera.top  =  12; sun.shadow.camera.bottom = -12;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x6688ff, 0.4);
  rim.position.set(-6, 8, -4);
  scene.add(rim);

  // ── Camera ─────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    45, window.innerWidth / window.innerHeight, 0.1, 200,
  );

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── HUD overlay ────────────────────────────────────────────────────────
  const hud = document.createElement('div');
  hud.style.cssText = [
    'position:fixed', 'top:10px', 'left:10px', 'z-index:10',
    'padding:8px 12px',
    'background:rgba(0,5,15,0.7)', 'border:1px solid #0ff5',
    'border-radius:4px', 'font-family:monospace', 'font-size:13px',
    'color:#cfe', 'line-height:1.6', 'pointer-events:none',
    'white-space:nowrap',
  ].join(';');
  document.body.appendChild(hud);

  const hint = document.createElement('div');
  hint.style.cssText = hud.style.cssText.replace('top:10px', 'bottom:10px');
  hint.innerHTML =
    '<b style="color:#0ff">Controls</b> ' +
    'WASD move • Q/E rotate • R hack • TAB toggle stealth/battle';
  document.body.appendChild(hint);

  // ── Character + animation registry ─────────────────────────────────────
  let character = null;
  let mixer     = null;
  // Two locomotion bundles + a separate hack action.
  const actions = {
    hack:    null,
    stealth: { idle: null, forward: null, back: null, left: null, right: null },
    battle:  { idle: null, forward: null, back: null, left: null, right: null },
  };

  // Character state.
  const charPos = new THREE.Vector3(0, 0, 0);
  let   facing  = Math.PI / 2;            // facing north (away from camera)
  let   loadedCount = 0;
  // 4 unique files per mode (idle of stealth IS the source) + 1 source +
  // 1 hack = 11. Counted as 11 .load() returns.
  const totalCount = 1 + 4 + 5 + 1;       // source + stealth striders + battle (5) + hack

  // ── Blend weights ──────────────────────────────────────────────────────
  // Two locomotion bundles in parallel. modeBlend cross-fades between them.
  // Within each bundle, the same blend-space pattern as before.
  const weights = {
    hack: 0,
    stealth: { idle: 1, forward: 0, back: 0, left: 0, right: 0 },
    battle:  { idle: 0, forward: 0, back: 0, left: 0, right: 0 },
  };
  // Smoothed scalars — ramp toward their targets so transitions are gradual.
  let moveBlend = 0;          // 0 = idle, 1 = full locomotion
  let hackBlend = 0;          // 0 = nothing, 1 = pure hack pose
  let modeBlend = 0;          // 0 = full stealth, 1 = full battle
  let mode      = 'stealth';
  const BLEND_RATE      = 8;  // 1/seconds — move/hack ramp
  const MODE_BLEND_RATE = 4;  // posture switch is slower (crouch ⇄ stand)

  function setHud() {
    const ready = loadedCount >= totalCount;
    const fmt = (n) => n.toFixed(2);
    const modeColor = mode === 'battle' ? '#f88' : '#7ef';
    hud.innerHTML =
      '<b style="color:#0ff">DEBUG LEVEL</b><br>' +
      `loaded: <b>${loadedCount}/${totalCount}</b>` +
      (ready ? '' : ' …') + '<br>' +
      `mode: <b style="color:${modeColor}">${mode.toUpperCase()}</b>` +
      ` <span style="opacity:.6">(modeBlend ${fmt(modeBlend)})</span><br>` +
      `<span style="opacity:.7">stealth</span>` +
      ` i:${fmt(weights.stealth.idle)}` +
      ` f:${fmt(weights.stealth.forward)}` +
      ` b:${fmt(weights.stealth.back)}` +
      ` l:${fmt(weights.stealth.left)}` +
      ` r:${fmt(weights.stealth.right)}<br>` +
      `<span style="opacity:.7">battle&nbsp;</span>` +
      ` i:${fmt(weights.battle.idle)}` +
      ` f:${fmt(weights.battle.forward)}` +
      ` b:${fmt(weights.battle.back)}` +
      ` l:${fmt(weights.battle.left)}` +
      ` r:${fmt(weights.battle.right)}<br>` +
      `hack: <b style="color:#fa7">${fmt(weights.hack)}</b>`;
  }
  setHud();

  // ── Input ──────────────────────────────────────────────────────────────
  const keys = new Set();
  let   hacking = false;             // true while the hack clip is playing through
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const wasDown = keys.has(k);
    keys.add(k);
    // R tap → start a one-shot hack play-through (movement interrupts).
    if (k === 'r' && !wasDown && actions.hack && !hacking) {
      hacking = true;
      const a = actions.hack;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.reset();
      a.setEffectiveWeight(0);   // hackBlend ramps this up
      a.play();
    }
    // TAB → toggle stealth ⇄ battle. modeBlend ramps the two bundles so the
    // crouch ⇄ stand transition fades smoothly.
    if (e.key === 'Tab') {
      e.preventDefault();
      mode = (mode === 'stealth') ? 'battle' : 'stealth';
    }
  });
  window.addEventListener('keyup',   (e) => keys.delete(e.key.toLowerCase()));

  // Configures every locomotion clip to play continuously at zero weight
  // and locks all striders' phase by syncing them to the stealth.forward
  // master clip. Same blend-tree scaffolding from before, applied to BOTH
  // mode bundles.
  function primeLocomotion() {
    const speedRatio = CLIP_SPEED > 0 ? (MOVE_SPEED / CLIP_SPEED) : 1;
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
    setupBundle(actions.stealth);
    setupBundle(actions.battle);
    // Initial pose: stealth idle visible, everything else at 0.
    if (actions.stealth.idle) actions.stealth.idle.setEffectiveWeight(1);

    // Phase-lock every strider to a single master (stealth.forward). Both
    // bundles share gait phase so cross-mode blends during the TAB switch
    // don't go out of sync either.
    const ref = actions.stealth.forward;
    if (ref) {
      for (const name of ['back', 'left', 'right']) {
        const a = actions.stealth[name];
        if (a) a.syncWith(ref);
      }
      for (const name of ['forward', 'back', 'left', 'right']) {
        const a = actions.battle[name];
        if (a) a.syncWith(ref);
      }
    }
  }

  function applyWeights() {
    const a = actions;
    if (a.stealth.idle)    a.stealth.idle.setEffectiveWeight(weights.stealth.idle);
    if (a.stealth.forward) a.stealth.forward.setEffectiveWeight(weights.stealth.forward);
    if (a.stealth.back)    a.stealth.back.setEffectiveWeight(weights.stealth.back);
    if (a.stealth.left)    a.stealth.left.setEffectiveWeight(weights.stealth.left);
    if (a.stealth.right)   a.stealth.right.setEffectiveWeight(weights.stealth.right);
    if (a.battle.idle)     a.battle.idle.setEffectiveWeight(weights.battle.idle);
    if (a.battle.forward)  a.battle.forward.setEffectiveWeight(weights.battle.forward);
    if (a.battle.back)     a.battle.back.setEffectiveWeight(weights.battle.back);
    if (a.battle.left)     a.battle.left.setEffectiveWeight(weights.battle.left);
    if (a.battle.right)    a.battle.right.setEffectiveWeight(weights.battle.right);
    if (a.hack)            a.hack.setEffectiveWeight(weights.hack);
  }

  // Attach an action onto the right slot in the actions tree, primed for
  // blend-tree use. `slot` is e.g. 'stealth.forward' or 'hack' or 'battle.idle'.
  function attachAction(slot, clip) {
    if (!clip || !mixer) return null;
    clip.name = slot;
    const action = mixer.clipAction(clip);
    if (slot === 'hack') {
      actions.hack = action;
    } else {
      const [bundle, name] = slot.split('.');
      actions[bundle][name] = action;
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.setEffectiveWeight(0);
      action.play();
    }
    return action;
  }

  function noteLoaded() {
    loadedCount++;
    setHud();
    if (loadedCount >= totalCount) primeLocomotion();
  }

  // Source FBX must finish first — it provides the rig + the mixer + the
  // stealth idle clip. Everything else binds to the same mixer.
  const sourceLoader = new FBXLoader();
  sourceLoader.load(
    ASSET_DIR + ANIM_FILES.source,
    (fbx) => {
      character = fbx;
      character.scale.setScalar(1);
      character.position.copy(charPos);
      character.traverse((child) => {
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
      scene.add(character);
      mixer = new THREE.AnimationMixer(character);
      mixer.addEventListener('finished', (e) => {
        if (actions.hack && e.action === actions.hack) hacking = false;
      });

      // Source FBX's first clip = stealth idle.
      const sourceClip = fbx.animations?.[0];
      if (sourceClip) {
        attachAction('stealth.idle', sourceClip);
        // Idle weight starts at 1 (set in primeLocomotion at full load).
        actions.stealth.idle?.play();
      }
      noteLoaded();

      // Now load all the other clips in parallel.
      const queue = [];
      // Stealth striders (source already covers stealth.idle).
      for (const dir of ['forward', 'back', 'left', 'right']) {
        queue.push({ slot: `stealth.${dir}`, file: ANIM_FILES.stealth[dir] });
      }
      // Whole battle bundle.
      for (const dir of ['idle', 'forward', 'back', 'left', 'right']) {
        queue.push({ slot: `battle.${dir}`, file: ANIM_FILES.battle[dir] });
      }
      // Hack one-shot.
      queue.push({ slot: 'hack', file: ANIM_FILES.hack });

      for (const job of queue) {
        const ld = new FBXLoader();
        ld.load(
          ASSET_DIR + job.file,
          (animFbx) => {
            attachAction(job.slot, animFbx.animations?.[0]);
            noteLoaded();
          },
          undefined,
          (err) => {
            noteLoaded();
            console.error(`debug-level: failed to load ${job.file}`, err);
          },
        );
      }
    },
    undefined,
    (err) => console.error('debug-level: source load failed', err),
  );

  // ── Update / render loop ───────────────────────────────────────────────
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);

    // ── Rotation: Q / E
    let turn = 0;
    if (keys.has('q')) turn += 1;
    if (keys.has('e')) turn -= 1;
    if (turn) {
      facing += turn * TURN_SPEED * dt;
      while (facing >  Math.PI) facing -= Math.PI * 2;
      while (facing < -Math.PI) facing += Math.PI * 2;
    }

    // ── Movement: WASD, camera-relative.
    let ix = 0, iz = 0;
    if (keys.has('w')) iz -= 1;
    if (keys.has('s')) iz += 1;
    if (keys.has('a')) ix -= 1;
    if (keys.has('d')) ix += 1;
    const len = Math.hypot(ix, iz);
    let wx = 0, wz = 0;
    if (len > 0) {
      ix /= len; iz /= len;
      wx =  iz;
      wz = -ix;
      charPos.x += wx * MOVE_SPEED * dt;
      charPos.z += wz * MOVE_SPEED * dt;
    }

    // ── Apply transform to the FBX root
    if (character) {
      character.position.copy(charPos);
      character.rotation.y = facing + MESH_FACING_OFFSET;
    }

    // ── Animation blend tree (after the source FBX is ready) ─────────────
    if (mixer) {
      // Movement aborts a hack play-through.
      if (hacking && len > 0) hacking = false;

      // Smoothly ramp the high-level scalars toward their input targets.
      const targetMove = (len > 0 && !hacking) ? 1 : 0;
      const targetHack = hacking ? 1 : 0;
      const targetMode = (mode === 'battle') ? 1 : 0;
      const stepFast = Math.min(1, dt * BLEND_RATE);
      const stepSlow = Math.min(1, dt * MODE_BLEND_RATE);
      moveBlend += (targetMove - moveBlend) * stepFast;
      hackBlend += (targetHack - hackBlend) * stepFast;
      modeBlend += (targetMode - modeBlend) * stepSlow;

      // Project the world-space movement vector onto the character's local
      // axes (same as before — both bundles share the same direction split).
      let fw = 0, bw = 0, lw = 0, rw = 0;
      if (len > 0) {
        const fx =  Math.sin(facing);
        const fz =  Math.cos(facing);
        const rx = -Math.cos(facing);
        const rz =  Math.sin(facing);
        const fwdC = wx * fx + wz * fz;
        const rgtC = wx * rx + wz * rz;
        fw = Math.max(0,  fwdC);
        bw = Math.max(0, -fwdC);
        rw = Math.max(0,  rgtC);
        lw = Math.max(0, -rgtC);
        const sum = fw + bw + rw + lw;
        if (sum > 0) { fw /= sum; bw /= sum; rw /= sum; lw /= sum; }
      }

      // Compose final weights:
      //   • hack pulls weight off the top.
      //   • The remainder is split between the two MODE bundles by modeBlend.
      //   • Inside each bundle, idle vs. moving is split by moveBlend, and
      //     the directional weights share the moving slice.
      const nonHack    = 1 - hackBlend;
      const stealthMul = (1 - modeBlend) * nonHack;
      const battleMul  = modeBlend       * nonHack;
      const moveS      = moveBlend       * stealthMul;
      const idleS      = (1 - moveBlend) * stealthMul;
      const moveB      = moveBlend       * battleMul;
      const idleB      = (1 - moveBlend) * battleMul;

      weights.hack            = hackBlend;
      weights.stealth.idle    = idleS;
      weights.stealth.forward = fw * moveS;
      weights.stealth.back    = bw * moveS;
      weights.stealth.left    = lw * moveS;
      weights.stealth.right   = rw * moveS;
      weights.battle.idle     = idleB;
      weights.battle.forward  = fw * moveB;
      weights.battle.back     = bw * moveB;
      weights.battle.left     = lw * moveB;
      weights.battle.right    = rw * moveB;

      applyWeights();
      setHud();

      // Hard-sync every strider's clock to the master (stealth.forward) every
      // frame. Without this, any duration mismatch between the eight strider
      // clips lets phase drift accumulate, and diagonal blends (or the cross-
      // mode TAB transition) start to look "off."
      const refAct = actions.stealth.forward;
      if (refAct) {
        const t = refAct.time;
        if (actions.stealth.back)    actions.stealth.back.time    = t;
        if (actions.stealth.left)    actions.stealth.left.time    = t;
        if (actions.stealth.right)   actions.stealth.right.time   = t;
        if (actions.battle.forward)  actions.battle.forward.time  = t;
        if (actions.battle.back)     actions.battle.back.time     = t;
        if (actions.battle.left)     actions.battle.left.time     = t;
        if (actions.battle.right)    actions.battle.right.time    = t;
      }

      mixer.update(dt);
    }

    // ── Camera follow (isometric)
    camera.position.set(
      charPos.x + Math.sin(CAM_YAW) * CAM_RADIUS,
      CAM_HEIGHT,
      charPos.z + Math.cos(CAM_YAW) * CAM_RADIUS,
    );
    camera.lookAt(charPos.x, 1.0, charPos.z);

    renderer.render(scene, camera);
  }
  tick();
}
