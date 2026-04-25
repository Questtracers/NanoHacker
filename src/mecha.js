import * as THREE from 'three';
import { isWall, rayMarch, findPath, findValidFloor } from './map.js';
import { makeFacingArrow } from './facing-arrow.js';

const STEALTH_CONE_ANGLE = Math.PI / 4;
const STEALTH_CONE_RANGE = 8;
const BATTLE_CONE_ANGLE  = Math.PI / 3;
const BATTLE_CONE_RANGE  = 13;
const LOSE_SIGHT_TIME    = 4.5;
const TURN_SPEED         = 1.6;
const TURN_SPEED_FAST    = 7.0;
const TURN_BOOST_TIME    = 0.5;
const TURN_THRESHOLD     = 0.18;
const AIM_SAMPLE_INTERVAL = 0.55; // s of real time between aim re-locks (mecha is slow)
const LEASH_RANGE        = 4.5;  // stays within this many cells of spawn while idle
const NEARBY_ALERT_RANGE = 9;    // wakes up if any other hostile gets alerted within this
const SPREAD             = Math.PI * 40 / 180; // ±40° fan for the side bullets
const BODY_SIZE          = 1.8;

// Player-driven (possessed) tuning — the mecha plays very differently when
// the human is at the wheel. Faster turn, shorter reload, beefier HP fraction
// on hack-link.
const POSSESSED_TURN_SPEED   = Math.PI * 0.85; // rad/s manual rotate
const POSSESSED_SHOT_INTERVAL = 0.55;          // s between fan volleys
const POSSESSED_HP_FRACTION  = 0.8;
// Rocket reload — 300 % of the normal shot interval, i.e. one rocket per
// three normal shots. Heavy-hitter on a leash so neither the player nor the
// AI can spam it.
const POSSESSED_ROCKET_INTERVAL = POSSESSED_SHOT_INTERVAL * 3.0;
// Hostile-AI rocket reload uses the same 3× ratio against the AI's slower
// shootInterval (1.5 s) — about one rocket per 4.5 s of fire window.
const ENEMY_ROCKET_INTERVAL = 1.5 * 3.0;

// `isStrictWall` ignores grid==2 (obstacles) and only treats true walls as
// blockers, since a mecha rolls through obstacles and crushes them.
function isStrictWall(map, x, z) {
  const gx = Math.round(x), gz = Math.round(z);
  if (gx < 0 || gz < 0 || gx >= map.width || gz >= map.height) return true;
  return map.grid[gz][gx] === 1;
}

export class Mecha {
  constructor(scene, x, z) {
    // Same capsule silhouette as the soldier, scaled up so the radius equals
    // half the old box width — keeps the chunky 70%-of-corridor footprint
    // while reading as a beefed-up grunt instead of a generic crate.
    const radius = BODY_SIZE / 2;     // 0.9
    const cylLen = BODY_SIZE * 0.35;  // gives the mech a torso instead of a sphere
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, cylLen, 6, 14),
      new THREE.MeshStandardMaterial({
        color:    0xaa3344,
        emissive: 0x330812,
        roughness: 0.55, metalness: 0.65,
      }),
    );
    // Capsule's centre is at length/2 + radius up from its bottom — but we
    // anchor the bottom of the capsule on the floor by placing the centre at
    // (cylLen/2 + radius). That sits the head above the body cleanly.
    body.position.set(x, cylLen / 2 + radius, z);
    body.castShadow = true;
    scene.add(body);
    this.mesh = body;

    // Vision cone — same triangle-fan trick as the soldier.
    this.coneSegments = 30;
    const coneGeo = new THREE.BufferGeometry();
    coneGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array((this.coneSegments + 2) * 3), 3));
    const idx = [];
    for (let i = 0; i < this.coneSegments; i++) idx.push(0, i + 1, i + 2);
    coneGeo.setIndex(idx);
    this.coneMat = new THREE.MeshBasicMaterial({
      color: 0xff5555, transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.coneMesh = new THREE.Mesh(coneGeo, this.coneMat);
    this.coneMesh.position.y = 0.18;
    this.coneMesh.renderOrder = 2;
    scene.add(this.coneMesh);

    // Big floor arrow — same triangle as the soldier but scaled up since
    // the mecha is huge.
    this.facingArrow = makeFacingArrow(0xff3344, 0.85);
    this.facingArrow.scale.setScalar(1.6);
    scene.add(this.facingArrow);

    // Bullets hit anywhere within the body footprint, not just the centre.
    this.hitRadius = BODY_SIZE / 2;

    this.spawnX = x; this.spawnZ = z;
    // Idle patrol via BFS waypoints inside the leash radius.
    this.patrolPath  = null;
    this.patrolPos   = 0;
    this.patrolPause = 0;
    this.facing       = Math.random() * Math.PI * 2;
    this.targetFacing = this.facing;
    this.bulletFacing   = null;
    this.turnBoostTimer = 0;
    this.speed   = 1.4;
    this.alive   = true;
    this.alerted          = false;
    this.losingSightTimer = 0;
    this.shootCooldown    = 1.5;
    this.shootInterval    = 1.5;
    // Lagged aim — between samples the mecha keeps swinging toward the
    // LAST known target spot, so the player can outrun the lock-on.
    this.aimedPos         = null;
    this.aimSampleTimer   = 0;
    this.faction = 'hostile';
    // Possession state — true when the player is driving this mecha. Skips
    // the AI loop and reads input from world.player.keys instead.
    this.possessed        = false;
    // Rocket-launcher cooldown — both hostile AI mechas and the possessed
    // player-mecha use it; the interval just changes on possession entry.
    // Start with a partial wind-up so a freshly-spawned mecha doesn't insta-
    // fire a rocket the first frame it spots the player.
    this.rocketInterval   = ENEMY_ROCKET_INTERVAL;
    this.rocketCooldown   = ENEMY_ROCKET_INTERVAL * 0.5;

    // HP — 15 hitpoints. Bar shows briefly after damage / on hack.
    this.maxHp   = 15;
    this.hp      = 15;
    this.hpTimer = 0;
    const barW = 1.4, barH = 0.14, barD = 0.02;
    const bg = new THREE.Mesh(
      new THREE.BoxGeometry(barW, barH, barD),
      new THREE.MeshBasicMaterial({ color: 0x550000, depthTest: false }),
    );
    bg.position.set(x, 2.7, z);
    bg.visible = false; bg.renderOrder = 3;
    scene.add(bg);
    const fg = new THREE.Mesh(
      new THREE.BoxGeometry(barW, barH, barD * 2),
      new THREE.MeshBasicMaterial({ color: 0xff4488, depthTest: false }),
    );
    fg.position.set(x, 2.7, z);
    fg.visible = false; fg.renderOrder = 4;
    scene.add(fg);
    this.hpBarBg = bg; this.hpBarFg = fg; this.hpBarW = barW;
  }

  get position() { return this.mesh.position; }

  _canSeePos(tx, tz, map) {
    const p = this.mesh.position;
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    const range = this.alerted ? BATTLE_CONE_RANGE : STEALTH_CONE_RANGE;
    if (dist > range) return false;
    // Stealth detection requires the visual cone. Once alerted, the mecha
    // holds focus on any target within range + LOS — only cover breaks the
    // lock, not the player's lateral movement.
    if (!this.alerted) {
      let diff = Math.atan2(dx, dz) - this.facing;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) > STEALTH_CONE_ANGLE) return false;
    }
    return rayMarch(map, p.x, p.z, dx / dist, dz / dist, dist) >= dist - 0.1;
  }

  // Faction-aware target picker. Hostile mechas look for the player + any
  // hack-linked friendlies; a hack-linked (friendly) mecha hunts the
  // remaining hostiles instead of attacking the player.
  _findVisibleTarget(world, map) {
    const pool = [];
    if (this.faction === 'hostile') {
      if (world.player) pool.push({ pos: world.player.position, isPlayer: true });
      for (const e of world.enemies || [])
        if (e !== this && e.alive && e.faction === 'friendly') pool.push({ pos: e.mesh.position });
      for (const d of world.drones || [])
        if (d.alive && d.faction === 'friendly') pool.push({ pos: d.mesh.position });
      for (const m of world.mechas || [])
        if (m !== this && m.alive && m.faction === 'friendly') {
          pool.push({ pos: m.mesh.position, isPlayer: m.possessed === true });
        }
    } else {
      for (const e of world.enemies || [])
        if (e !== this && e.alive && e.faction === 'hostile') pool.push({ pos: e.mesh.position });
      for (const d of world.drones || [])
        if (d.alive && d.faction === 'hostile') pool.push({ pos: d.mesh.position });
      for (const m of world.mechas || [])
        if (m !== this && m.alive && m.faction === 'hostile') pool.push({ pos: m.mesh.position });
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
      const a = this.facing - half + (i / this.coneSegments) * half * 2;
      const d = rayMarch(map, ox, oz, Math.sin(a), Math.cos(a), range);
      pos.setXYZ(i + 1, ox + Math.sin(a) * d, 0, oz + Math.cos(a) * d);
    }
    pos.needsUpdate = true;
    this.coneMesh.geometry.computeBoundingSphere();
    this.coneMat.color.setHex(this.alerted ? 0xff2244 : 0xff5555);
    this.coneMat.opacity = this.alerted ? 0.55 : 0.4;
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

  // Mechas treat obstacles as walkable — they just plough through. After a
  // movement step we ask the world to crush any obstacle the body now overlaps.
  _tryMove(dx, dz, dt, map, world) {
    const step = this.speed * dt;
    const p    = this.mesh.position;
    const m    = BODY_SIZE / 2 - 0.1;
    const nx = p.x + dx * step;
    const nz = p.z + dz * step;
    if (!isStrictWall(map, nx, p.z) &&
        !isStrictWall(map, nx + Math.sign(dx) * m, p.z) &&
        !isStrictWall(map, nx, p.z + m) &&
        !isStrictWall(map, nx, p.z - m)) p.x = nx;
    if (!isStrictWall(map, p.x, nz) &&
        !isStrictWall(map, p.x + m, nz) &&
        !isStrictWall(map, p.x - m, nz) &&
        !isStrictWall(map, p.x, nz + Math.sign(dz) * m)) p.z = nz;

    if (world?.destroyObstacleAt) {
      // Sweep the body footprint and destroy anything underneath.
      for (let oz = -1; oz <= 1; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          world.destroyObstacleAt(p.x + ox * (BODY_SIZE / 2.5), p.z + oz * (BODY_SIZE / 2.5));
        }
      }
    }
  }

  _pickPatrolDest(map) {
    // Random target inside the leash circle. Bail to null if no walkable cell
    // is close enough — the caller will short-pause and try again next frame.
    for (let tries = 0; tries < 6; tries++) {
      const angle = Math.random() * Math.PI * 2;
      const r     = 1.5 + Math.random() * (LEASH_RANGE - 1.5);
      const tx    = this.spawnX + Math.cos(angle) * r;
      const tz    = this.spawnZ + Math.sin(angle) * r;
      const v     = findValidFloor(map, tx, tz);
      if (!v) continue;
      if (Math.hypot(v.x - this.spawnX, v.z - this.spawnZ) > LEASH_RANGE) continue;
      // Don't bother re-picking essentially the same spot we're already on.
      if (Math.hypot(v.x - this.mesh.position.x, v.z - this.mesh.position.z) < 1.2) continue;
      return v;
    }
    return null;
  }

  _navigateTo(tx, tz, dt, map, world) {
    const dx = tx - this.mesh.position.x;
    const dz = tz - this.mesh.position.z;
    const d  = Math.hypot(dx, dz);
    if (d < 0.55) return true;
    this.targetFacing = Math.atan2(dx, dz);
    this._tryMove(dx / d, dz / d, dt, map, world);
    return false;
  }

  _shootFan(game, owner = 'enemy') {
    // Fan is centred on the mecha's actual facing — it has to turn toward
    // its target before shots line up.
    const angle = this.facing;
    const aim = (a) => game.spawnBullet(
      this.mesh.position.x, this.mesh.position.z,
      Math.sin(a), Math.cos(a), owner, this,
    );
    aim(angle);
    aim(angle - SPREAD);
    aim(angle + SPREAD);
  }

  _facingError() {
    let diff = this.targetFacing - this.facing;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff);
  }

  // ── Player-controlled update ──────────────────────────────────────────
  // WASD drives _tryMove (matches Player's camera-relative axes), Q/E
  // rotates at POSSESSED_TURN_SPEED, SPACE shoots via the global key
  // listener (which calls _shootFan + resets shootCooldown).
  _possessedUpdate(dt, realDt, map, world, game) {
    const keys = world?.player?.keys;
    if (!keys) return;

    // Manual rotation, real-time so aim stays responsive in slow-mo.
    let turn = 0;
    if (keys.has('q')) turn -= 1;
    if (keys.has('e')) turn += 1;
    if (turn) {
      this.facing += turn * POSSESSED_TURN_SPEED * realDt;
      while (this.facing >  Math.PI) this.facing -= Math.PI * 2;
      while (this.facing < -Math.PI) this.facing += Math.PI * 2;
    }
    this.targetFacing = this.facing;

    // Movement on world time (worldDt) so the slow-mo bargain still applies.
    let ix = 0, iz = 0;
    if (keys.has('w')) iz -= 1;
    if (keys.has('s')) iz += 1;
    if (keys.has('a')) ix -= 1;
    if (keys.has('d')) ix += 1;
    const len = Math.hypot(ix, iz);
    if (len > 0) {
      ix /= len; iz /= len;
      const wx =  iz;
      const wz = -ix;
      this._tryMove(wx, wz, dt, map, world);
    }

    // Cooldowns tick with worldDt — slow-mo slows both reloads.
    if (this.shootCooldown  > 0) this.shootCooldown  -= dt;
    if (this.rocketCooldown > 0) this.rocketCooldown -= dt;

    this.updateConeMesh(map);
    this._updateHpBar(dt, world?.cameraYaw);

    const fp = this.mesh.position;
    this.facingArrow.position.set(fp.x, 0.04, fp.z);
    this.facingArrow.rotation.y = this.facing;
    this.facingArrow.visible    = this.alive;
  }

  // Public hook used by the host's SPACE key listener while possessed.
  // Returns true if a volley was fired, false if still on cooldown.
  playerFire(game) {
    if (!this.alive || !this.possessed) return false;
    if (this.shootCooldown > 0) return false;
    this._shootFan(game, 'player');
    this.shootCooldown = POSSESSED_SHOT_INTERVAL;
    return true;
  }

  // F-key handler while possessed. Spawns a single rocket along the mecha's
  // current facing — explodes on contact, big AOE. Long cooldown.
  playerFireRocket(game) {
    if (!this.alive || !this.possessed) return false;
    if (this.rocketCooldown > 0) return false;
    if (typeof game?.spawnRocket !== 'function') return false;
    const fx = Math.sin(this.facing);
    const fz = Math.cos(this.facing);
    // Spawn slightly ahead of the body so the rocket doesn't immediately
    // self-detonate against the mecha's own hit radius.
    const offset = 1.2;
    game.spawnRocket(
      this.mesh.position.x + fx * offset,
      this.mesh.position.z + fz * offset,
      fx, fz, 'player', this,
    );
    this.rocketCooldown = POSSESSED_ROCKET_INTERVAL;
    return true;
  }

  update(dt, map, world, game) {
    if (!this.alive) return;
    // Real dt for rotation + shoot cadence so wind-up reads honestly during
    // slow-mo. Movement still uses dt (worldDt).
    const realDt = world?.realDt ?? dt;

    // Player-driven branch: skip every AI loop, read input from world.player,
    // and hand the rest of the body update (cone, hp bar, arrow) over.
    if (this.possessed) {
      return this._possessedUpdate(dt, realDt, map, world, game);
    }

    // Inherit alert state from any nearby alerted entity OF THE OPPOSITE
    // FACTION — a hostile mecha wakes up when an allied hostile spots the
    // player; a friendly (hacked) mecha wakes up when a hostile is nearby.
    if (!this.alerted) {
      const all = (world?.enemies || []).concat(world?.drones || []).concat(world?.mechas || []);
      for (const e of all) {
        if (e === this || !e.alive || !e.alerted) continue;
        // Wake on a nearby alerted enemy of the OPPOSITE faction — a
        // friendly mecha wakes when hostiles roar nearby, hostile wakes
        // when allies (other hostiles) spot the player. Same-faction
        // alerts don't propagate (they're already on our side).
        if (e.faction === this.faction) continue;
        const ed = Math.hypot(
          e.mesh.position.x - this.mesh.position.x,
          e.mesh.position.z - this.mesh.position.z,
        );
        if (ed <= NEARBY_ALERT_RANGE) { this.alerted = true; break; }
      }
    }

    const target = this._findVisibleTarget(world, map);
    if (target) {
      this.alerted          = true;
      this.losingSightTimer = 0;
      this.patrolPath       = null; // drop stale waypoints; re-pick on idle

      const dx   = target.pos.x - this.mesh.position.x;
      const dz   = target.pos.z - this.mesh.position.z;
      const dist = Math.hypot(dx, dz);

      // Lagged aim sample — mecha doesn't track the player perfectly. It
      // commits to a position, swings the turret there (real time), then
      // re-samples. Gives the player a window to slip the cone.
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

      // Mecha is a tank — it rotates first (real-time, no movement) and only
      // rolls / fires once aimed. The slow turn doubles as the player's
      // dodge window.
      const aligned = this._facingError() < TURN_THRESHOLD;
      if (aligned && dist > 3.5) this._tryMove(dx / dist, dz / dist, dt, map, world);

      // Both reloads tick with worldDt so slow-mo / pause throttles them.
      this.shootCooldown  -= dt;
      this.rocketCooldown -= dt;
      const owner = this.faction === 'friendly' ? 'player' : 'enemy';
      if (aligned && dist < BATTLE_CONE_RANGE) {
        // Rocket goes first when ready — heavier punch, longer cooldown, so
        // it pre-empts the regular fan when both timers are off CD.
        if (this.rocketCooldown <= 0 && typeof game?.spawnRocket === 'function') {
          const fx = Math.sin(this.facing);
          const fz = Math.cos(this.facing);
          const offset = 1.2;
          game.spawnRocket(
            this.mesh.position.x + fx * offset,
            this.mesh.position.z + fz * offset,
            fx, fz, owner, this,
          );
          this.rocketCooldown = this.rocketInterval;
        } else if (this.shootCooldown <= 0) {
          // Friendly mechas shoot bullets that can damage hostiles, hostile
          // mechas shoot enemy-coloured bullets that hit the player + allies.
          this._shootFan(game, owner);
          this.shootCooldown = this.shootInterval;
        }
      }
    } else if (this.alerted) {
      // Drop the cached aim so a re-acquire starts a fresh sample.
      this.aimedPos       = null;
      this.aimSampleTimer = 0;
      this.losingSightTimer += dt;
      // Drift forward in the last facing direction while searching.
      this._tryMove(Math.sin(this.facing), Math.cos(this.facing), dt * 0.4, map, world);
      if (this.losingSightTimer >= LOSE_SIGHT_TIME) {
        this.alerted          = false;
        this.losingSightTimer = 0;
      }
    } else {
      // Idle: short patrol around the spawn area. If the leash gets stretched
      // (knocked out somehow), walk straight back. Otherwise pick BFS-derived
      // waypoints inside the leash radius and march them slowly.
      const dx = this.mesh.position.x - this.spawnX;
      const dz = this.mesh.position.z - this.spawnZ;
      const fromSpawn = Math.hypot(dx, dz);
      if (fromSpawn > LEASH_RANGE + 0.5) {
        this.patrolPath = null;
        this._navigateTo(this.spawnX, this.spawnZ, dt, map, world);
      } else if (this.patrolPause > 0) {
        this.patrolPause -= dt;
        this.targetFacing += dt * 0.35;
      } else if (!this.patrolPath || this.patrolPos >= this.patrolPath.length) {
        const dest = this._pickPatrolDest(map);
        if (dest) {
          const from = findValidFloor(map, this.mesh.position.x, this.mesh.position.z);
          if (from) {
            this.patrolPath = findPath(map, from.x, from.z, dest.x, dest.z);
            this.patrolPos  = 0;
          }
        }
        if (!this.patrolPath || !this.patrolPath.length) {
          this.patrolPause = 0.6 + Math.random() * 0.6;
        }
      } else {
        const wp = this.patrolPath[this.patrolPos];
        if (this._navigateTo(wp.x, wp.z, dt, map, world)) {
          this.patrolPos++;
          if (this.patrolPos >= this.patrolPath.length) {
            // Brief pause before picking the next leg — feels like a watch
            // check rather than a robot pacing.
            this.patrolPause = 0.8 + Math.random() * 0.8;
          }
        }
      }
    }

    // Rotation:
    //   • Tracking a visible target → real-time, throttled to 20 % during
    //     slow-mo so the turret correction is clearly slow.
    //   • Alerted-but-blocked       → worldDt, so the cone doesn't sweep
    //     over the player and reset the de-alert timer.
    const seesTargetNow = !!target;
    const inSlowMo = dt + 1e-6 < realDt;
    const turnDt = seesTargetNow
      ? (inSlowMo ? realDt * 0.2 : realDt)
      : dt;
    this._smoothTurn(turnDt);
    this.updateConeMesh(map);
    this._updateHpBar(dt, world?.cameraYaw);

    // Sync the floor arrow to the body's footing and current facing.
    const fp = this.mesh.position;
    this.facingArrow.position.set(fp.x, 0.04, fp.z);
    this.facingArrow.rotation.y = this.facing;
    this.facingArrow.visible    = this.alive;
  }

  _updateHpBar(dt, cameraYaw = 0) {
    const p = this.mesh.position;
    // Billboard on the Y axis to camera yaw — bar's wide face always faces
    // the camera regardless of where the body is pointing.
    this.hpBarBg.position.set(p.x, 2.7, p.z);
    this.hpBarBg.rotation.y = cameraYaw;
    const ratio = Math.max(0, this.hp / this.maxHp);
    this.hpBarFg.scale.x = ratio;
    // Left-anchor the foreground bar against the rotated bg. The fg centre
    // shifts along the bar's local +X (which in world space, for three.js
    // Y rotation, points along (cos(yaw), 0, -sin(yaw))).
    const offset = this.hpBarW * (1 - ratio) / 2;
    this.hpBarFg.position.set(
      p.x - offset * Math.cos(cameraYaw),
      2.7,
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
    this.hpTimer = 3.5;
    this.hpBarBg.visible = true;
    this.hpBarFg.visible = true;
    if (this.hp <= 0) this.kill();
  }

  onBulletNearby(bulletDx, bulletDz) {
    if (!this.alive) return;
    this.bulletFacing   = Math.atan2(-bulletDx, -bulletDz);
    this.turnBoostTimer = TURN_BOOST_TIME;
  }

  hackLink() {
    if (!this.alive || this.faction === 'friendly') return;
    this.faction = 'friendly';
    // Mechas keep 80 % of their HP on hack — the player will be possessing
    // them, so they're meant to feel like a brief power fantasy, not the
    // glass cannon a halved soldier becomes.
    const newHp  = Math.max(1, Math.round(this.maxHp * POSSESSED_HP_FRACTION));
    this.maxHp   = newHp;
    this.hp      = Math.min(this.hp, newHp);
    this.hpTimer = 5;
    this.hpBarBg.visible = true;
    this.hpBarFg.visible = true;
    this.alerted          = false;
    this.losingSightTimer = 0;
    this.mesh.material.color.setHex(0x3399ff);
    this.mesh.material.emissive.setHex(0x113355);
    this.coneMat.color.setHex(0x66ccff);
  }

  // ── Possession ─────────────────────────────────────────────────────────
  // Called by the host when the player enters the mecha. The host is
  // responsible for hiding the player mesh and routing input. While
  // possessed the AI logic is bypassed entirely — _possessedUpdate runs
  // instead. shootCooldown is shortened so the player can mash the fire
  // button at a brisker tempo than the AI's lazy 1.5 s.
  enterPossession() {
    this.possessed = true;
    this.alerted = false;
    this.losingSightTimer = 0;
    this.shootCooldown = 0;
    // Player tempo is faster on both weapons.
    this.rocketInterval = POSSESSED_ROCKET_INTERVAL;
    this.rocketCooldown = 0;
  }

  leavePossession() {
    this.possessed = false;
    // Reset cadence to the AI's slower defaults — un-driven mecha shouldn't
    // keep firing at the player's quick tempo.
    this.shootCooldown  = this.shootInterval;
    this.rocketInterval = ENEMY_ROCKET_INTERVAL;
    this.rocketCooldown = ENEMY_ROCKET_INTERVAL;
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
