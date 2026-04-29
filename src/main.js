import * as THREE from 'three';
import { generateMap, buildMapMesh, pickFloorCell, findPath, findValidFloor, pickSpreadFloorCells, setRayBlocker } from './map.js';
import { buildLevelTiles, attachDoorFrame } from './level-tiles.js';
import { Player } from './player.js';
import { Enemy } from './enemy.js';
import { Drone } from './drone.js';
import { Door } from './door.js';
import { Obstacle, updateCrateDebris } from './obstacle.js';
import { Mecha } from './mecha.js';
import { Bullet, updatePlayerArrowVFX } from './bullet.js';
import { updateRocketExplosions } from './rocket-explosion.js';
import { spawnHackSwarm, updateHackSwarm } from './hack-swarm.js';
import { spawnConfetti, updateConfetti } from './confetti.js';
import { Rocket } from './rocket.js';
import { DebugSystem } from './debug.js';
import { HackMinigame } from './hack.js';
import { showCorpLogo } from './corplogo.js';
import { runDebugLevel } from './debug-level.js';
import { runTutorialLevel } from './tutorial-level.js';

const hudMode     = document.getElementById('mode');

// Tiny always-on overlay for the tile-tweak keys (I/K Y-offset, O/L
// wall-height scale). Sits in the top-right so it doesn't fight the
// main HUD. Refreshed by _refreshTileTweakHud whenever a key changes
// the values; updated in animate() too so the actual metric reads
// stay in sync if anything else mutates the group.
const _tileTweakHud = document.createElement('div');
_tileTweakHud.style.cssText = [
  'position:fixed', 'top:8px', 'right:8px', 'z-index:11',
  'padding:6px 10px',
  'background:rgba(0,5,15,0.7)', 'border:1px solid #0ff5',
  'border-radius:4px', 'font-family:monospace', 'font-size:12px',
  'color:#cfe', 'line-height:1.5', 'pointer-events:none',
  'white-space:nowrap',
].join(';');
document.body.appendChild(_tileTweakHud);
_tileTweakHud.innerHTML = '<span style="color:#789">tile tweak (waiting for load)</span>';
function _refreshTileTweakHud() {
  // levelTilesGroup is declared later in this file; only safe to read
  // once buildLevelTiles' Promise has populated it.
  const g = (typeof levelTilesGroup !== 'undefined') ? levelTilesGroup : null;
  if (!g) {
    _tileTweakHud.innerHTML = '<span style="color:#789">tile tweak (waiting for load)</span>';
    return;
  }
  const yOff   = g.position.y;
  const walls  = g.getObjectByName('walls');
  const wScale = walls ? walls.scale.y : 1;
  const wBase  = g.userData.wallBaseHeight || 0;
  const wallM  = wBase * wScale;
  _tileTweakHud.innerHTML =
    '<b style="color:#0ff">tile tweak</b><br>' +
    `<span style="color:#aaa">I / K</span> &nbsp;` +
    `Y offset: <b style="color:#ff0">${yOff.toFixed(2)} m</b><br>` +
    `<span style="color:#aaa">O / L</span> &nbsp;` +
    `wall height: <b style="color:#ff0">${wallM.toFixed(2)} m</b> ` +
    `<span style="color:#789">(× ${wScale.toFixed(2)})</span>`;
}
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
// 35 % closer than the original 22 / 18 framing — keeps the same isometric
// angle but pulls the character in for a more readable scale.
const CAM_RADIUS = 14.3;
const CAM_HEIGHT = 11.7;
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
// Box-wall fallback. Stays visible until the GLB tileset finishes
// loading, then we remove it. If the tileset load fails the fallback
// keeps the level navigable (boxes for walls, flat plane for floor).
const fallbackMapMesh = buildMapMesh(map, scene);
let levelTilesGroup = null;
buildLevelTiles(map, scene)
  .then((group) => {
    levelTilesGroup = group;
    _refreshTileTweakHud();
    if (fallbackMapMesh && fallbackMapMesh.parent) {
      fallbackMapMesh.parent.remove(fallbackMapMesh);
    }
    // Doors placed before the tileset finished loading get their
    // frames retro-attached now.
    for (const d of doors) {
      if (d._frameAttached) continue;
      attachDoorFrame(levelTilesGroup, scene, d.x, d.z, d.corridorDir, d.slabWidth);
      d._frameAttached = true;
    }
  })
  .catch((err) => {
    console.warn('level-tiles load failed; keeping box-wall fallback', err);
  });

// ── Destructible obstacles ──────────────────────────────────────────────────
// Group adjacent grid==2 cells into Obstacle entities. Each has 2 HP and
// renders as a per-cell Box stack via the Obstacle class.
const obstacles      = [];
const obstacleByCell = new Map();
{
  const seen = new Set();
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const k = `${r},${c}`;
      if (seen.has(k) || map.grid[r][c] !== 2) continue;
      const cells = [];
      const queue = [{ r, c }];
      seen.add(k);
      while (queue.length) {
        const cur = queue.shift();
        cells.push({ row: cur.r, col: cur.c });
        for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nr = cur.r + dr, nc = cur.c + dc;
          const nk = `${nr},${nc}`;
          if (seen.has(nk)) continue;
          if (nr < 0 || nr >= map.height || nc < 0 || nc >= map.width) continue;
          if (map.grid[nr][nc] !== 2) continue;
          seen.add(nk);
          queue.push({ r: nr, c: nc });
        }
      }
      const o = new Obstacle(scene, cells);
      obstacles.push(o);
      for (const cell of cells) obstacleByCell.set(`${cell.row},${cell.col}`, o);
    }
  }
}

function obstacleAt(x, z) {
  return obstacleByCell.get(`${Math.round(z)},${Math.round(x)}`) || null;
}

// Drop a single dead cell from both the index and the map grid so movement
// & vision pass through that exact tile (without affecting the rest of the
// obstacle structure).
function _retireCell(cell) {
  map.grid[cell.row][cell.col] = 0;
  obstacleByCell.delete(`${cell.row},${cell.col}`);
}

function damageObstacleAt(x, z, n = 1) {
  const o = obstacleAt(x, z);
  if (!o || !o.alive) return false;
  const dead = o.takeDamageAt(x, z, n);
  if (dead) _retireCell(dead);
  return true;
}

function destroyObstacleAt(x, z) {
  const o = obstacleAt(x, z);
  if (!o || !o.alive) return false;
  const dead = o.destroyCellAt(x, z);
  if (dead) _retireCell(dead);
  return true;
}

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

// ── Off-screen objective pointers ────────────────────────────────────────────
// Tiny edge-pinned arrows that rotate to face the active objective when it's
// outside the camera frustum. Hidden when the objective is on-screen so they
// don't fight the world marker for attention.
const arrowSpot = document.getElementById('arrow-spot');
const arrowExit = document.getElementById('arrow-exit');
const _projVec  = new THREE.Vector3();

function updateObjectiveArrow(el, worldX, worldZ, visible) {
  if (!visible) { el.style.opacity = '0'; return; }
  // Project to NDC. If z > 1 the target is behind the camera — flip the
  // direction so the arrow points the way you'd actually have to turn.
  _projVec.set(worldX, 0.5, worldZ).project(camera);
  let nx = _projVec.x, ny = _projVec.y;
  const behind = _projVec.z > 1;
  if (behind) { nx = -nx; ny = -ny; }
  const onScreen =
    !behind && Math.abs(nx) <= 0.95 && Math.abs(ny) <= 0.95;
  if (onScreen) { el.style.opacity = '0'; return; }
  // Push the point onto a screen-edge rectangle (with a small inset margin).
  const margin = 0.08;
  const limit  = 1 - margin;
  const k = Math.max(Math.abs(nx), Math.abs(ny)) || 1;
  const ex = (nx / k) * limit;
  const ey = (ny / k) * limit;
  const px = (ex + 1) * 0.5 * window.innerWidth;
  const py = (1 - ey) * 0.5 * window.innerHeight;
  // Triangle's transform-origin is its tip (left edge). Rotate to point at
  // the target direction — atan2 in screen space (note the y flip).
  const angle = Math.atan2(-ny, nx); // screen y is inverted
  el.style.transform =
    `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${angle}rad)`;
  el.style.opacity = '0.9';
}

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

// ── Mechas — heavy hostile that ignores obstacles and crushes them ─────────
// 3 per run. Spawn on rooms far from the player, idle near their spawn until
// alerted (line of sight or another hostile spotting nearby).
const mechas = [];
{
  const sortedRooms = [...map.rooms].sort((a, b) =>
    Math.hypot(b.cx - spawnCell.x, b.cy - spawnCell.z) -
    Math.hypot(a.cx - spawnCell.x, a.cy - spawnCell.z)
  );
  let placed = 0;
  for (const room of sortedRooms) {
    if (placed >= 3) break;
    const pos = findValidFloor(map, room.cx, room.cy);
    if (!pos) continue;
    if (Math.hypot(pos.x - spawnCell.x, pos.z - spawnCell.z) < 10) continue;
    mechas.push(new Mecha(scene, pos.x, pos.z));
    placed++;
  }
}
// Diagnostic hook for in-page testing — gives the preview console
// access to the live game state. Safe to leave; only adds globals.
window.__nano = { mechas, get player() { return player; }, get game() { return game; }, scene };

// Debug system — TAB
const debug = new DebugSystem(scene);
debug.buildRoutes(enemies);

// ── Doors ────────────────────────────────────────────────────────────────────
// Doors live ONLY on cells that are GEOMETRICALLY a straight corridor — i.e.
// floor with parallel walls bracketing the passage. Orientation and width are
// measured from the actual neighbours (not inferred from the L-path) so a
// door can never end up on a bend, intersection, or inside a room.
const doors = [];
function spawnCorridorDoors() {
  const isFloor = (x, y) =>
    x >= 0 && y >= 0 && x < map.width && y < map.height && map.grid[y][x] === 0;
  const isWallCell = (x, y) =>
    x < 0 || y < 0 || x >= map.width || y >= map.height || map.grid[y][x] === 1;

  const isInsideAnyRoom = (x, y) => {
    for (const r of map.rooms) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
    }
    return false;
  };

  // Walk outward along an axis until both sides hit a wall (true corridor)
  // or we exceed the cap (open area / room). Returns lo/hi/width or null if
  // the axis isn't tightly bounded.
  function boundedAxis(x, y, axis) {
    const MAX = 4;
    let lo = 0, hi = 0;
    const step = (n) => axis === 'Z' ? [x, y + n] : [x + n, y];
    while (lo <= MAX) {
      const [nx, nz] = step(-(lo + 1));
      if (!isFloor(nx, nz)) break;
      lo++;
    }
    while (hi <= MAX) {
      const [nx, nz] = step(hi + 1);
      if (!isFloor(nx, nz)) break;
      hi++;
    }
    if (lo > MAX || hi > MAX) return null;
    const [lx, lz] = step(-(lo + 1));
    const [rx, rz] = step(hi + 1);
    if (!isWallCell(lx, lz) || !isWallCell(rx, rz)) return null;
    return { lo, hi, width: 1 + lo + hi };
  }

  // The corridor's orientation falls out of which axis is bounded:
  //   • Z bounded + X unbounded → EW corridor (slab spans Z).
  //   • X bounded + Z unbounded → NS corridor (slab spans X).
  // The candidate must also sit at the geometric CENTRE (lo == hi) so the
  // door slab — which renders symmetrically around the cell — actually
  // covers the corridor wall-to-wall instead of leaving a gap on one side.
  function corridorMeasure(x, y) {
    const zw = boundedAxis(x, y, 'Z');
    const xw = boundedAxis(x, y, 'X');
    if (zw && !xw && zw.lo === zw.hi) return { dir: 'EW', width: zw.width };
    if (xw && !zw && xw.lo === xw.hi) return { dir: 'NS', width: xw.width };
    return null;
  }

  for (let i = 1; i < map.rooms.length; i++) {
    if (Math.random() >= 0.5) continue; // 50 % per corridor

    // Reconstruct the L-path the generator carved so we sample only cells
    // on this specific corridor (instead of accidentally landing on shared
    // corridor segments).
    const a = map.rooms[i - 1];
    const b = map.rooms[i];
    let cx = a.cx, cy = a.cy;
    const tx = b.cx, ty = b.cy;
    const path = [];
    while (cx !== tx) {
      path.push({ x: cx, y: cy });
      cx += cx < tx ? 1 : -1;
    }
    while (cy !== ty) {
      path.push({ x: cx, y: cy });
      cy += cy < ty ? 1 : -1;
    }

    // Filter to GEOMETRICALLY-valid corridor cells.
    const valid = [];
    for (const p of path) {
      if (isInsideAnyRoom(p.x, p.y)) continue;
      if (Math.hypot(p.x - spawnCell.x, p.y - spawnCell.z) <= 4) continue;
      if (doors.some(d => Math.hypot(d.x - p.x, d.z - p.y) < 3)) continue;
      const m = corridorMeasure(p.x, p.y);
      if (!m) continue;
      valid.push({ ...p, dir: m.dir, width: m.width });
    }
    if (!valid.length) continue;

    // Pick somewhere in the middle third for a more chokepoint-y feel.
    const lo = Math.floor(valid.length * 0.25);
    const hi = Math.max(lo + 1, Math.floor(valid.length * 0.75));
    const idx = lo + Math.floor(Math.random() * (hi - lo));
    const pt  = valid[idx];
    {
      const door = new Door(scene, pt.x, pt.y, pt.dir, pt.width);
      doors.push(door);
      // If the tileset has loaded already, attach the static frame
      // immediately; otherwise the post-load handler retro-attaches.
      if (levelTilesGroup) {
        attachDoorFrame(levelTilesGroup, scene, pt.x, pt.y, pt.dir, pt.width);
        door._frameAttached = true;
      }
    }
  }
}
spawnCorridorDoors();

// Returns true if a closed (and un-hacked) door would obstruct the player's
// next position. Movement that pushes the player AWAY from the door's slab
// axis is permitted so anyone caught mid-cross when the door closes can
// still slip out — they just can't enter or stay put.
function doorBlocksPlayer(x, z) {
  const cx = player.position.x;
  const cz = player.position.z;
  for (const d of doors) {
    if (!d.blocksPlayerAt(x, z)) continue;
    const isEW = d.corridorDir === 'EW';
    const cur  = isEW ? Math.abs(cx - d.x) : Math.abs(cz - d.z);
    const nxt  = isEW ? Math.abs(x - d.x)  : Math.abs(z - d.z);
    if (nxt > cur) continue; // moving away from the slab — allowed
    return true;
  }
  return false;
}

// Generic door collision used by bullets and the cone ray-marcher. A closed,
// un-hacked door treats its footprint cells as solid for bullets/vision —
// pathfinding deliberately ignores this so AI can still route through.
function cellBlockedByDoor(x, z) {
  for (const d of doors) {
    if (!d.blocksPlayer()) continue;
    if (d.containsCell(x, z)) return true;
  }
  return false;
}
setRayBlocker(cellBlockedByDoor);

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
  // Soldiers + drones + mechas + un-hacked doors are all valid hack targets.
  const all = enemies.concat(drones).concat(mechas).concat(doors);
  for (const e of all) {
    if (!e.alive || e.faction === 'friendly') continue;
    const d = Math.hypot(e.mesh.position.x - p.x, e.mesh.position.z - p.z);
    if (d > HACK_RANGE) continue;
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

window.addEventListener('keydown', e => {
  if (window.__nanoDebugLevel) return;
  if (gameOver || hacker.active || pendingHack || playerDying || mechaDying) return;
  const k = e.key.toLowerCase();
  // I / K — manual Y-offset for the loaded GLB tileset (debug only).
  // The procedural map was modelled assuming the tile origins sit at
  // y=0; if the GLB tiles' authored origins are above the floor they
  // need to be nudged down. Step is 5 cm.
  if (k === 'i' || k === 'k') {
    if (levelTilesGroup) {
      levelTilesGroup.position.y += (k === 'i' ? 0.05 : -0.05);
      _refreshTileTweakHud();
    }
    return;
  }
  // O / L — scale the wall InstancedMesh's height. We multiply the
  // wall group's Y scale (per-instance Y is already baked at build),
  // so all walls stretch / shrink together. Step is 10% per press.
  if (k === 'o' || k === 'l') {
    const walls = levelTilesGroup?.getObjectByName('walls');
    if (walls) {
      walls.scale.y = Math.max(0.05, walls.scale.y + (k === 'o' ? 0.10 : -0.10));
      _refreshTileTweakHud();
    }
    return;
  }
  if (k === 'r') {
    // Possession shortcuts (no minigame):
    //   • Currently driving a mecha → R ejects.
    //   • Standing next to a friendly (already-hacked) mecha → R re-enters it.
    if (possessedMecha) { ejectFromMecha(); return; }
    const allyMecha = findAllyMechaInRange();
    if (allyMecha)      { enterMechaPossession(allyMecha); return; }

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
    if (debug.enabled)                 diff = 2;
    else if (isSpot)                   diff = 7;
    else if (target instanceof Door)   diff = 2;
    else if (target instanceof Drone)  diff = 3;
    else if (target instanceof Mecha)  diff = 7;
    else                               diff = 5;

    const onClose = (won) => {
      hackRing.visible = false;
      pickRing.visible = false;
      if (won) {
        if (isSpot) {
          foundSpotA = true;
          spotAMarker.visible = false;
          exitMarker.visible  = true;
          hudObj.innerHTML    = 'Objective: reach the <b style="color:#7f5">Exit</b>';
          // Goal-hack flourish: 2× the hack-pickup confetti count,
          // tinted with the Spot-A cyan palette so it reads as a
          // larger, distinctly-coloured celebration.
          spawnConfetti(scene, spotACell.x, 0.35, spotACell.y, {
            particles: 60,
            size: 0.20,
            speed: 7.5,
            colors: [0x22ddff, 0x66e8ff, 0x88f0ff, 0x33aacc, 0xb6f4ff],
          });
        } else if (target.alive && typeof target.hackLink === 'function') {
          target.hackLink();
          // Hack-linking a mecha drops the player straight into possession —
          // no second "open the door" step. Eject (R) leaves it as an ally.
          if (target instanceof Mecha) enterMechaPossession(target);
          // Hack-success VFX — a small swarm of additive points streams
          // from the player's chest to the target. For soldiers the
          // target tracks the head bone (set up via
          // getHackTargetWorldPos); drones / mechas use mesh centre.
          if (typeof target.getHackTargetWorldPos === 'function') {
            spawnHackSwarm(
              scene,
              (out) => out.set(player.position.x, player.position.y + 1.0, player.position.z),
              (out) => target.getHackTargetWorldPos(out),
            );
          }
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
// Possession — when set, the player is driving this mecha. Their human body
// is hidden, input routes to the mecha, and camera follows it. Mecha death
// while possessed kills the player too.
let possessedMecha = null;
// Possession-transition state: while non-null, a "ghost" copy of the
// player is fading out at its old position, surrounded by a swarm
// streaming to the mecha. We track:
//   ghostTimer — seconds remaining before the rig is fully hidden
//   ghostPos   — frozen world position the ghost stands at
const POSSESS_GHOST_DURATION = 1.5;   // seconds
let   possessGhostTimer = 0;
const possessGhostPos   = new THREE.Vector3();
// Mecha-death-while-possessed sequence: HP-zero on the driven mecha
// triggers the rig's full-body death clip; the player's input is
// frozen during the hold and the "Destroyed inside the mecha"
// overlay shows once the animation has had time to play out. The
// hold duration is read from the actual clip on the rig (with a
// small buffer) so we never cut the animation short, with a
// safe fallback if the clip hasn't been resolved yet.
const MECHA_DEATH_FALLBACK_HOLD = 3.5;     // seconds
const MECHA_DEATH_BUFFER        = 0.4;     // extra hold after clip ends
let   mechaDying       = false;
let   mechaDeathTimer  = 0;

function enterMechaPossession(m) {
  if (possessedMecha || !m || !m.alive) return;
  possessedMecha = m;
  m.enterPossession();
  // Capture where the human was standing — the "ghost" copy stays
  // here through the fade so the player sees their old body get
  // dissolved. NOTE: we deliberately do NOT teleport player.mesh
  // into the mecha during this window, so the ghost is visible at
  // the right spot. The mesh moves to the mecha after the fade.
  possessGhostPos.set(player.position.x, player.position.y, player.position.z);
  possessGhostTimer = POSSESS_GHOST_DURATION;
  // Make every material under the player rig transparent so we can
  // animate opacity to 0 over the timer. enterMechaPossession runs
  // once per possession, so caching the originals on userData is
  // enough; eject restores them.
  setRigOpacity(player, 1, /*storeOriginal=*/true);
  player.facingTri.visible = false;
  player.aimLine.visible   = false;
  // Big swarm streaming from the ghost to the mecha — hack-link
  // visualised: the player's consciousness flowing into the chassis.
  spawnHackSwarm(
    scene,
    (out) => out.set(possessGhostPos.x, possessGhostPos.y + 1.0, possessGhostPos.z),
    (out) => out.set(m.mesh.position.x, m.mesh.position.y + 1.4, m.mesh.position.z),
    // Mecha possession is the most dramatic hack in the run — double
    // the particle count vs. a soldier hack so the cast feels heavy.
    { particles: 180, lifetime: POSSESS_GHOST_DURATION, size: 0.14 },
  );
  updatePlayerHPHUD();
  updateShotHUD();
}

// Walk every Mesh / SkinnedMesh under the player's rig and apply a
// uniform alpha to its materials. On the first call we stash the
// originals on userData so eject can restore them cleanly. Idempotent
// — calling with `storeOriginal=true` again won't double-stash.
function setRigOpacity(p, alpha, storeOriginal = false) {
  const apply = (m) => {
    if (!m) return;
    if (storeOriginal && m.userData._origOpacity === undefined) {
      m.userData._origOpacity     = m.opacity ?? 1;
      m.userData._origTransparent = m.transparent ?? false;
    }
    m.transparent = true;
    m.opacity     = alpha;
    m.depthWrite  = alpha > 0.99;
  };
  p.mesh.traverse((c) => {
    if (!c.isMesh && !c.isSkinnedMesh) return;
    if (Array.isArray(c.material)) c.material.forEach(apply);
    else if (c.material)            apply(c.material);
  });
}
function restoreRigOpacity(p) {
  const restore = (m) => {
    if (!m) return;
    if (m.userData._origOpacity !== undefined) {
      m.opacity     = m.userData._origOpacity;
      m.transparent = m.userData._origTransparent;
      m.depthWrite  = true;
      delete m.userData._origOpacity;
      delete m.userData._origTransparent;
    }
  };
  p.mesh.traverse((c) => {
    if (!c.isMesh && !c.isSkinnedMesh) return;
    if (Array.isArray(c.material)) c.material.forEach(restore);
    else if (c.material)            restore(c.material);
  });
}

function ejectFromMecha() {
  if (!possessedMecha) return;
  const m = possessedMecha;
  // Drop the human a body-length BEHIND the mecha (opposite the facing).
  const bx = m.mesh.position.x - Math.sin(m.facing) * 1.6;
  const bz = m.mesh.position.z - Math.cos(m.facing) * 1.6;
  player.mesh.position.x = bx;
  player.mesh.position.z = bz;
  player.facing = m.facing;
  player.facingDir.x = Math.sin(m.facing);
  player.facingDir.z = Math.cos(m.facing);
  player.mesh.visible = true;
  player.facingTri.visible = true;
  // If we ejected mid-possession-fade, kill the ghost timer and
  // restore the rig's authored opacity so the body re-materialises
  // fully solid before the burst plays.
  possessGhostTimer = 0;
  restoreRigOpacity(player);
  // Explosive swarm at the player's reappear position — hack-spell
  // "the consciousness returns" beat. Burst mode: no seek, just
  // outward expansion + fade.
  spawnHackSwarm(
    scene,
    (out) => out.set(bx, 1.0, bz),
    null,
    // Eject burst matches enter-cast scale: doubled vs. soldier hack.
    { mode: 'burst', particles: 160, lifetime: 0.9, size: 0.14, burstSpeed: 9 },
  );
  m.leavePossession();
  possessedMecha = null;
  updatePlayerHPHUD();
  updateShotHUD();
}

function findAllyMechaInRange() {
  const p = player.position;
  let best = null, bestD = Infinity;
  for (const m of mechas) {
    if (!m.alive || m.faction !== 'friendly') continue;
    const d = Math.hypot(m.mesh.position.x - p.x, m.mesh.position.z - p.z);
    if (d <= HACK_RANGE && d < bestD) { bestD = d; best = m; }
  }
  return best;
}

// ── Player life ─────────────────────────────────────────────────────────────
const PLAYER_MAX_HP = 2;
let   playerHp      = PLAYER_MAX_HP;
const hudPlayerHP   = document.getElementById('php');
function updatePlayerHPHUD() {
  if (!hudPlayerHP) return;
  // While possessing a mecha, the bar reports the mecha's HP — that's the
  // body actually taking hits. The human's HP is parked until eject.
  if (possessedMecha && possessedMecha.alive) {
    hudPlayerHP.innerHTML =
      `Mecha HP: <b>${possessedMecha.hp} / ${possessedMecha.maxHp}</b>`;
    return;
  }
  hudPlayerHP.innerHTML = `HP: <b>${playerHp} / ${PLAYER_MAX_HP}</b>`;
}
// Death sequence — between HP-zero and the "You were eliminated"
// overlay, the human plays its falling-back-death clip. While dying
// the player can no longer take damage, fire, or move; the world
// keeps simulating so soldiers / drones don't freeze mid-step.
const PLAYER_DEATH_HOLD = 2.2;     // seconds of death animation before overlay
let   playerDying       = false;
let   playerDeathTimer  = 0;
function playerTakeDamage(n = 1) {
  if (gameOver || playerDying) return;
  playerHp = Math.max(0, playerHp - n);
  updatePlayerHPHUD();
  if (playerHp <= 0) {
    // Trigger the rig's death clip; falls back to the overlay path
    // immediately if the rig isn't loaded yet.
    const ok = player.rig?.triggerDeath?.('back') === true;
    if (!ok) { endGame('You were eliminated'); return; }
    playerDying      = true;
    playerDeathTimer = PLAYER_DEATH_HOLD;
    // Stop any in-flight player-bow recoil / battle pose so the death
    // clip dominates without the bow hovering on the LeftHand.
    player.aimLine.visible = false;
    // Clear held keys + drop future inputs so the corpse can't keep
    // walking / firing while the death animation plays.
    player.setInputDisabled?.(true);
  }
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
function _fmtCd(c) {
  return c <= 0
    ? '<b style="color:#7ff">READY</b>'
    : `<b>${c.toFixed(1)}s</b>`;
}
function updateShotHUD() {
  if (!hudShot) return;
  // Possessed mecha → show BOTH weapons' reloads side by side. The mecha
  // owns these timers; we just read them every frame.
  if (possessedMecha && possessedMecha.alive) {
    const sd = Math.max(0, possessedMecha.shootCooldown);
    const rd = Math.max(0, possessedMecha.rocketCooldown);
    // Possessed mode rebinds the weapon controls — make the keys
    // explicit in the HUD so the player knows F is the rocket
    // launcher (SPACE is still the cannon).
    hudShot.innerHTML =
      `<span style="opacity:.7">J</span> Shot: ${_fmtCd(sd)} ` +
      `<span style="opacity:.5">|</span> ` +
      `<span style="color:#ff8866"><span style="opacity:.7">K</span> Rocket: ${_fmtCd(rd)}</span>`;
    return;
  }
  hudShot.innerHTML = `Shot: ${_fmtCd(shotCooldown)}`;
}

window.addEventListener('keydown', e => {
  if (window.__nanoDebugLevel) return;
  // K → mecha rocket launcher (only valid while possessing a mecha).
  if (e.key.toLowerCase() === 'k') {
    if (gameOver || hacker.active || playerDying || mechaDying) return;
    if (possessedMecha) possessedMecha.playerFireRocket(game);
    return;
  }
  if (e.key.toLowerCase() !== 'j') return;
  if (gameOver || hacker.active || playerDying || mechaDying) return;
  // While driving a mecha J fires its 3-bullet fan instead of the
  // player's pistol shot. Cooldown is managed inside the mecha.
  if (possessedMecha) {
    possessedMecha.playerFire(game);
    return;
  }
  if (shotCooldown > 0) return;
  const d = player.facingDir;
  const len = Math.hypot(d.x, d.z) || 1;
  // Spawn the arrow from the bow's LeftHand bone position. Falls
  // back to a forward offset if the bow rig hasn't loaded yet.
  const muzzle = player.getBowMuzzleWorldPos?.(new THREE.Vector3());
  const sx = muzzle ? muzzle.x : player.position.x + (d.x / len) * 0.6;
  const sy = muzzle ? muzzle.y : 0.6;
  const sz = muzzle ? muzzle.z : player.position.z + (d.z / len) * 0.6;
  game.spawnBullet(
    sx, sz,
    d.x / len, d.z / len,
    'player', null, sy,
  );
  // notifyShot() handles the recoil overlay AND the post-shot grace
  // window that keeps the bow visible through the recoil settle
  // before dissolving back to stealth.
  player.notifyShot?.();
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
    if (!(source instanceof Enemy)) return;
    timesSpotted++;
    const spottedRoom = findRoomAt(player.position.x, player.position.z);
    spawnDroneBatch(spottedRoom, 2);
  },
  spawnBullet(x, z, dx, dz, owner = 'enemy', shooter = null, y = 0.6) {
    bullets.push(new Bullet(scene, x, z, dx, dz, owner, shooter, y));
  },
  // Mecha-only — explosive round on a long cooldown. Lives in the same
  // bullets array since its update / alive / damage interface matches.
  spawnRocket(x, z, dx, dz, owner = 'player', shooter = null, y = 0.7) {
    bullets.push(new Rocket(scene, x, z, dx, dz, owner, shooter, y));
  },
  // Helpers for obstacle / door interaction.
  obstacleAt,
  damageObstacleAt,
  destroyObstacleAt,
  cellBlockedByDoor,
};

function updateModeUI() {
  hudMode.textContent = battleMode ? 'BATTLE' : 'STEALTH';
  hudMode.className   = 'mode ' + (battleMode ? 'battle' : 'stealth');
}
function endGame(msg) {
  gameOver = true;
  // Stack the message + the restart hint so the player sees both
  // without us having to touch the index.html layout.
  overlayText.innerHTML =
    `<div>${msg}</div>` +
    `<div style="font-size:18px;opacity:.75;margin-top:14px;">` +
    `Press <b style="color:#7ff">R</b> to restart` +
    `</div>`;
  overlay.style.display = 'flex';
}
// R-to-restart while game-over. Captured at the window level so it
// fires regardless of focus state. Reload preserves no run state —
// fine, that's the same behaviour as the overlay's "New Run" button.
window.addEventListener('keydown', (e) => {
  if (!gameOver) return;
  if (e.key.toLowerCase() === 'r') location.reload();
});

const clock = new THREE.Clock();
let   time  = 0;

function animate() {
  if (gameOver) return;
  // Debug level takeover — main animate / listeners are inert while the
  // empty test arena is running.
  if (window.__nanoDebugLevel) return;
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;

  // Pre-hack lock-on pulse freezes the world like an active hack does.
  if (tickPendingHack()) { renderer.render(scene, camera); return; }
  if (hacker.active)     { renderer.render(scene, camera); return; }

  // Death hold — drain the timer; once spent show the overlay. We
  // don't early-return here so the rest of the animate loop still
  // ticks the rig + AI + renders during the death animation.
  if (playerDying) {
    playerDeathTimer -= dt;
    if (playerDeathTimer <= 0 && !gameOver) endGame('You were eliminated');
  }

  // Skip player.update while possessing a mecha — the human is hidden and
  // their input gets routed to the mecha inside that entity's own update.
  // Keep the human's position glued to the mecha so any AI looking up
  // world.player.position sees the mecha (no stale waypoint in the corridor
  // where the player got in).
  if (!possessedMecha) {
    // While dying, freeze player input/movement but keep the rig's
    // mixer ticking so the death clip plays. We pass zero-input args
    // and the rig drives itself off its internal _dying / death blend.
    if (playerDying) {
      player.update(dt, map, doorBlocksPlayer, false, false);
    } else {
      // shotReady gates the rig's battle (standing aim) pose — while
      // reloading, the body drops back to the stealth bundle so the visual
      // matches the "Shot: Xs" HUD readout.
      player.update(dt, map, doorBlocksPlayer, battleMode, shotCooldown <= 0);
    }
  } else {
    // While the possession-enter ghost is fading, KEEP the player
    // mesh at its old (pre-possession) position so the dissolving
    // body is visible to the camera. The mecha is already simulating
    // independently. Once the timer expires we hide the rig and snap
    // it inside the mecha (where it stays for AI-position reads).
    if (possessGhostTimer > 0) {
      possessGhostTimer -= dt;
      const t = 1 - Math.max(0, possessGhostTimer) / POSSESS_GHOST_DURATION;
      // Pin the ghost to the captured spot. We deliberately do NOT
      // call player.update here — that would read player.keys (which
      // the mecha is also reading for movement) and translate the
      // ghost across the floor in lockstep with the mecha. Driving
      // the rig directly with zero movement keeps it animating in
      // place while the swarm carries the consciousness away.
      player.rig.position    = { x: possessGhostPos.x, z: possessGhostPos.z };
      player.rig.battleMode  = false;
      player.rig.setMovement(0, 0);
      player.rig.update(dt);
      // Linear fade — every material under the rig dissolves to 0
      // by the end of POSSESS_GHOST_DURATION.
      setRigOpacity(player, 1 - t);
      if (possessGhostTimer <= 0) {
        // Fade complete — hide the rig and restore opacity so the
        // next eject re-materialises a fully-opaque body.
        player.mesh.visible = false;
        restoreRigOpacity(player);
      }
    } else {
      player.mesh.position.x = possessedMecha.mesh.position.x;
      player.mesh.position.z = possessedMecha.mesh.position.z;
    }
    // HUD readouts pull live values from the mecha — refresh every frame so
    // mecha HP / cooldown updates are visible.
    updatePlayerHPHUD();
    updateShotHUD();
  }

  // Battle mode = some HOSTILE enemy is actively tracking the player. Friendly
  // enemies fighting other hostiles don't count — the player is allied with them.
  const anyAlerted =
    enemies.some(e => e.alive && e.alerted && e.faction === 'hostile') ||
    drones.some(d => d.alive && d.alerted && d.faction === 'hostile') ||
    mechas.some(m => m.alive && m.alerted && m.faction === 'hostile');
  if (anyAlerted !== battleMode) { battleMode = anyAlerted; updateModeUI(); }

  // Slow-mo trigger uses whichever body the player is currently driving.
  // While possessing the mecha, WASD on the mecha counts as "moving"; the
  // human's stationary mesh shouldn't gate the world clock.
  const ctrlMoved = possessedMecha
    ? ['w','a','s','d'].some(k => player.keys.has(k))
    : player.movedThisFrame;

  let worldDt = dt;
  // Slow-mo is suspended during the mecha-death hold so the
  // wreck's death animation plays out at normal speed instead of
  // dragging across ~12× the wall-clock duration.
  if (battleMode && !ctrlMoved && !mechaDying) {
    worldDt = dt * 0.08;
  }

  // Aim line shows in battle for whichever body the player is driving —
  // human OR possessed mecha. While the possess-enter ghost is still
  // dissolving we hide it (the camera is on the mecha but the human
  // body is still mid-fade, so a stray line at the ghost would read
  // wrong). Position + facing follow the active body each frame.
  const aimVisible = battleMode && !playerDying && (!possessedMecha || possessGhostTimer <= 0);
  player.aimLine.visible = aimVisible;
  if (possessedMecha && aimVisible) {
    player.aimLine.position.set(possessedMecha.mesh.position.x, 0, possessedMecha.mesh.position.z);
    player.aimLine.rotation.y = possessedMecha.facing;
  }
  if (aimVisible) {
    // Origin / facing for the hostile-detection segment depend on
    // who's currently driving — possessed mecha or human player.
    const ox = possessedMecha ? possessedMecha.mesh.position.x : player.position.x;
    const oz = possessedMecha ? possessedMecha.mesh.position.z : player.position.z;
    const fx = possessedMecha ? Math.sin(possessedMecha.facing) : player.facingDir.x;
    const fz = possessedMecha ? Math.cos(possessedMecha.facing) : player.facingDir.z;
    const RANGE = 6;
    let hostile = false;
    const checkList = (arr) => {
      if (hostile || !arr) return;
      for (const e of arr) {
        if (!e?.alive || e.faction === 'friendly') continue;
        const ex = e.mesh.position.x - ox, ez = e.mesh.position.z - oz;
        const along = ex * fx + ez * fz;             // projection on aim
        if (along < 0 || along > RANGE) continue;
        // Perpendicular distance from segment, then compare to radius.
        const perp = Math.hypot(ex - fx * along, ez - fz * along);
        if (perp <= (e.hitRadius ?? 0.45)) { hostile = true; return; }
      }
    };
    checkList(enemies);
    checkList(drones);
    checkList(mechas);
    player.setAimLineHostile(hostile);
  }

  // Entities pull `realDt` off the world view to rotate / cool down in real
  // time even while the world is in slow-mo. Movement still uses worldDt so
  // the slow-mo bargain holds.
  const worldView = {
    player, enemies, drones, mechas, map, destroyObstacleAt,
    realDt: dt, battleMode,
    debugOpen: debug.enabled, // forces every door to its open state
    cameraYaw: CAM_YAW,       // entities billboard their HP bars on this
  };
  for (const e of enemies) e.update(worldDt, map, worldView, game);
  for (const d of drones)  d.update(worldDt, map, worldView, game, time);
  for (const m of mechas)  m.update(worldDt, map, worldView, game);
  for (const dr of doors)  dr.update(dt, worldView);

  // Possessed mecha just blew up — the player goes with it, but we
  // hold off the overlay until the rig's death animation plays out.
  // possessedMecha stays set so the camera keeps following the wreck;
  // input is disabled so the player can't keep firing while it falls.
  if (possessedMecha && !possessedMecha.alive && !mechaDying) {
    mechaDying      = true;
    // Read the death clip's actual duration off the rig so we wait
    // for the entire animation. Falls back to a fixed hold if the
    // clip hasn't been resolved yet (rig still loading).
    const clip = possessedMecha.rig?._actions?.death?.getClip?.();
    mechaDeathTimer = clip?.duration
      ? clip.duration + MECHA_DEATH_BUFFER
      : MECHA_DEATH_FALLBACK_HOLD;
    player.setInputDisabled?.(true);
  }
  if (mechaDying) {
    mechaDeathTimer -= dt;
    if (mechaDeathTimer <= 0 && !gameOver) {
      // Hand-off to game-over: restore human visuals so the overlay
      // isn't behind a hidden body, drop the possession reference,
      // and show the eliminated screen.
      player.mesh.visible      = true;
      player.facingTri.visible = true;
      possessedMecha = null;
      return endGame('Destroyed inside the mecha');
    }
  }

  // Player bullets can damage both soldiers and drones (and mechas, added
  // below). Game callbacks let bullets damage obstacles on impact. While the
  // human is hidden inside a mecha we pass `null` so stray bullets don't
  // chip the invisible body — only the mecha takes hits.
  const bulletTargets = enemies.concat(drones).concat(mechas);
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const r = b.update(worldDt, map, possessedMecha ? null : player, bulletTargets, game);
    if (r === 'hit') {
      playerTakeDamage(b.damage ?? 1);
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

  // Camera follow — anchors on whichever body the player is driving.
  const followPos = possessedMecha ? possessedMecha.mesh.position : player.position;
  // `pos` is used by hack-collection + exit-reach checks below; alias it to
  // the camera focus so a possessed mecha can collect hacks / cross the exit
  // just like the human form.
  const pos = followPos;
  camera.position.set(
    followPos.x + Math.sin(CAM_YAW) * CAM_RADIUS,
    CAM_HEIGHT,
    followPos.z + Math.cos(CAM_YAW) * CAM_RADIUS
  );
  camera.lookAt(followPos.x, 0.5, followPos.z);

  // Off-screen pointers — Spot A while it's still the goal, then the exit.
  camera.updateMatrixWorld();
  updateObjectiveArrow(arrowSpot, spotACell.x, spotACell.y, !foundSpotA);
  updateObjectiveArrow(arrowExit, exitCell.x,  exitCell.y,   foundSpotA);

  // Hack point collection + animation
  for (const m of hackMeshes) {
    if (m.userData.collected) continue;
    m.rotation.y = time * 1.8;
    m.position.y = 0.35 + Math.sin(time * 2.2 + m.position.x) * 0.07;
    if (hacksCollected < MAX_HACKS &&
        Math.hypot(pos.x - m.position.x, pos.z - m.position.z) < 0.7) {
      m.userData.collected = true;
      // Confetti burst at the cube's last position, in the same
      // purple palette as the HUD's hack-points readout — sells the
      // pickup with a small celebratory flourish.
      spawnConfetti(scene, m.position.x, m.position.y, m.position.z, {
        particles: 30,
        size: 0.18,
      });
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
  // Tick crate debris on worldDt so they slow down with everything
  // else when SUPERHOT slow-mo is active.
  updateCrateDebris(worldDt);
  // Same gating for the arrow-impact explosions — they're a world VFX
  // and should bend with slow-mo.
  updatePlayerArrowVFX(worldDt);
  // Mecha rocket-impact blue explosion VFX — also slow-mo gated.
  updateRocketExplosions(worldDt);
  // Hack-success swarm VFX runs on REAL dt — slow-mo would otherwise
  // stretch the cast to 12+ real seconds while the player's standing
  // still in battle, which reads as "the swarm didn't fire". The cast
  // is a UI flourish, not a world event, so it shouldn't bend.
  updateHackSwarm(dt);
  // Confetti — UI-flourish only, also runs on real dt so it doesn't
  // get stretched by slow-mo when the player bags a pickup mid-combat.
  updateConfetti(dt);
  renderer.render(scene, camera);
}

updateModeUI();
updateHacksHUD();
updateShotHUD();
updatePlayerHPHUD();
// On the first visit of a session we play the tutorial straight away.
// The tutorial reloads the page when it finishes (or when the player
// declines the choice on step 1), and the second pass through this
// module sees `nanoTutorialDone === '1'` in sessionStorage so it
// falls through to the normal corp-logo splash + main-game flow.
// sessionStorage scopes the "played already" flag to the current
// browser tab so a fresh run / new tab gets the tutorial again.
//
// TAB during the splash still skips into the debug level; T into a
// fresh replay of the tutorial — both routes are kept for testing.
const TUTORIAL_DONE_KEY = 'nanoTutorialDone';
const tutorialDone = (() => {
  try { return sessionStorage.getItem(TUTORIAL_DONE_KEY) === '1'; }
  catch (_) { return false; }
})();
if (!tutorialDone) {
  try { sessionStorage.setItem(TUTORIAL_DONE_KEY, '1'); } catch (_) {}
  runTutorialLevel();
} else {
  showCorpLogo({ durationMs: 3500, fadeMs: 700 }, animate, runDebugLevel, runTutorialLevel);
}
