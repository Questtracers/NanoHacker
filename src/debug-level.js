import * as THREE from 'three';
import { SoldierRig } from './soldier-rig.js';

// Debug arena — soldier behaviour preview.
//
// One SoldierRig is dropped onto an empty floor and walks a randomly-
// generated polygon route, pausing briefly at each waypoint. The blend
// tree picks idle / forward / back / left / right based on the soldier's
// movement projected onto its facing — so corner-rounding triggers brief
// strafe contributions automatically.
//
// Controls:
//   • WASD       — pan the camera (camera-relative)
//   • TAB        — toggle soldier's normal / battle locomotion bundle
//   • P          — toggle the route gizmos (line + waypoint markers)
//   • T          — soldier fires the rifle (additive overlay)
//   • H          — soldier takes a hit (variant chosen by current mode)
//   • N          — soldier dies (one-shot, locks the rig in death pose)

const CAM_YAW       = Math.PI * 75 / 180;
const CAM_RADIUS    = 12;
const CAM_HEIGHT    = 9;
const CAM_PAN_SPEED = 6;

const SOLDIER_SPEED      = 1.6;        // m/s while walking
const SOLDIER_TURN_RATE  = Math.PI;    // rad/s — facing chases movement direction
const PAUSE_AT_WAYPOINT  = 1.2;        // s of idle between segments
const ROUTE_HALF_EXTENT  = 10;         // route fits inside ±10 m around origin
const NUM_WAYPOINTS      = 5;
const TARGET_REACH       = 0.4;        // m — distance to consider waypoint hit

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

  const hint = document.createElement('div');
  hint.style.cssText = hud.style.cssText.replace('top:10px', 'bottom:10px');
  hint.innerHTML =
    '<b style="color:#0ff">Controls</b> ' +
    'WASD pan • TAB normal/battle • P route • T fire • H hit • N die';
  document.body.appendChild(hint);

  // ── Random patrol route ────────────────────────────────────────────────
  const waypoints = [];
  for (let i = 0; i < NUM_WAYPOINTS; i++) {
    waypoints.push(new THREE.Vector3(
      (Math.random() - 0.5) * ROUTE_HALF_EXTENT * 2,
      0,
      (Math.random() - 0.5) * ROUTE_HALF_EXTENT * 2,
    ));
  }

  // Route gizmos — line connecting the waypoints (looped) plus a disc + pin
  // at each. Toggleable via TAB.
  const gizmos = [];
  let gizmosVisible = false;

  {
    const ROUTE_COLOR = 0x66ffaa;
    const pts = waypoints.map((w) => new THREE.Vector3(w.x, 0.05, w.z));
    pts.push(pts[0]); // close the loop
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
      color: ROUTE_COLOR, transparent: true, opacity: 0.65,
    }));
    line.visible = gizmosVisible;
    scene.add(line);
    gizmos.push(line);

    waypoints.forEach((w) => {
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 0.06, 20),
        new THREE.MeshBasicMaterial({ color: ROUTE_COLOR }),
      );
      disc.position.set(w.x, 0.06, w.z);
      disc.visible = gizmosVisible;
      scene.add(disc);
      gizmos.push(disc);

      const pin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8),
        new THREE.MeshBasicMaterial({
          color: ROUTE_COLOR, transparent: true, opacity: 0.55,
        }),
      );
      pin.position.set(w.x, 0.7, w.z);
      pin.visible = gizmosVisible;
      scene.add(pin);
      gizmos.push(pin);
    });
  }

  function setGizmosVisible(v) {
    gizmosVisible = v;
    for (const g of gizmos) g.visible = v;
  }

  // ── Soldier rig (the only character in this debug arena) ──────────────
  const soldier = new SoldierRig(scene, { moveSpeed: SOLDIER_SPEED });
  soldier.position = waypoints[0];
  // Aim initial facing at the next waypoint so the soldier doesn't have to
  // spin on startup.
  {
    const dx = waypoints[1].x - waypoints[0].x;
    const dz = waypoints[1].z - waypoints[0].z;
    soldier.facing = Math.atan2(dx, dz);
  }
  soldier.load();

  let currentWaypoint = 1;
  let pauseTimer = 0;

  // ── Input ──────────────────────────────────────────────────────────────
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const wasDown = keys.has(k);
    keys.add(k);
    if (e.key === 'Tab') {
      e.preventDefault();
      soldier.battleMode = !soldier.battleMode;
    }
    if (k === 'p' && !wasDown) setGizmosVisible(!gizmosVisible);
    if (k === 't' && !wasDown) soldier.triggerFiring();
    if (k === 'h' && !wasDown) soldier.triggerHit();
    if (k === 'n' && !wasDown) soldier.triggerDeath();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // Camera target — WASD pans this; the camera follows at fixed offset.
  const camTarget = new THREE.Vector3(
    waypoints[0].x, 0.5, waypoints[0].z,
  );

  function setHud() {
    const ready = soldier.loaded;
    const mode = soldier.battleMode ? 'BATTLE' : 'NORMAL';
    const modeColor = soldier.battleMode ? '#f88' : '#7ef';
    hud.innerHTML =
      '<b style="color:#0ff">DEBUG LEVEL — soldier preview</b><br>' +
      `loaded: <b>${(soldier.loadProgress * 100).toFixed(0)}%</b>` +
      (ready ? '' : ' …') + '<br>' +
      `mode: <b style="color:${modeColor}">${mode}</b><br>` +
      `waypoint: <b>${currentWaypoint + 1} / ${waypoints.length}</b>` +
      (pauseTimer > 0
        ? ` <span style="opacity:.7">(idle ${pauseTimer.toFixed(1)} s)</span>`
        : '') + '<br>' +
      `routes: <b>${gizmosVisible ? 'ON' : 'off'}</b>`;
  }

  // ── Update / render loop ───────────────────────────────────────────────
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);

    // Camera pan via WASD (camera-relative — same swizzle the player uses
    // in the main game so screen-up = world -X).
    let ix = 0, iz = 0;
    if (keys.has('w')) iz -= 1;
    if (keys.has('s')) iz += 1;
    if (keys.has('a')) ix -= 1;
    if (keys.has('d')) ix += 1;
    const len = Math.hypot(ix, iz);
    if (len > 0) {
      ix /= len; iz /= len;
      camTarget.x += iz * CAM_PAN_SPEED * dt;
      camTarget.z += -ix * CAM_PAN_SPEED * dt;
    }

    // Camera follows target.
    camera.position.set(
      camTarget.x + Math.sin(CAM_YAW) * CAM_RADIUS,
      CAM_HEIGHT,
      camTarget.z + Math.cos(CAM_YAW) * CAM_RADIUS,
    );
    camera.lookAt(camTarget.x, 0.5, camTarget.z);

    // ── Soldier route follower ───────────────────────────────────────
    if (soldier.isDying) {
      soldier.setMovement(0, 0);
    } else if (pauseTimer > 0) {
      pauseTimer -= dt;
      soldier.setMovement(0, 0);
    } else if (soldier.loaded) {
      const target = waypoints[currentWaypoint];
      const pos    = soldier.position;
      const dx     = target.x - pos.x;
      const dz     = target.z - pos.z;
      const dist   = Math.hypot(dx, dz);
      if (dist < TARGET_REACH) {
        // Reached waypoint — pause briefly then advance to the next.
        pauseTimer = PAUSE_AT_WAYPOINT;
        currentWaypoint = (currentWaypoint + 1) % waypoints.length;
        soldier.setMovement(0, 0);
      } else {
        // Step toward the waypoint at SOLDIER_SPEED.
        const dirX = dx / dist;
        const dirZ = dz / dist;
        pos.x += dirX * SOLDIER_SPEED * dt;
        pos.z += dirZ * SOLDIER_SPEED * dt;

        // Smoothly turn the soldier's facing toward the movement direction.
        // While the rotation lags the movement, the blend tree picks up
        // the strafe components automatically (forward + a touch of left
        // or right).
        const targetFacing = Math.atan2(dirX, dirZ);
        let diff = targetFacing - soldier.facing;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const turnStep = Math.sign(diff) *
                         Math.min(Math.abs(diff), SOLDIER_TURN_RATE * dt);
        soldier.facing = soldier.facing + turnStep;

        // Tell the rig the world-space movement direction so its blend
        // tree can resolve forward / back / left / right.
        soldier.setMovement(dirX, dirZ);
      }
    }

    soldier.update(dt);
    setHud();
    renderer.render(scene, camera);
  }
  tick();
}
