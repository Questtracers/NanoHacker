import * as THREE from 'three';
import { MechaRig } from './mecha-rig.js';

// Debug arena — player-piloted Rocket Mecha preview.
//
// One MechaRig dropped onto an empty floor; the player drives it as if
// it were possessed in the main game. WASD is camera-relative movement
// (same swizzle as Player), Q/E rotates the body. The blend tree picks
// idle / forward / back / strafe based on the world movement projected
// onto the mecha's facing — so rotating mid-stride lets you watch the
// strafe clips fade in.
//
// Controls:
//   • WASD       — move (camera-relative)
//   • Q / E      — rotate facing
//   • TAB        — toggle normal / battle locomotion bundle

const CAM_YAW    = Math.PI * 75 / 180;
const CAM_RADIUS = 14;
const CAM_HEIGHT = 11;
const MOVE_SPEED = 2.0;          // m/s
const TURN_SPEED = Math.PI;      // rad/s — same as Player

export function runDebugLevel() {
  // Tell the main game module to stand down.
  window.__nanoDebugLevel = true;

  // Hide whatever the main game already mounted at module-load time.
  document.querySelectorAll('canvas').forEach((c) => { c.style.display = 'none'; });
  ['hud', 'overlay', 'arrow-spot', 'arrow-exit'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // ── Renderer + scene ───────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x0a0d14);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0d14, 30, 90);

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

  const camera = new THREE.PerspectiveCamera(
    45, window.innerWidth / window.innerHeight, 0.1, 200,
  );
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── HUD ────────────────────────────────────────────────────────────────
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

  // ── Mecha rig ──────────────────────────────────────────────────────────
  const mecha = new MechaRig(scene, { moveSpeed: MOVE_SPEED });
  window.__mecha = mecha;   // diagnostic hook for testing
  mecha.position = { x: 0, z: 0 };
  mecha.facing   = 0;
  mecha.load();

  // ── Input ──────────────────────────────────────────────────────────────
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key === 'Tab') {
      e.preventDefault();
      mecha.battleMode = !mecha.battleMode;
    }
    // T / G — scrub the cannon/rocket recoil rate live (±0.1 per press).
    // Read at fire time, so the next SPACE / R press uses the new value.
    if (e.key === 't' || e.key === 'T') {
      mecha.recoilRate = Math.max(0.1, mecha.recoilRate + 0.1);
    }
    if (e.key === 'g' || e.key === 'G') {
      mecha.recoilRate = Math.max(0.1, mecha.recoilRate - 0.1);
    }
    // Y / H — scrub the recoil offset (how many frames the pump rewinds
    // before snapping back). Step is 1 frame at 30 fps = 0.0333 s.
    const FRAME_STEP = 1 / 30;
    if (e.key === 'y' || e.key === 'Y') {
      mecha.recoilOffset = mecha.recoilOffset + FRAME_STEP;
    }
    if (e.key === 'h' || e.key === 'H') {
      mecha.recoilOffset = Math.max(FRAME_STEP, mecha.recoilOffset - FRAME_STEP);
    }
    // U / J — scrub the additive arm-overlay intensity (cannon + rocket).
    // >1 extrapolates the additive delta past the authored pose so the aim
    // dominates the underlying walk-arm swing.
    if (e.key === 'u' || e.key === 'U') {
      mecha.armIntensity = Math.min(40, mecha.armIntensity + 1);
    }
    if (e.key === 'j' || e.key === 'J') {
      mecha.armIntensity = Math.max(0, mecha.armIntensity - 1);
    }
    // O — fire a hit reaction (additive, retriggers on every press).
    if (e.key === 'o' || e.key === 'O') {
      mecha.triggerHit();
    }
    // L — play the death one-shot. Press again to reset and retrigger.
    if (e.key === 'l' || e.key === 'L') {
      if (mecha.isDying) mecha.resetDeath();
      mecha.triggerDeath();
    }
    // SPACE — first press: reverse-play the cannon clip into the held
    // aim pose. Subsequent presses while held: recoil pump.
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      mecha.triggerCannon();
    }
    // R — same mechanic as SPACE but for the rocket-arm clip (forward).
    if (e.key === 'r' || e.key === 'R') {
      mecha.triggerRocket();
    }
    // M — toggle the spine-identity sanity test. Forces spine.quaternion
    // to identity post-mixer, regardless of cannon/rocket state. If the
    // upper body visibly straightens when toggled on, the bone reference
    // works. If nothing changes, the bone we found isn't the one the
    // mixer / renderer is actually using.
    if (e.key === 'm' || e.key === 'M') {
      mecha.forceSpineIdentity = !mecha.forceSpineIdentity;
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // Driver state — mirrors the player-possessed-mecha control flow from
  // the main game.
  const charPos = new THREE.Vector3(0, 0, 0);
  let   facing  = 0;

  // Renders the post-mixer Spine counter-rotation diagnostics. Lets us
  // verify (1) bones got captured, (2) the held-pose target was snapshot,
  // (3) armBlend ramps to 1, and (4) the per-frame block is actually
  // changing spine.quaternion (adjustDeg > 0). If hipsWorldDeg moves but
  // adjustDeg stays 0, something earlier in the chain is broken; if both
  // are non-zero but you still see arm drift, the lock is misaiming.
  function diagBlock(d, forceMode) {
    if (!d) return '<br><b style="color:#f66">DIAG: no diagnostics object on rig</b>';
    const yes = (b) => b ? '<b style="color:#0f8">yes</b>' : '<b style="color:#f66">NO</b>';
    const heat = (deg) => {
      if (deg < 0.05) return '#566';
      if (deg < 1)   return '#fc4';
      return '#0f8';
    };
    return '<br><span style="color:#888">— spine anchor —</span>' +
      `<br>frame#: <b style="color:#cfe">${d.frame}</b>` +
      ` &nbsp; force-id (M): <b style="color:${forceMode ? '#f44' : '#566'}">${forceMode ? 'ON' : 'off'}</b>` +
      `<br>hips: <b style="color:#cfe">${d.hipsName || '<not found>'}</b>` +
      `<br>spine: <b style="color:#cfe">${d.spineName || '<not found>'}</b>` +
      ` <span style="color:#789">(parent: ${d.spineParent || '?'})</span>` +
      `<br>target captured: ${yes(d.targetCaptured)}` +
      ` &nbsp; armBlend: <b>${d.armBlend.toFixed(3)}</b>` +
      `<br>compensated this frame: ${yes(d.compensated)}` +
      `<br>adjust: <b style="color:${heat(d.adjustDeg)}">${d.adjustDeg.toFixed(2)}°</b>` +
      ` &nbsp; hipsWorld: <b style="color:${heat(d.hipsWorldDeg)}">${d.hipsWorldDeg.toFixed(1)}°</b>`;
  }

  function setHud() {
    const ready = mecha.loaded;
    const facingDeg = ((facing * 180 / Math.PI) % 360 + 360) % 360;
    const mode = mecha.battleMode ? 'BATTLE' : 'NORMAL';
    const modeColor = mecha.battleMode ? '#f88' : '#7ef';
    hud.innerHTML =
      '<b style="color:#0ff">DEBUG LEVEL — possessed mecha</b> <span style="color:#f4a">[build:spine-diag-v2]</span><br>' +
      `loaded: <b>${(mecha.loadProgress * 100).toFixed(0)}%</b>` +
      (ready ? '' : ' …') + '<br>' +
      `mode:   <b style="color:${modeColor}">${mode}</b><br>` +
      `pos:    <b>${charPos.x.toFixed(1)}, ${charPos.z.toFixed(1)}</b><br>` +
      `facing: <b>${facingDeg.toFixed(0)}°</b><br>` +
      `recoilRate (T/G): <b style="color:#ff0">${mecha.recoilRate.toFixed(2)}</b>` +
      ` &nbsp; recoilFrames (Y/H): <b style="color:#ff0">${(mecha.recoilOffset * 30).toFixed(1)}f</b>` +
      ` <span style="color:#789">(${mecha.recoilOffset.toFixed(3)}s)</span><br>` +
      `armIntensity (U/J): <b style="color:#ff0">${mecha.armIntensity.toFixed(2)}</b><br>` +
      `hit (O): <b style="color:${mecha.isHit ? '#fa0' : '#566'}">${mecha.isHit ? 'PLAYING' : 'idle'}</b>` +
      ` &nbsp; death (L): <b style="color:${mecha.isDying ? '#f44' : '#566'}">${mecha.isDying ? 'DEAD' : 'alive'}</b><br>` +
      `cannon (SPACE): <b style="color:${
        mecha.isCannoning ? (mecha.isCannonHeld ? '#0f8' : '#fc4') : '#566'
      }">${mecha.isCannoning ? (mecha.isCannonHeld ? 'AIMED' : 'RAISING') : 'down'}</b><br>` +
      `rocket (R): <b style="color:${
        mecha.isRocketing ? (mecha.isRocketHeld ? '#0f8' : '#fc4') : '#566'
      }">${mecha.isRocketing ? (mecha.isRocketHeld ? 'ARMED' : 'ARMING') : 'down'}</b>` +
      diagBlock(mecha.diagnostics, mecha.forceSpineIdentity);
  }

  // ── Update / render loop ───────────────────────────────────────────────
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);

    // ── Q/E rotation ─────────────────────────────────────────────────
    let turn = 0;
    if (keys.has('q')) turn += 1;     // matches Player: Q = screen-left turn
    if (keys.has('e')) turn -= 1;     //                  E = screen-right turn
    if (turn) {
      facing += turn * TURN_SPEED * dt;
      while (facing >  Math.PI) facing -= Math.PI * 2;
      while (facing < -Math.PI) facing += Math.PI * 2;
    }

    // ── WASD camera-relative movement ───────────────────────────────
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

    // Push state into the rig.
    mecha.position = charPos;
    mecha.facing   = facing;
    mecha.setMovement(len > 0 ? wx : 0, len > 0 ? wz : 0);
    mecha.update(dt);

    // ── Camera follow ────────────────────────────────────────────────
    camera.position.set(
      charPos.x + Math.sin(CAM_YAW) * CAM_RADIUS,
      CAM_HEIGHT,
      charPos.z + Math.cos(CAM_YAW) * CAM_RADIUS,
    );
    camera.lookAt(charPos.x, 1.0, charPos.z);

    setHud();
    renderer.render(scene, camera);
  }
  tick();
}
