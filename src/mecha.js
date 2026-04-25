import * as THREE from 'three';
import { isWall, rayMarch, findPath, findValidFloor } from './map.js';

const STEALTH_CONE_ANGLE = Math.PI / 4;
const STEALTH_CONE_RANGE = 8;
const BATTLE_CONE_ANGLE  = Math.PI / 3;
const BATTLE_CONE_RANGE  = 13;
const LOSE_SIGHT_TIME    = 2.5;
const TURN_SPEED         = 1.6;
const TURN_SPEED_FAST    = 7.0;
const TURN_BOOST_TIME    = 0.5;
const LEASH_RANGE        = 4.5;  // stays within this many cells of spawn while idle
const NEARBY_ALERT_RANGE = 9;    // wakes up if any other hostile gets alerted within this
const SPREAD             = Math.PI * 40 / 180; // ±40° fan for the side bullets
const BODY_SIZE          = 1.8;

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
    this.faction = 'hostile';

    // HP — 8 hitpoints. Bar shows briefly after damage / on hack.
    this.maxHp   = 8;
    this.hp      = 8;
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
    const half  = this.alerted ? BATTLE_CONE_ANGLE  : STEALTH_CONE_ANGLE;
    if (dist > range) return false;
    let diff = Math.atan2(dx, dz) - this.facing;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > half) return false;
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
        if (m !== this && m.alive && m.faction === 'friendly') pool.push({ pos: m.mesh.position });
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

  _shootFan(dx, dz, dist, game, owner = 'enemy') {
    const angle = Math.atan2(dx, dz);
    const aim = (a) => game.spawnBullet(
      this.mesh.position.x, this.mesh.position.z,
      Math.sin(a), Math.cos(a), owner, this,
    );
    aim(angle);
    aim(angle - SPREAD);
    aim(angle + SPREAD);
  }

  update(dt, map, world, game) {
    if (!this.alive) return;

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
      this.targetFacing = Math.atan2(dx, dz);
      // Roll forward when the target is far away, hold ground when close.
      if (dist > 3.5) this._tryMove(dx / dist, dz / dist, dt, map, world);

      this.shootCooldown -= dt;
      if (this.shootCooldown <= 0 && dist < BATTLE_CONE_RANGE) {
        // Friendly mechas shoot bullets that can damage hostiles, hostile
        // mechas shoot enemy-coloured bullets that hit the player + allies.
        const owner = this.faction === 'friendly' ? 'player' : 'enemy';
        this._shootFan(dx, dz, dist, game, owner);
        this.shootCooldown = this.shootInterval;
      }
    } else if (this.alerted) {
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

    this._smoothTurn(dt);
    this.updateConeMesh(map);
    this._updateHpBar(dt);
  }

  _updateHpBar(dt) {
    const p = this.mesh.position;
    this.hpBarBg.position.set(p.x, 2.7, p.z);
    this.hpBarFg.position.set(p.x, 2.7, p.z);
    const ratio = Math.max(0, this.hp / this.maxHp);
    this.hpBarFg.scale.x = ratio;
    this.hpBarFg.position.x = p.x - (this.hpBarW * (1 - ratio)) / 2;
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
    const newHp  = Math.max(1, Math.floor(this.maxHp / 2));
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

  kill() {
    this.alive            = false;
    this.mesh.visible     = false;
    this.coneMesh.visible = false;
    this.hpBarBg.visible  = false;
    this.hpBarFg.visible  = false;
  }
}
