import * as THREE from 'three';

// Grid: 0 = floor, 1 = wall, 2 = low obstacle
export function generateMap(width = 40, height = 40, roomAttempts = 14) {
  const grid = Array.from({ length: height }, () => new Array(width).fill(1));
  const rooms = [];
  const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  for (let i = 0; i < roomAttempts; i++) {
    const rw = rand(7, 12);
    const rh = rand(7, 12);
    const rx = rand(2, width - rw - 3);
    const ry = rand(2, height - rh - 3);
    const room = { x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) };
    let overlaps = false;
    for (const o of rooms) {
      if (rx < o.x + o.w + 1 && rx + rw + 1 > o.x && ry < o.y + o.h + 1 && ry + rh + 1 > o.y) {
        overlaps = true; break;
      }
    }
    if (overlaps) continue;
    for (let y = ry; y < ry + rh; y++)
      for (let x = rx; x < rx + rw; x++)
        grid[y][x] = 0;
    rooms.push(room);
  }

  // 3-wide L-corridors between rooms
  const carve3 = (cx, cy) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x > 0 && y > 0 && x < width - 1 && y < height - 1) grid[y][x] = 0;
      }
  };
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1], b = rooms[i];
    let { cx: x, cy: y } = a;
    const { cx: tx, cy: ty } = b;
    while (x !== tx) { carve3(x, y); x += x < tx ? 1 : -1; }
    while (y !== ty) { carve3(x, y); y += y < ty ? 1 : -1; }
    carve3(x, y);
  }

  // Low obstacles inside rooms (placed away from walls and center)
  for (const room of rooms) {
    const count = 1 + Math.floor(Math.random() * 2);
    for (let c = 0; c < count; c++) {
      const horizontal = Math.random() < 0.5;
      const len = 2 + Math.floor(Math.random() * 2);
      const ox = rand(room.x + 2, room.x + room.w - len - 2);
      const oy = rand(room.y + 2, room.y + room.h - (horizontal ? 2 : len + 1));
      if (ox < 1 || oy < 1) continue;
      for (let k = 0; k < len; k++) {
        const x = horizontal ? ox + k : ox;
        const y = horizontal ? oy : oy + k;
        if (grid[y] && grid[y][x] === 0) grid[y][x] = 2;
      }
    }
  }

  return { grid, rooms, width, height };
}

export function buildMapMesh(map, scene) {
  const { grid, width, height } = map;
  const group = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({ color: 0x1a1f2a, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(width / 2 - 0.5, 0, height / 2 - 0.5);
  floor.receiveShadow = true;
  group.add(floor);

  const wallGeo = new THREE.BoxGeometry(1, 1.5, 1);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a4f6a, roughness: 0.6 });
  const lowGeo  = new THREE.BoxGeometry(1, 0.5, 1);
  const lowMat  = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.9, emissive: 0x1a0c00 });

  // Walls only — destructible obstacles (grid value 2) are now rendered by
  // the Obstacle class as per-cell Box meshes so they can be damaged or
  // destroyed individually.
  let wc = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (grid[y][x] === 1) wc++;

  const walls = new THREE.InstancedMesh(wallGeo, wallMat, wc);
  walls.castShadow = true; walls.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let wi = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (grid[y][x] === 1) {
        dummy.position.set(x, 0.75, y); dummy.updateMatrix();
        walls.setMatrixAt(wi++, dummy.matrix);
      }
    }
  group.add(walls);
  // Keep the geometry/materials around for the lows in case anything imports
  // them — but no instances are emitted.
  void lowGeo; void lowMat;
  scene.add(group);
  return group;
}

// Returns true for walls AND low obstacles (both block movement & vision)
export function isWall(map, x, z) {
  const gx = Math.round(x), gz = Math.round(z);
  if (gx < 0 || gz < 0 || gx >= map.width || gz >= map.height) return true;
  return map.grid[gz][gx] !== 0;
}

// Optional extra blocker (e.g. closed doors) consulted by rayMarch in addition
// to the static map grid. Hosts register a function via `setRayBlocker` —
// passing `null` clears it. Pathfinding (findPath) intentionally does NOT
// consult this so AI routes can plan through doors that auto-open.
let _rayBlocker = null;
export function setRayBlocker(fn) { _rayBlocker = fn || null; }

// Ray march for vision cone — returns distance to first obstruction
export function rayMarch(map, ox, oz, dx, dz, maxDist) {
  const step = 0.15;
  let t = 0;
  while (t < maxDist) {
    t += step;
    const px = ox + dx * t, pz = oz + dz * t;
    if (isWall(map, px, pz)) return t - step;
    if (_rayBlocker && _rayBlocker(px, pz)) return t - step;
  }
  return maxDist;
}

// A* pathfinding on the 4-connected grid with a wall-proximity penalty so
// agents prefer the centre of corridors. Each step has a base cost of 1 plus
// `wallPenalty` per 4-adjacent wall the destination cell touches — a 3-wide
// corridor's middle row therefore beats either edge row by 1 unit per cell,
// while still being beatable when the only path hugs a wall.
// Returns simplified waypoints (corners + endpoints), axis-aligned only.
export function findPath(map, sx, sz, ex, ez, wallPenalty = 0.6) {
  sx = Math.round(sx); sz = Math.round(sz);
  ex = Math.round(ex); ez = Math.round(ez);

  const snap = (ox, oz) => {
    for (let r = 0; r <= 5; r++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++)
          if (!isWall(map, ox + dx, oz + dz)) return [ox + dx, oz + dz];
    return null;
  };

  const s = snap(sx, sz), e2 = snap(ex, ez);
  if (!s || !e2) return null;
  [sx, sz] = s; [ex, ez] = e2;
  if (sx === ex && sz === ez) return [{ x: sx, z: sz }];

  const W   = map.width;
  const H   = map.height;
  const enc = (x, z) => z * W + x;
  const endK = enc(ex, ez);

  // Wall-proximity cost for stepping into (x, z): how many 4-neighbours are
  // walls. Penalises edge-of-corridor cells without forbidding them.
  const cellCost = (x, z) => {
    let n = 0;
    if (isWall(map, x + 1, z)) n++;
    if (isWall(map, x - 1, z)) n++;
    if (isWall(map, x, z + 1)) n++;
    if (isWall(map, x, z - 1)) n++;
    return 1 + n * wallPenalty;
  };

  const heuristic = (x, z) => Math.abs(x - ex) + Math.abs(z - ez);

  // Tiny binary-heap-free approach: re-sort the open list when needed. Maps
  // are small enough that the overhead is negligible.
  const gScore = new Map([[enc(sx, sz), 0]]);
  const parent = new Map([[enc(sx, sz), -1]]);
  // open: array of [fScore, x, z, key]
  const open   = [[heuristic(sx, sz), sx, sz, enc(sx, sz)]];
  const closed = new Set();

  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  let found = false;

  while (open.length) {
    // Pull the entry with the lowest fScore (linear — fine for a 68×68 grid)
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i][0] < open[bestIdx][0]) bestIdx = i;
    }
    const [, cx, cz, ck] = open.splice(bestIdx, 1)[0];
    if (closed.has(ck)) continue;
    if (ck === endK) { found = true; break; }
    closed.add(ck);

    const cg = gScore.get(ck);
    for (const [dx, dz] of dirs) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
      if (isWall(map, nx, nz)) continue;
      const nk = enc(nx, nz);
      if (closed.has(nk)) continue;
      const tentative = cg + cellCost(nx, nz);
      const known = gScore.get(nk);
      if (known !== undefined && tentative >= known) continue;
      gScore.set(nk, tentative);
      parent.set(nk, ck);
      open.push([tentative + heuristic(nx, nz), nx, nz, nk]);
    }
  }
  if (!found) return null;

  // Reconstruct cell list
  const cells = [];
  let cur = endK;
  while (cur !== -1) {
    cells.unshift({ x: cur % W, z: Math.floor(cur / W) });
    cur = parent.get(cur);
  }

  // Simplify to corners + endpoints only
  if (cells.length <= 2) return cells;
  const result = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const p = cells[i - 1], c = cells[i], n = cells[i + 1];
    if ((c.x - p.x) !== (n.x - c.x) || (c.z - p.z) !== (n.z - c.z)) result.push(c);
  }
  result.push(cells[cells.length - 1]);
  return result;
}

// Snap to a valid (non-wall) floor cell near (cx, cz)
export function findValidFloor(map, cx, cz, radius = 4) {
  cx = Math.round(cx); cz = Math.round(cz);
  for (let r = 0; r <= radius; r++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++)
        if (!isWall(map, cx + dx, cz + dz)) return { x: cx + dx, z: cz + dz };
  return null;
}

export function pickFloorCell(map, preferFarFrom = null, minDist = 0) {
  const floors = [];
  for (let y = 1; y < map.height - 1; y++)
    for (let x = 1; x < map.width - 1; x++)
      if (map.grid[y][x] === 0) floors.push({ x, y });
  if (preferFarFrom) {
    const far = floors.filter(f => Math.hypot(f.x - preferFarFrom.x, f.y - preferFarFrom.y) >= minDist);
    if (far.length) return far[Math.floor(Math.random() * far.length)];
  }
  return floors[Math.floor(Math.random() * floors.length)];
}

// Pick N floor cells spread across the map, avoiding avoidPos and each other
export function pickSpreadFloorCells(map, count, minSpacing = 5, avoidPos = null, avoidDist = 8) {
  const floors = [];
  for (let z = 1; z < map.height - 1; z++)
    for (let x = 1; x < map.width - 1; x++) {
      if (map.grid[z][x] !== 0) continue;
      if (avoidPos && Math.hypot(x - avoidPos.x, z - avoidPos.z) < avoidDist) continue;
      floors.push({ x, z });
    }
  // Shuffle
  for (let i = floors.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [floors[i], floors[j]] = [floors[j], floors[i]];
  }
  const picked = [];
  for (const cell of floors) {
    if (picked.length >= count) break;
    if (!picked.some(p => Math.hypot(p.x - cell.x, p.z - cell.z) < minSpacing))
      picked.push(cell);
  }
  return picked;
}
