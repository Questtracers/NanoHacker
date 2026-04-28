import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 3D tileset for the gameplay map. Replaces the box-wall + flat-plane
// visual produced by buildMapMesh() with five GLB models from
// Assets/Levels/BlueSet/ — wall, corner, door (frame), and two floor
// variants.  Everything is rendered through THREE.InstancedMesh so a
// 68×68 grid (a few thousand tiles) draws as a handful of GPU calls
// rather than thousands of meshes — this is what makes the tileset
// viable on low-end hardware. The original `buildMapMesh` stays as
// a fallback the host can fall back to if the GLB load fails.

const ASSET_DIR = 'Assets/Levels/BlueSet/';
const TILE_FILES = {
  corner: 'corner.glb',
  wall:   'wall.glb',
  door:   'door.glb',
  floor1: 'floor3d-1.glb',
  floor2: 'floor3d-2.glb',
};

// Mix ratio of the two floor variants — floor1 dominates so it reads
// as "default tile" and floor2 sprinkles in for visual break.
const FLOOR2_PROBABILITY = 0.18;

// Tile authoring assumes 1-metre cells. After load we measure each
// model and uniformly scale it to fit a 1-metre XZ footprint, so the
// modeller's chosen scale is invisible to the consumer. Walls and
// corners get an additional non-uniform Y scale that pushes them up
// to TARGET_WALL_HEIGHT — the source models are roughly knee-high
// otherwise. Doors match wall height too.
const TARGET_TILE_SIZE   = 1.0;
const TARGET_WALL_HEIGHT = 1.30;  // metres — wall height baked from in-game tuning
const TARGET_DOOR_HEIGHT = TARGET_WALL_HEIGHT * 2;  // doors are 2× wall height
// Default vertical offset of the whole tileset relative to world y=0.
// Tuned in-game with the I/K keys and baked here so a fresh load
// starts at the right level.
const DEFAULT_Y_OFFSET   = -0.2;

// In-memory cache keyed by tile name so subsequent loads are instant.
const _cache = {};

// Per-tile pre-rotation (in radians, around X) baked into the geometry
// at load time. Confirmed via the in-debug-level rotation tuner: walls
// and doors are AUTHORED upright (Y=height, Z=length), so neither needs
// an X bake. Corners + floors are correct as-is too.
const PRE_ROT_X = {};

async function loadTile(name) {
  if (_cache[name]) return _cache[name];
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(ASSET_DIR + TILE_FILES[name]);
  // Pull the first Mesh out of the loaded scene. GLB exports usually
  // wrap the geometry in a Group with one or more Mesh children.
  let mesh = null;
  gltf.scene.traverse((c) => { if (c.isMesh && !mesh) mesh = c; });
  if (!mesh) throw new Error(`level-tiles: no mesh inside ${TILE_FILES[name]}`);
  // Bake the mesh's local transform into the geometry so its world
  // origin sits at the tile's footprint center / floor (y = 0). This
  // makes InstancedMesh placement predictable: position == grid cell
  // center and the bottom of the tile is on the floor.
  mesh.updateMatrixWorld(true);
  const geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);
  // Apply the per-tile X pre-rotation BEFORE we measure / re-center,
  // so the post-rotation bounding box drives the alignment logic.
  const preRotX = PRE_ROT_X[name];
  if (preRotX) {
    const m = new THREE.Matrix4().makeRotationX(preRotX);
    geometry.applyMatrix4(m);
  }
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const center = new THREE.Vector3();
  bb.getCenter(center);
  // Translate so XZ center == origin and bottom == y=0.
  geometry.translate(-center.x, -bb.min.y, -center.z);
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  const size = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  const material = mesh.material;
  // Texture color-space fix-up — GLB usually flags base-color textures
  // correctly already, but be defensive.
  const fixup = (m) => {
    if (m && m.map) m.map.colorSpace = THREE.SRGBColorSpace;
  };
  if (Array.isArray(material)) material.forEach(fixup);
  else fixup(material);
  _cache[name] = { geometry, material, size };
  return _cache[name];
}

// Helper: world-grid wall test. Treats out-of-bounds as wall and only
// counts grid==1 (true walls) — destructible obstacles (grid==2) are
// rendered separately by the Obstacle class.
function isWallCell(grid, w, h, x, z) {
  if (x < 0 || z < 0 || x >= w || z >= h) return true;
  return grid[z][x] === 1;
}

// Build all tile InstancedMeshes for the supplied map grid and add
// them to the scene under one Group. Returns a Promise that resolves
// to that Group once every GLB has loaded and the meshes are placed.
// Caller decides what to do with the placeholder (e.g. remove the
// box-wall fallback once this resolves).
export async function buildLevelTiles(map, scene) {
  const [floor1, floor2, wall, corner, door] = await Promise.all([
    loadTile('floor1'),
    loadTile('floor2'),
    loadTile('wall'),
    loadTile('corner'),
    loadTile('door'),
  ]);

  const W = map.width, H = map.height;
  const grid = map.grid;

  // Floors get a uniform XZ scale (Y stays at native — they're flat).
  const sFloor1 = TARGET_TILE_SIZE / Math.max(floor1.size.x, floor1.size.z, 0.0001);
  const sFloor2 = TARGET_TILE_SIZE / Math.max(floor2.size.x, floor2.size.z, 0.0001);
  // Walls + doors went through the X pre-rotation, so their local axes
  // now read as: X = thickness (kept native), Y = height (stretched to
  // wall height), Z = length along the wall (stretched to one cell).
  // This gives full per-axis control so adjacent walls actually touch
  // along their length-direction edge.
  const sWallX  = 1.0;                                              // thickness — leave alone
  const sWallY  = TARGET_WALL_HEIGHT / Math.max(0.0001, wall.size.y);
  const sWallZ  = TARGET_TILE_SIZE   / Math.max(0.0001, wall.size.z);
  const sDoorX  = 1.0;
  const sDoorY  = TARGET_DOOR_HEIGHT / Math.max(0.0001, door.size.y);
  const sDoorZ  = TARGET_TILE_SIZE   / Math.max(0.0001, door.size.z);
  // Corners: only Y needs adjustment (already cubic-ish in XZ).
  const sCorner = TARGET_TILE_SIZE   / Math.max(corner.size.x, corner.size.z, 0.0001);
  const yCorner = TARGET_WALL_HEIGHT / Math.max(0.0001, corner.size.y);

  const group  = new THREE.Group();
  group.name   = 'levelTiles';
  group.position.y = DEFAULT_Y_OFFSET;
  const dummy  = new THREE.Object3D();

  // ── Floor instances ──────────────────────────────────────────────
  // Walk the grid and bin each floor cell into one of the two floor
  // variants by probability. Each instance gets a random 0/90/180/270°
  // yaw to break tile-repeat patterns.
  const f1Cells = [];
  const f2Cells = [];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (grid[z][x] === 1) continue;   // walls only — obstacles (2) stay as floors visually
      if (Math.random() < FLOOR2_PROBABILITY) f2Cells.push([x, z]);
      else                                    f1Cells.push([x, z]);
    }
  }
  const buildFloorInst = (cells, asset, scale) => {
    if (!cells.length) return null;
    const inst = new THREE.InstancedMesh(asset.geometry, asset.material, cells.length);
    inst.receiveShadow = true;
    inst.castShadow    = false;        // floor doesn't cast onto itself
    for (let i = 0; i < cells.length; i++) {
      const [x, z] = cells[i];
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, Math.floor(Math.random() * 4) * Math.PI / 2, 0);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    return inst;
  };
  const floorInst1 = buildFloorInst(f1Cells, floor1, sFloor1);
  const floorInst2 = buildFloorInst(f2Cells, floor2, sFloor2);
  if (floorInst1) group.add(floorInst1);
  if (floorInst2) group.add(floorInst2);

  // ── Wall instances ───────────────────────────────────────────────
  // For every floor cell, check the 4 cardinal neighbours. Each
  // neighbour that is a wall produces one wall-tile instance.
  //
  // Position offset: instead of sitting EXACTLY on the half-cell
  // boundary (where half the wall thickness would protrude into the
  // floor cell and let the player's mesh visually clip through), the
  // wall is shifted by half its thickness toward the wall cell. That
  // way the wall geometry sits entirely on the wall-cell side of the
  // boundary and the player's collision (which already keeps them off
  // the wall cell) stops them from touching the wall visually.
  //
  // Rotation: confirmed via the tuner — N/S edges want -π/2 around Y
  // (local +Z → +X), E/W edges no rotation at all.
  //
  // Thickness in WORLD axes: after rotation, the wall's authored X
  // axis becomes the world axis perpendicular to the wall's run. For
  // N/S walls that's world Z; for E/W walls that's world X. The
  // unscaled X size of the model (we use sWallX = 1.0) is its real
  // thickness in metres.
  const halfThick = (wall.size.x * sWallX) * 0.5;   // = 0.20 by default
  const wallEdges = [];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (grid[z][x] === 1) continue;
      // N edge: wall cell at z-1; shift center back by halfThick so
      // the +Z half of the wall's thickness lands ON the boundary
      // (not inside the floor cell).
      if (isWallCell(grid, W, H, x,     z - 1)) wallEdges.push([x,                   z - 0.5 - halfThick, -Math.PI / 2]);
      // S edge: wall cell at z+1; shift forward by halfThick.
      if (isWallCell(grid, W, H, x,     z + 1)) wallEdges.push([x,                   z + 0.5 + halfThick, -Math.PI / 2]);
      // E edge: wall cell at x+1; thickness now along world X with
      // rotation 0, so shift +X by halfThick.
      if (isWallCell(grid, W, H, x + 1, z))     wallEdges.push([x + 0.5 + halfThick, z,                    0]);
      // W edge: wall cell at x-1; shift -X by halfThick.
      if (isWallCell(grid, W, H, x - 1, z))     wallEdges.push([x - 0.5 - halfThick, z,                    0]);
    }
  }
  if (wallEdges.length) {
    const wallInst = new THREE.InstancedMesh(wall.geometry, wall.material, wallEdges.length);
    wallInst.castShadow    = true;
    wallInst.receiveShadow = true;
    wallInst.name          = 'walls';   // host can find + rescale to tweak height
    for (let i = 0; i < wallEdges.length; i++) {
      const [px, pz, ry] = wallEdges[i];
      dummy.position.set(px, 0, pz);
      dummy.rotation.set(0, ry, 0);
      dummy.scale.set(sWallX, sWallY, sWallZ);
      dummy.updateMatrix();
      wallInst.setMatrixAt(i, dummy.matrix);
    }
    wallInst.instanceMatrix.needsUpdate = true;
    group.add(wallInst);
  }
  // Stash the authored wall height on the group so a host's tile-tweak
  // overlay can show actual wall metres (group's Y scale × this).
  group.userData.wallBaseHeight = TARGET_WALL_HEIGHT;

  // Corner instances are skipped — wall tiles meeting at right angles
  // already read as a clean corner without an extra piece. Asset still
  // loaded above (free in case we want it back later) but no instances
  // are emitted into the scene.
  void corner; void sCorner; void yCorner;

  // Door frames are placed by the host (Door class) — see attachDoorFrame()
  // below for the helper. We just expose the loaded tile asset here.
  group.userData.doorAsset   = door;
  group.userData.doorScaleX  = sDoorX;
  group.userData.doorScaleY  = sDoorY;
  group.userData.doorScaleZ  = sDoorZ;

  scene.add(group);
  return group;
}

// Add a static door-frame model to the scene at the given grid position
// and orientation. Called per-Door from main.js so the existing slab +
// ring visuals stay (they show open/closed state); the frame is just
// chrome around them. Returns the placed Mesh (single-instance, since
// the door count is small — a handful of doors don't justify the
// InstancedMesh bookkeeping).
//
//   tilesGroup    — the Group returned by buildLevelTiles (carries
//                   the door asset in userData).
//   x, z          — door cell position in grid coordinates.
//   corridorDir   — 'EW' (corridor runs E↔W, slab spans N–S, so the
//                   frame's long axis is N–S — rotate +90°); 'NS'
//                   (corridor runs N↔S, frame spans E–W — default).
//   corridorWidth — door width in cells (1, 3, …). The frame X-scale
//                   is multiplied so the model spans the corridor.
export function attachDoorFrame(tilesGroup, scene, x, z, corridorDir = 'NS', corridorWidth = 1) {
  const asset = tilesGroup?.userData?.doorAsset;
  const sX = tilesGroup?.userData?.doorScaleX || 1;
  const sY = tilesGroup?.userData?.doorScaleY || 1;
  const sZ = tilesGroup?.userData?.doorScaleZ || 1;
  if (!asset) return null;
  const mesh = new THREE.Mesh(asset.geometry, asset.material);
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  // The door is authored upright with its long axis along local +Z
  // (matches the wall model — both are 1m wide / cell along Z, height
  // on Y, thin on X). Stretch Z by the corridor width so multi-cell
  // doors fill the gap. Door class's `corridorDir` describes which way
  // the corridor runs:
  //   'EW' → corridor runs east-west along X, slab spans north-south
  //          along Z. Frame's long axis already on Z → no rotation.
  //   'NS' → corridor runs north-south along Z, slab spans east-west
  //          along X. Rotate +90° around Y so the frame spans X.
  mesh.scale.set(sX, sY, sZ * corridorWidth);
  mesh.position.set(x, 0, z);
  mesh.rotation.y = (corridorDir === 'NS') ? Math.PI / 2 : 0;
  scene.add(mesh);
  return mesh;
}
