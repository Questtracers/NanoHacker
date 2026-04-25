import * as THREE from 'three';
import { isWall, rayMarch, findPath, findValidFloor } from './map.js';

const STEALTH_CONE_ANGLE = Math.PI / 4;
const STEALTH_CONE_RANGE = 7;
const BATTLE_CONE_ANGLE  = Math.PI / 3;
const BATTLE_CONE_RANGE  = 12;
const LOSE_SIGHT_TIME    = 2.0;
const WAIT_TIME          = 1.5;
const TURN_SPEED         = 2.5;
const TURN_SPEED_FAST    = 9.0; // boost rate when reacting to bullets
const TURN_BOOST_TIME    = 0.45;
const TURN_THRESHOLD     = 0.18; // rad — must be within ~10° before moving

export class Enemy {
  constructor(scene, x, z) {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 0.4, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0xff5555, emissive: 0x331010 })
    );
    body.position.set(x, 0.55, z);
    body.castShadow = true;
    scene.add(body);
    this.mesh = body;

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

    this.facing          = Math.random() * Math.PI * 2;
    this.targetFacing    = this.facing;
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
    const half  = this.alerted ? BATTLE_CONE_ANGLE  : STEALTH_CONE_ANGLE;
    if (dist > range) return false;
    let diff = Math.atan2(dx, dz) - this.facing;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > half) return false;
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
    } else {
      for (const e of world.enemies || []) {
        if (e !== this && e.alive && e.faction === 'hostile') pool.push({ pos: e.mesh.position, ent: e });
      }
      for (const d of world.drones || []) {
        if (d.alive && d.faction === 'hostile') pool.push({ pos: d.mesh.position, ent: d });
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
    if (!this.alive) return;
    // Back-compat: if the host still passes the player directly, wrap it.
    if (world && !world.player && world.position) world = { player: world };

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
      this.targetFacing = Math.atan2(dx, dz);
      // Pathfind toward the target instead of charging straight at it. This
      // makes the soldier round walls / corners cleanly rather than mashing
      // into them. Path is recomputed every ~0.4 s as the player moves.
      if (dist > 3.5) this._chaseStep(dx, dz, dist, dt, map, target.pos);

      this.shootCooldown -= dt;
      if (this.shootCooldown <= 0 && dist < BATTLE_CONE_RANGE) {
        const owner = this.faction === 'friendly' ? 'player' : 'enemy';
        game.spawnBullet(this.mesh.position.x, this.mesh.position.z, dx / dist, dz / dist, owner, this);
        this.burstRemaining--;
        if (this.burstRemaining <= 0) {
          this.burstRemaining = 3;
          this.shootCooldown  = this.burstRest;
        } else {
          this.shootCooldown  = this.burstGap;
        }
      }

    } else if (this.alerted) {
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

    this._smoothTurn(dt);
    this.updateConeMesh(map);
    this._updateHpBar(dt);
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

  _updateHpBar(dt) {
    const p = this.mesh.position;
    this.hpBarBg.position.set(p.x, 1.35, p.z);
    this.hpBarFg.position.set(p.x, 1.35, p.z);
    // Shrink the green bar from the centre toward the right (left anchor).
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
    if (this.mesh?.material) {
      this.mesh.material.color.setHex(0x66ccff);
      if (this.mesh.material.emissive) this.mesh.material.emissive.setHex(0x113355);
    }
    this.alerted          = false;
    this.losingSightTimer = 0;
    this.returningToRoute = true;
    this.pathPos          = this._nearestRoutePathPos();
    this.patrolPhase      = 'move';
  }

  kill() {
    this.alive            = false;
    this.mesh.visible     = false;
    this.coneMesh.visible = false;
    this.hpBarBg.visible  = false;
    this.hpBarFg.visible  = false;
  }
}
