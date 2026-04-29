import * as THREE from 'three';

// Confetti-blast VFX — burst of small flat ribbons flying outward from
// a point, tumbling end-over-end as they fall. Modelled after the
// Quarks "confetti-blast" preset: many lightweight rectangles, each
// with random orientation + angular velocity + gravity.
//
// Public API:
//   spawnConfetti(scene, x, y, z, opts?)
//     opts: {
//       particles  : count           (default 30)
//       lifetime   : seconds         (default 1.6)
//       colors     : array of hex    (default warm purple set)
//       speed      : initial m/s     (default 6.0)
//       size       : ribbon length m (default 0.16)
//       gravity    : m/s²            (default 9.0)
//     }
//   updateConfetti(dt)  — call once per frame
//
// Each particle is a flat rectangle (BoxGeometry of trivial depth)
// rendered as a regular Mesh, lit by ambient + emissive so the
// colours stay readable even in dark corridors. Tumbling is real
// per-axis angular velocity, not a billboard hack — the ribbons
// flash bright when they edge-on the camera and dim when face-on.

const FLOOR_Y          = 0.04;
const RESTITUTION      = 0.35;
const GROUND_FRICTION  = 0.55;
const SETTLE_THRESHOLD = 0.4;

const DEFAULT_COLORS_PURPLE = [
  0xc080ff, 0xaa44ff, 0xee99ff, 0x8833ff, 0xddbbff,
];

const _live = [];

export function spawnConfetti(scene, x, y, z, opts = {}) {
  const count    = opts.particles ?? 30;
  const lifetime = opts.lifetime  ?? 1.6;
  const colors   = opts.colors    ?? DEFAULT_COLORS_PURPLE;
  const speed    = opts.speed     ?? 6.0;
  const size     = opts.size      ?? 0.16;
  const gravity  = opts.gravity   ?? 9.0;

  const parts = [];
  for (let i = 0; i < count; i++) {
    // Domed-upward burst — angle around vertical, elevation biased
    // toward the upper hemisphere so confetti rains down rather than
    // hugging the floor.
    const ang  = Math.random() * Math.PI * 2;
    const elev = Math.random() * Math.PI * 0.5 + 0.05;   // 3°..93°
    const sp   = speed * (0.6 + Math.random() * 0.7);
    const c    = colors[Math.floor(Math.random() * colors.length)];

    // Flat ribbon — long in X, very thin in Z, tiny in Y so all
    // three rotation axes are visually distinguishable.
    const geo = new THREE.BoxGeometry(size, size * 0.04, size * 0.45);
    const mat = new THREE.MeshStandardMaterial({
      color:    c,
      emissive: new THREE.Color(c).multiplyScalar(0.6),
      roughness: 0.6,
      metalness: 0.1,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );
    scene.add(mesh);
    parts.push({
      mesh,
      vx: Math.cos(ang) * Math.cos(elev) * sp,
      vy: Math.sin(elev) * sp + 0.8,
      vz: Math.sin(ang) * Math.cos(elev) * sp,
      // Per-axis angular velocity in rad/s — picked from a wide range
      // so each ribbon tumbles uniquely.
      avx: (Math.random() - 0.5) * 18,
      avy: (Math.random() - 0.5) * 18,
      avz: (Math.random() - 0.5) * 18,
      age: 0,
      life: lifetime * (0.7 + Math.random() * 0.6),
      gravity,
    });
  }

  _live.push({ scene, parts, age: 0, lifetime });
}

export function updateConfetti(dt) {
  if (dt <= 0) return;
  for (let i = _live.length - 1; i >= 0; i--) {
    const cf = _live[i];
    cf.age += dt;
    let alive = 0;
    for (const p of cf.parts) {
      if (p.age >= p.life) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.mesh.parent?.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        continue;
      }
      alive++;
      // Air drag — frame-rate independent.
      const drag = Math.pow(0.97, dt * 60);
      p.vx *= drag; p.vy *= drag; p.vz *= drag;
      p.vy -= p.gravity * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      // Floor bounce — restitution + ground friction, with a settle
      // threshold so ribbons can come to rest instead of micro-bouncing.
      if (p.mesh.position.y < FLOOR_Y) {
        p.mesh.position.y = FLOOR_Y;
        if (p.vy < 0) {
          p.vy = -p.vy * RESTITUTION;
          p.vx *= GROUND_FRICTION;
          p.vz *= GROUND_FRICTION;
          // Tumble decays once it's rolling on the ground.
          p.avx *= 0.6; p.avy *= 0.6; p.avz *= 0.6;
          if (p.vy < SETTLE_THRESHOLD) p.vy = 0;
        }
      }
      // Tumble.
      p.mesh.rotation.x += p.avx * dt;
      p.mesh.rotation.y += p.avy * dt;
      p.mesh.rotation.z += p.avz * dt;
      // Fade out the last 30 % of life so disappearance is graceful.
      const t = p.age / p.life;
      p.mesh.material.opacity = (t < 0.7) ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
    }
    if (alive === 0 && cf.age >= 0.1) _live.splice(i, 1);
  }
}
