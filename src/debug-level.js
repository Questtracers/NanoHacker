import * as THREE from 'three';
import { Player } from './player.js';
import { Mecha } from './mecha.js';
import { Bullet, updatePlayerArrowVFX } from './bullet.js';
import { Rocket } from './rocket.js';
import { updateRocketExplosions } from './rocket-explosion.js';
import { spawnHackSwarm, updateHackSwarm } from './hack-swarm.js';
import { spawnConfetti, updateConfetti } from './confetti.js';
import { updateCrateDebris } from './obstacle.js';
import { HackMinigame } from './hack.js';

// Debug arena — minimal "1v1 with a mecha" sandbox.
//
// Spawns the human and a single hostile AI mecha on an open floor with
// no walls / doors / drones / hack-points / exits. All combat rules
// from the live game still apply: WASD/Q/E movement, SPACE shoot, R
// hack (diff 2 against the mecha so the player can iterate quickly),
// F mecha rocket while possessed, slow-mo, death animation, possess
// fade, restart on R from the death overlay.

const RIG_X = 50, RIG_Z = 50;        // arena origin (well inside the map)
const MECHA_OFFSET_Z = 12;           // metres in front of the player

const CAM_YAW    = Math.PI * 75 / 180;
const CAM_RADIUS = 14.3;
const CAM_HEIGHT = 11.7;
const HACK_RANGE = 5.0;
const SHOT_COOLDOWN = 5.0;
const PLAYER_MAX_HP = 2;
const PLAYER_DEATH_HOLD = 2.2;
const POSSESS_GHOST_DURATION = 1.5;

export function runDebugLevel(opts = {}) {
  // openingMessage — string shown as a one-shot card at the top of
  // the screen for ~6 s when the level boots. Used by the tutorial
  // hand-off so the mentor can leave the player with a parting line
  // ("Now I believe you're ready…") in the same visual frame as the
  // sandbox they'll be testing themselves in.
  const openingMessage = opts.openingMessage || null;
  window.__nanoDebugLevel = true;

  // Hide any pre-existing canvases / HUD bits left by the main game.
  document.querySelectorAll('canvas').forEach((c) => { c.style.display = 'none'; });
  ['hud', 'overlay', 'arrow-spot', 'arrow-exit'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // ── Renderer + scene ────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x05060a);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x05060a, 22, 80);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x1c1f29, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(RIG_X, 0, RIG_Z);
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(120, 120, 0x224466, 0x162132);
  grid.position.set(RIG_X, 0.001, RIG_Z);
  scene.add(grid);

  scene.add(new THREE.AmbientLight(0x8899aa, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(RIG_X + 20, 40, RIG_Z + 10);
  sun.target.position.set(RIG_X, 0, RIG_Z);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -50; sun.shadow.camera.right = 50;
  sun.shadow.camera.top  =  50; sun.shadow.camera.bottom = -50;
  scene.add(sun);
  scene.add(sun.target);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 220);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── Stub map (large open zero-grid so isWall always passes) ─────────
  const MAP_SIZE = 200;
  const map = {
    width: MAP_SIZE, height: MAP_SIZE,
    grid: Array.from({ length: MAP_SIZE }, () => new Array(MAP_SIZE).fill(0)),
    rooms: [],
  };

  // ── Entities ────────────────────────────────────────────────────────
  const player = new Player(scene, RIG_X, RIG_Z);
  const mechas = [new Mecha(scene, RIG_X, RIG_Z + MECHA_OFFSET_Z)];
  const bullets = [];

  // Mecha spawns with a random facing in its own constructor — fine
  // for a populated maze, but in this empty arena there's no patrol
  // path to spin it around, so a wrong starting angle would leave the
  // player permanently outside its vision cone (and battle mode would
  // never trigger, hiding the aim line). Point it straight at the
  // player on spawn so the cone catches them as soon as they walk in.
  // Player is at (RIG_X, RIG_Z); mecha is +Z of the player → mecha
  // looks down -Z (facing = π).
  {
    const m = mechas[0];
    m.facing       = Math.PI;
    m.targetFacing = Math.PI;
  }

  // ── HUD ─────────────────────────────────────────────────────────────
  const hud = document.createElement('div');
  hud.style.cssText = [
    'position:fixed', 'top:10px', 'left:10px', 'z-index:10',
    'padding:8px 12px',
    'background:rgba(0,5,15,0.7)', 'border:1px solid #0ff5',
    'border-radius:4px', 'font-family:monospace', 'font-size:13px',
    'color:#cfe', 'line-height:1.6', 'pointer-events:none',
    'white-space:pre',
  ].join(';');
  document.body.appendChild(hud);

  // Optional one-shot opening message — used by the tutorial hand-off.
  if (openingMessage) {
    const card = document.createElement('div');
    card.style.cssText = [
      'position:fixed', 'left:50%', 'top:60px', 'transform:translateX(-50%)',
      'z-index:35',
      'padding:18px 28px', 'max-width:80vw',
      'background:rgba(245,250,255,0.95)',
      'border:1px solid rgba(120,180,255,0.6)',
      'border-radius:12px',
      'box-shadow:0 6px 36px rgba(70,110,160,0.25)',
      'font-family:"Trebuchet MS", "Lucida Grande", sans-serif',
      'color:#22344c', 'font-size:18px', 'line-height:1.45',
      'transition:opacity 400ms ease',
    ].join(';');
    card.textContent = openingMessage;
    document.body.appendChild(card);
    // Fade out after a generous read time, then remove from DOM.
    setTimeout(() => { card.style.opacity = '0'; }, 6000);
    setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, 6500);
  }

  const overlayEl = document.createElement('div');
  overlayEl.style.cssText = [
    'position:fixed', 'inset:0', 'display:none', 'z-index:20',
    'background:rgba(0,0,0,0.75)', 'color:#fff',
    'align-items:center', 'justify-content:center', 'flex-direction:column',
    'font-size:28px', 'font-family:monospace',
  ].join(';');
  document.body.appendChild(overlayEl);

  // ── Game state ──────────────────────────────────────────────────────
  let battleMode      = false;
  let gameOver        = false;
  let playerHp        = PLAYER_MAX_HP;
  let playerDying     = false;
  let playerDeathTimer = 0;
  let shotCooldown    = 0;
  let possessedMecha  = null;
  let possessGhostTimer = 0;
  const possessGhostPos = new THREE.Vector3();
  let pendingHack     = null;
  const HACK_PREP_MS  = 850;

  // Calibration knobs — separate yaws for cannon vs rocket. T/G nudge
  // whichever is currently armed (or cannon by default). Pre-seeded
  // from the gameplay-baked values so the debug starts at the same
  // pose the live game uses.
  let cannonYawDeg = -40;
  let rocketYawDeg = -45;
  const UPPER_BODY_YAW_STEP = 1.0;
  function applyUpperBodyYawToAll() {
    const cannon = cannonYawDeg * Math.PI / 180;
    const rocket = rocketYawDeg * Math.PI / 180;
    for (const m of mechas) m.rig?.setShootingUpperBodyYaw?.({ cannon, rocket });
  }
  function activeWeaponLabel() {
    const m = mechas[0];
    if (!m?.rig) return 'cannon';
    if (m.rig.isRocketing) return 'rocket';
    return 'cannon';
  }
  applyUpperBodyYawToAll();

  function endGame(msg) {
    gameOver = true;
    overlayEl.innerHTML =
      `<div>${msg}</div>` +
      `<div style="font-size:18px;opacity:.75;margin-top:14px;">` +
      `Press <b style="color:#7ff">R</b> to restart` +
      `</div>`;
    overlayEl.style.display = 'flex';
  }

  function playerTakeDamage(n = 1) {
    if (gameOver || playerDying) return;
    playerHp = Math.max(0, playerHp - n);
    if (playerHp <= 0) {
      const ok = player.rig?.triggerDeath?.('back') === true;
      if (!ok) { endGame('You were eliminated'); return; }
      playerDying      = true;
      playerDeathTimer = PLAYER_DEATH_HOLD;
      player.aimLine.visible = false;
      player.setInputDisabled?.(true);
    }
  }

  // Same rig-opacity helpers as main.js — duplicated locally so the
  // debug level stays self-contained.
  function setRigOpacity(p, alpha, storeOriginal = false) {
    const apply = (m) => {
      if (!m) return;
      if (storeOriginal && m.userData._origOpacity === undefined) {
        m.userData._origOpacity     = m.opacity ?? 1;
        m.userData._origTransparent = m.transparent ?? false;
      }
      m.transparent = true;
      m.opacity     = alpha;
      m.depthWrite  = alpha > 0.99;
    };
    p.mesh.traverse((c) => {
      if (!c.isMesh && !c.isSkinnedMesh) return;
      if (Array.isArray(c.material)) c.material.forEach(apply);
      else if (c.material)            apply(c.material);
    });
  }
  function restoreRigOpacity(p) {
    const restore = (m) => {
      if (!m) return;
      if (m.userData._origOpacity !== undefined) {
        m.opacity     = m.userData._origOpacity;
        m.transparent = m.userData._origTransparent;
        m.depthWrite  = true;
        delete m.userData._origOpacity;
        delete m.userData._origTransparent;
      }
    };
    p.mesh.traverse((c) => {
      if (!c.isMesh && !c.isSkinnedMesh) return;
      if (Array.isArray(c.material)) c.material.forEach(restore);
      else if (c.material)            restore(c.material);
    });
  }

  function enterMechaPossession(m) {
    if (possessedMecha || !m || !m.alive) return;
    possessedMecha = m;
    m.enterPossession();
    possessGhostPos.set(player.position.x, player.position.y, player.position.z);
    possessGhostTimer = POSSESS_GHOST_DURATION;
    setRigOpacity(player, 1, true);
    player.facingTri.visible = false;
    player.aimLine.visible   = false;
    spawnHackSwarm(
      scene,
      (out) => out.set(possessGhostPos.x, possessGhostPos.y + 1.0, possessGhostPos.z),
      (out) => out.set(m.mesh.position.x, m.mesh.position.y + 1.4, m.mesh.position.z),
      { particles: 180, lifetime: POSSESS_GHOST_DURATION, size: 0.14 },
    );
  }
  function ejectFromMecha() {
    if (!possessedMecha) return;
    const m = possessedMecha;
    const bx = m.mesh.position.x - Math.sin(m.facing) * 1.6;
    const bz = m.mesh.position.z - Math.cos(m.facing) * 1.6;
    player.mesh.position.x = bx;
    player.mesh.position.z = bz;
    player.facing = m.facing;
    player.facingDir.x = Math.sin(m.facing);
    player.facingDir.z = Math.cos(m.facing);
    player.mesh.visible = true;
    player.facingTri.visible = true;
    possessGhostTimer = 0;
    restoreRigOpacity(player);
    spawnHackSwarm(
      scene, (out) => out.set(bx, 1.0, bz), null,
      { mode: 'burst', particles: 160, lifetime: 0.9, size: 0.14, burstSpeed: 9 },
    );
    m.leavePossession();
    possessedMecha = null;
  }

  // ── Game callbacks ──────────────────────────────────────────────────
  const game = {
    spawnBullet(x, z, dx, dz, owner = 'enemy', shooter = null, y = 0.6) {
      bullets.push(new Bullet(scene, x, z, dx, dz, owner, shooter, y));
    },
    spawnRocket(x, z, dx, dz, owner = 'player', shooter = null, y = 0.7) {
      bullets.push(new Rocket(scene, x, z, dx, dz, owner, shooter, y));
    },
    onEnemySeesPlayer() {},
    cellBlockedByDoor() { return false; },
    damageObstacleAt() {},
    obstacleAt() { return null; },
    destroyObstacleAt() {},
  };

  // ── Hack minigame ───────────────────────────────────────────────────
  // Wired up exactly like main.js, but the difficulty for the mecha is
  // pinned to 2 instead of the live game's 7 so iteration is fast.
  // The minigame consumes hack points via getHP/spendHP — for the
  // sandbox we hand it a fixed pool so premium commands don't error.
  let debugHackPoints = 5;
  const hacker = new HackMinigame({
    getHP:   () => debugHackPoints,
    spendHP: (n) => { debugHackPoints = Math.max(0, debugHackPoints - n); },
  });

  // ── Input ───────────────────────────────────────────────────────────
  const pickRing = (() => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.05, 32),
      new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    scene.add(m);
    return m;
  })();

  window.addEventListener('keydown', (e) => {
    if (gameOver) {
      if (e.key.toLowerCase() === 'r') location.reload();
      return;
    }
    if (hacker.active || pendingHack || playerDying) return;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      if (possessedMecha) { ejectFromMecha(); return; }
      // Look for a mecha within HACK_RANGE.
      let target = null, bestD = Infinity;
      for (const m of mechas) {
        if (!m.alive) continue;
        const d = Math.hypot(player.position.x - m.mesh.position.x,
                             player.position.z - m.mesh.position.z);
        if (d < HACK_RANGE && d < bestD) { bestD = d; target = m; }
      }
      if (!target) return;
      const onClose = (won) => {
        pickRing.visible = false;
        if (won) {
          target.hackLink();
          enterMechaPossession(target);
        } else {
          playerTakeDamage(1);
        }
      };
      pendingHack = { target, onClose, startTime: performance.now() };
      pickRing.position.set(target.mesh.position.x, 0.03, target.mesh.position.z);
      pickRing.visible = true;
      return;
    }
    if (k === 'k') {
      if (possessedMecha) possessedMecha.playerFireRocket(game);
      return;
    }
    // Upper-body yaw calibration — T / G nudge ±1° on whichever weapon
    // the mecha is currently armed with (cannon by default, rocket if
    // the rocket arm is up). Pure calibration: doesn't affect gameplay
    // state, just changes which value the rig's post-mixer block uses.
    if (k === 't' || k === 'g') {
      const sign = k === 't' ? +1 : -1;
      if (activeWeaponLabel() === 'rocket') rocketYawDeg += sign * UPPER_BODY_YAW_STEP;
      else                                   cannonYawDeg += sign * UPPER_BODY_YAW_STEP;
      applyUpperBodyYawToAll();
      return;
    }
    if (k === 'j') {
      if (possessedMecha) { possessedMecha.playerFire(game); return; }
      if (shotCooldown > 0) return;
      const d = player.facingDir;
      const len = Math.hypot(d.x, d.z) || 1;
      const muzzle = player.getBowMuzzleWorldPos?.(new THREE.Vector3());
      const sx = muzzle ? muzzle.x : player.position.x + (d.x / len) * 0.6;
      const sy = muzzle ? muzzle.y : 0.6;
      const sz = muzzle ? muzzle.z : player.position.z + (d.z / len) * 0.6;
      game.spawnBullet(sx, sz, d.x / len, d.z / len, 'player', null, sy);
      player.notifyShot?.();
      shotCooldown = SHOT_COOLDOWN;
    }
  });

  function tickPendingHack() {
    if (!pendingHack) return false;
    const elapsed = performance.now() - pendingHack.startTime;
    const progress = Math.min(elapsed / HACK_PREP_MS, 1);
    const scale = 1 + Math.sin(progress * Math.PI) * 0.9;
    pickRing.scale.setScalar(scale);
    pickRing.material.opacity = 0.6 + 0.4 * Math.sin(progress * Math.PI * 4);
    if (progress >= 1) {
      const p = pendingHack;
      pendingHack = null;
      pickRing.scale.setScalar(1);
      pickRing.material.opacity = 0.9;
      hacker.open(2, { onClose: p.onClose });
    }
    return true;
  }

  // ── Render / animate ────────────────────────────────────────────────
  const clock = new THREE.Clock();
  function tick() {
    if (gameOver) return;
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);

    if (tickPendingHack()) { renderer.render(scene, camera); return; }
    if (hacker.active)     { renderer.render(scene, camera); return; }

    if (playerDying) {
      playerDeathTimer -= dt;
      if (playerDeathTimer <= 0 && !gameOver) endGame('You were eliminated');
    }

    // Player update (skipped during the possession ghost fade).
    if (!possessedMecha) {
      if (playerDying) {
        player.update(dt, map, null, false, false);
      } else {
        player.update(dt, map, null, battleMode, shotCooldown <= 0);
      }
    } else {
      if (possessGhostTimer > 0) {
        possessGhostTimer -= dt;
        const t = 1 - Math.max(0, possessGhostTimer) / POSSESS_GHOST_DURATION;
        player.rig.position    = { x: possessGhostPos.x, z: possessGhostPos.z };
        player.rig.battleMode  = false;
        player.rig.setMovement(0, 0);
        player.rig.update(dt);
        setRigOpacity(player, 1 - t);
        if (possessGhostTimer <= 0) {
          player.mesh.visible = false;
          restoreRigOpacity(player);
        }
      } else {
        player.mesh.position.x = possessedMecha.mesh.position.x;
        player.mesh.position.z = possessedMecha.mesh.position.z;
      }
    }

    // Battle mode + slow-mo.
    const anyAlerted = mechas.some(m => m.alive && m.alerted && m.faction === 'hostile');
    battleMode = anyAlerted;
    const ctrlMoved = possessedMecha
      ? ['w','a','s','d'].some(k => player.keys.has(k))
      : player.movedThisFrame;
    let worldDt = dt;
    if (battleMode && !ctrlMoved) worldDt = dt * 0.08;

    // Aim line — same rules as main.
    const aimVisible = battleMode && !playerDying && (!possessedMecha || possessGhostTimer <= 0);
    player.aimLine.visible = aimVisible;
    if (possessedMecha && aimVisible) {
      player.aimLine.position.set(possessedMecha.mesh.position.x, 0, possessedMecha.mesh.position.z);
      player.aimLine.rotation.y = possessedMecha.facing;
    }
    if (aimVisible) {
      const ox = possessedMecha ? possessedMecha.mesh.position.x : player.position.x;
      const oz = possessedMecha ? possessedMecha.mesh.position.z : player.position.z;
      const fx = possessedMecha ? Math.sin(possessedMecha.facing) : player.facingDir.x;
      const fz = possessedMecha ? Math.cos(possessedMecha.facing) : player.facingDir.z;
      let hostile = false;
      for (const e of mechas) {
        if (!e?.alive || e.faction === 'friendly') continue;
        const ex = e.mesh.position.x - ox, ez = e.mesh.position.z - oz;
        const along = ex * fx + ez * fz;
        if (along < 0 || along > 6) continue;
        const perp = Math.hypot(ex - fx * along, ez - fz * along);
        if (perp <= (e.hitRadius ?? 0.45)) { hostile = true; break; }
      }
      player.setAimLineHostile(hostile);
    }

    // Mechas tick. World view mirrors what main.js passes so AI works
    // identically — entities pull realDt for in-place rotation, and the
    // camera-yaw is used for HP-bar billboard alignment.
    const worldView = {
      player, enemies: [], drones: [], mechas, map,
      destroyObstacleAt: () => {}, realDt: dt, battleMode,
      debugOpen: false, cameraYaw: CAM_YAW,
    };
    for (const m of mechas) m.update(worldDt, map, worldView, game);

    if (possessedMecha && !possessedMecha.alive) {
      possessedMecha = null;
      player.mesh.visible = true;
      player.facingTri.visible = true;
      return endGame('Destroyed inside the mecha');
    }

    // Bullets.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      const r = b.update(worldDt, map, possessedMecha ? null : player, mechas, game);
      if (r === 'hit') {
        playerTakeDamage(b.damage ?? 1);
        if (gameOver) return;
      }
      if (!b.alive) bullets.splice(i, 1);
    }

    if (shotCooldown > 0) shotCooldown -= worldDt;

    // Camera follow.
    const followPos = possessedMecha ? possessedMecha.mesh.position : player.position;
    camera.position.set(
      followPos.x + Math.sin(CAM_YAW) * CAM_RADIUS,
      CAM_HEIGHT,
      followPos.z + Math.cos(CAM_YAW) * CAM_RADIUS,
    );
    camera.lookAt(followPos.x, 0.5, followPos.z);

    // VFX pools.
    updateCrateDebris(worldDt);
    updatePlayerArrowVFX(worldDt);
    updateRocketExplosions(worldDt);
    updateHackSwarm(dt);
    updateConfetti(dt);

    // HUD.
    const mecha = mechas[0];
    hud.textContent = [
      'DEBUG LEVEL — 1v1 mecha sandbox',
      'WASD/Q/E move/turn • J shoot • R hack-link • K rocket (mecha)',
      'T / G — upper-body yaw +/- (mecha shooting pose)',
      '',
      `HP:        ${playerHp} / ${PLAYER_MAX_HP}`,
      `Shot:      ${shotCooldown <= 0 ? 'READY' : shotCooldown.toFixed(1) + 's'}`,
      `Mecha HP:  ${mecha?.alive ? `${mecha.hp} / ${mecha.maxHp}` : 'DOWN'}`,
      `Possessed: ${possessedMecha ? 'YES (R to eject)' : 'no'}`,
      `Mode:      ${battleMode ? 'BATTLE' : 'STEALTH'}`,
      `UpperYaw:  cannon=${cannonYawDeg.toFixed(1)}°  rocket=${rocketYawDeg.toFixed(1)}°  (active: ${activeWeaponLabel()})`,
    ].join('\n');

    renderer.render(scene, camera);
  }
  tick();
}
