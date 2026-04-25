import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// Empty test arena used to build up the FBX character + animation pipeline
// in isolation, before wiring it into the real game. Reachable from the
// corp-logo splash by pressing TAB.
//
// Controls match the main-game stealth feel:
//   • WASD       — camera-relative move
//   • Q / E      — rotate facing
//   • R (hold)   — play the hack animation
//
// Animation state machine (post-load):
//   • Hacking  → 'hack'
//   • Idle     → 'idle'
//   • Moving   → forward / back / left / right
//                (based on the movement vector projected onto the character's
//                facing — so the player can hold W and rotate to watch the
//                back / strafe clips kick in.)

// Asset registry. The Idle FBX is the SKINNED file (mesh + textures + idle
// clip). The rest are bone-only animations exported "without skin" from
// Mixamo and retarget onto the same rig.
const ASSET_DIR = 'Assets/CyberPunk_Hacker/';
// File map: forward ↔ back and left ↔ right are swapped here. With the
// character starting facing AWAY from the camera (north — opposite the
// camera, which sits in the south), this is the mapping that puts the
// expected animation under each key.
const ANIM_FILES = {
  idle:    'Crouch Idle.fbx',          // skinned source — load first
  forward: 'Crouch Walk Back.fbx',     // swapped
  back:    'Crouch Walk Forward.fbx',  // swapped
  left:    'Crouch Walk Right.fbx',    // swapped
  right:   'Crouch Walk Left.fbx',     // swapped
  hack:    'Hacking.fbx',
};

// Camera matches the main game's isometric framing for consistency.
const CAM_YAW    = Math.PI * 75 / 180;
const CAM_RADIUS = 9;
const CAM_HEIGHT = 7.5;

const MOVE_SPEED  = 2.5;             // m/s while walking
const TURN_SPEED  = Math.PI;         // rad/s for Q/E
// Approximate world speed the Mixamo crouch-walk clips were authored for —
// when their root displacement is stripped the legs still cycle at the rate
// a body would have travelled at if the displacement were left in. We scale
// timeScale so the visible leg cycle matches MOVE_SPEED → no foot slide.
// Tweak this if the legs look too fast / too slow.
const CLIP_SPEED  = 1.4;             // m/s baked into the strider clips
// Mixamo characters face -Z at rotation.y=0; our facing convention treats
// 0 as +Z. Add π to align the mesh with the facing angle.
const MESH_FACING_OFFSET = Math.PI;

export function runDebugLevel() {
  // Tell the main game module to stand down — its animate loop bails on
  // this flag, and its window key listeners (R for hack, F for rocket,
  // SPACE for shoot) early-return so they don't fight our input.
  window.__nanoDebugLevel = true;

  // The main game module already constructed its renderer + HUD at import
  // time. Hide everything before we drop our own canvas in so the debug
  // level renders to a clean screen.
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
  ].join(';');
  document.body.appendChild(hud);

  const hint = document.createElement('div');
  hint.style.cssText = hud.style.cssText
    .replace('top:10px', 'bottom:10px')
    .replace('left:10px', 'left:10px');
  hint.innerHTML =
    '<b style="color:#0ff">Controls</b> ' +
    'WASD move • Q/E rotate • R tap to hack (movement interrupts)';
  document.body.appendChild(hint);

  // ── Input ──────────────────────────────────────────────────────────────
  const keys = new Set();
  let   hacking = false;             // true while the hack clip is playing through
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const wasDown = keys.has(k);
    keys.add(k);
    // Tap R → start a one-shot hack play-through. Hack runs in parallel
    // with the locomotion bundle but its weight ramps toward 1 via
    // hackBlend, while the locomotion weights ramp to 0. The mixer's
    // 'finished' listener flips `hacking` back off when the clip ends, and
    // movement (WASD) interrupts the play-through mid-clip.
    if (k === 'r' && !wasDown && actions.hack && !hacking) {
      hacking = true;
      const a = actions.hack;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.reset();
      a.setEffectiveWeight(0); // hackBlend will ramp this up
      a.play();
    }
  });
  window.addEventListener('keyup',   (e) => keys.delete(e.key.toLowerCase()));

  // ── Character + animation registry ─────────────────────────────────────
  let character    = null;
  let mixer        = null;
  const actions    = {};   // name -> AnimationAction

  // Character state. Start facing north (camera sits in the south), 180°
  // away from the previous orientation. Combined with the swapped file map
  // above, this puts each key under the animation that visually matches
  // the user's intent.
  const charPos = new THREE.Vector3(0, 0, 0);
  let   facing  = Math.PI / 2;
  let   loadedCount = 0;
  const totalCount  = Object.keys(ANIM_FILES).length;

  // ── Blend weights ──────────────────────────────────────────────────────
  // Instead of cross-fading between clips, every locomotion clip runs in
  // parallel and we drive their per-action weights each frame. The result
  // is a continuous "blend space": pressing W+D weights forward + right
  // simultaneously, so the legs always step in the actual movement direction
  // instead of snapping between four discrete clips.
  //
  // weights sum to ≤ 1 each frame; the engine accumulates the active poses.
  const weights = {
    idle: 1, forward: 0, back: 0, left: 0, right: 0, hack: 0,
  };
  // Smoothed scalars — ramp toward their targets so transitions are gradual.
  let moveBlend = 0;   // 0 = idle, 1 = full locomotion
  let hackBlend = 0;   // 0 = nothing, 1 = pure hack pose
  const BLEND_RATE = 8; // 1/seconds — higher = snappier ramp

  function setHud() {
    const ready = loadedCount >= totalCount;
    const fmt = (n) => n.toFixed(2);
    hud.innerHTML =
      '<b style="color:#0ff">DEBUG LEVEL</b><br>' +
      `loaded: <b>${loadedCount}/${totalCount}</b>` +
      (ready ? '' : ' …') + '<br>' +
      `<span style="opacity:.7">weights</span><br>` +
      `&nbsp;idle&nbsp;&nbsp;<b style="color:#7fa">${fmt(weights.idle)}</b>` +
      `&nbsp;hack&nbsp;<b style="color:#7fa">${fmt(weights.hack)}</b><br>` +
      `&nbsp;fwd&nbsp;&nbsp;<b style="color:#7fa">${fmt(weights.forward)}</b>` +
      `&nbsp;back&nbsp;<b style="color:#7fa">${fmt(weights.back)}</b><br>` +
      `&nbsp;left&nbsp;<b style="color:#7fa">${fmt(weights.left)}</b>` +
      `&nbsp;right&nbsp;<b style="color:#7fa">${fmt(weights.right)}</b>`;
  }
  setHud();

  // Configures every locomotion clip to play continuously at zero weight.
  // setEffectiveWeight + play() is the standard pattern for a blend tree —
  // the action keeps stepping its time forward but contributes nothing to
  // the pose until weight rises above 0.
  //
  // Two extra refinements applied here:
  //   1. timeScale = MOVE_SPEED / CLIP_SPEED on every strider clip so the
  //      legs cycle at the rate the body is actually translating. Kills foot
  //      slide when MOVE_SPEED differs from the clip's authored speed.
  //   2. syncWith(forward) on back/left/right so all four strider clips
  //      share a single playback head. Diagonal blends (e.g. forward+right)
  //      then have their gait phases locked instead of drifting apart, so
  //      the blended foot lands at a single coherent moment.
  function primeLocomotion() {
    const speedRatio = CLIP_SPEED > 0 ? (MOVE_SPEED / CLIP_SPEED) : 1;
    for (const name of ['idle', 'forward', 'back', 'left', 'right']) {
      const a = actions[name];
      if (!a) continue;
      a.enabled = true;
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.setEffectiveWeight(name === 'idle' ? 1 : 0);
      // Idle keeps its native speed (it isn't a stride). Striders are
      // sped/slowed to match the body's translation rate.
      a.timeScale = (name === 'idle') ? 1 : speedRatio;
      if (!a.isRunning()) a.play();
    }
    // Phase-lock all directional striders to the forward clip. syncWith
    // copies time + timeScale once; with all four clips at the same time-
    // scale and similar period, they stay in step from there.
    const ref = actions.forward;
    if (ref) {
      for (const name of ['back', 'left', 'right']) {
        const a = actions[name];
        if (a) a.syncWith(ref);
      }
    }
  }

  function applyWeights() {
    for (const name of Object.keys(weights)) {
      const a = actions[name];
      if (!a) continue;
      a.setEffectiveWeight(weights[name]);
    }
  }

  // Idle FBX must finish first — it provides the rig + the mixer. We chain
  // the rest after so they all bind to the same mixer instance.
  const sourceLoader = new FBXLoader();
  sourceLoader.load(
    ASSET_DIR + ANIM_FILES.idle,
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
      // When the one-shot hack clip ends naturally, drop the flag so the
      // state machine can route into idle / movement on the next frame.
      mixer.addEventListener('finished', (e) => {
        if (actions.hack && e.action === actions.hack) hacking = false;
      });

      const clip = fbx.animations?.[0];
      if (clip) {
        clip.name = 'idle';
        actions.idle = mixer.clipAction(clip);
        actions.idle.play();
      }
      loadedCount++;
      setHud();

      // Now load the rest in parallel onto the same mixer.
      for (const [name, file] of Object.entries(ANIM_FILES)) {
        if (name === 'idle') continue;
        const ld = new FBXLoader();
        ld.load(
          ASSET_DIR + file,
          (animFbx) => {
            const c = animFbx.animations?.[0];
            if (c && mixer) {
              c.name = name;
              const action = mixer.clipAction(c);
              actions[name] = action;
              // Locomotion clips immediately join the blend at weight 0;
              // the per-frame state machine ramps them in. Hack stays
              // dormant until the player taps R.
              if (name !== 'hack') {
                action.setLoop(THREE.LoopRepeat, Infinity);
                action.setEffectiveWeight(0);
                action.play();
              }
            }
            loadedCount++;
            setHud();
            // Once all clips are in, re-prime to lock the configuration.
            if (loadedCount >= totalCount) primeLocomotion();
          },
          undefined,
          (err) => {
            loadedCount++;
            setHud();
            console.error(`debug-level: failed to load ${file}`, err);
          },
        );
      }
    },
    undefined,
    (err) => console.error('debug-level: idle/source load failed', err),
  );

  // ── Update / render loop ───────────────────────────────────────────────
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);

    // ── Rotation: Q / E
    // Swapped from the main game's convention so that, with the character
    // facing the camera, Q rotates the body toward the user's screen-left
    // and E toward screen-right (matches keyboard intuition).
    let turn = 0;
    if (keys.has('q')) turn += 1;
    if (keys.has('e')) turn -= 1;
    if (turn) {
      facing += turn * TURN_SPEED * dt;
      while (facing >  Math.PI) facing -= Math.PI * 2;
      while (facing < -Math.PI) facing += Math.PI * 2;
    }

    // ── Movement: WASD, camera-relative (matches Player).
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
      // Movement aborts a hack play-through — the character commits to
      // walking instead of finishing the lock-on.
      if (hacking && len > 0) hacking = false;

      // Smoothly ramp the high-level scalars toward their input targets so
      // none of the transitions snap.
      const targetMove = (len > 0 && !hacking) ? 1 : 0;
      const targetHack = hacking ? 1 : 0;
      const stepFactor = Math.min(1, dt * BLEND_RATE);
      moveBlend += (targetMove - moveBlend) * stepFactor;
      hackBlend += (targetHack - hackBlend) * stepFactor;

      // Project the world-space movement vector onto the character's local
      // axes. Initial facing is set so this projection lines key intent up
      // with the corresponding clip:
      //   • forward = (sin θ, cos θ)
      //   • right   = forward × up = (-cos θ, sin θ)
      // A diagonal input weights both forward and right at the same time —
      // that's the actual blend space at work.
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
      //   • hack takes priority — its weight comes off the top.
      //   • whatever's left is split between idle and the locomotion bundle
      //     by `moveBlend`.
      //   • inside the locomotion bundle, fw/bw/lw/rw share by direction.
      const nonHack = 1 - hackBlend;
      const moveShare = moveBlend  * nonHack;
      const idleShare = (1 - moveBlend) * nonHack;
      weights.hack    = hackBlend;
      weights.idle    = idleShare;
      weights.forward = fw * moveShare;
      weights.back    = bw * moveShare;
      weights.left    = lw * moveShare;
      weights.right   = rw * moveShare;

      applyWeights();
      setHud();

      // Hard-sync all strider clocks to the forward clip every frame.
      // syncWith only copies time + timeScale ONCE; after that each clip
      // advances independently, and tiny duration differences between the
      // four Mixamo strides accumulate phase drift over a few seconds.
      // Forcing back/left/right.time = forward.time before mixer.update
      // wipes the drift out — the four clips always share the same gait
      // phase, so a forward+right diagonal blend always plants its foot at
      // a single coherent beat.
      const refAct = actions.forward;
      if (refAct) {
        for (const name of ['back', 'left', 'right']) {
          const a = actions[name];
          if (a) a.time = refAct.time;
        }
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
