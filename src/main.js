import * as THREE from 'three';
import { generateMap, buildMapMesh, pickFloorCell, findPath, findValidFloor, pickSpreadFloorCells } from './map.js';
import { Player } from './player.js';
import { Enemy } from './enemy.js';
import { Drone } from './drone.js';
import { Door } from './door.js';
import { Bullet } from './bullet.js';
import { DebugSystem } from './debug.js';
import { HackMinigame } from './hack.js';
import { showCorpLogo } from './corplogo.js';

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

// Find a clean spawn spot near (cx, cz). Three passes:
//   1. all 8 neighbours walkable (true open floor)
//   2. all 4 NSEW neighbours walkable (free of obstacles on cardinal sides)
//   3. fallback to the standard findValidFloor (may end up next to something)
// This keeps soldiers off obstacle edges in tight rooms where a strict 8-
// neighbour search wouldn't find anything.
function findCenteredFloor(cx, cz, radius = 8) {
  const isFree = (x, z) =>
    x > 0 && z > 0 && x < map.width - 1 && z < map.height - 1 &&
    map.grid[z][x] === 0;
  // Pass 1 — fully centered cell
  for (let r = 0; r <= radius; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(cx + dx), z = Math.round(cz + dz);
        if (!isFree(x, z)) continue;
        let ok = true;
        for (let oz = -1; oz <= 1 && ok; oz++) {
          for (let ox = -1; ox <= 1 && ok; ox++) {
            if (ox === 0 && oz === 0) continue;
            if (!isFree(x + ox, z + oz)) ok = false;
          }
        }
        if (ok) return { x, z };
      }
    }
  }
  // Pass 2 — only the 4 NSEW neighbours need to be walkable
  for (let r = 0; r <= radius; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(cx + dx), z = Math.round(cz + dz);
        if (!isFree(x, z)) continue;
        if (isFree(x + 1, z) && isFree(x - 1, z) &&
            isFree(x, z + 1) && isFree(x, z - 1)) return { x, z };
      }
    }
  }
  return findValidFloor(map, cx, cz);
}

for (let i = 0; i < enemyCount; i++) {
  const room = map.rooms[1 + (i % (map.rooms.length - 1))] || map.rooms[0];
  const spawnPos = findCenteredFloor(room.cx, room.cy);
  if (!spawnPos) continue;
  if (Math.hypot(spawnPos.x - spawnCell.x, spawnPos.z - spawnCell.z) < 6) continue;
  const e = new Enemy(scene, spawnPos.x, spawnPos.z);
  buildEnemyRoute(e);
  enemies.push(e);
}

// Debug system — TAB
const debug = new DebugSystem(scene);
debug.buildRoutes(enemies);

// ── Doors ────────────────────────────────────────────────────────────────────
// Doors live ONLY in the 3-cell-wide corridors that the map generator carves
// between consecutive rooms. Each such corridor independently has a 50 % chance
// of receiving exactly one door, placed on a corridor cell that lies outside
// every room rectangle (so they're never confused with in-room obstacles).
const doors = [];
function spawnCorridorDoors() {
  const isInsideAnyRoom = (x, y) => {
    for (const r of map.rooms) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
    }
    return false;
  };

  for (let i = 1; i < map.rooms.length; i++) {
    if (Math.random() >= 0.5) continue; // 50 % per corridor

    // Reconstruct the same L-shape the generator carved: horizontal leg first
    // along the source room's centre row, then vertical leg up the dest col.
    const a = map.rooms[i - 1];
    const b = map.rooms[i];
    let cx = a.cx, cy = a.cy;
    const tx = b.cx, ty = b.cy;
    const path = [];
    while (cx !== tx) {
      path.push({ x: cx, y: cy, dir: 'EW' });
      cx += cx < tx ? 1 : -1;
    }
    while (cy !== ty) {
      path.push({ x: cx, y: cy, dir: 'NS' });
      cy += cy < ty ? 1 : -1;
    }

    // Keep only true corridor cells (outside all rooms), away from spawn,
    // not piling up on top of another door, AND on a straight stretch (skip
    // any cell where the corridor changes direction so a door never sits on
    // an L-bend, which would render with the slab not actually covering the
    // passable cells).
    const valid = path.filter((p, i) => {
      if (isInsideAnyRoom(p.x, p.y)) return false;
      if (Math.hypot(p.x - spawnCell.x, p.y - spawnCell.z) <= 4) return false;
      if (doors.some(d => Math.hypot(d.x - p.x, d.z - p.y) < 3)) return false;
      const prev = path[i - 1];
      const next = path[i + 1];
      if (prev && prev.dir !== p.dir) return false;
      if (next && next.dir !== p.dir) return false;
      return true;
    });
    if (!valid.length) continue;

    // Pick somewhere in the middle third for a more chokepoint-y feel.
    const lo = Math.floor(valid.length * 0.25);
    const hi = Math.max(lo + 1, Math.floor(valid.length * 0.75));
    const idx = lo + Math.floor(Math.random() * (hi - lo));
    const pt  = valid[idx];
    doors.push(new Door(scene, pt.x, pt.y, pt.dir));
  }
}
spawnCorridorDoors();

// Returns true if a closed (and un-hacked) door overlaps the player at (x, z).
function doorBlocksPlayer(x, z) {
  for (const d of doors) if (d.blocksPlayerAt(x, z)) return true;
  return false;
}

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
  // Soldiers + drones + un-hacked doors are all valid hack targets.
  for (const e of enemies.concat(drones).concat(doors)) {
    if (!e.alive || e.faction === 'friendly') continue;
    const d = Math.hypot(e.mesh.position.x - p.x, e.mesh.position.z - p.z);
    if (d > HACK_RANGE) continue;
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

window.addEventListener('keydown', e => {
  if (gameOver || hacker.active || pendingHack) return;
  const k = e.key.toLowerCase();
  if (k === 'r') {
    const p = player.position;
    const spotDist = Math.hypot(p.x - spotACell.x, p.z - spotACell.y);
    const spotInRange = !foundSpotA && spotDist < HACK_RANGE;
    const enemyTarget = findHackLinkTarget();
    const enemyDist = enemyTarget
      ? Math.hypot(p.x - enemyTarget.mesh.position.x, p.z - enemyTarget.mesh.position.z)
      : Infinity;

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

    let diff;
    if (debug.enabled)                diff = 2;
    else if (isSpot)                  diff = 7;
    else if (target instanceof Door)  diff = 2;
    else if (target instanceof Drone) diff = 3;
    else                              diff = 5;

    const onClose = (won) => {
      hackRing.visible = false;
      pickRing.visible = false;
      if (won) {
        if (isSpot) {
          foundSpotA = true;
          spotAMarker.visible = false;
          exitMarker.visible  = true;
          hudObj.innerHTML    = 'Objective: reach the <b style="color:#7f5">Exit</b>';
        } else if (target.alive && typeof target.hackLink === 'function') {
          target.hackLink();
        }
        return;
      }
      // Failed hack: 1 HP damage to the player.
      playerTakeDamage(1);
      // Doors don't react — they just stay closed. Spot A is an objective,
      // not an entity. Only enemies become aware on a failed hack.
      if (!isSpot && target && target.alive && !(target instanceof Door)) {
        target.alerted          = true;
        target.losingSightTimer = 0;
        const ep = target.mesh.position;
        const dx = player.position.x - ep.x;
        const dz = player.position.z - ep.z;
        const faceTarget = Math.atan2(dx, dz);
        target.facing = faceTarget;
        if ('targetFacing' in target) target.targetFacing = faceTarget;
        if (target instanceof Enemy) {
          game.onEnemySeesPlayer(target, player);
        }
      }
    };

    // Stage a pending hack so the world freezes and the lock-on ring pulses
    // for a short beat before the terminal actually opens.
    pendingHack = { target, isSpot, diff, onClose, startTime: performance.now() };
    return;
  }
  if (k >= '1' && k <= '9') hacker.open(debug.enabled ? 2 : parseInt(k, 10));
});

// Run the lock-on effect for one frame. Returns true while the pulse is still
// ongoing (so the animate loop can skip world updates), false once the hack
// has been handed off to the terminal.
function tickPendingHack() {
  if (!pendingHack) return false;
  const elapsed  = performance.now() - pendingHack.startTime;
  const progress = Math.min(elapsed / HACK_PREP_MS, 1);
  // Scale pulse: outward expansion that settles back to ~1 by the end.
  const scale   = 1 + Math.sin(progress * Math.PI) * 0.9;
  const opacity = 0.6 + 0.4 * Math.sin(progress * Math.PI * 4);
  pickRing.scale.setScalar(scale);
  pickRing.material.opacity = opacity;
  // Shift the ring colour from yellow → cyan for a "locking in" vibe.
  const hue = 0.12 + progress * 0.35;
  pickRing.material.color.setHSL(hue, 1, 0.6);
  if (progress >= 1) {
    const p = pendingHack;
    pendingHack = null;
    pickRing.scale.setScalar(1);
    pickRing.material.opacity = 0.9;
    pickRing.material.color.setHex(0xffcc66);
    hacker.open(p.diff, { onClose: p.onClose });
  }
  return true;
}

// ── Game state ────────────────────────────────────────────────────────────────
const bullets   = [];
let battleMode  = false;
let foundSpotA  = false;
let gameOver    = false;

// ── Player life ─────────────────────────────────────────────────────────────
const PLAYER_MAX_HP = 2;
let   playerHp      = PLAYER_MAX_HP;
const hudPlayerHP   = document.getElementById('php');
function updatePlayerHPHUD() {
  if (hudPlayerHP) hudPlayerHP.innerHTML = `HP: <b>${playerHp} / ${PLAYER_MAX_HP}</b>`;
}
function playerTakeDamage(n = 1) {
  if (gameOver) return;
  playerHp = Math.max(0, playerHp - n);
  updatePlayerHPHUD();
  if (playerHp <= 0) endGame('You were eliminated');
}

// Pending hack-link: briefly freezes the world and animates the lock-on ring
// over the target before the maze actually opens.
const HACK_PREP_MS = 850;
let   pendingHack  = null; // { target, isSpot, diff, onClose, startTime }

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

  // Pre-hack lock-on pulse freezes the world like an active hack does.
  if (tickPendingHack()) { renderer.render(scene, camera); return; }
  if (hacker.active)     { renderer.render(scene, camera); return; }

  player.update(dt, map, doorBlocksPlayer);

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
  // Doors animate at real-time speed (not SUPERHOT-modulated) so the open
  // animation always feels responsive when an enemy approaches.
  for (const dr of doors) dr.update(dt, worldView);

  // Player bullets can damage both soldiers and drones.
  const bulletTargets = enemies.concat(drones);
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const r = b.update(worldDt, map, player, bulletTargets);
    if (r === 'hit') {
      playerTakeDamage(1);
      if (gameOver) return;
    }
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
updatePlayerHPHUD();
// Intro splash: shows the target corp for a few seconds before the run
// begins, then starts the animation loop.
showCorpLogo({ durationMs: 3500, fadeMs: 700 }, animate);
