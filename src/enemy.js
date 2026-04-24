import * as THREE from 'three';
import { isWall, rayMarch } from './map.js';

const STEALTH_CONE_ANGLE = Math.PI / 4;
const STEALTH_CONE_RANGE = 7;
const BATTLE_CONE_ANGLE  = Math.PI / 3;
const BATTLE_CONE_RANGE  = 12;
const LOSE_SIGHT_TIME    = 2.0;
const WAIT_TIME          = 1.5;
const TURN_SPEED         = 2.5;
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

    this.facing       = Math.random() * Math.PI * 2;
    this.targetFacing = this.facing;
    this.speed        = 2.0;
    this.alive        = true;

    this.alerted          = false;
    this.losingSightTimer = 0;
    this.shootCooldown    = 1.0;

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

  canSee(player, map) {
    const p = this.mesh.position, pp = player.position;
    const dx = pp.x - p.x, dz = pp.z - p.z;
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

  _smoothTurn(dt) {
    let diff = this.targetFacing - this.facing;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.facing += Math.sign(diff) * Math.min(Math.abs(diff), TURN_SPEED * dt);
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
    const step = this.speed * dt;
    const p    = this.mesh.position;
    if (!isWall(map, p.x + dx * step, p.z)) p.x += dx * step;
    if (!isWall(map, p.x, p.z + dz * step)) p.z += dz * step;
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
    this.coneMat.color.setHex(this.alerted ? 0xff3030 : 0xffaa00);
    this.coneMat.opacity = this.alerted ? 0.45 : 0.38;
  }

  update(dt, map, player, game) {
    if (!this.alive) return;

    const seesPlayer = this.canSee(player, map);

    if (seesPlayer) {
      this.alerted          = true;
      this.losingSightTimer = 0;
      this.returningToRoute = false;
      game.onEnemySeesPlayer();

      const dx   = player.position.x - this.mesh.position.x;
      const dz   = player.position.z - this.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      this.targetFacing = Math.atan2(dx, dz);
      if (dist > 3.5) this._tryMove(dx / dist, dz / dist, dt, map);

      this.shootCooldown -= dt;
      if (this.shootCooldown <= 0 && dist < BATTLE_CONE_RANGE) {
        game.spawnBullet(this.mesh.position.x, this.mesh.position.z, dx / dist, dz / dist);
        this.shootCooldown = 1.2;
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

    this._smoothTurn(dt);
    this.updateConeMesh(map);
  }

  kill() {
    this.alive            = false;
    this.mesh.visible     = false;
    this.coneMesh.visible = false;
  }
}
