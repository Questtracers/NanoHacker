import * as THREE from 'three';
import { generateMap, buildMapMesh, pickFloorCell, findPath, findValidFloor, pickSpreadFloorCells } from './map.js';
import { Player } from './player.js';
import { Enemy } from './enemy.js';
import { Drone } from './drone.js';
import { Bullet } from './bullet.js';
import { DebugSystem } from './debug.js';
import { HackMinigame } from './hack.js';

const hudMode     = document.getElementById('mode');
const hudObj      = document.getElementById('obj');
const hudHacks    = document.getElementById('hacks');
const overlay     = document.getElementById('overlay');
const overlayText = document.getElementById('overlay-text');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.setClearColor(0x05060a);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x05060a, 22, 62);

const CAM_YAW    = Math.PI * 75 / 180;
const CAM_RADIUS = 22;
const CAM_HEIGHT = 18;
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 220);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

scene.add(new THREE.AmbientLight(0x8899aa, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(20, 40, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -50; sun.shadow.camera.right = 50;
sun.shadow.camera.top  =  50; sun.shadow.camera.bottom = -50;
scene.add(sun);

// Map — ~25% larger than previous 54×54
const map = generateMap(68, 68, 18);
buildMapMesh(map, scene);

// Player — spawns at a validated floor cell near first room's centre
const startRoom  = map.rooms[0];
const spawnCell  = findValidFloor(map, startRoom.cx, startRoom.cy) ?? { x: startRoom.cx, z: startRoom.cy };
const player     = new Player(scene, spawnCell.x, spawnCell.z);

// Objectives
const spotACell = pickFloorCell(map, { x: spawnCell.x, y: spawnCell.z }, 18);
const exitCell  = pickFloorCell(map, { x: spotACell.x, y: spotACell.y  }, 14);

function makeMarker(color, x, z) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.65, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.03, z);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 3.2, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 })
  );
  beacon.position.set(x, 1.6, z);
  g.add(ring); g.add(beacon);
  scene.add(g);
  return g;
}
const spotAMarker = makeMarker(0x22ddff, spotACell.x, spotACell.y);
const exitMarker  = makeMarker(0x77ff55, exitCell.x,  exitCell.y);
exitMarker.visible = false;

// ── Hack points ──────────────────────────────────────────────────────────────
const MAX_HACKS     = 5;
const HACK_PICK_COUNT = 10 + Math.floor(Math.random() * 4); // 10-13 on map
let   hacksCollected  = 0;

const hackCells = pickSpreadFloorCells(map, HACK_PICK_COUNT, 6,
  { x: spawnCell.x, z: spawnCell.z }, 8);

const hackMeshes = hackCells.map(cell => {
  const geo = new THREE.BoxGeometry(0.45, 0.55, 0.45);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8833ff, emissive: 0x441188, roughness: 0.4, metalness: 0.5,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(cell.x, 0.35, cell.z);
  m.castShadow = true;
  scene.add(m);
  // Glow ring on floor
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.5, 20),
    new THREE.MeshBasicMaterial({ color: 0xaa44ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(cell.x, 0.02, cell.z);
  scene.add(ring);
  m.userData.ring = ring;
  m.userData.collected = false;
  return m;
});

function updateHacksHUD() {
  hudHacks.innerHTML = `Hacks: <b>${hacksCollected} / ${MAX_HACKS}</b>`;
  // Keep the hack terminal's HP counter in sync with the world pool even if
  // the terminal is already open (e.g. during debug).
  if (hacker && typeof hacker._updateHPDisplay === 'function') {
    hacker._updateHPDisplay();
  }
}

// ── Enemies ──────────────────────────────────────────────────────────────────
const enemies = [];
const enemyCount = 6 + Math.floor(Math.random() * 3);

function buildEnemyRoute(enemy) {
  const p     = enemy.position;
  const rooms = map.rooms;

  // Find closest room to this enemy as route start
  let startRoom = rooms[0], bestD = Infinity;
  for (const r of rooms) {
    const d = Math.hypot(p.x - r.cx, p.z - r.cy);
    if (d < bestD) { bestD = d; startRoom = r; }
  }

  // Pick a different room far enough away as the other endpoint
  const candidates = rooms.filter(r =>
    r !== startRoom && Math.hypot(r.cx - startRoom.cx, r.cy - startRoom.cy) > 10
  );
  const endRoom = candidates.length
    ? candidates[Math.floor(Math.random() * candidates.length)]
    : rooms[(rooms.indexOf(startRoom) + 1) % rooms.length];

  // Snap both endpoints to valid floor cells
  const jitter = () => Math.round((Math.random() - 0.5) * 2);
  const a = findValidFloor(map, startRoom.cx + jitter(), startRoom.cy + jitter());
  const b = findValidFloor(map, endRoom.cx   + jitter(), endRoom.cy   + jitter());
  if (!a || !b) return;

  // BFS path — guaranteed axis-aligned, no wall crossings
  const path = findPath(map, a.x, a.z, b.x, b.z);
  if (path && path.length >= 2) enemy.setRoutePath(path);
}

for (let i = 0; i < enemyCount; i++) {
  const room = map.rooms[1 + (i % (map.rooms.length - 1))] || map.rooms[0];
  // Snap spawn to a valid (non-wall, non-obstacle) cell near room centre
  const spawnPos = findValidFloor(map, room.cx, room.cy);
  if (!spawnPos) continue;
  if (Math.hypot(spawnPos.x - spawnCell.x, spawnPos.z - spawnCell.z) < 6) continue;
  const e = new Enemy(scene, spawnPos.x, spawnPos.z);
  buildEnemyRoute(e);
  enemies.push(e);
}

// Debug system — TAB
const debug = new DebugSystem(scene);
debug.buildRoutes(enemies);

// Hacking minigame — R. Premium in-terminal commands (cls, overclock, numeric
// shortcuts) spend hack points from the world pool.
const hacker = new HackMinigame({
  getHP:   () => hacksCollected,
  spendHP: (n) => {
    hacksCollected = Math.max(0, hacksCollected - n);
    updateHacksHUD();
  },
});
// ── Hack-link target selection & range ring ─────────────────────────────────
const HACK_RANGE = 5.0;
const hackRing = (() => {
  const g = new THREE.RingGeometry(HACK_RANGE - 0.12, HACK_RANGE, 64);
  const m = new THREE.MeshBasicMaterial({
    color: 0x99ccff, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  });
  const r = new THREE.Mesh(g, m);
  r.rotation.x = -Math.PI / 2;
  r.position.y = 0.02;
  r.visible = false;
  scene.add(r);
  return r;
})();
const pickRing = (() => {
  const g = new THREE.RingGeometry(0.5, 0.72, 24);
  const m = new THREE.MeshBasicMaterial({
    color: 0xffcc66, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
  });
  const r = new THREE.Mesh(g, m);
  r.rotation.x = -Math.PI / 2;
  r.position.y = 0.03;
  r.visible = false;
  scene.add(r);
  return r;
})();

function findHackLinkTarget() {
  let best = null, bestDist = Infinity;
  const p = player.position;
  for (const e of enemies.concat(drones)) {
    if (!e.alive || e.faction === 'friendly') continue;
    const d = Math.hypot(e.mesh.position.x - p.x, e.mesh.position.z - p.z);
    if (d > HACK_RANGE) continue;
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

window.addEventListener('keydown', e => {
  if (gameOver || hacker.active) return;
  const k = e.key.toLowerCase();
  if (k === 'r') {
    const p = player.position;
    // Spot A becomes a hackable objective until it's collected.
    const spotDist = Math.hypot(p.x - spotACell.x, p.z - spotACell.y);
    const spotInRange = !foundSpotA && spotDist < HACK_RANGE;
    const enemyTarget = findHackLinkTarget();
    const enemyDist = enemyTarget
      ? Math.hypot(p.x - enemyTarget.mesh.position.x, p.z - enemyTarget.mesh.position.z)
      : Infinity;

    // Choose whichever hackable is closer.
    let isSpot = false, target = null;
    if (spotInRange && spotDist <= enemyDist) { isSpot = true; target = 'spot'; }
    else if (enemyTarget)                     { target = enemyTarget; }

    hackRing.position.set(p.x, 0.02, p.z);
    hackRing.visible = true;
    if (!target) {
      setTimeout(() => { hackRing.visible = false; }, 450);
      return;
    }

    if (isSpot) pickRing.position.set(spotACell.x, 0.03, spotACell.y);
    else        pickRing.position.set(target.mesh.position.x, 0.03, target.mesh.position.z);
    pickRing.visible = true;

    // Difficulty: debug shortcut overrides everything; otherwise per-target.
    let diff;
    if (debug.enabled)            diff = 2;
    else if (isSpot)              diff = 7;
    else if (target instanceof Drone) diff = 3;
    else                           diff = 5;

    hacker.open(diff, {
      onClose: (won) => {
        hackRing.visible = false;
        pickRing.visible = false;
        if (!won) return;
        if (isSpot) {
          foundSpotA = true;
          spotAMarker.visible = false;
          exitMarker.visible  = true;
          hudObj.innerHTML    = 'Objective: reach the <b style="color:#7f5">Exit</b>';
        } else if (target.alive && typeof target.hackLink === 'function') {
          target.hackLink();
        }
      },
    });
    return;
  }
  // 1..9 still opens a practice maze at that difficulty (debug mode pins to 2).
  if (k >= '1' && k <= '9') hacker.open(debug.enabled ? 2 : parseInt(k, 10));
});

// ── Game state ────────────────────────────────────────────────────────────────
const bullets   = [];
let battleMode  = false;
let foundSpotA  = false;
let gameOver    = false;

// Gun shot — SPACE fires a bullet in the player's last-facing direction.
// Cooldown is 5 s in stealth; in battle it only drains while the player moves
// (same SUPERHOT rule the rest of the world obeys).
const SHOT_COOLDOWN = 5.0;
let   shotCooldown  = 0;

const hudShot = document.getElementById('shot');
function updateShotHUD() {
  if (!hudShot) return;
  hudShot.innerHTML = shotCooldown <= 0
    ? 'Shot: <b style="color:#7ff">READY</b>'
    : `Shot: <b>${shotCooldown.toFixed(1)}s</b>`;
}

window.addEventListener('keydown', e => {
  if (e.key !== ' ') return;
  if (gameOver || hacker.active) return;
  if (shotCooldown > 0) return;
  const d = player.facingDir;
  const len = Math.hypot(d.x, d.z) || 1;
  game.spawnBullet(
    player.position.x + (d.x / len) * 0.6,
    player.position.z + (d.z / len) * 0.6,
    d.x / len, d.z / len,
    'player',
  );
  shotCooldown = SHOT_COOLDOWN;
  updateShotHUD();
});

// ── Drones ────────────────────────────────────────────────────────────────
// Not spawned at start. Every time a soldier first-sees the player, a new
// batch of 2 drones is spawned in rooms far from the player, initially
// heading toward the room where the spot happened. Total over a run grows
// with `timesSpotted × 2`.
const drones       = [];
let   timesSpotted = 0;

function findRoomAt(x, z) {
  let best = null, bestDist = Infinity;
  for (const r of map.rooms) {
    const d = Math.hypot(x - r.cx, z - r.cy);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
}

function spawnDroneBatch(spottedRoom, count = 2) {
  if (!map.rooms?.length) return;
  // Sort rooms by distance from player, farthest first, to place drones
  // well away from the action.
  const sorted = [...map.rooms].sort((a, b) =>
    Math.hypot(b.cx - player.position.x, b.cy - player.position.z) -
    Math.hypot(a.cx - player.position.x, a.cy - player.position.z)
  );
  const firstTarget = spottedRoom
    ? { x: spottedRoom.cx, z: spottedRoom.cy }
    : null;
  for (let i = 0; i < count; i++) {
    const room = sorted[i % sorted.length];
    const pos  = findValidFloor(map, room.cx, room.cy);
    if (!pos) continue;
    drones.push(new Drone(scene, pos.x, pos.z, firstTarget));
  }
}

const game = {
  onEnemySeesPlayer(source) {
    // Only soldier spots trigger drone reinforcements — drones spotting the
    // player again shouldn't snowball extra waves.
    if (!(source instanceof Enemy)) return;
    timesSpotted++;
    const spottedRoom = findRoomAt(player.position.x, player.position.z);
    spawnDroneBatch(spottedRoom, 2);
  },
  spawnBullet(x, z, dx, dz, owner = 'enemy') {
    bullets.push(new Bullet(scene, x, z, dx, dz, owner));
  },
};

function updateModeUI() {
  hudMode.textContent = battleMode ? 'BATTLE' : 'STEALTH';
  hudMode.className   = 'mode ' + (battleMode ? 'battle' : 'stealth');
}
function endGame(msg) {
  gameOver = true;
  overlayText.textContent = msg;
  overlay.style.display   = 'flex';
}

const clock = new THREE.Clock();
let   time  = 0;

function animate() {
  if (gameOver) return;
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;

  // Freeze game world while hacking
  if (hacker.active) { renderer.render(scene, camera); return; }

  player.update(dt, map);

  // Battle mode = some HOSTILE enemy is actively tracking the player. Friendly
  // enemies fighting other hostiles don't count — the player is allied with them.
  const anyAlerted =
    enemies.some(e => e.alive && e.alerted && e.faction === 'hostile') ||
    drones.some(d => d.alive && d.alerted && d.faction === 'hostile');
  if (anyAlerted !== battleMode) { battleMode = anyAlerted; updateModeUI(); }

  // SUPERHOT: enemies move at full speed with player, slow to 8% when player stops
  let worldDt = dt;
  if (battleMode) {
    const nominal = player.speed * dt;
    const ratio   = nominal > 0.0001 ? player.lastMoveAmount / nominal : 0;
    worldDt = dt * Math.max(ratio, 0.08); // never fully freeze — always 8% minimum
  }

  const worldView = { player, enemies, drones };
  for (const e of enemies) e.update(worldDt, map, worldView, game);
  for (const d of drones)  d.update(worldDt, map, worldView, game, time);

  // Player bullets can damage both soldiers and drones.
  const bulletTargets = enemies.concat(drones);
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const r = b.update(worldDt, map, player, bulletTargets);
    if (r === 'hit') return endGame('You were eliminated');
    if (!b.alive) bullets.splice(i, 1);
  }

  // Shot cooldown drains with real time in stealth, with worldDt in battle so
  // the same SUPERHOT bargain applies (stop moving ⇒ reload crawls).
  if (shotCooldown > 0) {
    shotCooldown = Math.max(0, shotCooldown - (battleMode ? worldDt : dt));
    updateShotHUD();
  }

  // Camera follow
  const pos = player.position;
  camera.position.set(
    pos.x + Math.sin(CAM_YAW) * CAM_RADIUS,
    CAM_HEIGHT,
    pos.z + Math.cos(CAM_YAW) * CAM_RADIUS
  );
  camera.lookAt(pos.x, 0.5, pos.z);

  // Hack point collection + animation
  for (const m of hackMeshes) {
    if (m.userData.collected) continue;
    m.rotation.y = time * 1.8;
    m.position.y = 0.35 + Math.sin(time * 2.2 + m.position.x) * 0.07;
    if (hacksCollected < MAX_HACKS &&
        Math.hypot(pos.x - m.position.x, pos.z - m.position.z) < 0.7) {
      m.userData.collected = true;
      scene.remove(m);
      scene.remove(m.userData.ring);
      hacksCollected++;
      updateHacksHUD();
    }
  }

  // Objectives — Spot A is no longer claimed by walking over it; the player
  // must Hack-Link it (R key within HACK_RANGE, difficulty 7). The exit is
  // still a simple walk-over once Spot A is compromised.
  if (foundSpotA && Math.hypot(pos.x - exitCell.x, pos.z - exitCell.y) < 0.85) {
    return endGame('Map cleared!');
  }

  debug.update(player, enemies, battleMode);
  renderer.render(scene, camera);
}

updateModeUI();
updateHacksHUD();
updateShotHUD();
animate();
