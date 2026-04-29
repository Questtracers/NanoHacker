import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { isWall, rayMarch, findValidFloor, findPath } from './map.js';
import { makeFacingArrow } from './facing-arrow.js';

// Drone visual parameters — separate from the cone / AI logic.
// `facing` = cone direction (legacy, used for AI + vision).
// `bodyFacing` = the model's yaw, follows movement / shoot direction
//                independently of the cone. Smoothed toward target.
// `bodyPitch`  = forward tilt that BANKS through a yaw rotation: zero
//                at the start, peaks at the rotation midpoint, back to
//                zero at the end. Magnitude scales with how big the
//                rotation is, capped at BODY_PITCH_MAX.
const BODY_TURN_SPEED      = 6.0;            // rad/s body smoothing
const BODY_PITCH_MAX       = Math.PI / 3;    // 60° peak — biggest banks
const BODY_PITCH_BLEND_RATE = 8.0;           // 1/s exp blend toward target
// Recoil — total duration in seconds, peak displacement in metres.
// Curve: fast attack to peak (15 % of duration), then easing back to 0.
const RECOIL_DURATION      = 0.5;
const RECOIL_DISTANCE      = 0.25;
const RECOIL_ATTACK_FRAC   = 0.15;

const STEALTH_CONE_ANGLE = Math.PI / 8; // half the soldier's spread
const BATTLE_CONE_ANGLE  = Math.PI / 6;
const STEALTH_CONE_RANGE = 6;
const BATTLE_CONE_RANGE  = 10;
const LOSE_SIGHT_TIME    = 3.5;
const CONE_ROT_SPEED     = 1.4; // rad/s, clockwise sweep
const TURN_SPEED         = 3.0; // rad/s when locking onto a target
const TURN_SPEED_FAST    = 9.0; // rad/s when reacting to a bullet
const TURN_BOOST_TIME    = 0.45;
const TURN_THRESHOLD     = 0.18;
const AIM_SAMPLE_INTERVAL = 0.35; // s of real time between aim re-locks

export class Drone {
  constructor(scene, x, z, firstTarget = null) {
    // Two-layer visual: `bodyRoot` tracks the logic position (mesh
    // alias for collision / cone / HP-bar code); `bodyVis` is a child
    // group that holds the actual model and applies yaw, pitch, and
    // recoil offset purely visually so the cone stays anchored to the
    // logic position regardless of how the body kicks around.
    this.hoverBase = 1.0;
    this.bodyRoot = new THREE.Group();
    this.bodyRoot.position.set(x, this.hoverBase, z);
    scene.add(this.bodyRoot);

    this.bodyVis = new THREE.Group();
    this.bodyRoot.add(this.bodyVis);

    // Placeholder — small magenta sphere shown until the FBX streams in.
    const placeholder = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 12, 12),
      new THREE.MeshStandardMaterial({
        color: 0xff66cc, emissive: 0x551133, roughness: 0.3, metalness: 0.6,
      }),
    );
    placeholder.castShadow = true;
    this.bodyVis.add(placeholder);
    this._placeholder = placeholder;

    // Stream in the actual FBX model. Auto-scale to ~0.7 m largest extent
    // so it reads at a similar footprint to the placeholder. Fixed-up
    // material setup (sRGB textures, tighter PBR) once it's loaded.
    new FBXLoader().load(
      'Assets/Drone/Drone.fbx',
      (fbx) => {
        const box = new THREE.Box3().setFromObject(fbx);
        const size = box.getSize(new THREE.Vector3());
        const native = Math.max(size.x, size.y, size.z) || 1;
        const scale = 0.7 / native;
        fbx.scale.setScalar(scale);
        fbx.traverse((c) => {
          if (!c.isMesh && !c.isSkinnedMesh) return;
          c.castShadow    = true;
          c.receiveShadow = true;
          const fix = (m) => {
            if (m.map) {
              m.map.colorSpace = THREE.SRGBColorSpace;
              m.map.anisotropy = 4;
            }
            m.metalness = 0.5;
            m.roughness = 0.4;
            if (m.color && m.map) m.color.set(0xffffff);
            m.needsUpdate = true;
          };
          if (Array.isArray(c.material)) c.material.forEach(fix);
          else if (c.material)            fix(c.material);
        });
        // Center the model on the bodyVis origin so yaw/pitch rotate
        // around a sensible point, not an offset corner.
        box.setFromObject(fbx);
        const center = box.getCenter(new THREE.Vector3());
        fbx.position.sub(center);
        // Authored orientation has the model on its side; rotate -90°
        // around X so the flat underside ends up parallel to the floor.
        fbx.rotation.x = -Math.PI / 2;
        // Swap placeholder for the real model.
        this.bodyVis.remove(this._placeholder);
        this._placeholder = null;
        this.bodyVis.add(fbx);
        this._modelLoaded = true;
        // If hack-linked while loading, re-tint the new mesh.
        if (this.faction === 'friendly') this._applyFactionTint();
      },
      undefined,
      (err) => console.error('Drone: failed to load Drone.fbx', err),
    );

    this.mesh = this.bodyRoot;

    // Vision cone (same triangle-fan trick as the soldier, narrower half-angle)
    this.coneSegments = 24;
    const coneGeo = new THREE.BufferGeometry();
    coneGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array((this.coneSegments + 2) * 3), 3));
    const idx = [];
    for (let i = 0; i < this.coneSegments; i++) idx.push(0, i + 1, i + 2);
    coneGeo.setIndex(idx);

    this.coneMat = new THREE.MeshBasicMaterial({
      color: 0xff66ff, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.coneMesh = new THREE.Mesh(coneGeo, this.coneMat);
    this.coneMesh.position.y = 0.18;
    this.coneMesh.renderOrder = 2;
    scene.add(this.coneMesh);

    // Floor arrow following the cone — useful since drones spin a lot.
    this.facingArrow = makeFacingArrow(0xff66cc, 0.85);
    scene.add(this.facingArrow);

    // Continuous clockwise rotation — independent of movement direction.
    this.facing          = Math.random() * Math.PI * 2;
    this.bulletFacing    = null; // transient override when reacting to bullets
    this.turnBoostTimer  = 0;
    // Visual body state — separate from cone facing. The model rotates
    // toward movement / shoot direction; pitch tracks cone yaw rate.
    this.bodyFacing      = this.facing;
    this.bodyPitch       = 0;
    this._lastFacing     = this.facing;
    this._lastBodyX      = x;
    this._lastBodyZ      = z;
    // Bank-through-yaw state. When the body's yaw target shifts to a
    // new heading we snapshot the start angle and total signed rotation;
    // pitch then follows a sine curve that peaks at the rotation
    // midpoint and returns to zero on arrival.
    this._yawBankStart   = this.facing;
    this._yawBankTarget  = this.facing;
    this._yawBankTotal   = 0;
    // Recoil timer ticks down from RECOIL_DURATION on each shot.
    this._recoilTimer    = 0;
    this._recoilFacing   = this.facing;
    this._modelLoaded    = false;

    this.speed   = 2.6;
    this.alive   = true;
    this.alerted = false;
    this.losingSightTimer = 0;
    // BFS pathfinding while chasing the player so the drone doesn't smear
    // itself against walls when the player is around a corner.
    this.chasePath      = null;
    this.chasePos       = 0;
    this.chasePathTimer = 0;
    this.faction = 'hostile';
    // Drones fire one shot at a time, slightly faster than soldier bursts.
    this.shootCooldown    = 0.80;
    this.shootInterval    = 0.80;
    // Lagged aim — between samples the drone keeps rotating to the LAST
    // sighted target position, so the player can dodge the lock-on by moving.
    this.aimedPos         = null;
    this.aimSampleTimer   = 0;

    this.maxHp   = 2;
    this.hp      = this.maxHp;
    this.hpTimer = 0;
    const barW = 0.75, barH = 0.1, barD = 0.02;
    const bg = new THREE.Mesh(
      new THREE.BoxGeometry(barW, barH, barD),
      new THREE.MeshBasicMaterial({ color: 0x550000, depthTest: false }),
    );
    bg.position.set(x, 1.7, z);
    bg.visible = false; bg.renderOrder = 3;
    scene.add(bg);
    const fg = new THREE.Mesh(
      new THREE.BoxGeometry(barW, barH, barD * 2),
      new THREE.MeshBasicMaterial({ color: 0xff44aa, depthTest: false }),
    );
    fg.position.set(x, 1.7, z);
    fg.visible = false; fg.renderOrder = 4;
    scene.add(fg);
    this.hpBarBg = bg;
    this.hpBarFg = fg;
    this.hpBarW  = barW;

    // First destination = room where the player was spotted; afterwards random.
    // Drones now travel along BFS-computed corridors the same way soldiers do,
    // so they stop getting stuck on walls.
    this.firstDest = firstTarget; // { x, z } | null
    this.routePath = null;
    this.pathPos   = 0;
  }

  get position() { return this.mesh.position; }

  _buildRoute(map) {
    let dest;
    if (this.firstDest) {
      dest = this.firstDest;
      this.firstDest = null;
    } else if (map.rooms?.length) {
      const room = map.rooms[Math.floor(Math.random() * map.rooms.length)];
      dest = { x: room.cx, z: room.cy };
    } else {
      return null;
    }
    const fromV = findValidFloor(map, this.mesh.position.x, this.mesh.position.z);
    const toV   = findValidFloor(map, dest.x, dest.z);
    if (!fromV || !toV) return null;
    const path = findPath(map, fromV.x, fromV.z, toV.x, toV.z);
    return (path && path.length >= 1) ? path : null;
  }

  canSee(player, map) { return this._canSeePos(player.position.x, player.position.z, map); }

  _canSeePos(tx, tz, map) {
    const p = this.mesh.position;
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    const range = this.alerted ? BATTLE_CONE_RANGE : STEALTH_CONE_RANGE;
    if (dist > range) return false;
    // Stealth: must be inside the visual cone. Alerted: hold focus on any
    // target within range + line-of-sight, regardless of angle, so the
    // drone keeps tracking a moving player until cover breaks the LOS.
    if (!this.alerted) {
      let diff = Math.atan2(dx, dz) - this.facing;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) > STEALTH_CONE_ANGLE) return false;
    }
    return rayMarch(map, p.x, p.z, dx / dist, dz / dist, dist) >= dist - 0.1;
  }

  _findVisibleTarget(world, map) {
    const pool = [];
    if (this.faction === 'hostile') {
      if (world.player) pool.push({ pos: world.player.position, ent: world.player, isPlayer: true });
      for (const e of world.enemies || []) if (e.alive && e.faction === 'friendly') pool.push({ pos: e.mesh.position, ent: e });
      for (const d of world.drones  || []) if (d !== this && d.alive && d.faction === 'friendly') pool.push({ pos: d.mesh.position, ent: d });
      for (const m of world.mechas  || []) {
        if (m.alive && m.faction === 'friendly') {
          // A possessed mecha is the player for trigger purposes.
          pool.push({ pos: m.mesh.position, ent: m, isPlayer: m.possessed === true });
        }
      }
    } else {
      for (const e of world.enemies || []) if (e.alive && e.faction === 'hostile') pool.push({ pos: e.mesh.position, ent: e });
      for (const d of world.drones  || []) if (d !== this && d.alive && d.faction === 'hostile') pool.push({ pos: d.mesh.position, ent: d });
      for (const m of world.mechas  || []) if (m.alive && m.faction === 'hostile') pool.push({ pos: m.mesh.position, ent: m });
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
    // Same palette as the soldier — keeps all hostile-AI cones reading
    // as a single colour family regardless of unit type.
    if (this.faction === 'friendly') {
      this.coneMat.color.setHex(this.alerted ? 0x3388ff : 0x66ccff);
    } else {
      this.coneMat.color.setHex(this.alerted ? 0xff3030 : 0xffaa00);
    }
    this.coneMat.opacity = this.alerted ? 0.5 : 0.35;
  }

  _navigateTo(tx, tz, dt, map) {
    const dx = tx - this.mesh.position.x;
    const dz = tz - this.mesh.position.z;
    const d  = Math.hypot(dx, dz);
    if (d < 0.55) return true;
    const step = this.speed * dt;
    const nx = this.mesh.position.x + (dx / d) * step;
    const nz = this.mesh.position.z + (dz / d) * step;
    if (!isWall(map, nx, this.mesh.position.z)) this.mesh.position.x = nx;
    if (!isWall(map, this.mesh.position.x, nz)) this.mesh.position.z = nz;
    return false;
  }

  update(dt, map, world, game, time = 0) {
    if (!this.alive) return;
    if (world && !world.player && world.position) world = { player: world };

    // Real dt for rotation + shoot cooldown so the lock-on tell stays visible
    // and reload pacing is honest even while the world is in slow-mo.
    const realDt = world?.realDt ?? dt;

    // Gentle hover bob — purely cosmetic.
    this.mesh.position.y = this.hoverBase + Math.sin(time * 3.0 + this.mesh.position.x) * 0.08;

    const target = this._findVisibleTarget(world, map);
    // Bullet boost overrides every other facing logic for a short window so
    // the cone swings fast toward the bullet's source without teleporting.
    const boosting = this.turnBoostTimer > 0 && this.bulletFacing !== null;
    let aligned = false;
    if (target) {
      const wasAlerted = this.alerted;
      this.alerted          = true;
      this.losingSightTimer = 0;
      if (!wasAlerted && game?.onEnemySeesPlayer) game.onEnemySeesPlayer(this, world.player);

      const dx   = target.pos.x - this.mesh.position.x;
      const dz   = target.pos.z - this.mesh.position.z;
      const dist = Math.hypot(dx, dz);

      // Lagged aim sample: latch the target position every AIM_SAMPLE_INTERVAL
      // seconds (real time) and rotate toward the LATCH, not the live target.
      // A moving player can stay ahead of the cone instead of being snap-tracked.
      if (!this.aimedPos) this.aimedPos = { x: target.pos.x, z: target.pos.z };
      this.aimSampleTimer -= realDt;
      if (this.aimSampleTimer <= 0) {
        this.aimedPos.x = target.pos.x;
        this.aimedPos.z = target.pos.z;
        this.aimSampleTimer = AIM_SAMPLE_INTERVAL;
      }
      const ax = this.aimedPos.x - this.mesh.position.x;
      const az = this.aimedPos.z - this.mesh.position.z;
      const wantFacing = Math.atan2(ax, az);

      let diff = wantFacing - this.facing;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      aligned = Math.abs(diff) < TURN_THRESHOLD;
      if (!boosting) {
        // Real-time turn, throttled to 20 % during slow-mo so the cone
        // correction is visibly slow rather than a snap.
        const inSlowMo = dt + 1e-6 < realDt;
        const turnRate = TURN_SPEED * (inSlowMo ? 0.2 : 1);
        this.facing += Math.sign(diff) * Math.min(Math.abs(diff), turnRate * realDt);
      }

      // Chase via a periodically-refreshed BFS path so the drone rounds
      // corners cleanly. Movement is gated on alignment — drones can't fly
      // and rotate at the same time.
      if (aligned && dist > 2.2) {
        this._chaseStep(dt, map, target.pos);
      }

      // Fire rapid single shots while in range AND aimed. Cooldown ticks
      // with worldDt — slow-mo / pause slows the next shot too.
      this.shootCooldown -= dt;
      if (aligned && this.shootCooldown <= 0 && dist < BATTLE_CONE_RANGE) {
        // Bullets come out along the drone's current facing — its cone has
        // to lock on the target before shots will actually connect.
        const owner = this.faction === 'friendly' ? 'player' : 'enemy';
        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);
        game.spawnBullet(this.mesh.position.x, this.mesh.position.z, fx, fz, owner, this);
        this.shootCooldown = this.shootInterval;
        // Visual recoil — body kicks back along the shot direction
        // for ~0.5 s. Snap-aim the body toward the shot for the kick
        // window so the offset reads as a clean recoil along the
        // muzzle, regardless of which way the body was drifting.
        this._kickRecoil(this.facing);
      }
      // Clear any stale wander route so we start fresh once alert ends.
      this.routePath = null;
    } else {
      // Forget the cached aim so a re-acquire starts fresh instead of using
      // a stale snapshot.
      this.aimedPos       = null;
      this.aimSampleTimer = 0;
      if (this.alerted) {
        // Losing-sight timer ticks on WORLD time (worldDt) so slow-mo
        // stretches the de-alert just like it stretches everything else.
        this.losingSightTimer += dt;
        if (this.losingSightTimer >= LOSE_SIGHT_TIME) {
          this.alerted          = false;
          this.losingSightTimer = 0;
        }
      }
      // Cone sweep — uses worldDt so SUPERHOT slow-mo applies: when the
      // player stops moving in battle the cone visibly pauses too,
      // matching the rest of the world. While alerted-but-blocked the
      // cone holds still: a sweeping cone would keep re-acquiring the
      // player every rotation and reset the de-alert timer.
      if (!boosting && !this.alerted) this.facing -= CONE_ROT_SPEED * dt;

      // Wander via BFS routes — soldier-style corridor following, random dests.
      if (!this.routePath || this.pathPos >= this.routePath.length) {
        this.routePath = this._buildRoute(map);
        this.pathPos   = 0;
      }
      if (this.routePath && this.pathPos < this.routePath.length) {
        const wp = this.routePath[this.pathPos];
        if (this._navigateTo(wp.x, wp.z, dt, map)) this.pathPos++;
      }
    }

    // Apply the fast smooth turn toward the bullet source if one was queued.
    // Real-time so the snap-look reads as a quick reaction even in slow-mo.
    if (boosting) {
      let diff = this.bulletFacing - this.facing;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.facing += Math.sign(diff) * Math.min(Math.abs(diff), TURN_SPEED_FAST * realDt);
      this.turnBoostTimer -= realDt;
      if (this.turnBoostTimer <= 0) this.bulletFacing = null;
    }

    // Soft separation from soldiers, other drones and mechas so a swarm
    // can't bunch up into a single visual blob.
    this._avoidOthers(world, dt, map);

    // ── Drone body visuals ───────────────────────────────────────────
    // Yaw target: most recent shot for half a second, otherwise the
    // movement direction since last frame. Pitch tracks cone yaw rate
    // (faster scan → more pitched). Recoil offsets the visual model
    // relative to the bodyRoot. All purely cosmetic — the AI / cone /
    // collision math reads from bodyRoot.position which stays put.
    this._updateBodyVisuals(dt, realDt);

    this.updateConeMesh(map);
    this._updateHpBar(dt, world?.cameraYaw);
    const fp = this.mesh.position;
    this.facingArrow.position.set(fp.x, 0.04, fp.z);
    this.facingArrow.rotation.y = this.facing;
    this.facingArrow.visible    = this.alive;
  }

  _chaseStep(dt, map, targetPos) {
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
      const wp = this.chasePath[this.chasePos];
      if (this._navigateTo(wp.x, wp.z, dt, map)) this.chasePos++;
      return;
    }
    // Fallback — fly directly toward the target if no path could be built.
    this._navigateTo(targetPos.x, targetPos.z, dt, map);
  }

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
        const radius = (o.hitRadius ?? 0.4) + 0.6;
        if (d > radius || d < 0.001) continue;
        const force = (radius - d) / radius;
        pushX += (dx / d) * force;
        pushZ += (dz / d) * force;
      }
    }
    if (pushX !== 0 || pushZ !== 0) {
      const mag = Math.hypot(pushX, pushZ);
      this._navigateTo(
        this.mesh.position.x + pushX / mag,
        this.mesh.position.z + pushZ / mag,
        dt * 0.55,
        map,
      );
    }
  }

  // ── Body visuals — yaw, pitch, recoil ─────────────────────────────
  // Independent from cone facing so the model rotates toward where
  // it's MOVING / FIRING, while the cone keeps scanning. Pitch banks
  // forward in proportion to how fast the cone is yawing — gives the
  // drone a "leaning into the scan" read instead of a static turret.
  _updateBodyVisuals(dt, realDt) {
    if (dt <= 0) dt = 1e-6;
    // ── Body yaw target ────────────────────────────────────────────
    // While the recoil window is live we lock the body to the shot
    // direction so the kick reads cleanly. Otherwise: movement-based
    // when actually moving, else stay where we last pointed.
    let target = this.bodyFacing;
    if (this._recoilTimer > 0) {
      target = this._recoilFacing;
    } else {
      const dx = this.mesh.position.x - this._lastBodyX;
      const dz = this.mesh.position.z - this._lastBodyZ;
      const moveLen = Math.hypot(dx, dz);
      if (moveLen > 0.005) target = Math.atan2(dx, dz);
    }

    // Detect a "fresh" yaw target — if the new target differs from
    // the previous bank target by more than a small threshold, we
    // re-snapshot start + total so pitch starts a new sine arc.
    const wrap = (a) => {
      while (a >  Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    };
    const targetDelta = wrap(target - this._yawBankTarget);
    if (Math.abs(targetDelta) > 0.05) {
      this._yawBankStart  = this.bodyFacing;
      this._yawBankTarget = target;
      this._yawBankTotal  = wrap(target - this.bodyFacing);
    }

    // Smooth toward target (shortest arc).
    let diff = wrap(target - this.bodyFacing);
    const yawStep = Math.min(Math.abs(diff), BODY_TURN_SPEED * dt);
    this.bodyFacing += Math.sign(diff) * yawStep;

    // ── Pitch from yaw progress (banks through the rotation) ─────
    // Pitch follows a sine curve over the rotation: 0 at start,
    // peak at midpoint, 0 at arrival. Peak magnitude scales with
    // how big the rotation is — small turns barely tilt, half-circle
    // turns bank to the full BODY_PITCH_MAX.
    let pitchTarget = 0;
    const totalAbs = Math.abs(this._yawBankTotal);
    if (totalAbs > 0.05) {
      const traveled = wrap(this.bodyFacing - this._yawBankStart);
      const progress = Math.max(0, Math.min(1,
        (this._yawBankTotal !== 0 ? traveled / this._yawBankTotal : 0)));
      const magnitude = Math.min(1, totalAbs / Math.PI);
      pitchTarget = -BODY_PITCH_MAX * magnitude * Math.sin(progress * Math.PI);
      // Once the yaw has settled, retire the bank so we don't keep
      // computing a stale curve.
      if (Math.abs(diff) < 0.02 && progress >= 0.999) {
        this._yawBankTotal = 0;
      }
    }
    const pitchStep = Math.min(1, dt * BODY_PITCH_BLEND_RATE);
    this.bodyPitch += (pitchTarget - this.bodyPitch) * pitchStep;
    this._lastFacing  = this.facing;
    this._lastBodyX   = this.mesh.position.x;
    this._lastBodyZ   = this.mesh.position.z;

    // ── Recoil offset ─────────────────────────────────────────────
    // Curve: linear ramp up to peak in RECOIL_ATTACK_FRAC of duration,
    // then ease back down to 0 over the rest. Offset is in WORLD
    // units along the negative-of-facing axis (kick backward).
    let recoilAmp = 0;
    if (this._recoilTimer > 0) {
      this._recoilTimer -= dt;
      const phase = 1 - Math.max(0, this._recoilTimer) / RECOIL_DURATION;
      if (phase < RECOIL_ATTACK_FRAC) {
        recoilAmp = phase / RECOIL_ATTACK_FRAC;
      } else {
        recoilAmp = 1 - (phase - RECOIL_ATTACK_FRAC) / (1 - RECOIL_ATTACK_FRAC);
      }
      if (this._recoilTimer <= 0) this._recoilTimer = 0;
    }
    const recoilDist = recoilAmp * RECOIL_DISTANCE;
    const recoilX = -Math.sin(this._recoilFacing) * recoilDist;
    const recoilZ = -Math.cos(this._recoilFacing) * recoilDist;

    // ── Push to bodyVis ───────────────────────────────────────────
    this.bodyVis.position.set(recoilX, 0, recoilZ);
    this.bodyVis.rotation.y = this.bodyFacing;
    this.bodyVis.rotation.x = this.bodyPitch;
  }

  _kickRecoil(facing) {
    this._recoilTimer  = RECOIL_DURATION;
    this._recoilFacing = facing;
  }

  _applyFactionTint() {
    if (!this.bodyVis) return;
    const friendly = this.faction === 'friendly';
    this.bodyVis.traverse((c) => {
      if (!c.isMesh && !c.isSkinnedMesh) return;
      const tint = (m) => {
        if (m.color)    m.color.setHex(friendly ? 0x66ccff : 0xff66cc);
        if (m.emissive) m.emissive.setHex(friendly ? 0x113355 : 0x551133);
      };
      if (Array.isArray(c.material)) c.material.forEach(tint);
      else if (c.material)            tint(c.material);
    });
  }

  onBulletNearby(bulletDx, bulletDz) {
    if (!this.alive) return;
    // Defer the actual turn to update(): store the target angle + boost
    // timer so the cone rotates at TURN_SPEED_FAST instead of snapping.
    this.bulletFacing   = Math.atan2(-bulletDx, -bulletDz);
    this.turnBoostTimer = TURN_BOOST_TIME;
  }

  // World-space target for the hack-swarm VFX. Drones are floating
  // bodies — there's no head bone to home on, so we just take the
  // mesh centre. Same signature as Enemy.getHackTargetWorldPos for
  // the host's swarm-spawn call site.
  getHackTargetWorldPos(out = new THREE.Vector3()) {
    out.copy(this.mesh.position);
    return out;
  }

  hackLink() {
    if (!this.alive || this.faction === 'friendly') return;
    this.faction = 'friendly';
    const newHp = Math.max(1, Math.floor(this.maxHp / 2));
    this.maxHp = newHp;
    this.hp    = Math.min(this.hp, newHp);
    // Keep the HP bar visible for a few seconds so the player can see that
    // their new drone ally is already half-damaged.
    this.hpTimer = 5;
    this.hpBarBg.visible = true;
    this.hpBarFg.visible = true;
    // Tint runs against whichever child is currently in bodyVis —
    // placeholder sphere or the loaded FBX model. _applyFactionTint
    // also runs again on FBX load if hack happened during streaming.
    this._applyFactionTint();
    this.alerted          = false;
    this.losingSightTimer = 0;
    this.routePath        = null;
  }

  _updateHpBar(dt, cameraYaw = 0) {
    const p = this.mesh.position;
    this.hpBarBg.position.set(p.x, 1.7, p.z);
    this.hpBarBg.rotation.y = cameraYaw;
    const ratio = Math.max(0, this.hp / this.maxHp);
    this.hpBarFg.scale.x = ratio;
    // Left-anchored shrink — see mecha for the rotated-frame offset maths.
    const offset = this.hpBarW * (1 - ratio) / 2;
    this.hpBarFg.position.set(
      p.x - offset * Math.cos(cameraYaw),
      1.7,
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
    if (this.hp <= 0) this.kill();
  }

  kill() {
    this.alive               = false;
    this.mesh.visible        = false;
    this.coneMesh.visible    = false;
    this.facingArrow.visible = false;
    this.hpBarBg.visible     = false;
    this.hpBarFg.visible     = false;
  }
}
