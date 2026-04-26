import * as THREE from 'three';
import { CharacterRig } from './character-rig.js';

// Empty test arena. The character rig is now fully owned by CharacterRig
// (`./character-rig.js`); this file just builds a stage and routes input
// into the rig's setters. Same module powers the player in the main game,
// so anything that works here works there.
//
// Controls:
//   • WASD       — camera-relative move
//   • Q / E      — rotate facing
//   • R (tap)    — play the hack animation (movement interrupts)
//   • TAB        — toggle stealth ⇄ battle mode
//   • M          — fire shot (additive recoil overlay)
//   • N          — take a hit (additive overlay; crouch / battle variant)
//   • U          — die falling backwards
//   • I          — die falling forwards

const CAM_YAW    = Math.PI * 75 / 180;
const CAM_RADIUS = 9;
const CAM_HEIGHT = 7.5;
const MOVE_SPEED = 2.5;
const TURN_SPEED = Math.PI;

export function runDebugLevel() {
  // Tell the main game module to stand down — its animate loop and key
  // listeners (R, F, SPACE, TAB) early-return on this flag.
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

  const hint = document.createElement('div');
  hint.style.cssText = hud.style.cssText.replace('top:10px', 'bottom:10px');
  hint.innerHTML =
    '<b style="color:#0ff">Controls</b> ' +
    'WASD move • Q/E rotate • R hack • TAB stealth/battle • M shoot • N hit • U/I die back/front';
  document.body.appendChild(hint);

  function setHud(rig) {
    const ready = rig.loaded;
    const mode = rig.battleMode ? 'BATTLE' : 'STEALTH';
    const modeColor = rig.battleMode ? '#f88' : '#7ef';
    hud.innerHTML =
      '<b style="color:#0ff">DEBUG LEVEL</b><br>' +
      `loaded: <b>${(rig.loadProgress * 100).toFixed(0)}%</b>` +
      (ready ? '' : ' …') + '<br>' +
      `mode: <b style="color:${modeColor}">${mode}</b>`;
  }

  // ── Character rig (the only piece that ports to the real game) ────────
  const rig = new CharacterRig(scene, { moveSpeed: MOVE_SPEED });
  rig.position = { x: 0, z: 0 };
  rig.facing = Math.PI / 2;     // north — see character-rig.js for why
  rig.load();

  // ── Input ──────────────────────────────────────────────────────────────
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const wasDown = keys.has(k);
    keys.add(k);
    if (k === 'r' && !wasDown) rig.triggerHack();
    if (k === 'm' && !wasDown) rig.triggerRecoil();
    if (k === 'n' && !wasDown) rig.triggerHit();
    if (k === 'u' && !wasDown) rig.triggerDeath('back');
    if (k === 'i' && !wasDown) rig.triggerDeath('front');
    if (e.key === 'Tab') {
      e.preventDefault();
      rig.battleMode = !rig.battleMode;
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // ── Update / render loop ───────────────────────────────────────────────
  let facing = Math.PI / 2;
  const charPos = new THREE.Vector3(0, 0, 0);

  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);

    // Q/E rotation.
    let turn = 0;
    if (keys.has('q')) turn += 1;
    if (keys.has('e')) turn -= 1;
    if (turn) {
      facing += turn * TURN_SPEED * dt;
      while (facing >  Math.PI) facing -= Math.PI * 2;
      while (facing < -Math.PI) facing += Math.PI * 2;
    }

    // WASD camera-relative movement.
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

    // Push state into the rig and tick it.
    rig.position = charPos;
    rig.facing   = facing;
    rig.setMovement(wx, wz);
    rig.update(dt);

    setHud(rig);

    // Camera follow (isometric).
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
