import * as THREE from 'three';
import { Player } from './player.js';
import { Mecha }  from './mecha.js';
import { Drone }  from './drone.js';
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

  // ── Player ─────────────────────────────────────────────────────────────
  const playerStart = { x: ARENA_HALF - 6, z: ARENA_HALF };
  const player = new Player(scene, playerStart.x, playerStart.z);
  player.hp = PLAYER_MAX_HP;
  let playerHp = PLAYER_MAX_HP;

  // ── Mecha ──────────────────────────────────────────────────────────────
  const mechaStart = { x: ARENA_HALF + 6, z: ARENA_HALF };
  const mecha = new Mecha(scene, mechaStart.x, mechaStart.z);

  // ── Drone ──────────────────────────────────────────────────────────────
  // One drone wandering the opposite side so the visual upgrades (FBX
  // model, body yaw, pitch banking, recoil offset) can be observed.
  const droneStart = { x: ARENA_HALF - 8, z: ARENA_HALF + 4 };
  const drones = [new Drone(scene, droneStart.x, droneStart.z, null)];

  // Diagnostic hook for in-page testing.
  window.__nanoSandbox = {
    player, mecha, drones, scene,
    get bullets() { return bullets; },
  };

  // ── World / game stubs ────────────────────────────────────────────────
  const bullets = [];
  const world = {
    player,
    enemies: [],
    drones,
    mechas:  [mecha],
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
  // Player.constructor wires WASD/Q/E itself. We only listen for our
  // sandbox-specific shortcuts on top.
  let battleMode = false;
  let shotCooldown = 0;
  let slowMoActive = false;        // for HUD readout
  const SHOT_COOLDOWN = 0.6;
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'tab') {
      e.preventDefault();
      // Manually flip alert state for testing (also triggers battle mode).
      mecha.alerted = !mecha.alerted;
      if (mecha.alerted) mecha.aimedPos = { x: player.position.x, z: player.position.z };
    }
    if (k === ' ' || e.code === 'Space') {
      e.preventDefault();
      // Player fan / pistol shot — single bullet if not possessed, else
      // hand off to the mecha's possessed fire path.
      if (mecha.possessed) {
        mecha.playerFire(game);
        return;
      }
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
    if (k === 'f') {
      if (mecha.possessed) mecha.playerFireRocket(game);
    }
    if (k === 'h') {
      if (mecha.alive && mecha.faction !== 'friendly') mecha.hackLink();
    }
    if (k === 'p') {
      if (mecha.possessed) {
        mecha.leavePossession();
        player.mesh.visible = true;
        player.facingTri.visible = true;
      } else if (mecha.alive && mecha.faction === 'friendly') {
        mecha.enterPossession();
        player.mesh.position.x = mecha.mesh.position.x;
        player.mesh.position.z = mecha.mesh.position.z;
        player.mesh.visible = false;
        player.facingTri.visible = false;
      }
    }
  });

  // Bullet collision against player + mecha. Player gets damaged by
  // 'enemy' bullets (mecha's regular fire), mecha gets hit by 'player'
  // bullets. Friendly fire is on for everything else.
  function tickBullets(dt) {
    for (const b of bullets) {
      if (!b.alive) continue;
      b.update(dt, map, player, [], game);
      if (!b.alive) continue;
      // Player hit
      if (b.owner === 'enemy' && !mecha.possessed) {
        const dx = b.mesh.position.x - player.position.x;
        const dz = b.mesh.position.z - player.position.z;
        if (dx * dx + dz * dz < 0.7) {
          playerHp = Math.max(0, playerHp - (b.damage || 1));
          b.destroy();
          continue;
        }
      }
      // Mecha hit
      if (b.owner === 'player' && b.shooter !== mecha) {
        const dx = b.mesh.position.x - mecha.mesh.position.x;
        const dz = b.mesh.position.z - mecha.mesh.position.z;
        const r = mecha.hitRadius || 1;
        if (dx * dx + dz * dz < r * r) {
          mecha.takeDamage(b.damage || 1);
          b.destroy();
          continue;
        }
      }
      // Drone hits — player shots damage hostile drones; the drone's own
      // shots damage the player (handled above via owner==='enemy').
      if (b.owner === 'player') {
        for (const d of drones) {
          if (!d.alive || d.faction !== 'hostile' || b.shooter === d) continue;
          const dx = b.mesh.position.x - d.mesh.position.x;
          const dz = b.mesh.position.z - d.mesh.position.z;
          if (dx * dx + dz * dz < 0.45 * 0.45) {
            d.takeDamage(b.damage || 1);
            b.destroy();
            break;
          }
        }
      }
    }
    for (let i = bullets.length - 1; i >= 0; i--) {
      if (!bullets[i].alive) bullets.splice(i, 1);
    }
  }

  function setHud() {
    const possessed = mecha.possessed ? 'POSSESSED' : (mecha.faction === 'friendly' ? 'FRIENDLY' : 'HOSTILE');
    const possessedColor = mecha.possessed ? '#0f8'
                         : (mecha.faction === 'friendly' ? '#7ef' : '#f88');
    const armState = mecha.rig?.isCannonHeld ? 'CANNON HELD'
                   : mecha.rig?.isCannoning   ? 'CANNON RAISING'
                   : mecha.rig?.isRocketHeld  ? 'ROCKET HELD'
                   : mecha.rig?.isRocketing   ? 'ROCKET ARMING'
                   : mecha.rig?._disarming    ? 'DISARMING ' + mecha.rig._disarming.toUpperCase()
                   : 'DOWN';
    const armColor = (mecha.rig?.isCannonHeld || mecha.rig?.isRocketHeld) ? '#0f8'
                   : (mecha.rig?._disarming) ? '#fa0'
                   : (mecha.rig?.isCannoning || mecha.rig?.isRocketing) ? '#fc4'
                   : '#566';
    hud.innerHTML =
      '<b style="color:#0ff">DEBUG LEVEL — gameplay sandbox</b><br>' +
      'WASD move • Q/E turn • SPACE shoot<br>' +
      'TAB alert • H hack • P possess • F rocket(possessed)<br>' +
      `mode: <b style="color:${battleMode ? '#f88' : '#7ef'}">${battleMode ? 'BATTLE' : 'STEALTH'}</b>` +
      ` &nbsp; slow-mo: <b style="color:${slowMoActive ? '#fc4' : '#566'}">${slowMoActive ? 'ON (8%)' : 'off'}</b><br>` +
      '<br>' +
      `Player HP: <b style="color:${playerHp <= 0 ? '#f44' : '#cfe'}">${playerHp} / ${PLAYER_MAX_HP}</b><br>` +
      `Mecha HP:  <b>${mecha.hp} / ${mecha.maxHp}</b> ` +
      `<span style="color:${possessedColor}">[${possessed}]</span><br>` +
      `alerted: <b style="color:${mecha.alerted ? '#f88' : '#7ef'}">${mecha.alerted ? 'YES' : 'no'}</b>` +
      ` &nbsp; loseSightT: <b>${(mecha.losingSightTimer || 0).toFixed(1)}s</b><br>` +
      `arm state: <b style="color:${armColor}">${armState}</b><br>` +
      `shootCD: <b>${Math.max(0, mecha.shootCooldown).toFixed(1)}s</b>` +
      ` &nbsp; rocketCD: <b>${Math.max(0, mecha.rocketCooldown).toFixed(1)}s</b>` +
      (mecha.possessed
        ? `<br>disarmTimer: <b>${Math.max(0, mecha._disarmTimer || 0).toFixed(1)}s</b>`
        : '');
  }

  // ── Update / render loop ───────────────────────────────────────────────
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    world.realDt = dt;

    if (shotCooldown > 0) shotCooldown -= dt;

    // ── Player update first so movedThisFrame is fresh for slow-mo ────
    if (mecha.possessed) {
      // Possessed: mecha reads player.keys and drives itself.
      // Keep the player ghost glued to the mecha so anything looking up
      // world.player.position sees the mecha's spot.
      player.mesh.position.x = mecha.mesh.position.x;
      player.mesh.position.z = mecha.mesh.position.z;
    } else {
      player.update(dt, map, null, battleMode, shotCooldown <= 0);
    }

    // ── SUPERHOT slow-mo ─────────────────────────────────────────────
    // Same rule as main.js: while battle mode is active AND the player
    // isn't moving, the world ticks at 8% speed. Possessed-mecha mode
    // counts WASD-on-mecha as "moving" so the slow-mo lifts whenever
    // the human is at the wheel and steering.
    const ctrlMoved = mecha.possessed
      ? ['w','a','s','d'].some(k => player.keys.has(k))
      : player.movedThisFrame;
    let worldDt = dt;
    slowMoActive = battleMode && !ctrlMoved;
    if (slowMoActive) worldDt = dt * 0.08;

    mecha.update(worldDt, map, world, game);
    for (const d of drones) d.update(worldDt, map, world, game, performance.now() / 1000);
    tickBullets(worldDt);

    battleMode =
      (!!mecha.alerted  && mecha.faction !== 'friendly') ||
      drones.some(d => d.alive && d.alerted && d.faction === 'hostile');

    setHud();

    // ── Camera follow ────────────────────────────────────────────────
    // Center on the midpoint between player and mecha so both are
    // always in frame, with a slight bias toward whichever is
    // currently being controlled.
    const focus = mecha.possessed ? mecha.mesh.position : player.position;
    const other = mecha.possessed ? player.position : mecha.mesh.position;
    const cx = focus.x * 0.7 + other.x * 0.3;
    const cz = focus.z * 0.7 + other.z * 0.3;
    camera.position.set(
      cx + Math.sin(CAM_YAW) * CAM_RADIUS,
      CAM_HEIGHT,
      cz + Math.cos(CAM_YAW) * CAM_RADIUS,
    );
    camera.lookAt(cx, 1.0, cz);

    renderer.render(scene, camera);
  }
  tick();
}
