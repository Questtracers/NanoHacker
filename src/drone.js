import * as THREE from 'three';
import { isWall, rayMarch, findValidFloor, findPath } from './map.js';

const STEALTH_CONE_ANGLE = Math.PI / 8; // half the soldier's spread
const BATTLE_CONE_ANGLE  = Math.PI / 6;
const STEALTH_CONE_RANGE = 6;
const BATTLE_CONE_RANGE  = 10;
const LOSE_SIGHT_TIME    = 1.8;
const CONE_ROT_SPEED     = 1.4; // rad/s, clockwise sweep
const TURN_SPEED_FAST    = 9.0; // rad/s when reacting to a bullet
const TURN_BOOST_TIME    = 0.45;

export class Drone {
  constructor(scene, x, z, firstTarget = null) {
    // Body: small floating sphere, pink/magenta to read as different from
    // the red capsule soldiers.
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 14, 14),
      new THREE.MeshStandardMaterial({
        color: 0xff66cc, emissive: 0x551133, roughness: 0.3, metalness: 0.6,
      }),
    );
    body.position.set(x, 1.0, z); // hovers a bit above the floor
    body.castShadow = true;
    scene.add(body);
    this.mesh = body;
    this.hoverBase = 1.0;

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

    // Continuous clockwise rotation — independent of movement direction.
    this.facing          = Math.random() * Math.PI * 2;
    this.bulletFacing    = null; // transient override when reacting to bullets
    this.turnBoostTimer  = 0;

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
    const half  = this.alerted ? BATTLE_CONE_ANGLE  : STEALTH_CONE_ANGLE;
    if (dist > range) return false;
    let diff = Math.atan2(dx, dz) - this.facing;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > half) return false;
    return rayMarch(map, p.x, p.z, dx / dist, dz / dist, dist) >= dist - 0.1;
  }

  _findVisibleTarget(world, map) {
    const pool = [];
    if (this.faction === 'hostile') {
      if (world.player) pool.push({ pos: world.player.position, ent: world.player, isPlayer: true });
      for (const e of world.enemies || []) if (e.alive && e.faction === 'friendly') pool.push({ pos: e.mesh.position, ent: e });
      for (const d of world.drones  || []) if (d !== this && d.alive && d.faction === 'friendly') pool.push({ pos: d.mesh.position, ent: d });
    } else {
      for (const e of world.enemies || []) if (e.alive && e.faction === 'hostile') pool.push({ pos: e.mesh.position, ent: e });
      for (const d of world.drones  || []) if (d !== this && d.alive && d.faction === 'hostile') pool.push({ pos: d.mesh.position, ent: d });
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
    if (this.faction === 'friendly') {
      this.coneMat.color.setHex(this.alerted ? 0x3388ff : 0x66ccff);
    } else {
      this.coneMat.color.setHex(this.alerted ? 0xff3399 : 0xff66ff);
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

    // Gentle hover bob — purely cosmetic.
    this.mesh.position.y = this.hoverBase + Math.sin(time * 3.0 + this.mesh.position.x) * 0.08;

    const target = this._findVisibleTarget(world, map);
    // Bullet boost overrides every other facing logic for a short window so
    // the cone swings fast toward the bullet's source without teleporting.
    const boosting = this.turnBoostTimer > 0 && this.bulletFacing !== null;
    if (target) {
      const wasAlerted = this.alerted;
      this.alerted          = true;
      this.losingSightTimer = 0;
      if (!wasAlerted && game?.onEnemySeesPlayer) game.onEnemySeesPlayer(this, world.player);

      const dx   = target.pos.x - this.mesh.position.x;
      const dz   = target.pos.z - this.mesh.position.z;
      const dist = Math.hypot(dx, dz);

      // Lock the cone onto the target while we can see them — unless the
      // drone is still mid-reacting to a bullet.
      if (!boosting) this.facing = Math.atan2(dx, dz);

      // Chase via a periodically-refreshed BFS path so the drone rounds
      // corners cleanly instead of pressing into walls when the player
      // breaks line-of-sight around a turn.
      if (dist > 2.2) {
        this._chaseStep(dt, map, target.pos);
      }

      // Fire rapid single shots while in range.
      this.shootCooldown -= dt;
      if (this.shootCooldown <= 0 && dist < BATTLE_CONE_RANGE) {
        const owner = this.faction === 'friendly' ? 'player' : 'enemy';
        game.spawnBullet(this.mesh.position.x, this.mesh.position.z, dx / dist, dz / dist, owner, this);
        this.shootCooldown = this.shootInterval;
      }
      // Clear any stale wander route so we start fresh once alert ends.
      this.routePath = null;
    } else {
      if (this.alerted) {
        this.losingSightTimer += dt;
        if (this.losingSightTimer >= LOSE_SIGHT_TIME) {
          this.alerted          = false;
          this.losingSightTimer = 0;
        }
      }
      // Cone sweeps clockwise when NOT locked onto the player — unless the
      // drone is still mid-reacting to a bullet.
      if (!boosting) this.facing -= CONE_ROT_SPEED * dt;

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
    if (boosting) {
      let diff = this.bulletFacing - this.facing;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.facing += Math.sign(diff) * Math.min(Math.abs(diff), TURN_SPEED_FAST * dt);
      this.turnBoostTimer -= dt;
      if (this.turnBoostTimer <= 0) this.bulletFacing = null;
    }

    // Soft separation from soldiers, other drones and mechas so a swarm
    // can't bunch up into a single visual blob.
    this._avoidOthers(world, dt, map);

    this.updateConeMesh(map);
    this._updateHpBar(dt);
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

  onBulletNearby(bulletDx, bulletDz) {
    if (!this.alive) return;
    // Defer the actual turn to update(): store the target angle + boost
    // timer so the cone rotates at TURN_SPEED_FAST instead of snapping.
    this.bulletFacing   = Math.atan2(-bulletDx, -bulletDz);
    this.turnBoostTimer = TURN_BOOST_TIME;
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
    if (this.mesh?.material) {
      this.mesh.material.color.setHex(0x66ccff);
      if (this.mesh.material.emissive) this.mesh.material.emissive.setHex(0x113355);
    }
    this.alerted          = false;
    this.losingSightTimer = 0;
    this.routePath        = null;
  }

  _updateHpBar(dt) {
    const p = this.mesh.position;
    this.hpBarBg.position.set(p.x, 1.7, p.z);
    this.hpBarFg.position.set(p.x, 1.7, p.z);
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
    this.hpTimer = 3;
    this.hpBarBg.visible = true;
    this.hpBarFg.visible = true;
    if (this.hp <= 0) this.kill();
  }

  kill() {
    this.alive            = false;
    this.mesh.visible     = false;
    this.coneMesh.visible = false;
    this.hpBarBg.visible  = false;
    this.hpBarFg.visible  = false;
  }
}
