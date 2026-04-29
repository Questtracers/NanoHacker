import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { isWall, rayMarch, findPath, findValidFloor } from './map.js';
import { makeFacingArrow } from './facing-arrow.js';
import { SoldierRig } from './soldier-rig.js';

// Rifle-on-RightHand calibration values, tuned in the debug-level
// weapon-calibration tool. All in the bone's LOCAL space. The rifle
// is parented to the bone and stays visible across every animation
// (idle, walk, alerted aim, firing recoil, hit, death) — soldiers
// always carry it.
const RIFLE_FILE = 'Assets/Weapons/soldier_rifle.glb';
const RIFLE_BONE = 'RightHand';
const RIFLE_POS  = new THREE.Vector3(0.04, 0.16, 0.04);
const RIFLE_ROT  = new THREE.Euler(
   100.0 * Math.PI / 180,
    -5.0 * Math.PI / 180,
   -80.0 * Math.PI / 180,
  'XYZ',
);
const RIFLE_SCALE = 0.481;

// Bullet emergence point in RightHand-local space — calibrated in the
// debug-level soldier-bullet hotspot tool. Bullets spawn from this
// world-transformed point so they emerge from the rifle's muzzle and
// follow the recoil animation correctly.
const MUZZLE_HOTSPOT_LOCAL = new THREE.Vector3(0.08, 0.375, 0.07);
const _tmpMuzzle = new THREE.Vector3();

// Cache the rifle geometry+material so each new Enemy reuses the same
// Three.js buffers — much cheaper than re-loading the GLB per soldier.
let _rifleAsset = null;
let _rifleLoadStarted = false;
const _waitingForRifle = new Set();
function _ensureRifleLoaded() {
  if (_rifleAsset || _rifleLoadStarted) return;
  _rifleLoadStarted = true;
  new GLTFLoader().load(
    RIFLE_FILE,
    (gltf) => {
      let mesh = null;
      gltf.scene.traverse((c) => { if (c.isMesh && !mesh) mesh = c; });
      if (!mesh) return;
      mesh.updateMatrixWorld(true);
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      _rifleAsset = { geometry: geo, material: mesh.material };
      // Retro-attach to any soldier that's been waiting.
      for (const enemy of _waitingForRifle) enemy._attachRifle();
      _waitingForRifle.clear();
    },
    undefined,
    (err) => console.error('Enemy: failed to load rifle', err),
  );
}
_ensureRifleLoaded();

const STEALTH_CONE_ANGLE = Math.PI / 4;
const STEALTH_CONE_RANGE = 7;
const BATTLE_CONE_ANGLE  = Math.PI / 3;
const BATTLE_CONE_RANGE  = 12;
const LOSE_SIGHT_TIME    = 4.0;
const WAIT_TIME          = 1.5;
const TURN_SPEED         = 2.5;
const TURN_SPEED_FAST    = 9.0; // boost rate when reacting to bullets
const TURN_BOOST_TIME    = 0.45;
const TURN_THRESHOLD     = 0.18; // rad — must be within ~10° before moving
const AIM_SAMPLE_INTERVAL = 0.45; // s of real time between aim re-locks

export class Enemy {
  constructor(scene, x, z) {
    // SoldierRig replaces the placeholder capsule. The rig's root Group
    // is added to the scene immediately and the FBX content streams in
    // over a few seconds — by the time the corp logo finishes the body
    // is visible.
    //
    // We alias `this.mesh` to rig.root so existing AI code (collision,
    // cone math, HP bar positioning, etc.) keeps reading position from
    // the same place.
    this.rig = new SoldierRig(scene, { moveSpeed: 2.0 });
    this.rig.position = { x, z };
    this.rig.load();
    this.mesh = this.rig.root;
    // Rifle is always carried — _attachRifle waits for both the rig's
    // skeleton and the rifle GLB to be ready before parenting.
    this._rifle = null;
    this._tryAttachRifle();

    this.coneSegments = 28;
    const coneGeo = new THREE.BufferGeometry();
    coneGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array((this.coneSegments + 2) * 3), 3));
    const idx = [];
    for (let i = 0; i < this.coneSegments; i++) idx.push(0, i + 1, i + 2);
    coneGeo.setIndex(idx);

    this.coneMat = new THREE.MeshBasicMaterial({
      color: 0xffaa00, transparent: true, opacity: 0.38,
      side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.coneMesh = new THREE.Mesh(coneGeo, this.coneMat);
    this.coneMesh.position.y = 0.18;
    this.coneMesh.renderOrder = 2;
    scene.add(this.coneMesh);

    // Floor arrow indicating which way the enemy is currently aimed.
    this.facingArrow = makeFacingArrow(0xff5555, 0.85);
    scene.add(this.facingArrow);

    this.facing          = Math.random() * Math.PI * 2;
    this.targetFacing    = this.facing;
    this.rig.facing      = this.facing;
    // During a short window after a bullet grazes us the cone swings at a
    // FAST rate toward the bullet's source regardless of anything else the
    // AI wants to track — this keeps the reaction feeling sudden.
    this.bulletFacing    = null;
    this.turnBoostTimer  = 0;
    this.speed           = 2.0;
    this.alive        = true;
    // 'hostile' by default; a successful hack-link flips this to 'friendly'
    // and the soldier starts hunting other hostiles instead of the player.
    this.faction      = 'hostile';

    this.alerted          = false;
    this.losingSightTimer = 0;
    this.shootCooldown    = 1.0;
    // Aim is re-sampled on a real-time interval — between samples the soldier
    // keeps swinging toward where it last saw the target, so a moving player
    // can break the lock-on instead of the cone tracking them perfectly.
    this.aimedPos         = null;
    this.aimSampleTimer   = 0;
    // While alerted, the soldier follows a BFS path toward the player so it
    // doesn't crash into walls. Recomputed periodically as the player moves.
    this.chasePath      = null;
    this.chasePos       = 0;
    this.chasePathTimer = 0;
    // Burst fire: 3 bullets close together, then a longer pause.
    this.burstRemaining   = 3;
    this.burstGap         = 0.10;
    this.burstRest        = 1.1;

    // Combat HP. Player bullets shave one hitpoint each.
    this.maxHp   = 4;
    this.hp      = this.maxHp;
    this.hpTimer = 0; // seconds the bar stays visible after a hit

    // HP bar: two thin boxes stacked above the capsule. Hidden until hit.
    const barW = 0.9, barH = 0.12, barD = 0.02;
    const bg = new THREE.Mesh(
      new THREE.BoxGeometry(barW, barH, barD),
      new THREE.MeshBasicMaterial({ color: 0x550000, depthTest: false }),
    );
    bg.position.set(x, 1.35, z);
    bg.visible = false;
    bg.renderOrder = 3;
    scene.add(bg);

    const fg = new THREE.Mesh(
      new THREE.BoxGeometry(barW, barH, barD * 2),
      new THREE.MeshBasicMaterial({ color: 0x44ff44, depthTest: false }),
    );
    fg.position.set(x, 1.35, z);
    fg.visible = false;
    fg.renderOrder = 4;
    scene.add(fg);

    this.hpBarBg = bg;
    this.hpBarFg = fg;
    this.hpBarW  = barW;

    // Patrol route
    this.routePath    = null;
    this.pathPos      = 0;
    this.routeDir     = 1;
    this.waitTimer    = 0;
    // Three patrol phases: 'move' | 'wait' | 'turn'
    // wait  = pausing at an endpoint
    // turn  = completing rotation toward next waypoint before stepping off
    this.patrolPhase  = 'move';

    this.returningToRoute = false;
    this._debugColor      = null;
  }

  get position() { return this.mesh.position; }

  setRoutePath(path) {
    if (!path?.length) return;
    this.routePath   = path;
    this.pathPos     = Math.min(1, path.length - 1);
    this.routeDir    = 1;
    this.waitTimer   = 0;
    this.patrolPhase = 'move';
  }

  canSee(player, map) { return this._canSeePos(player.position.x, player.position.z, map); }

  _canSeePos(tx, tz, map) {
    const p = this.mesh.position;
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    const range = this.alerted ? BATTLE_CONE_RANGE : STEALTH_CONE_RANGE;
    if (dist > range) return false;
    // Stealth requires the target to actually be inside the visual cone.
    // Once ALERTED, we hold focus on anyone within range + line-of-sight —
    // the cone-angle constraint drops away so the player can't break tracking
    // just by side-stepping. Cover (a wall blocking the ray) is the only way
    // out of the lock.
    if (!this.alerted) {
      let diff = Math.atan2(dx, dz) - this.facing;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) > STEALTH_CONE_ANGLE) return false;
    }
    return rayMarch(map, p.x, p.z, dx / dist, dz / dist, dist) >= dist - 0.1;
  }

  // Nearest visible opposing-faction entity in the world. Hostiles look for
  // the player + friendlies; friendlies look for hostiles only.
  _findVisibleTarget(world, map) {
    const pool = [];
    if (this.faction === 'hostile') {
      if (world.player) pool.push({ pos: world.player.position, ent: world.player, isPlayer: true });
      for (const e of world.enemies || []) {
        if (e !== this && e.alive && e.faction === 'friendly') pool.push({ pos: e.mesh.position, ent: e });
      }
      for (const d of world.drones || []) {
        if (d.alive && d.faction === 'friendly') pool.push({ pos: d.mesh.position, ent: d });
      }
      // Friendly mechas are valid targets too. A POSSESSED mecha counts as
      // "the player" for trigger purposes (drone backup, alerted UI), since
      // the human is literally driving it.
      for (const m of world.mechas || []) {
        if (m.alive && m.faction === 'friendly') {
          pool.push({ pos: m.mesh.position, ent: m, isPlayer: m.possessed === true });
        }
      }
    } else {
      for (const e of world.enemies || []) {
        if (e !== this && e.alive && e.faction === 'hostile') pool.push({ pos: e.mesh.position, ent: e });
      }
      for (const d of world.drones || []) {
        if (d.alive && d.faction === 'hostile') pool.push({ pos: d.mesh.position, ent: d });
      }
      for (const m of world.mechas || []) {
        if (m.alive && m.faction === 'hostile') pool.push({ pos: m.mesh.position, ent: m });
      }
    }
    let best = null, bestDist = Infinity;
    const p = this.mesh.position;
    for (const c of pool) {
      if (!this._canSeePos(c.pos.x, c.pos.z, map)) continue;
      const d = Math.hypot(c.pos.x - p.x, c.pos.z - p.z);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  _smoothTurn(dt) {
    const boosting = this.turnBoostTimer > 0 && this.bulletFacing !== null;
    const dest = boosting ? this.bulletFacing : this.targetFacing;
    let diff = dest - this.facing;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const speed = boosting ? TURN_SPEED_FAST : TURN_SPEED;
    this.facing += Math.sign(diff) * Math.min(Math.abs(diff), speed * dt);
    if (this.turnBoostTimer > 0) {
      this.turnBoostTimer -= dt;
      if (this.turnBoostTimer <= 0) this.bulletFacing = null;
    }
  }

  _facingError() {
    let diff = this.targetFacing - this.facing;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff);
  }

  // Aim targetFacing toward routePath[idx]
  _aimAtWaypoint(idx) {
    const wp = this.routePath?.[idx];
    if (!wp) return;
    const dx = wp.x - this.mesh.position.x;
    const dz = wp.z - this.mesh.position.z;
    if (Math.hypot(dx, dz) > 0.1) this.targetFacing = Math.atan2(dx, dz);
  }

  _navigateTo(tx, tz, dt, map) {
    const dx = tx - this.mesh.position.x;
    const dz = tz - this.mesh.position.z;
    const d  = Math.hypot(dx, dz);
    if (d < 0.55) return true;
    this.targetFacing = Math.atan2(dx, dz);
    this._tryMove(dx / d, dz / d, dt, map);
    return false;
  }

  _tryMove(dx, dz, dt, map) {
    // Same axis-separated wall check the player uses, with a 0.3-unit body
    // margin so soldiers don't clip into obstacle edges or hug walls in tight
    // corridors. Helps keep their patrol look centred and prevents
    // "spawned-on-an-obstacle" visual stuck states.
    const step   = this.speed * dt;
    const p      = this.mesh.position;
    const margin = 0.3;
    const nx = p.x + dx * step;
    const nz = p.z + dz * step;
    if (!isWall(map, nx, p.z) &&
        !isWall(map, nx + Math.sign(dx) * margin, p.z) &&
        !isWall(map, nx, p.z + margin) &&
        !isWall(map, nx, p.z - margin)) p.x = nx;
    if (!isWall(map, p.x, nz) &&
        !isWall(map, p.x + margin, nz) &&
        !isWall(map, p.x - margin, nz) &&
        !isWall(map, p.x, nz + Math.sign(dz) * margin)) p.z = nz;
  }

  _advanceRoute() {
    const next = this.pathPos + this.routeDir;
    if (next < 0 || next >= this.routePath.length) {
      // Endpoint reached — reverse direction, enter wait phase
      this.routeDir   *= -1;
      this.waitTimer   = WAIT_TIME;
      this.patrolPhase = 'wait';
    } else {
      this.pathPos     = next;
      this.patrolPhase = 'move';
    }
  }

  _nearestRoutePathPos() {
    if (!this.routePath?.length) return 0;
    const p = this.mesh.position;
    let best = 0, bestD = Infinity;
    this.routePath.forEach((wp, i) => {
      const d = Math.hypot(p.x - wp.x, p.z - wp.z);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  updateConeMesh(map) {
    const range = this.alerted ? BATTLE_CONE_RANGE : STEALTH_CONE_RANGE;
    const half  = this.alerted ? BATTLE_CONE_ANGLE  : STEALTH_CONE_ANGLE;
    const pos   = this.coneMesh.geometry.getAttribute('position');
    const ox = this.mesh.position.x, oz = this.mesh.position.z;
    pos.setXYZ(0, ox, 0, oz);
    for (let i = 0; i <= this.coneSegments; i++) {
      const a  = this.facing - half + (i / this.coneSegments) * half * 2;
      const d  = rayMarch(map, ox, oz, Math.sin(a), Math.cos(a), range);
      pos.setXYZ(i + 1, ox + Math.sin(a) * d, 0, oz + Math.cos(a) * d);
    }
    pos.needsUpdate = true;
    this.coneMesh.geometry.computeBoundingSphere();
    if (this.faction === 'friendly') {
      this.coneMat.color.setHex(this.alerted ? 0x3388ff : 0x66ccff);
    } else {
      this.coneMat.color.setHex(this.alerted ? 0xff3030 : 0xffaa00);
    }
    this.coneMat.opacity = this.alerted ? 0.45 : 0.38;
  }

  update(dt, map, world, game) {
    if (!this.alive) {
      // Even a dead soldier needs the mixer to advance so the death clip
      // plays through and stays clamped at its final pose.
      if (this.rig) this.rig.update(dt);
      return;
    }
    // Back-compat: if the host still passes the player directly, wrap it.
    if (world && !world.player && world.position) world = { player: world };

    // Rotation + shooting cadence run in real time so the player can read the
    // wind-up during slow-mo. Movement still uses dt (worldDt) to honour the
    // SUPERHOT bargain.
    const realDt = world?.realDt ?? dt;

    // Capture the body position before AI moves it — the delta this frame
    // is what the rig's blend tree uses to pick locomotion clips.
    const beforeX = this.mesh.position.x;
    const beforeZ = this.mesh.position.z;

    const target = this._findVisibleTarget(world, map);
    const seesTarget = target !== null;

    if (seesTarget) {
      const wasAlerted = this.alerted;
      this.alerted          = true;
      this.losingSightTimer = 0;
      this.returningToRoute = false;
      // Only notify on the transition — and only when a HOSTILE soldier
      // actually spots the player (not when a friendly spots a hostile, and
      // not when seeing another enemy).
      if (!wasAlerted && this.faction === 'hostile' && target.isPlayer) {
        game.onEnemySeesPlayer(this, world.player);
      }

      const dx   = target.pos.x - this.mesh.position.x;
      const dz   = target.pos.z - this.mesh.position.z;
      const dist = Math.hypot(dx, dz);

      // Aim is re-sampled on a real-time interval. Between samples the
      // soldier keeps rotating toward the LAST known target position, so a
      // moving player can break the lock-on rather than the cone snapping
      // onto them every frame.
      if (!this.aimedPos) this.aimedPos = { x: target.pos.x, z: target.pos.z };
      this.aimSampleTimer -= realDt;
      if (this.aimSampleTimer <= 0) {
        this.aimedPos.x = target.pos.x;
        this.aimedPos.z = target.pos.z;
        this.aimSampleTimer = AIM_SAMPLE_INTERVAL;
      }
      const ax = this.aimedPos.x - this.mesh.position.x;
      const az = this.aimedPos.z - this.mesh.position.z;
      this.targetFacing = Math.atan2(ax, az);

      // Combat is split into two phases: rotate (real-time, no movement, no
      // shots) until aligned, then chase + fire. So the player gets a clear,
      // visible "cone swinging onto me" tell before bullets start coming.
      const aligned = this._facingError() < TURN_THRESHOLD;
      if (aligned && dist > 3.5) {
        this._chaseStep(dx, dz, dist, dt, map, target.pos);
      }

      // Shoot cadence ticks with worldDt — when the player stops moving and
      // the world freezes, the reload freezes with it.
      this.shootCooldown -= dt;
      if (aligned && this.shootCooldown <= 0 && dist < BATTLE_CONE_RANGE) {
        // Always fire along the soldier's actual facing — they have to turn
        // (via _smoothTurn) to land hits, so the player can dodge during the
        // wind-up if they read the cone's swing.
        const owner = this.faction === 'friendly' ? 'player' : 'enemy';
        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);
        // Pull bullet spawn from the calibrated bone-local muzzle hotspot
        // so the bullet (and its muzzle flash) emerge from the rifle tip
        // and ride the recoil animation. Falls back to body center while
        // the rifle rig is still streaming.
        let sx = this.mesh.position.x, sz = this.mesh.position.z, sy = 0.6;
        if (this._muzzleHotspot) {
          const v = this._muzzleHotspot.getWorldPosition(_tmpMuzzle);
          sx = v.x; sy = v.y; sz = v.z;
        }
        game.spawnBullet(sx, sz, fx, fz, owner, this, sy);
        if (this.rig) this.rig.triggerFiring();
        this.burstRemaining--;
        if (this.burstRemaining <= 0) {
          this.burstRemaining = 3;
          this.shootCooldown  = this.burstRest;
        } else {
          this.shootCooldown  = this.burstGap;
        }
      }

    } else if (this.alerted) {
      // Lost line of sight: forget the cached aim so the next acquisition
      // starts a fresh sample interval (rather than instantly snapping).
      this.aimedPos       = null;
      this.aimSampleTimer = 0;
      this.losingSightTimer += dt;
      if (this.losingSightTimer >= LOSE_SIGHT_TIME) {
        this.alerted          = false;
        this.losingSightTimer = 0;
        this.returningToRoute = true;
        this.pathPos          = this._nearestRoutePathPos();
        this.patrolPhase      = 'move';
      } else {
        this._tryMove(Math.sin(this.facing), Math.cos(this.facing), dt * 0.35, map);
      }

    } else if (this.returningToRoute) {
      if (this.routePath?.length) {
        const wp = this.routePath[this.pathPos];
        if (this._navigateTo(wp.x, wp.z, dt, map)) {
          this.returningToRoute = false;
          this.patrolPhase      = 'move';
        }
      } else {
        this.returningToRoute = false;
      }

    } else if (this.routePath?.length) {
      // ── Patrol state machine ─────────────────────────────────────────
      if (this.patrolPhase === 'wait') {
        // Standing at endpoint, slowly look around
        this.waitTimer -= dt;
        this.targetFacing += dt * 0.4;
        if (this.waitTimer <= 0) {
          // Wait done → compute where we're heading next and turn toward it
          const nextIdx = this.pathPos + this.routeDir; // already reversed, so this is inward
          const clampedIdx = Math.max(0, Math.min(nextIdx, this.routePath.length - 1));
          this._aimAtWaypoint(clampedIdx);
          this.patrolPhase = 'turn';
        }

      } else if (this.patrolPhase === 'turn') {
        // Turned fully → only then start walking
        if (this._facingError() < TURN_THRESHOLD) {
          // Advance pathPos now that the turn is done
          const next = this.pathPos + this.routeDir;
          if (next >= 0 && next < this.routePath.length) this.pathPos = next;
          this.patrolPhase = 'move';
        }

      } else {
        // 'move' — walk toward current waypoint
        const wp      = this.routePath[this.pathPos];
        const reached = this._navigateTo(wp.x, wp.z, dt, map);
        if (reached) this._advanceRoute();
      }
    }

    // Soft separation from other living entities so soldiers don't pile up.
    this._avoidOthers(world, dt, map);

    // Rotation:
    //   • Tracking a visible target → real-time, but throttled to 20 % when
    //     the world is in slow-mo so the cone correction reads as a slow,
    //     deliberate sweep instead of a snap. Player has time to dodge.
    //   • Alerted-but-blocked       → worldDt, so the cone doesn't sweep
    //     over the player and reset the de-alert timer.
    const inSlowMo = dt + 1e-6 < realDt;
    const turnDt = seesTarget
      ? (inSlowMo ? realDt * 0.2 : realDt)
      : dt;
    this._smoothTurn(turnDt);
    this.updateConeMesh(map);
    this._updateHpBar(dt, world?.cameraYaw);
    // Keep the floor arrow under the soldier and aligned to their facing.
    const fp = this.mesh.position;
    this.facingArrow.position.set(fp.x, 0.04, fp.z);
    this.facingArrow.rotation.y = this.facing;
    this.facingArrow.visible    = this.alive;

    // ── Push state into the SoldierRig ─────────────────────────────────
    // The blend tree picks idle / strafe directions from the actual world
    // movement that happened during this AI tick. We feed it the delta
    // between pre-AI and current positions; the rig normalises and projects
    // onto its own facing internally. battleMode mirrors `alerted`.
    if (this.rig) {
      const moveDx = this.mesh.position.x - beforeX;
      const moveDz = this.mesh.position.z - beforeZ;
      const len    = Math.hypot(moveDx, moveDz);
      this.rig.facing     = this.facing;
      this.rig.battleMode = this.alerted;
      if (len > 1e-5) {
        this.rig.setMovement(moveDx / len, moveDz / len);
      } else {
        this.rig.setMovement(0, 0);
      }
      this.rig.update(dt);
    }
  }

  // Chase a moving target via a periodically-recomputed BFS path. Falls back
  // to the old direct charge if pathfinding can't return a usable waypoint
  // list (e.g. target snapped onto an unreachable cell).
  _chaseStep(dx, dz, dist, dt, map, targetPos) {
    this.chasePathTimer -= dt;
    const needsRefresh =
      this.chasePathTimer <= 0 ||
      !this.chasePath ||
      this.chasePos >= this.chasePath.length;
    if (needsRefresh) {
      const from = findValidFloor(map, this.mesh.position.x, this.mesh.position.z);
      const to   = findValidFloor(map, targetPos.x, targetPos.z);
      const path = (from && to)
        ? findPath(map, from.x, from.z, to.x, to.z)
        : null;
      this.chasePath      = (path && path.length >= 1) ? path : null;
      this.chasePos       = 0;
      this.chasePathTimer = 0.4;
    }
    if (this.chasePath && this.chasePos < this.chasePath.length) {
      const wp   = this.chasePath[this.chasePos];
      const wdx  = wp.x - this.mesh.position.x;
      const wdz  = wp.z - this.mesh.position.z;
      const wd   = Math.hypot(wdx, wdz);
      if (wd < 0.55) {
        this.chasePos++;
      } else {
        this._tryMove(wdx / wd, wdz / wd, dt, map);
      }
      return;
    }
    // Fallback — direct vector at the target.
    this._tryMove(dx / dist, dz / dist, dt, map);
  }

  // Soft repulsion from other living entities (soldiers, drones, mechas). A
  // tiny push perpendicular to the body means crowds spread out instead of
  // overlapping in the same cell.
  _avoidOthers(world, dt, map) {
    if (!world) return;
    const groups = [world.enemies, world.drones, world.mechas].filter(Boolean);
    let pushX = 0, pushZ = 0;
    for (const arr of groups) {
      for (const o of arr) {
        if (o === this || !o || !o.alive) continue;
        const dx = this.mesh.position.x - o.mesh.position.x;
        const dz = this.mesh.position.z - o.mesh.position.z;
        const d  = Math.hypot(dx, dz);
        // Larger entities (mechas) push from a wider radius.
        const radius = (o.hitRadius ?? 0.4) + 0.7;
        if (d > radius || d < 0.001) continue;
        const force = (radius - d) / radius;
        pushX += (dx / d) * force;
        pushZ += (dz / d) * force;
      }
    }
    if (pushX !== 0 || pushZ !== 0) {
      const mag = Math.hypot(pushX, pushZ);
      this._tryMove(pushX / mag, pushZ / mag, dt * 0.55, map);
    }
  }

  _updateHpBar(dt, cameraYaw = 0) {
    const p = this.mesh.position;
    this.hpBarBg.position.set(p.x, 1.35, p.z);
    this.hpBarBg.rotation.y = cameraYaw;
    const ratio = Math.max(0, this.hp / this.maxHp);
    this.hpBarFg.scale.x = ratio;
    // Left-anchored shrink — keep fg's left edge under bg's left edge after
    // rotation. See mecha for the maths (three.js Y rotation convention).
    const offset = this.hpBarW * (1 - ratio) / 2;
    this.hpBarFg.position.set(
      p.x - offset * Math.cos(cameraYaw),
      1.35,
      p.z + offset * Math.sin(cameraYaw),
    );
    this.hpBarFg.rotation.y = cameraYaw;
    if (this.hpTimer > 0) {
      this.hpTimer -= dt;
      if (this.hpTimer <= 0) {
        this.hpBarBg.visible = false;
        this.hpBarFg.visible = false;
      }
    }
  }

  takeDamage(n = 1) {
    if (!this.alive) return;
    this.hp -= n;
    this.hpTimer = 3;
    this.hpBarBg.visible = true;
    this.hpBarFg.visible = true;
    // Visual flinch — the rig picks the variant that matches its current
    // mode (battle ⇒ aggressive hit, otherwise normal hit).
    if (this.rig && this.hp > 0) this.rig.triggerHit();
    if (this.hp <= 0) this.kill();
  }

  onBulletNearby(bulletDx, bulletDz) {
    if (!this.alive) return;
    // Stash the bullet's origin angle and kick off the boost window. The
    // _smoothTurn uses this over the AI's targetFacing for ~½ s, so the cone
    // swings toward the shooter even if the soldier was tracking someone
    // else — fast but smooth, no teleport.
    this.bulletFacing   = Math.atan2(-bulletDx, -bulletDz);
    this.turnBoostTimer = TURN_BOOST_TIME;
  }

  // Flip this soldier to the player's side: halves HP and switches faction
  // so they begin hunting hostiles. Visuals recolour to a friendly blue.
  // World-space target for the hack-swarm VFX — the head bone if the
  // rig has streamed in, otherwise the body centre raised to head
  // height. Falls back gracefully so the swarm never fails to find
  // somewhere to fly to. Caches the bone reference on first hit.
  getHackTargetWorldPos(out = new THREE.Vector3()) {
    if (!this._headBone && this.rig?._fbx) {
      this.rig._fbx.traverse((node) => {
        if (this._headBone) return;
        if (/Head$/.test(node.name || '')) this._headBone = node;
      });
    }
    if (this._headBone) {
      this._headBone.getWorldPosition(out);
    } else {
      out.set(this.mesh.position.x, this.mesh.position.y + 1.5, this.mesh.position.z);
    }
    return out;
  }

  hackLink() {
    if (!this.alive || this.faction === 'friendly') return;
    this.faction = 'friendly';
    const newHp = Math.max(1, Math.floor(this.maxHp / 2));
    this.maxHp = newHp;
    this.hp    = Math.min(this.hp, newHp);
    // Keep the HP bar visible for several seconds so the player can clock
    // that their new ally is already half-damaged.
    this.hpTimer = 5;
    this.hpBarBg.visible = true;
    this.hpBarFg.visible = true;
    // Tint every SkinnedMesh material under the rig with a friendly blue
    // emissive glow — keeps the authored texture but adds a clear visual
    // cue. The old capsule had a single top-level material; the rig
    // hierarchy may have several, so traverse.
    if (this.mesh) {
      this.mesh.traverse((c) => {
        if (!c.isMesh && !c.isSkinnedMesh) return;
        const tint = (m) => {
          if (m.emissive) m.emissive.setHex(0x113355);
        };
        if (Array.isArray(c.material)) c.material.forEach(tint);
        else if (c.material)            tint(c.material);
      });
    }
    this.alerted          = false;
    this.losingSightTimer = 0;
    this.returningToRoute = true;
    this.pathPos          = this._nearestRoutePathPos();
    this.patrolPhase      = 'move';
  }

  kill() {
    this.alive               = false;
    // Don't hide the body — let the death animation play and clamp at the
    // final pose. The rig's mixer keeps ticking via the early-return path
    // in update() so the clip plays through.
    if (this.rig) this.rig.triggerDeath();
    this.coneMesh.visible    = false;
    this.facingArrow.visible = false;
    this.hpBarBg.visible     = false;
    this.hpBarFg.visible     = false;
  }

  // Wait for both the rig's skeleton and the cached rifle asset, then
  // parent the rifle to the RightHand bone with the calibrated
  // transform. If either side isn't ready yet, register and poll.
  _tryAttachRifle() {
    if (this._rifle) return;                  // already attached
    const ready = !!(this.rig._fbx && _rifleAsset);
    if (ready) { this._attachRifle(); return; }
    _waitingForRifle.add(this);
    // Also poll for the rig FBX in case the rifle is already cached
    // but the rig is still streaming — clear the wait once attached.
    const poll = setInterval(() => {
      if (!this.alive) { clearInterval(poll); return; }
      if (!this._rifle && this.rig._fbx && _rifleAsset) {
        clearInterval(poll);
        this._attachRifle();
      }
    }, 100);
  }

  _attachRifle() {
    if (this._rifle || !_rifleAsset || !this.rig._fbx) return;
    let hand = null;
    this.rig._fbx.traverse((node) => {
      if (!hand && new RegExp(`${RIFLE_BONE}$`).test(node.name || '')) hand = node;
    });
    if (!hand) {
      console.warn('Enemy: RightHand bone not found; rifle not attached');
      return;
    }
    const rifle = new THREE.Mesh(_rifleAsset.geometry, _rifleAsset.material);
    rifle.castShadow = true;
    rifle.position.copy(RIFLE_POS);
    rifle.rotation.copy(RIFLE_ROT);
    rifle.scale.setScalar(RIFLE_SCALE);
    hand.add(rifle);
    this._rifle = rifle;
    // Empty marker at the calibrated muzzle hotspot — bone-local, so it
    // tracks the recoil animation. We'll read its world position each
    // shot to get the bullet spawn point.
    const muzzle = new THREE.Object3D();
    muzzle.position.copy(MUZZLE_HOTSPOT_LOCAL);
    hand.add(muzzle);
    this._muzzleHotspot = muzzle;
    _waitingForRifle.delete(this);
  }
}
