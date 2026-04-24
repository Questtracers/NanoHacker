import * as THREE from 'three';
import { generateMap, buildMapMesh, pickFloorCell, findPath, findValidFloor, pickSpreadFloorCells } from './map.js';
import { Player } from './player.js';
import { Enemy } from './enemy.js';
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

// Hacking minigame — R
const hacker = new HackMinigame();
window.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'r' && !gameOver && !hacker.active) hacker.open();
});

// ── Game state ────────────────────────────────────────────────────────────────
const bullets   = [];
let battleMode  = false;
let foundSpotA  = false;
let gameOver    = false;

const game = {
  onEnemySeesPlayer() {},
  spawnBullet(x, z, dx, dz) { bullets.push(new Bullet(scene, x, z, dx, dz)); },
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

  const anyAlerted = enemies.some(e => e.alive && e.alerted);
  if (anyAlerted !== battleMode) { battleMode = anyAlerted; updateModeUI(); }

  // SUPERHOT: enemies move at full speed with player, slow to 8% when player stops
  let worldDt = dt;
  if (battleMode) {
    const nominal = player.speed * dt;
    const ratio   = nominal > 0.0001 ? player.lastMoveAmount / nominal : 0;
    worldDt = dt * Math.max(ratio, 0.08); // never fully freeze — always 8% minimum
  }

  for (const e of enemies) e.update(worldDt, map, player, game);

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const r = b.update(worldDt, map, player);
    if (r === 'hit') return endGame('You were eliminated');
    if (!b.alive) bullets.splice(i, 1);
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

  // Objectives
  if (!foundSpotA && Math.hypot(pos.x - spotACell.x, pos.z - spotACell.y) < 0.85) {
    foundSpotA = true;
    spotAMarker.visible = false;
    exitMarker.visible  = true;
    hudObj.innerHTML    = 'Objective: reach the <b style="color:#7f5">Exit</b>';
  }
  if (foundSpotA && Math.hypot(pos.x - exitCell.x, pos.z - exitCell.y) < 0.85) {
    return endGame('Map cleared!');
  }

  debug.update(player, enemies, battleMode);
  renderer.render(scene, camera);
}

updateModeUI();
updateHacksHUD();
animate();
