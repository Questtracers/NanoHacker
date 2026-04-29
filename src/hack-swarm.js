import * as THREE from 'three';

// Hack-success swarm — a tiny cloud of bright additive points that
// streams from the player's chest to the hacked target's head bone
// over a couple of seconds. Modelled after the Quarks "magic spell"
// vibe: each particle wanders independently with a steering force
// pulling it toward the target, plus a small tangential swirl so the
// group reads as a swarm rather than a straight line.
//
// Public API:
//   spawnHackSwarm(scene, getOriginPos, getTargetPos, opts?)
//     Origin and target are CALLBACKS returning Vector3 each frame —
//     so the swarm tracks both the player AND the moving target.
//   updateHackSwarm(dt)
//     Integrate every active swarm. Call once per frame from the
//     host's animate loop.
//
// Options:
//   { particles, lifetime, color, size, mode, burstSpeed }
//   mode = 'seek' (default) — seeks the target every frame, used for
//          successful hacks and for the possession-enter cast.
//   mode = 'burst' — pure outward expansion + fade, no seeking. Used
//          for the possession-eject "the hacker returns to the body"
//          beat. `burstSpeed` (m/s) controls the outward velocity.

const DEFAULT_PARTICLES = 36;
const DEFAULT_LIFETIME  = 1.2;     // seconds — punchier than before
const DEFAULT_COLOR     = 0xc080ff; // matches the HUD hack tint
const DEFAULT_SIZE      = 0.10;

const SEEK_ACCEL        = 32.0;    // m/s² toward target — bumped 2× for speed
const SWIRL_ACCEL       = 8.0;     // m/s² perpendicular force (orbiting)
const DRAG              = 0.94;    // a touch less drag so particles arrive sooner
const ARRIVAL_RADIUS    = 0.22;
const STAGGER_SPREAD    = 0.18;    // tightened so the burst feels snappy
const INITIAL_BURST     = 2.4;     // bigger initial outward kick

const HIDDEN_Y = -1e4;

const _live = [];
const _vTarget = new THREE.Vector3();
const _vOrigin = new THREE.Vector3();
const _vDelta  = new THREE.Vector3();
const _vPerp   = new THREE.Vector3();
const _UP      = new THREE.Vector3(0, 1, 0);

export function spawnHackSwarm(scene, getOriginPos, getTargetPos, opts = {}) {
  const count      = opts.particles  ?? DEFAULT_PARTICLES;
  const lifetime   = opts.lifetime   ?? DEFAULT_LIFETIME;
  const color      = opts.color      ?? DEFAULT_COLOR;
  const size       = opts.size       ?? DEFAULT_SIZE;
  const mode       = opts.mode       ?? 'seek';
  const burstSpeed = opts.burstSpeed ?? 8.0;

  // Pull a starting origin so we can seed positions there.
  getOriginPos(_vOrigin);

  const positions = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);
  const baseColor = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    positions[i * 3]     = _vOrigin.x;
    positions[i * 3 + 1] = _vOrigin.y;
    positions[i * 3 + 2] = _vOrigin.z;
    colors[i * 3]     = baseColor.r;
    colors[i * 3 + 1] = baseColor.g;
    colors[i * 3 + 2] = baseColor.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    vertexColors: true,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  // Per-particle state. `delay` staggers emission so the swarm trails
  // off the origin instead of all spawning at once.
  const parts = [];
  for (let i = 0; i < count; i++) {
    const ang  = Math.random() * Math.PI * 2;
    const elev = (Math.random() - 0.5) * Math.PI * 0.8;
    // Burst mode uses `burstSpeed` directly so the explosion reads as
    // a wide cloud. Seek mode uses INITIAL_BURST so the seeking force
    // can dominate quickly.
    const sp = (mode === 'burst')
      ? burstSpeed * (0.6 + Math.random() * 0.6)
      : INITIAL_BURST * (0.5 + Math.random());
    parts.push({
      x: _vOrigin.x, y: _vOrigin.y, z: _vOrigin.z,
      // Outward initial velocity in a random direction so the swarm
      // bursts out of the player before the seeking force pulls it back.
      vx: Math.cos(ang) * Math.cos(elev) * sp,
      vy: Math.sin(elev) * sp + 0.4,
      vz: Math.sin(ang) * Math.cos(elev) * sp,
      delay: Math.random() * STAGGER_SPREAD,
      age: 0,
      // Each particle has its own swirl phase so the perpendicular
      // force doesn't collapse the swarm to a single corkscrew.
      swirlPhase: Math.random() * Math.PI * 2,
      swirlRate:  4 + Math.random() * 3,
    });
  }

  _live.push({
    scene, points, geo, mat, parts,
    getOriginPos, getTargetPos,
    age: 0, lifetime,
    baseColor,
    mode,
  });
}

export function updateHackSwarm(dt) {
  if (dt <= 0) return;
  for (let i = _live.length - 1; i >= 0; i--) {
    const sw = _live[i];
    sw.age += dt;
    const t = sw.age / sw.lifetime;
    // Pull the live target / origin every frame so the swarm tracks
    // movement (target may be a walking soldier, player may be moving).
    if (sw.getTargetPos) sw.getTargetPos(_vTarget);
    if (sw.getOriginPos) sw.getOriginPos(_vOrigin);

    const pos = sw.geo.attributes.position;
    let alive = 0;
    for (let j = 0; j < sw.parts.length; j++) {
      const p = sw.parts[j];
      // Pre-emission delay: park off-screen until our turn.
      if (p.delay > 0) {
        p.delay -= dt;
        if (p.delay > 0) {
          pos.setXYZ(j, 0, HIDDEN_Y, 0);
          continue;
        }
        // First emission tick — seed at the live origin so the burst
        // leaves the player wherever they are NOW.
        p.x = _vOrigin.x; p.y = _vOrigin.y; p.z = _vOrigin.z;
      }
      p.age += dt;
      if (sw.mode === 'seek' && sw.getTargetPos) {
        // Direction toward target.
        _vDelta.set(_vTarget.x - p.x, _vTarget.y - p.y, _vTarget.z - p.z);
        const dist = _vDelta.length();
        // Particle reached target (or close enough): absorb and park.
        if (dist <= ARRIVAL_RADIUS) {
          pos.setXYZ(j, 0, HIDDEN_Y, 0);
          p.age = sw.lifetime + 1;     // mark as dead
          continue;
        }
        alive++;
        _vDelta.divideScalar(dist || 1);
        // Seek (pull toward target).
        p.vx += _vDelta.x * SEEK_ACCEL * dt;
        p.vy += _vDelta.y * SEEK_ACCEL * dt;
        p.vz += _vDelta.z * SEEK_ACCEL * dt;
        // Tangential swirl — perpendicular to seek dir + UP, oscillated
        // by per-particle phase so each one orbits at its own rate.
        _vPerp.copy(_vDelta).cross(_UP).normalize();
        const swirl = Math.sin(p.swirlPhase + p.age * p.swirlRate);
        p.vx += _vPerp.x * SWIRL_ACCEL * swirl * dt;
        p.vy += Math.cos(p.swirlPhase + p.age * p.swirlRate) * SWIRL_ACCEL * 0.5 * dt;
        p.vz += _vPerp.z * SWIRL_ACCEL * swirl * dt;
      } else {
        // Burst mode: no seek, no swirl. Just integrate the initial
        // outward velocity with gravity-free decay so the cloud
        // expands and settles.
        alive++;
        p.vy -= 1.6 * dt;                  // mild gravity for fall-off
      }
      // Drag (frame-rate independent).
      const k = Math.pow(DRAG, dt * 60);
      p.vx *= k; p.vy *= k; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      pos.setXYZ(j, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    // Fade the whole material toward the end of the lifetime so any
    // particles that haven't reached the target yet dissolve cleanly.
    const fade = Math.max(0, 1 - Math.max(0, t - 0.7) / 0.3);
    sw.mat.opacity = fade;

    // Cleanup. We only treat `alive === 0` as a kill condition AFTER
    // the staggered emission window has passed — otherwise an unlucky
    // RNG roll where every particle's pre-emission delay exceeds the
    // first frame's dt would dispose the swarm before it ever rendered
    // (which was the "second hack does nothing" bug).
    const pastEmission = sw.age > STAGGER_SPREAD + 0.05;
    if (sw.age >= sw.lifetime || (pastEmission && alive === 0)) {
      sw.scene.remove(sw.points);
      sw.geo.dispose();
      sw.mat.dispose();
      _live.splice(i, 1);
    }
  }
}
