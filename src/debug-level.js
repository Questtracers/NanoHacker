import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Player } from './player.js';
import { Bullet } from './bullet.js';
import { Rocket } from './rocket.js';

// Debug arena — gameplay sandbox.
//
// Drops one Mecha (full AI) and the Player into an empty walkable room
// so the user can watch the cannon-arm flow, hit reactions, recoil pumps,
// disarm reversal, etc. all in one place without the rest of the
// gameplay layer (drones, doors, hacks, soldiers, level geometry).
//
// Controls:
//   • WASD       — move (camera-relative)
//   • Q / E      — rotate facing
//   • SPACE      — pistol shot
//   • TAB        — toggle: alert the mecha manually (debug)
//   • H          — hack-link the mecha (flips it to faction=friendly)
//   • P          — possess / eject the (hack-linked) mecha
//   • F          — rocket while possessed

const CAM_YAW    = Math.PI * 75 / 180;
const CAM_RADIUS = 16;
const CAM_HEIGHT = 13;
const ARENA_HALF = 24;     // half-extent in cells; arena is 2× this
const PLAYER_MAX_HP = 2;

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
  scene.fog = new THREE.Fog(0x0a0d14, 40, 110);

  const floorSize = ARENA_HALF * 2;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(floorSize, floorSize),
    new THREE.MeshStandardMaterial({ color: 0x1c1f29, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(ARENA_HALF, 0, ARENA_HALF);   // arena spans 0..floorSize
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(floorSize, floorSize, 0x224466, 0x162132);
  grid.position.set(ARENA_HALF, 0.001, ARENA_HALF);
  scene.add(grid);

  scene.add(new THREE.AmbientLight(0x99aabb, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -16; sun.shadow.camera.right = 16;
  sun.shadow.camera.top  =  16; sun.shadow.camera.bottom = -16;
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

  // ── Stub map ───────────────────────────────────────────────────────────
  // The gameplay code (Mecha AI, bullets) imports map utilities that
  // expect a `{ width, height, grid }` object. Build a fully-walkable
  // grid sized to the arena — every cell is 0 (floor), no walls, no
  // obstacles. Good enough for vision, ray-march, and BFS pathing in
  // the open arena.
  const W = floorSize, H = floorSize;
  const map = {
    width: W,
    height: H,
    grid: Array.from({ length: H }, () => Array.from({ length: W }, () => 0)),
    rooms: [],
  };

  // ── Obstacles ──────────────────────────────────────────────────────────
  // A handful of waist-high blocks scattered around the arena center so
  // there's actual geometry to hide behind / sweep cones over. Each
  // entry is { x, z, w, d, h }: world-space center + footprint and height.
  // We mark every covered grid cell as 1 (wall) so rayMarch / vision
  // cones / pathfinding all treat them as obstacles.
  const obstacles = [
    { x: ARENA_HALF + 1,  z: ARENA_HALF - 5, w: 3, d: 1.5, h: 1.4 },
    { x: ARENA_HALF - 4,  z: ARENA_HALF + 3, w: 1.5, d: 4, h: 1.4 },
    { x: ARENA_HALF + 6,  z: ARENA_HALF + 6, w: 2.5, d: 2.5, h: 2.0 },
    { x: ARENA_HALF - 7,  z: ARENA_HALF - 7, w: 2, d: 2, h: 1.6 },
    { x: ARENA_HALF,      z: ARENA_HALF + 9, w: 4, d: 1, h: 1.2 },
  ];
  const obstacleMat = new THREE.MeshStandardMaterial({
    color: 0x4a3322, roughness: 0.85, metalness: 0.1,
  });
  for (const o of obstacles) {
    const geo = new THREE.BoxGeometry(o.w, o.h, o.d);
    const mesh = new THREE.Mesh(geo, obstacleMat);
    mesh.position.set(o.x, o.h / 2, o.z);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    // Mark the covered grid cells as walls so rayMarch / vision blocks.
    const x0 = Math.floor(o.x - o.w / 2);
    const x1 = Math.ceil (o.x + o.w / 2);
    const z0 = Math.floor(o.z - o.d / 2);
    const z1 = Math.ceil (o.z + o.d / 2);
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        if (z >= 0 && z < H && x >= 0 && x < W) map.grid[z][x] = 1;
      }
    }
  }

  // ── Drone rotation tuner ──────────────────────────────────────────────
  // A static Drone.fbx hovering at a fixed point — no AI, no movement,
  // no shots. The user adjusts its X / Y rotation live with U/J/H/L
  // and reads the values off the HUD; we use the result to bake the
  // correct PRE_ROT values into the gameplay Drone class.
  const tuner = {
    droneRotX: 0,
    droneRotY: 0,
    droneRoot: null,            // Group we apply rotations to
    apply() {
      if (!this.droneRoot) return;
      this.droneRoot.rotation.set(this.droneRotX, this.droneRotY, 0);
    },
  };
  (async () => {
    const loader = new FBXLoader();
    const fbx = await loader.loadAsync('Assets/Drone/Drone.fbx');
    // Auto-scale to ~0.7 m so it reads at a recognisable drone size.
    const box = new THREE.Box3().setFromObject(fbx);
    const size = box.getSize(new THREE.Vector3());
    const native = Math.max(size.x, size.y, size.z) || 1;
    const scale = 0.7 / native;
    fbx.scale.setScalar(scale);
    box.setFromObject(fbx);
    const center = box.getCenter(new THREE.Vector3());
    fbx.position.sub(center);
    fbx.traverse((c) => {
      if (!c.isMesh && !c.isSkinnedMesh) return;
      c.castShadow    = true;
      c.receiveShadow = true;
    });
    // Wrap in a Group so rotation is applied cleanly without fighting
    // any baked-in transform on the FBX root.
    const root = new THREE.Group();
    root.position.set(ARENA_HALF + 6, 1.5, ARENA_HALF);  // hovering
    root.add(fbx);
    scene.add(root);
    tuner.droneRoot = root;
    tuner.apply();
  })();

  // ── Player ─────────────────────────────────────────────────────────────
  const playerStart = { x: ARENA_HALF - 6, z: ARENA_HALF };
  const player = new Player(scene, playerStart.x, playerStart.z);
  player.hp = PLAYER_MAX_HP;
  let playerHp = PLAYER_MAX_HP;

  // Mecha + drone are removed so the focus is purely on the wall /
  // door tuner corridor. Re-add them here when you want to fight or
  // test possession again.

  // Diagnostic hook for in-page testing.
  window.__nanoSandbox = {
    player, scene, tuner,
    get bullets() { return bullets; },
  };

  // ── World / game stubs ────────────────────────────────────────────────
  const bullets = [];
  const world = {
    player,
    enemies: [],
    drones:  [],
    mechas:  [],
    realDt: 0,
    cameraYaw: CAM_YAW,
    destroyObstacleAt() { /* obstacles are static in the sandbox */ },
  };
  const game = {
    spawnBullet(x, z, dx, dz, owner = 'enemy', shooter = null) {
      bullets.push(new Bullet(scene, x, z, dx, dz, owner, shooter));
    },
    spawnRocket(x, z, dx, dz, owner = 'player', shooter = null) {
      bullets.push(new Rocket(scene, x, z, dx, dz, owner, shooter));
    },
    obstacleAt() { return null; },
    damageObstacleAt() {},
    destroyObstacleAt() {},
    cellBlockedByDoor() { return false; },
  };

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

  // ── Extra debug input ─────────────────────────────────────────────────
  // Player.constructor wires WASD/Q/E itself. We only listen for the
  // sandbox-specific shortcuts (SPACE shoot + tile-tuner keys) here.
  let shotCooldown = 0;
  const SHOT_COOLDOWN = 0.6;
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (shotCooldown > 0) return;
      const d = player.facingDir;
      const len = Math.hypot(d.x, d.z) || 1;
      game.spawnBullet(
        player.position.x + (d.x / len) * 0.6,
        player.position.z + (d.z / len) * 0.6,
        d.x / len, d.z / len, 'player', player,
      );
      shotCooldown = SHOT_COOLDOWN;
    }
    // ── Drone rotation tuner ────────────────────────────────────────
    // U / J = X axis, H / L = Y axis. Step is 15°.
    const TUNE_STEP = Math.PI / 12;
    if (k === 'u') { tuner.droneRotX += TUNE_STEP; tuner.apply(); }
    if (k === 'j') { tuner.droneRotX -= TUNE_STEP; tuner.apply(); }
    if (k === 'h') { tuner.droneRotY += TUNE_STEP; tuner.apply(); }
    if (k === 'l') { tuner.droneRotY -= TUNE_STEP; tuner.apply(); }
  });

  // Bullet collision — only walls (handled in Bullet.update) since the
  // mecha + drone are gone. Bullets just expire on hit / lifetime.
  function tickBullets(dt) {
    for (const b of bullets) {
      if (!b.alive) continue;
      b.update(dt, map, player, [], game);
    }
    for (let i = bullets.length - 1; i >= 0; i--) {
      if (!bullets[i].alive) bullets.splice(i, 1);
    }
  }

  function setHud() {
    const r2d = (r) => (r * 180 / Math.PI).toFixed(0);
    hud.innerHTML =
      '<b style="color:#0ff">DEBUG LEVEL — drone rotation tuner</b><br>' +
      'WASD move • Q/E turn • SPACE shoot<br>' +
      '<span style="color:#aaa">drone — U/J = X axis • H/L = Y axis</span><br>' +
      `drone rot: <b style="color:#ff0">x=${r2d(tuner.droneRotX)}°</b> ` +
      `<b style="color:#ff0">y=${r2d(tuner.droneRotY)}°</b><br>` +
      `Player HP: <b style="color:${playerHp <= 0 ? '#f44' : '#cfe'}">${playerHp} / ${PLAYER_MAX_HP}</b>`;
  }

  // ── Update / render loop ───────────────────────────────────────────────
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    world.realDt = dt;

    if (shotCooldown > 0) shotCooldown -= dt;
    player.update(dt, map, null, false, shotCooldown <= 0);
    tickBullets(dt);
    setHud();

    // ── Camera follow ────────────────────────────────────────────────
    // Bias toward the drone position so the tuner stays in frame
    // while the user iterates on rotation values.
    const focusX = player.position.x * 0.5 + (ARENA_HALF + 6) * 0.5;
    const focusZ = player.position.z * 0.5 + ARENA_HALF       * 0.5;
    camera.position.set(
      focusX + Math.sin(CAM_YAW) * CAM_RADIUS,
      CAM_HEIGHT,
      focusZ + Math.cos(CAM_YAW) * CAM_RADIUS,
    );
    camera.lookAt(focusX, 1.0, focusZ);

    renderer.render(scene, camera);
  }
  tick();
}
